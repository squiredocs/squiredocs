/**
 * nextSteps block (feature 009, US3 / T013): the approved payload teaches the
 * next step, identically across all four delivery sites (tool approved, REST
 * approved, tool inline, REST inline), carries no secrets, and never rides the
 * raw byte claim channel.
 *
 * Contract: specs/009-rest-login-api/contracts/next-steps-block.md.
 * Serial DB; deterministic in-memory rate-limit counter.
 */
process.env.LOGIN_RATE_LIMIT_FORCE_MEMORY = '1';

const express = require('express');
const request = require('supertest');
const { createPool, createPersistence } = require('./helpers/db');
const { createLoginRouter } = require('../api/login');
const { createLoginClaimRouter } = require('../api/mcp-login-claim');
const loginStatusTool = require('../mcp/tools/login-status');
const loginService = require('../mcp/auth/login-service');
const delegation = require('../mcp/auth/delegation');
const apiTokens = require('../mcp/auth/api-tokens');
const rateLimit = require('../mcp/auth/rate-limit');

const pool = createPool();
const persistence = createPersistence();

const BASE = 'https://squiredocs.com';
const TOOL_CTX = { isAnonymous: true, baseUrl: BASE, clientIp: '198.51.100.9' };

// A bare `claude mcp add … /mcp` (no --header) must appear in NO payload — this
// matches an add command whose /mcp is NOT followed by --header before the
// string ends. The credentialed form has ` --header` right after /mcp, so it is
// not flagged.
const BARE_ADD = /claude mcp add[^"\\]*\/mcp(?![^"\\]*--header)/;

describe('nextSteps block across all delivery sites', () => {
  let app;
  let userId;

  beforeAll(async () => {
    loginService.init(pool);
    delegation.init(pool);
    apiTokens.init(pool);
    const u = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('nextsteps-test', 'nextsteps@example.com', 'NextSteps User', NULL)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`
    );
    userId = u.rows[0].id;

    app = express();
    app.set('trust proxy', true);
    app.use(createLoginRouter(persistence));
    app.use(createLoginClaimRouter(persistence));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM mcp_pending_authorizations');
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await persistence.destroy();
    await pool.end();
  });

  beforeEach(async () => {
    rateLimit._reset();
    await pool.query('DELETE FROM mcp_pending_authorizations');
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [userId]);
  });

  // Create + approve a fresh pairing; returns its handle (one-shot per site).
  async function approvedHandle(agentName) {
    const started = await request(app)
      .post('/api/login/start')
      .set('X-Forwarded-For', '198.51.100.9')
      .send({ agentName });
    const entered = await loginService.enterCode(started.body.userCode, userId);
    const approved = await loginService.approveAuthorization(entered.authorizationId, userId);
    expect(approved.status).toBe('approved');
    return started.body.handle;
  }

  // The shared assertions every nextSteps block must satisfy.
  function assertNextSteps(nextSteps, containerJson) {
    expect(nextSteps).toBeDefined();
    // Credentialed --header registration, canonical file path pre-filled (any
    // base URL — the tool sees squiredocs.com, supertest an ephemeral host).
    expect(nextSteps.registerMcp).toMatch(
      /claude mcp add --transport http squire https?:\/\/[^ ]+\/mcp --header "Authorization: Bearer \$\(cat ~\/\.squire\/credential\)"/
    );
    // Three runnable REST recipes: list, create-from-markdown, export.
    const commands = nextSteps.restRecipes.map((r) => r.command).join('\n');
    expect(commands).toMatch(/https?:\/\/[^"]+\/api\/docs"/); // list GET /api/docs
    expect(commands).toContain('/api/docs/import'); // create POST /api/docs/import
    expect(commands).toMatch(/\/api\/docs\/[^"]*\/export\?format=markdown/); // export
    // Every recipe references the credential only via $(cat <file>).
    for (const r of nextSteps.restRecipes) {
      expect(r.command).toContain('$(cat ~/.squire/credential)');
    }
    // The bare (uncredentialed) add form appears nowhere in the container payload.
    expect(containerJson).not.toMatch(BARE_ADD);
    // No credential material anywhere in the block.
    expect(JSON.stringify(nextSteps)).not.toContain('sk_sqd_');
  }

  test('tool approved payload carries a correct, secret-free nextSteps block', async () => {
    const handle = await approvedHandle('ToolApproved');
    const payload = await loginStatusTool.handler({ handle }, TOOL_CTX);
    expect(payload.status).toBe('approved');
    assertNextSteps(payload.nextSteps, JSON.stringify(payload));
  });

  test('REST approved payload carries a correct, secret-free nextSteps block', async () => {
    const handle = await approvedHandle('RestApproved');
    const res = await request(app).get('/api/login/status').set('Authorization', `Bearer ${handle}`);
    expect(res.body.status).toBe('approved');
    assertNextSteps(res.body.nextSteps, JSON.stringify(res.body));
  });

  test('tool inline payload carries a correct, secret-free nextSteps block', async () => {
    const handle = await approvedHandle('ToolInline');
    const payload = await loginStatusTool.handler({ handle, inline: true }, TOOL_CTX);
    expect(payload.status).toBe('approved');
    expect(payload.credential).toMatch(/^sk_sqd_/);
    // nextSteps itself has no secret even though the payload delivers the credential.
    assertNextSteps(payload.nextSteps, JSON.stringify(payload.nextSteps));
  });

  test('REST inline payload carries a correct, secret-free nextSteps block', async () => {
    const handle = await approvedHandle('RestInline');
    const res = await request(app)
      .get('/api/login/status')
      .query({ inline: 'true' })
      .set('Authorization', `Bearer ${handle}`);
    expect(res.body.status).toBe('approved');
    expect(res.body.credential).toMatch(/^sk_sqd_/);
    assertNextSteps(res.body.nextSteps, JSON.stringify(res.body.nextSteps));
  });

  test('the raw byte claim response is exactly the credential bytes + newline (no nextSteps)', async () => {
    const handle = await approvedHandle('RawClaim');
    // Deliver the recipe first, then claim over the byte channel.
    await request(app).get('/api/login/status').set('Authorization', `Bearer ${handle}`);
    const claim = await request(app).get('/api/login/claim').set('Authorization', `Bearer ${handle}`);
    expect(claim.status).toBe(200);
    expect(claim.text).toMatch(/^sk_sqd_[^\n]+\n$/);
    expect(claim.text).not.toContain('nextSteps');
    expect(claim.text).not.toContain('claude mcp add');
  });
});
