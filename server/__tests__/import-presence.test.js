/**
 * Feature 037 — imports announce presence (US1/US3/US4).
 *
 * Exercises the REAL import router end to end (real requireAuth, real Yjs-backed
 * document service, real import + sync engines) with only server/import-presence.js's
 * COLLABORATORS swapped for the shared doubles. That split is deliberate: the
 * questions here are orchestration questions — was a session opened, when,
 * with what identity, and did a failure leak into the response — and a real
 * WS-dialing presence session cannot answer them deterministically.
 *
 * Assertions C1-C13 in specs/037-import-presence/contracts/import-presence.md.
 */
const request = require('supertest');
const express = require('express');
const Y = require('yjs');

const { createPool, createPersistence } = require('./helpers/db');
const pool = createPool();
const persistence = createPersistence();

const documents = require('../documents');
const documentService = require('../document-service');
const apiTokens = require('../mcp/auth/api-tokens');
const importPresence = require('../import-presence');
const cursorOps = require('../mcp/yjs/cursor-operations');
const { generateAccessToken } = require('../auth/jwt');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../origin');
const { buildFrontmatter } = require('../mcp/yjs/serialization');
const { createImportRouter } = require('../api/docs-import');
const { makeAgentPresenceDouble } = require('./helpers/import-presence-doubles');

const pendingOperations = [];
async function drain() { await Promise.all(pendingOperations.splice(0)); }
async function maxClock(docId) {
  const r = await pool.query('SELECT MAX(clock)::int AS c FROM yjs_updates WHERE doc_guid=$1', [docId]);
  return r.rows[0].c;
}
/** A pushed file: squire frontmatter (docGuid + baseline clock) + body. */
function fileFor(docId, clock, body) {
  return buildFrontmatter({
    docGuid: docId, title: 'T', clock,
    exportedAt: '2026-01-01T00:00:00Z', lastModifiedBy: '', flavor: 'squire',
  }) + '\n' + body;
}

