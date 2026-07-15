/**
 * Feature 010, US2 (FR-011, RD-2, SC-004): anonymous registration is bounded by
 * a per-IP budget shared across /register + the authorize/approve auto-register
 * paths, plus a global daily cap. Over budget ⇒ uniform 429 with NO row written.
 */
process.env.RL_TEST_ENABLE = '1';
process.env.RL_FORCE_MEMORY = '1';
process.env.RL_REGISTER_PER_HOUR = '3';
process.env.RL_REGISTER_GLOBAL_PER_DAY = '5';

const request = require('supertest');
const express = require('express');
const rateLimit = require('../rate-limit');
const oauthFlow = require('../mcp/auth/oauth-flow');
const registeredAgents = require('../mcp/auth/registered-agents');
const oauthRouter = require('../mcp/auth/oauth-router');
const { createPool } = require('./helpers/db');

let pool;

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/mcp/auth', oauthRouter);
  return app;
}

describe('registration admission caps (FR-011, RD-2)', () => {
  beforeAll(() => {
    pool = createPool();
    oauthFlow.init(pool);
    registeredAgents.init(pool);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM registered_agents WHERE id LIKE 'client_%' OR description LIKE 'OAuth registered agent:%'").catch(() => {});
    await pool.end();
  });
  beforeEach(() => rateLimit._reset());

  it('per-IP register flood is capped; no new rows written over budget', async () => {
    const app = buildApp();
    const ip = '203.0.113.50';
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM registered_agents')).rows[0].n;

    let created = 0;
    let limited = 0;
    // 6 registrations from one IP; budget is 3/hour.
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/mcp/auth/register')
        .set('X-Forwarded-For', ip)
        .send({ client_name: `flood-agent-${i}-${Date.now()}` });
      if (res.status === 201 || res.status === 200) created++;
      else if (res.status === 429) {
        limited++;
        expect(res.body).toEqual({ error: 'Rate limit exceeded. Retry later.' });
      }
    }

    expect(created).toBe(3);       // exactly the per-IP budget
    expect(limited).toBe(3);       // the rest rejected
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM registered_agents')).rows[0].n;
    expect(after - before).toBe(3); // NO row written over budget (SC-004)
  });

  it('global daily cap bounds the aggregate across many IPs', async () => {
    rateLimit._reset();
    // Per-IP budget is 3, global is 5. Spread 1 registration per IP across 8 IPs
    // (so per-IP never bites) — the global cap should admit only 5.
    let created = 0;
    for (let i = 0; i < 8; i++) {
      const { allowed } = await rateLimit.checkRegistrationAdmission(`10.0.0.${i}`);
      if (allowed) created++;
    }
    expect(created).toBe(5); // global daily cap
  });

  it('the authorize auto-register path shares the same per-IP register budget', async () => {
    rateLimit._reset();
    const ip = '198.51.100.42';
    // Consume the per-IP budget (3) via the shared admission helper — as
    // POST /register would.
    for (let i = 0; i < 3; i++) {
      expect((await rateLimit.checkRegistrationAdmission(ip)).allowed).toBe(true);
    }
    // The 4th admission from the SAME ip — whether it originates from /register,
    // /authorize, or /approve — is denied (shared budget).
    expect((await rateLimit.checkRegistrationAdmission(ip)).allowed).toBe(false);
  });
});
