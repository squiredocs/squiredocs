/**
 * Agent delegation tests
 *
 * Tests the agent delegation module which manages OAuth-style delegations
 * allowing AI agents to act on behalf of users.
 */
const { createPool, createTestUser, cleanupTestUser } = require('../../../__tests__/helpers/db');
const delegation = require('../../auth/delegation');

// Create shared pool for this test suite
const pool = createPool();

describe('Agent Delegation Module', () => {
  let testUserId;

  beforeAll(async () => {
    // Initialize the delegation module with the pool
    delegation.init(pool);

    // Create a test user using shared helper
    testUserId = await createTestUser(pool, 'delegation-test@example.com');
  });

  afterAll(async () => {
    // Clean up test data using shared helper
    await cleanupTestUser(pool, testUserId);
    await pool.end();
  });

  beforeEach(async () => {
    // Clean delegations before each test
    await pool.query('DELETE FROM agent_activity_log WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [testUserId]);
  });

  describe('createDelegation', () => {
    test('creates a new delegation with default scopes', async () => {
      const result = await delegation.createDelegation(
        testUserId,
        'claude-code:test123',
        'Claude Code'
      );

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.user_id).toBe(testUserId);
      expect(result.agent_id).toBe('claude-code:test123');
      expect(result.agent_name).toBe('Claude Code');
      expect(result.scopes).toContain('documents:read');
      expect(result.scopes).toContain('documents:write');
      expect(result.revoked_at).toBeNull();
    });

    test('creates a delegation with custom scopes', async () => {
      const customScopes = ['documents:read'];

      const result = await delegation.createDelegation(
        testUserId,
        'claude-code:readonly',
        'Claude Code (Read Only)',
        { scopes: customScopes }
      );

      expect(result.scopes).toEqual(customScopes);
      expect(result.scopes).not.toContain('documents:write');
    });

    test('creates a delegation with expiration', async () => {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

      const result = await delegation.createDelegation(
        testUserId,
        'claude-code:expiring',
        'Claude Code (Expiring)',
        { expiresAt }
      );

      expect(result.expires_at).toBeDefined();
      expect(new Date(result.expires_at).getTime()).toBeCloseTo(expiresAt.getTime(), -3);
    });

    test('creates a delegation with metadata', async () => {
      const metadata = { version: '1.0', capabilities: ['edit', 'watch'] };

      const result = await delegation.createDelegation(
        testUserId,
        'claude-code:with-meta',
        'Claude Code',
        { metadata }
      );

      expect(result.agent_metadata).toEqual(metadata);
    });

    test('updates existing delegation for same user-agent pair', async () => {
      // Create first delegation
      const first = await delegation.createDelegation(
        testUserId,
        'claude-code:update-test',
        'Claude Code v1'
      );

      // Create second delegation with same agent_id - should update
      const second = await delegation.createDelegation(
        testUserId,
        'claude-code:update-test',
        'Claude Code v2',
        { scopes: ['documents:read'] }
      );

      expect(second.id).toBe(first.id);
      expect(second.agent_name).toBe('Claude Code v2');
      expect(second.scopes).toEqual(['documents:read']);
    });
  });

  describe('getDelegation', () => {
    test('retrieves an existing delegation by ID', async () => {
      const created = await delegation.createDelegation(
        testUserId,
        'claude-code:get-test',
        'Claude Code'
      );

      const result = await delegation.getDelegation(created.id);

      expect(result).toBeDefined();
      expect(result.id).toBe(created.id);
      expect(result.agent_id).toBe('claude-code:get-test');
    });

    test('returns null for non-existent delegation', async () => {
      const result = await delegation.getDelegation('00000000-0000-0000-0000-000000000000');

      expect(result).toBeNull();
    });
  });

  describe('getActiveDelegation', () => {
    test('retrieves active delegation for user-agent pair', async () => {
      await delegation.createDelegation(
        testUserId,
        'claude-code:active-test',
        'Claude Code'
      );

      const result = await delegation.getActiveDelegation(testUserId, 'claude-code:active-test');

      expect(result).toBeDefined();
      expect(result.agent_id).toBe('claude-code:active-test');
      expect(result.revoked_at).toBeNull();
    });

    test('returns null for revoked delegation', async () => {
      const created = await delegation.createDelegation(
        testUserId,
        'claude-code:revoked-test',
        'Claude Code'
      );

      await delegation.revokeDelegation(created.id);

      const result = await delegation.getActiveDelegation(testUserId, 'claude-code:revoked-test');

      expect(result).toBeNull();
    });

    test('returns null for expired delegation', async () => {
      // Create delegation that expired in the past
      await pool.query(
        `INSERT INTO agent_delegations (user_id, agent_id, agent_name, expires_at)
         VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour')`,
        [testUserId, 'claude-code:expired-test', 'Claude Code']
      );

      const result = await delegation.getActiveDelegation(testUserId, 'claude-code:expired-test');

      expect(result).toBeNull();
    });

    test('returns null for non-existent delegation', async () => {
      const result = await delegation.getActiveDelegation(testUserId, 'nonexistent-agent');

      expect(result).toBeNull();
    });
  });

  describe('checkDelegation', () => {
    test('returns valid for active delegation with required scope', async () => {
      const created = await delegation.createDelegation(
        testUserId,
        'claude-code:check-test',
        'Claude Code',
        { scopes: ['documents:read', 'documents:write'] }
      );

      const result = await delegation.checkDelegation(created.id, 'documents:read');

      expect(result.isValid).toBe(true);
      expect(result.delegation).toBeDefined();
      expect(result.reason).toBeUndefined();
    });

    test('returns invalid when scope not granted', async () => {
      const created = await delegation.createDelegation(
        testUserId,
        'claude-code:scope-test',
        'Claude Code',
        { scopes: ['documents:read'] }
      );

      const result = await delegation.checkDelegation(created.id, 'documents:write');

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('scope');
    });

    test('returns invalid for revoked delegation', async () => {
      const created = await delegation.createDelegation(
        testUserId,
        'claude-code:revoke-check',
        'Claude Code'
      );

      await delegation.revokeDelegation(created.id);

      const result = await delegation.checkDelegation(created.id, 'documents:read');

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('revoked');
    });

    test('returns invalid for expired delegation', async () => {
      // Create delegation that expired
      const insertResult = await pool.query(
        `INSERT INTO agent_delegations (user_id, agent_id, agent_name, expires_at)
         VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour')
         RETURNING id`,
        [testUserId, 'claude-code:expire-check', 'Claude Code']
      );

      const result = await delegation.checkDelegation(
        insertResult.rows[0].id,
        'documents:read'
      );

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('expired');
    });

    test('returns invalid for non-existent delegation', async () => {
      const result = await delegation.checkDelegation(
        '00000000-0000-0000-0000-000000000000',
        'documents:read'
      );

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('not found');
    });
  });

  describe('revokeDelegation', () => {
    test('revokes an active delegation', async () => {
      const created = await delegation.createDelegation(
        testUserId,
        'claude-code:to-revoke',
        'Claude Code'
      );

      const result = await delegation.revokeDelegation(created.id);

      expect(result).toBe(true);

      // Verify revoked
      const check = await delegation.getDelegation(created.id);
      expect(check.revoked_at).not.toBeNull();
    });

    test('returns false for non-existent delegation', async () => {
      const result = await delegation.revokeDelegation('00000000-0000-0000-0000-000000000000');

      expect(result).toBe(false);
    });

    test('revoke is idempotent', async () => {
      const created = await delegation.createDelegation(
        testUserId,
        'claude-code:double-revoke',
        'Claude Code'
      );

      await delegation.revokeDelegation(created.id);
      const result = await delegation.revokeDelegation(created.id);

      // Should succeed (or return true) even if already revoked
      expect(result).toBe(true);
    });
  });

  describe('listUserDelegations', () => {
    test('lists all delegations for a user', async () => {
      await delegation.createDelegation(testUserId, 'agent-1', 'Agent 1');
      await delegation.createDelegation(testUserId, 'agent-2', 'Agent 2');

      const result = await delegation.listUserDelegations(testUserId);

      expect(result).toHaveLength(2);
      expect(result.map((d) => d.agent_id)).toContain('agent-1');
      expect(result.map((d) => d.agent_id)).toContain('agent-2');
    });

    test('lists only active delegations by default', async () => {
      await delegation.createDelegation(testUserId, 'active-agent', 'Active');
      const toRevoke = await delegation.createDelegation(testUserId, 'revoked-agent', 'Revoked');
      await delegation.revokeDelegation(toRevoke.id);

      const result = await delegation.listUserDelegations(testUserId);

      expect(result).toHaveLength(1);
      expect(result[0].agent_id).toBe('active-agent');
    });

    test('includes revoked delegations when requested', async () => {
      await delegation.createDelegation(testUserId, 'active-agent-2', 'Active');
      const toRevoke = await delegation.createDelegation(testUserId, 'revoked-agent-2', 'Revoked');
      await delegation.revokeDelegation(toRevoke.id);

      const result = await delegation.listUserDelegations(testUserId, { includeRevoked: true });

      expect(result).toHaveLength(2);
    });

    test('returns empty array for user with no delegations', async () => {
      const result = await delegation.listUserDelegations('00000000-0000-0000-0000-000000000000');

      expect(result).toEqual([]);
    });

    // These rows are serialised straight to the user by
    // GET /mcp/auth/delegations/:userId, so a `SELECT *` here put a
    // password-equivalent refresh-token hash in an API response. Assert on the
    // shape, not just the one column, so a future column added to the table is
    // non-public until someone deliberately names it in the query.
    test('never returns secret material', async () => {
      await delegation.createDelegation(testUserId, 'secret-check', 'Secret Check');

      const [row] = await delegation.listUserDelegations(testUserId);

      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('refresh_token_hash');
      for (const key of Object.keys(row)) {
        expect(key).not.toMatch(/hash|secret|token_hash/i);
      }
    });
  });

  describe('updateLastUsed', () => {
    test('updates last_used_at timestamp', async () => {
      const created = await delegation.createDelegation(
        testUserId,
        'claude-code:last-used',
        'Claude Code'
      );

      expect(created.last_used_at).toBeNull();

      await delegation.updateLastUsed(created.id);

      const updated = await delegation.getDelegation(created.id);
      expect(updated.last_used_at).not.toBeNull();
    });
  });

  describe('logAgentAction', () => {
    test('logs an agent action', async () => {
      const created = await delegation.createDelegation(
        testUserId,
        'claude-code:log-test',
        'Claude Code'
      );

      await delegation.logAgentAction(created.id, 'document:read', {
        metadata: { size: 1024 },
      });

      // Verify log was created
      const result = await pool.query(
        'SELECT * FROM agent_activity_log WHERE delegation_id = $1',
        [created.id]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].action).toBe('document:read');
      expect(result.rows[0].user_id).toBe(testUserId);
      expect(result.rows[0].doc_guid).toBeNull();
    });

    test('logs an agent action with document reference', async () => {
      // Create a document for the test
      const docResult = await pool.query(
        `INSERT INTO documents (id, creator_id)
         VALUES (uuid_generate_v4(), $1)
         RETURNING id`,
        [testUserId]
      );
      const docId = docResult.rows[0].id;

      const created = await delegation.createDelegation(
        testUserId,
        'claude-code:log-doc-test',
        'Claude Code'
      );

      await delegation.logAgentAction(created.id, 'document:update', {
        docGuid: docId,
        metadata: { operations: 3 },
      });

      // Verify log was created with doc reference
      const result = await pool.query(
        'SELECT * FROM agent_activity_log WHERE delegation_id = $1',
        [created.id]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].action).toBe('document:update');
      expect(result.rows[0].doc_guid).toBe(docId);

      // Clean up document
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    });
  });
});
