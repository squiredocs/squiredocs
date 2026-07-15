/**
 * Store tests for mcp_pending_authorizations (feature 008, T007).
 *
 * Exercises every atomic transition predicate against a real DB: one-shot code
 * entry, approve/deny guards, one-shot payload delivery, the concurrent atomic
 * claim (exactly one winner), code-uniqueness retry, the lazy GC sweep, and poll
 * bookkeeping. Serial (--runInBand); the table is truncated between cases.
 */
const crypto = require('crypto');
const { createPool, createTestUser, cleanupTestUser } = require('../../../__tests__/helpers/db');
const store = require('../../auth/pending-authorizations');
const delegation = require('../../auth/delegation');

const pool = createPool();

const IP = '203.0.113.7';

function rand(n = 16) {
  return crypto.randomBytes(n).toString('hex');
}

/**
 * Insert a pending-authorization row directly with column overrides so tests
 * can construct any state without going through the full flow.
 */
async function insertRow(overrides = {}) {
  const row = {
    handle_hash: rand(),
    user_code_hash: rand(),
    agent_name: 'Test Agent',
    state: 'pending',
    origin_ip: IP,
    expires_at: new Date(Date.now() + 600_000),
    ...overrides,
  };
  const cols = Object.keys(row);
  const vals = cols.map((_, i) => `$${i + 1}`);
  const result = await pool.query(
    `INSERT INTO mcp_pending_authorizations (${cols.join(', ')})
     VALUES (${vals.join(', ')}) RETURNING *`,
    cols.map((c) => row[c])
  );
  return result.rows[0];
}