describe('037 import presence', () => {
  let app;
  let ownerId;
  let ownerJwt;
  let patDefault;
  let presenceDouble;
  const createdDocIds = [];

  beforeAll(async () => {
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          pendingOperations.push(
            persistence.storeUpdate(docGuid, update, parsed.userId, parsed.agentName)
              .catch((err) => console.error(`persist error for ${docGuid}:`, err))
          );
        });
        try {
          const persisted = await persistence.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), ORIGIN_DB_LOAD);
        } catch (e) { /* fresh doc */ }
      },
      writeState: async () => {},
      provider: persistence,
    });
    documentService.init(getYDoc, (n) => (n.startsWith('s/') ? n.slice(2) : n));
    documents.init(pool);
    apiTokens.init(pool);

    const u = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ('test-037-presence', 'test-037-presence@example.com', 'Presence Owner')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, email, name, is_admin`
    );
    ownerId = u.rows[0].id;
    ownerJwt = generateAccessToken(u.rows[0]);
    patDefault = (await apiTokens.createToken(ownerId, 'Claude Code')).token;

    app = express();
    app.use(createImportRouter(persistence));
  });

  afterAll(async () => {
    importPresence._setDepsForTests();
    await drain();
    for (const id of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid=$1', [id]);
      await pool.query('DELETE FROM documents WHERE id=$1', [id]);
    }
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id=$1', [ownerId]);
    await pool.query('DELETE FROM users WHERE id=$1', [ownerId]);
    await persistence.destroy();
    await pool.end();
  });

  beforeEach(() => {
    presenceDouble = makeAgentPresenceDouble();
    importPresence._setDepsForTests({ agentPresence: presenceDouble });
  });

  /** Seed a document owned by ownerId with the given markdown body. */
  async function seedDoc(body) {
    const docId = await documentService.createSeededDocument({
      userId: ownerId,
      title: 'Doc',
      nodes: require('../mcp/yjs/pm-json-to-nodes').pmJsonToNodes(
        require('../../shared/markdown').markdownToPm(body)
      ),
    });
    createdDocIds.push(docId);
    await drain();
    return { docId, clock: await maxClock(docId) };
  }

  function put(docId, body, { auth = `Bearer ${patDefault}`, query = '' } = {}) {
    let req = request(app).put(`/api/docs/${docId}/import${query}`);
    if (auth) req = req.set('Authorization', auth);
    return req.set('Content-Type', 'text/markdown').send(body);
  }

  // -------------------------------------------------------------------------
  // C1-C3, C11, C13 — who gets a session, and when (T003)
  // -------------------------------------------------------------------------
  describe('session gating (C1-C3, C11, C13)', () => {
    test('C1: an agent import opens exactly one session, with the mode identity, before parsing', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      const res = await put(docId, '\n\nAppended line.\n');
      await drain();

      expect(res.status).toBe(200);
      // ONE open + ONE apply-time refresh, both on the same synthetic token.
      expect(presenceDouble.sessions).toHaveLength(2);
      const [opened] = presenceDouble.sessions;
      expect(opened.docGuid).toBe(docId);
      expect(opened.options).toEqual({ requiredRole: 'editor' });
      expect(opened.agentToken.isAgent).toBe(true);
      expect(opened.agentToken.userId).toBe(ownerId);
      // append/replace inherit the CALLER's agent id, so an import and a
      // concurrent MCP call on the same token collapse to one entry (FR-002).
      expect(opened.agentToken.agentId).toMatch(/^api-token:/);
      expect(opened.agentToken.agentName).toBe('Claude Code');
      // The dial credential is a fresh synthetic JWT, never the raw bearer.
      expect(typeof opened.agentToken.rawToken).toBe('string');
      expect(opened.agentToken.rawToken).not.toContain(patDefault);
    });

    test('C1: the session is opened BEFORE any content changes', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      let sessionsAtFirstWrite = null;
      const shared = documentService.getSharedDoc(docId);
      const spy = () => {
        if (sessionsAtFirstWrite === null) sessionsAtFirstWrite = presenceDouble.sessions.length;
      };
      shared.on('update', spy);
      try {
        await put(docId, '\n\nAppended line.\n');
        await drain();
      } finally {
        shared.off('update', spy);
      }
      // The open landed before the import's transaction emitted anything.
      expect(sessionsAtFirstWrite).toBe(1);
    });

    test('C2: a browser-session (human) import opens no session at all', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      const res = await put(docId, '\n\nHuman line.\n', { auth: `Bearer ${ownerJwt}` });
      await drain();

      expect(res.status).toBe(200);
      expect(presenceDouble.sessions).toHaveLength(0);
      expect(presenceDouble.selections).toHaveLength(0);
    });

    test('C3: POST /api/docs/import (create) opens no session', async () => {
      const res = await request(app)
        .post('/api/docs/import')
        .set('Authorization', `Bearer ${patDefault}`)
        .set('Content-Type', 'text/markdown')
        .send('# Created\n\nBody.\n');
      await drain();
      if (res.body && res.body.docId) createdDocIds.push(res.body.docId);

      expect(res.status).toBe(201);
      expect(presenceDouble.sessions).toHaveLength(0);
    });

    test('C11: two imports on one token against one doc reuse the same session key', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      await put(docId, '\n\nFirst.\n');
      await put(docId, '\n\nSecond.\n');
      await drain();

      // Dedup is the presence layer's own `${userId}-${agentId}-${docGuid}`
      // reuse path, so what this feature must guarantee is that every call
      // presents the SAME key components.
      const keys = new Set(presenceDouble.sessions.map(
        (s) => `${s.agentToken.userId}-${s.agentToken.agentId}-${s.docGuid}`
      ));
      expect(keys.size).toBe(1);
    });

    test('C13: a failed import never tears the session down — it expires on its TTL', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      const res = await put(docId, '   \n'); // empty body ⇒ 400, after presence opened
      await drain();

      expect(res.status).toBe(400);
      expect(presenceDouble.sessions).toHaveLength(1); // opened, never refreshed
      expect(presenceDouble.selections).toHaveLength(0);
      // There is no teardown affordance on the double; assert the module never
      // reaches for one.
      expect(typeof importPresence.close).toBe('undefined');
      expect(typeof importPresence.endSession).toBe('undefined');
    });

    test('FR-014: nothing in this feature triggers a modify-style highlight sweep', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      await put(docId, '\n\nAppended line.\n');
      await drain();
      expect(presenceDouble.highlights).toHaveLength(0);
    });
  });
});
