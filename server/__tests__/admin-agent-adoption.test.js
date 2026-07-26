/**
 * Feature 036 — GET /api/admin/users/:userId/adoption.
 *
 * The endpoint is the entire server side of the feature, and it reads three
 * tables that carry secret material (agent_delegations.refresh_token_hash,
 * mcp_api_tokens.token_hash, registered_agents.client_secret_hash) plus an
 * activity log whose metadata column holds tool arguments verbatim. So the
 * suite is organised around what could actually go wrong:
 *
 *   (a) correctness against known seeded state — lifetime listing with
 *       active/revoked/expired labels, the registered-name fallback, the mint
 *       path, the onboarding fields, the activity summary and the empty states;
 *   (b) the exposure boundary — no secret material in the payload, and the
 *       admin gate proven NON-VACUOUSLY by mounting the real requireAdmin
 *       middleware exactly as server/index.js does. Mounting admin.router bare
 *       would let a non-admin through and make the 403 assertion meaningless;
 *   (c) read-only-ness — the surface exposes no mutation verb, and reading it
 *       repeatedly writes nothing.
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { createPool } = require('./helpers/db');

// Set test secrets before requiring auth modules.
process.env.ACCESS_TOKEN_SECRET = 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

const admin = require('../api/admin');
const appSettings = require('../api/app-settings');
const aiUsage = require('../ai-usage');
const users = require('../auth/users');
const { generateAccessToken } = require('../auth/jwt');
const { requireAdmin } = require('../auth/middleware');

const EMAIL_SUFFIX = '@admin-adoption.test.example.com';
const REGISTERED_AGENT_ID = `test-registered-agent-${crypto.randomUUID().slice(0, 8)}`;

describe('Feature 036: per-user adoption detail', () => {
  let app;
  let pool;
  let adminToken;
  let regularToken;

  // The richly-seeded subject of most assertions.
  let connectedUser;
  let welcomeDocId;
  let activeDelegationId;

  // Foils: a user with nothing, and one whose only doc is the welcome doc.
  let untouchedUser;
  let welcomeOnlyUser;

  const mkUser = async (label) => users.findOrCreateUser({
    googleId: `${label}-${crypto.randomUUID()}`,
    email: `${label}-${crypto.randomUUID()}${EMAIL_SUFFIX}`,
    name: `${label} User`,
    picture: null,
  });

  const mkDoc = async (ownerId, title) => {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO documents (id, creator_id, title) VALUES ($1, $2, $3)', [id, ownerId, title]);
    await pool.query(
      "INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')",
      [id, ownerId]
    );
    return id;
  };

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    admin.init(pool);
    aiUsage.init(pool);
    await appSettings.init(pool);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    // The production mounting, gate included (server/index.js).
    app.use('/api/admin', requireAdmin, admin.router);

    const adminUser = await mkUser('admin');
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [adminUser.id]);
    adminToken = generateAccessToken(await users.findById(adminUser.id));

    regularToken = generateAccessToken(await mkUser('regular'));

    connectedUser = await mkUser('connected');
    untouchedUser = await mkUser('untouched');
    welcomeOnlyUser = await mkUser('welcomeonly');

    // A registered client, so one delegation can prove the catalog name wins.
    await pool.query(
      `INSERT INTO registered_agents (id, name, description, client_secret_hash)
       VALUES ($1, 'Registered Display Name', 'seeded by the 036 suite', 'secret-hash-must-never-surface')`,
      [REGISTERED_AGENT_ID]
    );

    // Three delegations: one active+registered, one revoked, one expired and
    // unregistered (so the self-reported name has to carry it).
    const del = async (agentId, agentName, clientId, extra) => {
      const { rows } = await pool.query(
        `INSERT INTO agent_delegations
           (user_id, agent_id, agent_name, agent_client_id, scopes, refresh_token_hash,
            created_at, last_used_at, revoked_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'refresh-hash-must-never-surface',
                 $6, $7, $8, $9)
         RETURNING id`,
        [connectedUser.id, agentId, agentName, clientId,
          ['documents:read', 'documents:write'],
          extra.createdAt, extra.lastUsedAt || null, extra.revokedAt || null, extra.expiresAt || null],
      );
      return rows[0].id;
    };

    activeDelegationId = await del(
      'agent-active', 'Self Reported Active', REGISTERED_AGENT_ID,
      { createdAt: '2026-01-02T00:00:00Z', lastUsedAt: '2026-07-20T00:00:00Z' },
    );
    await del(
      'agent-revoked', 'Revoked Agent', null,
      { createdAt: '2026-02-02T00:00:00Z', revokedAt: '2026-03-03T00:00:00Z' },
    );
    await del(
      'agent-expired', 'Expired Agent', null,
      { createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-02-01T00:00:00Z' },
    );

    // Five tokens covering both mint paths and all three states.
    const tok = async (name, prefix, extra) => {
      const { rows } = await pool.query(
        `INSERT INTO mcp_api_tokens
           (user_id, name, token_prefix, token_hash, scopes, created_at, last_used_at,
            revoked_at, expires_at, minted_by_delegation_id, minted_by_api_token_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [connectedUser.id, name, prefix, `hash-must-never-surface-${crypto.randomUUID()}`,
          ['documents:read'], extra.createdAt, extra.lastUsedAt || null,
          extra.revokedAt || null, extra.expiresAt || null,
          extra.mintedByDelegation || null, extra.mintedByToken || null],
      );
      return rows[0].id;
    };

    const interactiveTokenId = await tok('Interactive token', 'sk_sqd_aaa', {
      createdAt: '2026-04-01T00:00:00Z', lastUsedAt: '2026-07-25T00:00:00Z',
    });
    await tok('Delegation-minted token', 'sk_sqd_bbb', {
      createdAt: '2026-04-02T00:00:00Z', mintedByDelegation: activeDelegationId,
    });
    await tok('Token-minted token', 'sk_sqd_ccc', {
      createdAt: '2026-04-03T00:00:00Z', mintedByToken: interactiveTokenId,
    });
    await tok('Revoked token', 'sk_sqd_ddd', {
      createdAt: '2026-04-04T00:00:00Z', revokedAt: '2026-05-05T00:00:00Z',
    });
    await tok('Expired token', 'sk_sqd_eee', {
      createdAt: '2026-04-05T00:00:00Z', expiresAt: '2026-05-01T00:00:00Z',
    });

    // Onboarding: a welcome doc plus a real one, onboarded, welcome email sent,
    // and an agent-OAuth signup source.
    welcomeDocId = await mkDoc(connectedUser.id, 'Welcome to Squire Docs');
    await mkDoc(connectedUser.id, 'A real document');
    await pool.query(
      `UPDATE users SET welcome_doc_id = $2, onboarded_at = '2026-01-05T00:00:00Z',
              welcome_email_sent_at = '2026-01-06T00:00:00Z', signup_source = 'agent_oauth'
       WHERE id = $1`,
      [connectedUser.id, welcomeDocId]
    );

    // Two logged agent actions. metadata carries content deliberately, to prove
    // the response never echoes it.
    for (const [action, at] of [['tool:read_document', '2026-07-01T00:00:00Z'],
      ['tool:modify', '2026-07-24T12:00:00Z']]) {
      await pool.query(
        `INSERT INTO agent_activity_log (delegation_id, agent_id, user_id, action, metadata, created_at)
         VALUES ($1, 'agent-active', $2, $3, $4, $5)`,
        [activeDelegationId, connectedUser.id, action,
          JSON.stringify({ args: { secretUserContent: 'must-never-surface' } }), at],
      );
    }

    // The welcome-only user owns exactly the seeded welcome doc.
    const woDoc = await mkDoc(welcomeOnlyUser.id, 'Welcome to Squire Docs');
    await pool.query('UPDATE users SET welcome_doc_id = $2 WHERE id = $1', [welcomeOnlyUser.id, woDoc]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE email LIKE '%${EMAIL_SUFFIX}'`);
    await pool.query('DELETE FROM registered_agents WHERE id = $1', [REGISTERED_AGENT_ID]);
    await pool.end();
  });

  const getAdoption = (userId, token = adminToken) =>
    request(app).get(`/api/admin/users/${userId}/adoption`).set('Authorization', `Bearer ${token}`);

  describe('delegations (FR-001, FR-003, FR-004)', () => {
    let delegations;

    beforeAll(async () => {
      const res = await getAdoption(connectedUser.id);
      expect(res.status).toBe(200);
      delegations = res.body.delegations;
    });

    const byName = (name) => delegations.find((d) => d.agentName === name);

    test('lists every delegation ever created, not just the live one', () => {
      expect(delegations).toHaveLength(3);
      expect(delegations.map((d) => d.agentName).sort())
        .toEqual(['Expired Agent', 'Registered Display Name', 'Revoked Agent']);
    });

    test('labels active, revoked and expired distinctly', () => {
      expect(byName('Registered Display Name').state).toBe('active');
      expect(byName('Revoked Agent').state).toBe('revoked');
      // Seeded with expires_at in the past and revoked_at NULL, so `expired` is
      // exercised on a delegation and not only on a token.
      expect(byName('Expired Agent').state).toBe('expired');
    });

    test('the registered-catalog name wins over the self-reported one', () => {
      const active = byName('Registered Display Name');
      expect(active.agentClientId).toBe(REGISTERED_AGENT_ID);
    });

    test('an unregistered delegation falls back to its self-reported name, never blank', () => {
      // agentClientId null is what makes the fallback visible in the UI.
      expect(byName('Revoked Agent').agentClientId).toBeNull();
    });

    test('carries scopes and the lifetime timestamps', () => {
      const active = byName('Registered Display Name');
      expect(active.scopes).toEqual(['documents:read', 'documents:write']);
      expect(new Date(active.createdAt).toISOString()).toBe('2026-01-02T00:00:00.000Z');
      expect(new Date(active.lastUsedAt).toISOString()).toBe('2026-07-20T00:00:00.000Z');
    });

    test('orders newest-first by created_at', () => {
      const created = delegations.map((d) => new Date(d.createdAt).getTime());
      expect(created).toEqual([...created].sort((a, b) => b - a));
    });
  });

  describe('API tokens (FR-002, FR-003)', () => {
    let tokens;

    beforeAll(async () => {
      const res = await getAdoption(connectedUser.id);
      tokens = res.body.tokens;
    });

    test('lists every token ever minted, with its state', () => {
      expect(tokens).toHaveLength(5);
      const byName = Object.fromEntries(tokens.map((t) => [t.name, t.state]));
      expect(byName['Interactive token']).toBe('active');
      expect(byName['Revoked token']).toBe('revoked');
      expect(byName['Expired token']).toBe('expired');
    });

    test('a token minted by a delegation AND one minted by a token both read as agent-minted', () => {
      const byName = Object.fromEntries(tokens.map((t) => [t.name, t.mintedBy]));
      expect(byName['Delegation-minted token']).toBe('agent');
      expect(byName['Token-minted token']).toBe('agent');
    });

    test('ships the mint-parent ids so a minted token correlates with its minter', () => {
      const fromDelegation = tokens.find((t) => t.name === 'Delegation-minted token');
      expect(fromDelegation.mintedByDelegationId).toBe(activeDelegationId);
      expect(fromDelegation.mintedByApiTokenId).toBeNull();

      const fromToken = tokens.find((t) => t.name === 'Token-minted token');
      expect(fromToken.mintedByApiTokenId)
        .toBe(tokens.find((t) => t.name === 'Interactive token').id);
      expect(fromToken.mintedByDelegationId).toBeNull();
    });

    test('orders newest-first by created_at', () => {
      const created = tokens.map((t) => new Date(t.createdAt).getTime());
      expect(created).toEqual([...created].sort((a, b) => b - a));
    });

    test('a token with no mint parent reads as interactively minted', () => {
      expect(tokens.find((t) => t.name === 'Interactive token').mintedBy).toBe('interactive');
    });

    test('identifies tokens by display name and non-secret prefix only', () => {
      const t = tokens.find((t) => t.name === 'Interactive token');
      expect(t.tokenPrefix).toBe('sk_sqd_aaa');
      expect(t.scopes).toEqual(['documents:read']);
      expect(new Date(t.lastUsedAt).toISOString()).toBe('2026-07-25T00:00:00.000Z');
    });
  });

  describe('onboarding state (FR-005)', () => {
    test('reports signup source/time, onboarding, real-doc authorship and welcome email', async () => {
      const res = await getAdoption(connectedUser.id);
      const o = res.body.onboarding;

      expect(o.signupSource).toBe('agent_oauth');
      expect(o.createdAt).toBeTruthy();
      expect(new Date(o.onboardedAt).toISOString()).toBe('2026-01-05T00:00:00.000Z');
      expect(o.authoredNonWelcomeDoc).toBe(true);
      expect(new Date(o.welcomeEmailSentAt).toISOString()).toBe('2026-01-06T00:00:00.000Z');
    });

    test('a user whose only doc is the seeded welcome doc has authored no real document', async () => {
      const res = await getAdoption(welcomeOnlyUser.id);
      expect(res.body.onboarding.authoredNonWelcomeDoc).toBe(false);
    });

    test('a fresh account reports not-yet-onboarded rather than erroring', async () => {
      const res = await getAdoption(untouchedUser.id);
      expect(res.status).toBe(200);
      expect(res.body.onboarding.onboardedAt).toBeNull();
      expect(res.body.onboarding.welcomeEmailSentAt).toBeNull();
      expect(res.body.onboarding.authoredNonWelcomeDoc).toBe(false);
      expect(res.body.onboarding.signupSource).toBe('browser');
    });
  });

  describe('activity summary (FR-006)', () => {
    test('reports the all-time count and the most recent timestamp', async () => {
      const res = await getAdoption(connectedUser.id);
      expect(res.body.activity.count).toBe(2);
      expect(new Date(res.body.activity.lastActivityAt).toISOString())
        .toBe('2026-07-24T12:00:00.000Z');
    });

    test('a user with no logged activity reports zero and null, not an error', async () => {
      const res = await getAdoption(untouchedUser.id);
      expect(res.status).toBe(200);
      expect(res.body.activity.count).toBe(0);
      expect(res.body.activity.lastActivityAt).toBeNull();
    });

    test('never echoes the activity log metadata, which holds tool arguments', async () => {
      const res = await getAdoption(connectedUser.id);
      expect(JSON.stringify(res.body)).not.toContain('must-never-surface');
      expect(JSON.stringify(res.body)).not.toContain('secretUserContent');
      expect(res.body.activity.metadata).toBeUndefined();
    });
  });

  describe('empty state (FR-012)', () => {
    test('a user who never connected anything gets empty lists, not an error', async () => {
      const res = await getAdoption(untouchedUser.id);
      expect(res.status).toBe(200);
      expect(res.body.delegations).toEqual([]);
      expect(res.body.tokens).toEqual([]);
    });
  });

  describe('secret material (FR-009, SC-003, US3 acceptance 1)', () => {
    test('no hash of any kind appears anywhere in the payload', async () => {
      const res = await getAdoption(connectedUser.id);
      const body = JSON.stringify(res.body);

      // The three seeded secrets, by value.
      expect(body).not.toContain('refresh-hash-must-never-surface');
      expect(body).not.toContain('hash-must-never-surface');
      expect(body).not.toContain('secret-hash-must-never-surface');

      // ...and by field name, so a future rename can't quietly reintroduce one.
      for (const field of ['token_hash', 'tokenHash', 'refresh_token_hash', 'refreshTokenHash',
        'client_secret_hash', 'clientSecretHash', 'metadata', 'agent_metadata', 'agentMetadata']) {
        expect(body).not.toContain(field);
      }
    });

    test('no 64-character hex string appears — the catch-all for a column added later', async () => {
      const res = await getAdoption(connectedUser.id);
      // Every hash on these tables is a varchar(64) SHA-256 hex digest, so this
      // fires even for a secret column that does not exist yet.
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/i);
    });

    test('no full sk_sqd_ token value appears — only the stored prefix', async () => {
      const res = await getAdoption(connectedUser.id);
      // Prefixes are varchar(12); anything materially longer is a token body.
      for (const match of JSON.stringify(res.body).matchAll(/sk_sqd_[A-Za-z0-9_-]*/g)) {
        expect(match[0].length).toBeLessThanOrEqual(12);
      }
    });

    test('token objects expose exactly the non-secret identification fields', async () => {
      const res = await getAdoption(connectedUser.id);
      for (const t of res.body.tokens) {
        expect(Object.keys(t).sort()).toEqual([
          'createdAt', 'expiresAt', 'id', 'lastUsedAt', 'mintedBy',
          'mintedByApiTokenId', 'mintedByDelegationId',
          'name', 'revokedAt', 'scopes', 'state', 'tokenPrefix',
        ]);
      }
    });

    test('delegation objects expose exactly the non-secret fields', async () => {
      const res = await getAdoption(connectedUser.id);
      for (const d of res.body.delegations) {
        expect(Object.keys(d).sort()).toEqual([
          'agentClientId', 'agentName', 'createdAt', 'expiresAt', 'id',
          'lastUsedAt', 'revokedAt', 'scopes', 'state',
        ]);
      }
    });
  });

  describe('admin gate (FR-008, US1 acceptance 5)', () => {
    // Mounted behind the REAL requireAdmin, so these are not vacuous.
    test('a signed-in non-admin gets 403 and no adoption data', async () => {
      const res = await getAdoption(connectedUser.id, regularToken);
      expect(res.status).toBe(403);
      expect(res.body.delegations).toBeUndefined();
      expect(res.body.tokens).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('sk_sqd_');
    });

    test('an unauthenticated caller gets 401 and no adoption data', async () => {
      const res = await request(app).get(`/api/admin/users/${connectedUser.id}/adoption`);
      expect(res.status).toBe(401);
      expect(res.body.delegations).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('sk_sqd_');
    });

    test('the gate is genuinely engaged — the admin reaches the same URL', async () => {
      // Without this, a 403 could come from a broken route rather than the gate.
      const res = await getAdoption(connectedUser.id);
      expect(res.status).toBe(200);
    });
  });

  describe('read-only by construction (FR-010, FR-011, SC-004)', () => {
    test('an unknown user id is a 404, not an empty success', async () => {
      const res = await getAdoption(crypto.randomUUID());
      expect(res.status).toBe(404);
    });

    test('a malformed user id is a 404, not a 500', async () => {
      const res = await getAdoption('not-a-uuid');
      expect(res.status).toBe(404);
    });

    test('the adoption path offers no mutation verb', async () => {
      const url = `/api/admin/users/${connectedUser.id}/adoption`;
      for (const verb of ['post', 'put', 'patch', 'delete']) {
        const res = await request(app)[verb](url).set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(404);
      }
    });

    test('repeated reads write nothing to the underlying tables', async () => {
      const snapshot = async () => {
        const { rows } = await pool.query(
          `SELECT
             (SELECT COUNT(*) FROM agent_delegations WHERE user_id = $1) AS delegations,
             (SELECT COUNT(*) FROM mcp_api_tokens WHERE user_id = $1) AS tokens,
             (SELECT COUNT(*) FROM agent_activity_log WHERE user_id = $1) AS activity,
             (SELECT MAX(last_used_at) FROM agent_delegations WHERE user_id = $1) AS del_last_used,
             (SELECT MAX(last_used_at) FROM mcp_api_tokens WHERE user_id = $1) AS tok_last_used,
             (SELECT onboarded_at FROM users WHERE id = $1) AS onboarded_at`,
          [connectedUser.id]
        );
        return rows[0];
      };

      const before = await snapshot();
      await getAdoption(connectedUser.id);
      await getAdoption(connectedUser.id);
      await getAdoption(connectedUser.id);
      const after = await snapshot();

      expect(after).toEqual(before);
    });
  });
});
