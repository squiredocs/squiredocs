/**
 * Feature 059 test helper: a real Express app on a FRESH instance database
 * (createFreshInstanceDb, research R15), with the /auth router mounted the way
 * server/index.js mounts it (body parsers, cookie parser, the per-IP /auth
 * limiter) and the real onboarding wired to a Yjs persistence on that same
 * database, so a claim lands on a genuinely seeded welcome document.
 *
 * The caller sets SQUIRE_MODE and calls _resetInstanceConfigForTests() before
 * requiring this helper's start().
 *
 * Only the Google adapter may be mocked by a suite (jest.mock at the top of
 * the test file); nothing else here is a stand-in.
 */
const Y = require('yjs');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createFreshInstanceDb, dropFreshInstanceDb } = require('./db');

// A generous /auth budget so a suite's own request volume never trips the
// limiter; the limiter itself is still in the chain, exactly as in index.js.
process.env.RL_AUTH_PER_MIN = process.env.RL_AUTH_PER_MIN || '10000';
process.env.RL_FORCE_MEMORY = '1';

async function startLocalInstance() {
  const fresh = await createFreshInstanceDb();
  const pool = fresh.pool;

  const { PostgresPersistence } = require('../../postgres-persistence');
  const persistence = new PostgresPersistence({ connectionString: fresh.url });
  const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
  const { ORIGIN_DB_LOAD, parseOrigin } = require('../../origin');
  const pending = [];
  setPersistence({
    bindState: async (docName, ydoc) => {
      const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
      ydoc.on('update', (update, origin) => {
        const parsed = parseOrigin(origin);
        if (!parsed) return;
        pending.push(persistence.storeUpdate(docGuid, update, parsed.userId, parsed.agentName).catch(() => {}));
      });
      try {
        const persisted = await persistence.getYDoc(docGuid);
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), ORIGIN_DB_LOAD);
      } catch { /* new document */ }
      ydoc._bindComplete = true;
    },
    writeState: async () => {},
    provider: persistence,
  });
  const documentService = require('../../document-service');
  documentService.init(getYDoc, (n) => (n.startsWith('s/') ? n.slice(2) : n));

  require('../../documents').init(pool);
  require('../../auth/users').init(pool);
  require('../../onboarding').init(pool);
  require('../../spaces').init(pool);
  require('../../mcp/auth/oauth-flow').init(pool);
  require('../../mcp/auth/registered-agents').init(pool);
  require('../../mcp/auth/api-tokens').init(pool);

  const rateLimit = require('../../rate-limit');
  const authRouter = require('../../auth/routes');
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use('/auth', rateLimit.authRouteLimiter(), authRouter);

  return {
    app,
    pool,
    url: fresh.url,
    async reset() {
      await Promise.all(pending.splice(0));
      // This suite's private clone: safe to reset whole tables.
      await pool.query('DELETE FROM signin_links');
      await pool.query("DELETE FROM app_settings WHERE key = 'instance_owner_user_id'");
      await pool.query('DELETE FROM users');
    },
    async close() {
      await Promise.all(pending.splice(0));
      try { await persistence.destroy(); } catch { /* best effort */ }
      await dropFreshInstanceDb(fresh);
    },
  };
}

/** The session cookies a response sets. */
function sessionCookies(res) {
  return (res.headers['set-cookie'] || []).filter((c) => /^(accessToken|refreshToken)=[^;]+/.test(c));
}

module.exports = { startLocalInstance, sessionCookies };