describe('pending-authorizations store', () => {
  let userId;
  let delegationId;

  beforeAll(async () => {
    store.init(pool);
    delegation.init(pool);
    userId = await createTestUser(pool, 'pending-auth-store-test@example.com');
    const d = await delegation.createDelegation(userId, `mcp-login:store-test-${rand(4)}`, 'Test Agent', {
      scopes: ['documents:read', 'documents:write'],
    });
    delegationId = d.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM mcp_pending_authorizations');
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [userId]);
    await cleanupTestUser(pool, userId);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM mcp_pending_authorizations');
  });

  describe('create', () => {
    test('inserts and returns the row plus the plaintext code used', async () => {
      const { row, userCode } = await store.create({
        agentName: 'Creator',
        handleHash: rand(),
        originIp: IP,
        expiresAt: new Date(Date.now() + 600_000),
        generateCode: () => ({ userCode: 'WXYZ-BCDF', userCodeHash: rand() }),
      });
      expect(row.id).toBeDefined();
      expect(row.state).toBe('pending');
      expect(userCode).toBe('WXYZ-BCDF');
    });

    test('retries on an outstanding-code collision and succeeds with a new code', async () => {
      const collidingHash = rand();
      await insertRow({ user_code_hash: collidingHash });

      let attempt = 0;
      const { row, userCode } = await store.create({
        agentName: 'Retrier',
        handleHash: rand(),
        originIp: IP,
        expiresAt: new Date(Date.now() + 600_000),
        generateCode: () => {
          attempt += 1;
          // First attempt collides with the outstanding row; second is unique.
          return attempt === 1
            ? { userCode: 'AAAA-AAAA', userCodeHash: collidingHash }
            : { userCode: 'BBBB-CCCC', userCodeHash: rand() };
        },
      });
      expect(attempt).toBe(2);
      expect(userCode).toBe('BBBB-CCCC');
      expect(row.state).toBe('pending');
    });
  });

  describe('consumeCode', () => {
    test('binds the entering user once; a second consume of the same code fails', async () => {
      const codeHash = rand();
      await insertRow({ user_code_hash: codeHash });

      const first = await store.consumeCode(codeHash, userId);
      expect(first).not.toBeNull();
      expect(first.entered_by_user_id).toBe(userId);
      expect(first.code_entered_at).not.toBeNull();
      expect(first.state).toBe('pending');

      const second = await store.consumeCode(codeHash, userId);
      expect(second).toBeNull();
    });

    test('does not consume an expired pending row', async () => {
      const codeHash = rand();
      await insertRow({ user_code_hash: codeHash, expires_at: new Date(Date.now() - 1000) });
      expect(await store.consumeCode(codeHash, userId)).toBeNull();
    });
  });

  describe('approve', () => {
    test('approves a live pending row', async () => {
      const row = await insertRow();
      const approved = await store.approve(pool, row.id, userId, delegationId, 300);
      expect(approved).not.toBeNull();
      expect(approved.state).toBe('approved');
      expect(approved.approved_by_user_id).toBe(userId);
      expect(approved.delegation_id).toBe(delegationId);
      expect(new Date(approved.claim_expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    test('returns null (zero rows) when the authorization TTL has lapsed', async () => {
      const row = await insertRow({ expires_at: new Date(Date.now() - 1000) });
      expect(await store.approve(pool, row.id, userId, delegationId, 300)).toBeNull();
    });

    test('returns null on a non-pending row', async () => {
      const row = await insertRow({ state: 'denied' });
      expect(await store.approve(pool, row.id, userId, delegationId, 300)).toBeNull();
    });
  });

  describe('deny', () => {
    test('denies a pending row; a second deny returns null', async () => {
      const row = await insertRow();
      expect(await store.deny(row.id)).not.toBeNull();
      expect(await store.deny(row.id)).toBeNull();
    });

    test('returns null on an approved row', async () => {
      const row = await insertRow({ state: 'approved', claim_expires_at: new Date(Date.now() + 300_000) });
      expect(await store.deny(row.id)).toBeNull();
    });
  });

  describe('markPayloadDelivered', () => {
    test('delivers once; a second delivery returns null (one-shot)', async () => {
      const row = await insertRow({
        state: 'approved',
        delegation_id: delegationId,
        claim_expires_at: new Date(Date.now() + 300_000),
      });
      const first = await store.markPayloadDelivered(row.handle_hash);
      expect(first).not.toBeNull();
      expect(first.payload_delivered_at).not.toBeNull();
      expect(await store.markPayloadDelivered(row.handle_hash)).toBeNull();
    });
  });

  describe('claim (concurrent)', () => {
    test('exactly one of N parallel claims wins the row', async () => {
      const row = await insertRow({
        state: 'approved',
        delegation_id: delegationId,
        claim_expires_at: new Date(Date.now() + 300_000),
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.claim(pool, row.handle_hash, 'rest'))
      );
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0].state).toBe('claimed');
    });

    test('does not claim past the claim window', async () => {
      const row = await insertRow({
        state: 'approved',
        delegation_id: delegationId,
        claim_expires_at: new Date(Date.now() - 1000),
      });
      expect(await store.claim(pool, row.handle_hash, 'rest')).toBeNull();
    });
  });

  describe('lazy GC sweep', () => {
    test('expireLapsedApproved marks + returns lapsed approvals', async () => {
      const lapsed = await insertRow({
        state: 'approved',
        delegation_id: delegationId,
        claim_expires_at: new Date(Date.now() - 1000),
      });
      const live = await insertRow({
        state: 'approved',
        delegation_id: delegationId,
        claim_expires_at: new Date(Date.now() + 300_000),
      });
      const rows = await store.expireLapsedApproved();
      expect(rows.map((r) => r.id)).toContain(lapsed.id);
      expect(rows.map((r) => r.id)).not.toContain(live.id);
      expect(rows.find((r) => r.id === lapsed.id).delegation_id).toBe(delegationId);

      const after = await store.findById(lapsed.id);
      expect(after.state).toBe('expired');
    });

    test('expireLapsedPending expires stale pendings; deleteTerminalOlderThan prunes old terminals', async () => {
      const stale = await insertRow({ expires_at: new Date(Date.now() - 1000) });
      await store.expireLapsedPending();
      expect((await store.findById(stale.id)).state).toBe('expired');

      // A terminal row created "25 hours ago" is deleted; a fresh one is kept.
      const old = await insertRow({ state: 'denied' });
      await pool.query(
        "UPDATE mcp_pending_authorizations SET created_at = NOW() - interval '25 hours' WHERE id = $1",
        [old.id]
      );
      const fresh = await insertRow({ state: 'denied' });
      await store.deleteTerminalOlderThan(24);
      expect(await store.findById(old.id)).toBeNull();
      expect(await store.findById(fresh.id)).not.toBeNull();
    });
  });

  describe('count helpers', () => {
    test('countPendingByIp / countPendingGlobal ignore expired and terminal rows', async () => {
      await insertRow({ origin_ip: IP });
      await insertRow({ origin_ip: IP });
      await insertRow({ origin_ip: '198.51.100.9' });
      await insertRow({ origin_ip: IP, expires_at: new Date(Date.now() - 1000) }); // lapsed
      await insertRow({ origin_ip: IP, state: 'denied' }); // terminal

      expect(await store.countPendingByIp(IP)).toBe(2);
      expect(await store.countPendingGlobal()).toBe(3);
    });
  });

  describe('recordPoll (D8)', () => {
    test('first poll is compliant; an immediate second poll is premature and raises the interval', async () => {
      const row = await insertRow();
      const first = await store.recordPoll(row.handle_hash, 5);
      expect(first.premature).toBe(false);
      expect(first.requiredInterval).toBe(5);

      const second = await store.recordPoll(row.handle_hash, 5);
      expect(second.premature).toBe(true);
      expect(second.requiredInterval).toBe(10);

      const third = await store.recordPoll(row.handle_hash, 5);
      expect(third.premature).toBe(true);
      expect(third.requiredInterval).toBe(15);
    });

    test('returns null for an unknown handle', async () => {
      expect(await store.recordPoll(rand(), 5)).toBeNull();
    });
  });
});
