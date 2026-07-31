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

    test('FR-007: apply re-arms the TTL by re-presenting the SAME token and duration', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      await put(docId, '\n\nAppended.\n');
      await drain();

      // The open and the apply-time refresh must be indistinguishable to
      // agent-presence: same session key components, same duration. That is
      // precisely what routes the second call down the reuse path, which is
      // what re-arms _setSessionTimeout and gives the session its ~60 s linger
      // AFTER the response — even when the image pass ran for a minute.
      expect(presenceDouble.sessions).toHaveLength(2);
      const [opened, refreshed] = presenceDouble.sessions;
      expect(refreshed.docGuid).toBe(opened.docGuid);
      expect(refreshed.agentToken.userId).toBe(opened.agentToken.userId);
      expect(refreshed.agentToken.agentId).toBe(opened.agentToken.agentId);
      expect(refreshed.durationSeconds).toBe(opened.durationSeconds);
      expect(refreshed.durationSeconds).toBe(60);
      expect(refreshed.options).toEqual({ requiredRole: 'editor' });

      // NOTE: that the re-armed timeout then actually expires unattended is
      // agent-presence's own _setSessionTimeout behavior and needs a live WS
      // provider (the reuse path gates on provider.wsconnected). It is covered
      // manually by quickstart scenario A, not here.
    });

    test('FR-014: nothing in this feature triggers a modify-style highlight sweep', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      await put(docId, '\n\nAppended line.\n');
      await drain();
      expect(presenceDouble.highlights).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // C6-C9 — the temporary selection covers what actually changed (T005)
  // -------------------------------------------------------------------------
  describe('changed range (C6-C9)', () => {
    /**
     * Resolve the recorded RelativePosition JSON back to absolute block
     * indices. Asserting on the resolved COORDINATES rather than on the
     * arithmetic is the point: it proves the positions a viewer's browser
     * would resolve actually bracket the changed blocks.
     */
    function resolvedBlocks(docId, selection) {
      const doc = documentService.getSharedDoc(docId);
      const fragment = doc.get('default', Y.XmlFragment);
      const blocks = fragment.toArray();
      const anchor = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(selection.anchor), doc
      );
      const head = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(selection.head), doc
      );
      const indexOfType = (pos) => {
        if (!pos) return -1;
        // The position lands inside a block's text; walk up to the top level.
        let node = pos.type;
        while (node && node.parent && node.parent !== fragment) node = node.parent;
        return blocks.indexOf(node);
      };
      return { first: indexOfType(anchor), last: indexOfType(head) };
    }

    test('C6: append ⇒ the range covers exactly the appended blocks', async () => {
      const { docId } = await seedDoc('# Notes\n\nKeep one.\n\nKeep two.');
      const before = documentService.getSharedDoc(docId).get('default', Y.XmlFragment).length;

      await put(docId, '\n\nAdded A.\n\nAdded B.\n');
      await drain();

      expect(presenceDouble.selections).toHaveLength(1);
      const { first, last } = resolvedBlocks(docId, presenceDouble.selections[0]);
      const after = documentService.getSharedDoc(docId).get('default', Y.XmlFragment).length;
      expect(after).toBe(before + 2);
      expect(first).toBe(before);     // first appended block
      expect(last).toBe(after - 1);   // last appended block
    });

    test('LOW-2: a tail edit landing between apply and settle does not drag the range', async () => {
      // settle runs after updateDocument's setImmediate hop, so a browser edit
      // relayed in that hop is already in the post-apply length. Computing the
      // range from that length would slide it off the imported blocks and onto
      // the human's. Injected at the settle boundary, which is exactly where
      // such an edit would have become visible.
      const { docId } = await seedDoc('# Notes\n\nKeep one.\n\nKeep two.');
      const before = documentService.getSharedDoc(docId).get('default', Y.XmlFragment).length;

      const realSettle = importPresence.settle;
      const spy = jest.spyOn(importPresence, 'settle').mockImplementation((presence, ctx) => {
        const doc = documentService.getSharedDoc(docId);
        const fragment = doc.get('default', Y.XmlFragment);
        doc.transact(() => {
          fragment.insert(fragment.length, require('../mcp/yjs/pm-json-to-nodes').pmJsonToNodes(
            require('../../shared/markdown').markdownToPm('Human tail edit.')
          ));
        }, { userId: ownerId, agentName: null });
        return realSettle(presence, ctx);
      });
      try {
        await put(docId, '\n\nAdded A.\n\nAdded B.\n');
        await drain();
      } finally { spy.mockRestore(); }

      expect(presenceDouble.selections).toHaveLength(1);
      const { first, last } = resolvedBlocks(docId, presenceDouble.selections[0]);
      expect(first).toBe(before);          // first appended block
      expect(last).toBe(before + 1);       // last appended block, NOT the human's
      const blocks = documentService.getSharedDoc(docId)
        .get('default', Y.XmlFragment).toArray().map((n) => n.toString());
      expect(blocks[last]).toContain('Added B.');
      expect(blocks.some((b) => b.includes('Human tail edit.'))).toBe(true);
    });

    test('C7: replace ⇒ the range covers the whole post-apply document', async () => {
      const { docId } = await seedDoc('# Notes\n\nOld one.\n\nOld two.\n\nOld three.');
      await put(docId, '# Fresh\n\nNew body.\n', { query: '?mode=replace' });
      await drain();

      expect(presenceDouble.selections).toHaveLength(1);
      const { first, last } = resolvedBlocks(docId, presenceDouble.selections[0]);
      const len = documentService.getSharedDoc(docId).get('default', Y.XmlFragment).length;
      expect(first).toBe(0);
      expect(last).toBe(len - 1);
    });

    test('C8: a sync push touching blocks 3 and 7 ⇒ first=3, last=7', async () => {
      const paras = Array.from({ length: 9 }, (_, i) => `Line ${i}.`);
      const { docId, clock } = await seedDoc(paras.join('\n\n'));

      const edited = paras.slice();
      edited[3] = 'Line 3 EDITED.';
      edited[7] = 'Line 7 EDITED.';
      const res = await put(docId, fileFor(docId, clock, edited.join('\n\n')), { query: '?mode=sync' });
      await drain();

      expect(res.status).toBe(200);
      expect(presenceDouble.selections).toHaveLength(1);
      const { first, last } = resolvedBlocks(docId, presenceDouble.selections[0]);
      expect(first).toBe(3);
      expect(last).toBe(7);
    });

    test('RBD-8: a sync push that ONLY deletes a mid-document block shows no selection', async () => {
      // The deleted block's recorded index points, post-apply, at its surviving
      // neighbour — highlighting it would tell the viewer content they never
      // touched had just changed. Pure deletions must show nothing.
      const paras = ['Alpha here.', 'Beta here.', 'Gamma here.', 'Delta here.', 'Epsilon here.'];
      const { docId, clock } = await seedDoc(paras.join('\n\n'));
      const kept = paras.filter((_, i) => i !== 2); // drop the middle block

      const res = await put(docId, fileFor(docId, clock, kept.join('\n\n')), { query: '?mode=sync' });
      await drain();

      expect(res.status).toBe(200);
      expect(res.body.noop).toBe(false); // the push DID change the document…
      const fragment = documentService.getSharedDoc(docId).get('default', Y.XmlFragment);
      expect(fragment.length).toBe(4);
      expect(presenceDouble.selections).toHaveLength(0); // …and pointed at nothing
    });

    test('RBD-8: a mixed insert+delete push spans only the inserted block', async () => {
      const paras = ['Alpha here.', 'Beta here.', 'Gamma here.', 'Delta here.', 'Epsilon here.'];
      const { docId, clock } = await seedDoc(paras.join('\n\n'));
      const edited = paras.filter((_, i) => i !== 2).concat('Brand new tail.');

      const res = await put(docId, fileFor(docId, clock, edited.join('\n\n')), { query: '?mode=sync' });
      await drain();

      expect(res.status).toBe(200);
      expect(presenceDouble.selections).toHaveLength(1);
      const fragment = documentService.getSharedDoc(docId).get('default', Y.XmlFragment);
      const blocks = fragment.toArray().map((n) => n.toString());
      const newIndex = blocks.findIndex((b) => b.includes('Brand new tail.'));
      expect(newIndex).toBeGreaterThanOrEqual(0);
      const { first, last } = resolvedBlocks(docId, presenceDouble.selections[0]);
      // The delete-derived index (the surviving neighbour of removed "Gamma here.")
      // must not widen the span back over untouched blocks.
      expect(first).toBe(newIndex);
      expect(last).toBe(newIndex);
    });

    test('C9: a no-op sync push opens a session but shows NO selection (FR-012)', async () => {
      const body = '# Notes\n\nUnchanged one.\n\nUnchanged two.';
      const { docId, clock } = await seedDoc(body);
      const shared = documentService.getSharedDoc(docId);
      const currentBody = require('../mcp/yjs/serialization')
        .toMarkdown(shared.get('default', Y.XmlFragment));

      const res = await put(docId, fileFor(docId, clock, currentBody), { query: '?mode=sync' });
      await drain();

      expect(res.status).toBe(200);
      expect(res.body.noop).toBe(true);
      expect(presenceDouble.sessions.length).toBeGreaterThanOrEqual(1); // opened
      expect(presenceDouble.selections).toHaveLength(0);                // never fabricated
    });
  });

  // -------------------------------------------------------------------------
  // C4, C5, C10 — presence is provably decorative (T019-T021, US3)
  //
  // The proof obligation is that degradation cannot reach the byte channel:
  // not the response, not the latency beyond the cap, not the document.
  // -------------------------------------------------------------------------
  describe('degradation never reaches the import (C4, C5, C10)', () => {
    test('C4: a rejecting getOrCreateSession leaves the response identical, and warns once', async () => {
      const { docId: healthyDoc } = await seedDoc('# Notes\n\nOne.');
      const healthy = await put(healthyDoc, '\n\nAppended.\n');
      await drain();

      const { docId } = await seedDoc('# Notes\n\nOne.');
      presenceDouble.reset(); // drop the healthy baseline's recordings
      presenceDouble.behave({ mode: 'reject' });
      const warns = jest.spyOn(console, 'warn').mockImplementation(() => {});
      let logged;
      let res;
      try {
        res = await put(docId, '\n\nAppended.\n');
        await drain();
        logged = warns.mock.calls.map((c) => String(c[0]));
      } finally { warns.mockRestore(); }

      expect(res.status).toBe(healthy.status);
      expect(Object.keys(res.body).sort()).toEqual(Object.keys(healthy.body).sort());
      expect(res.body.blocks).toEqual(healthy.body.blocks);
      expect(res.body.markdown).toBe(healthy.body.markdown);
      // Observable, but only in the log.
      expect(logged.filter((l) => l.startsWith('[import-presence]'))).toHaveLength(1);
      expect(presenceDouble.selections).toHaveLength(0);
    });

    test('C5: a hanging getOrCreateSession costs at most the ~2 s cap', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      presenceDouble.behave({ mode: 'hang' });

      const started = Date.now();
      const res = await put(docId, '\n\nAppended.\n');
      const elapsed = Date.now() - started;
      await drain();

      expect(res.status).toBe(200);
      // The double's promise NEVER settles, so the fact that a response came
      // back at all is the real assertion: without the cap this request would
      // hang forever. The lower bound proves the cap is what released it; the
      // upper bound is deliberately loose because this file shares a machine
      // with the rest of the serial backend suite and a tight wall-clock
      // ceiling here would be a flake generator, not a regression detector.
      expect(elapsed).toBeGreaterThanOrEqual(importPresence.PRESENCE_ATTACH_CAP_MS - 100);
      expect(elapsed).toBeLessThan(30000);
      // The import completed while the session was still attaching, so nothing
      // was ever announced — the ratified best-effort trade (US3 scenario 2).
      expect(presenceDouble.selections).toHaveLength(0);
    }, 60000);

    test('C10: the document is byte-identical with presence enabled and disabled (FR-013)', async () => {
      const body = '## Added\n\nSome **text** here.\n\n- a\n- b\n';

      // Same seed content, same import, only presence differs.
      const withPresence = await seedDoc('# Notes\n\nOne.');
      await put(withPresence.docId, body);
      await drain();

      const withoutPresence = await seedDoc('# Notes\n\nOne.');
      presenceDouble.behave({ mode: 'reject' });
      await put(withoutPresence.docId, body);
      await drain();

      const { toMarkdown } = require('../mcp/yjs/serialization');
      const read = (id) => toMarkdown(
        documentService.getSharedDoc(id).get('default', Y.XmlFragment)
      );
      // Markdown equality is the readable half of the claim; the structural
      // half is that presence performed no transaction of its own.
      expect(read(withPresence.docId)).toBe(read(withoutPresence.docId));

      const rows = async (id) => (await pool.query(
        'SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_guid=$1', [id]
      )).rows[0].n;
      expect(await rows(withPresence.docId)).toBe(await rows(withoutPresence.docId));
    });

    test('SC-005: a session that attaches AFTER the apply still writes nothing to the doc', async () => {
      presenceDouble.behave({ mode: 'resolve', delayMs: 40 });
      const { docId } = await seedDoc('# Notes\n\nOne.');
      const before = await (async () => {
        await put(docId, '\n\nAppended.\n');
        await drain();
        return Y.encodeStateAsUpdate(documentService.getSharedDoc(docId));
      })();

      // Let the late attach land and the settle chain run to completion.
      await new Promise((r) => setTimeout(r, 200));
      const after = Y.encodeStateAsUpdate(documentService.getSharedDoc(docId));

      expect(Buffer.from(after)).toEqual(Buffer.from(before));
      expect(presenceDouble.selections).toHaveLength(1); // it DID announce, late
    });

    test('a throwing position computation is logged and never reaches the response', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      const boom = jest.spyOn(cursorOps, 'createBlockRangeSelection')
        .mockImplementation(() => { throw new Error('position math exploded'); });
      importPresence._setDepsForTests({ agentPresence: presenceDouble, cursorOps });
      const warns = jest.spyOn(console, 'warn').mockImplementation(() => {});
      let res;
      let logged;
      try {
        res = await put(docId, '\n\nAppended.\n');
        await drain();
        logged = warns.mock.calls.map((c) => String(c[0]));
      } finally { warns.mockRestore(); boom.mockRestore(); }

      expect(res.status).toBe(200);
      expect(res.body.blocks).toEqual({ imported: 1 });
      expect(logged.some((l) => l.includes('changed-range computation failed'))).toBe(true);
      // The session still refreshed; only the selection was lost.
      expect(presenceDouble.selections).toHaveLength(0);
      expect(presenceDouble.sessions).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // C12 / SC-006 — presence and provenance tell one story (T024-T026, US4)
  //
  // The label a viewer sees while the agent works must be exactly the author
  // version history records for the same change. These walk the mode x identity
  // matrix and compare the two ends against each other, not against a
  // hand-rolled string.
  // -------------------------------------------------------------------------
  describe('identity parity with version history (C12)', () => {
    const agentPresenceReal = require('../mcp/agent-presence');

    /** The label agent-presence would actually render for a token. */
    function labelFor(agentToken, userName) {
      // Exercised through the real _buildAgentInfo so the assertion tracks the
      // shipped label shape rather than a copy of it.
      const info = agentPresenceReal._buildAgentInfo(
        agentToken, userName, 'test-037-presence@example.com', null, ownerId
      );
      expect(info.isAgent).toBe(true);
      return info.name;
    }

    async function agentNameOnLatestRow(docId) {
      const r = await pool.query(
        'SELECT agent_name FROM yjs_updates WHERE doc_guid=$1 ORDER BY clock DESC LIMIT 1', [docId]
      );
      return r.rows[0].agent_name;
    }

    test.each(['append', 'replace'])(
      '%s: the presence label and the stored author are the same token name',
      async (mode) => {
        const { docId } = await seedDoc('# Notes\n\nOne.');
        await put(docId, '## Added\n\nText.\n', { query: `?mode=${mode}` });
        await drain();

        const token = presenceDouble.sessions[0].agentToken;
        expect(labelFor(token, 'Presence Owner')).toBe('Claude Code (Presence Owner)');
        // The same string version history attributes the change to.
        expect(await agentNameOnLatestRow(docId)).toBe('Claude Code');
        expect(token.agentName).toBe(await agentNameOnLatestRow(docId));
      }
    );

    test('sync: the presence label and the stored author are both Repo Sync', async () => {
      const { docId, clock } = await seedDoc('# Notes\n\nAlpha.\n\nBeta.');
      const res = await put(docId, fileFor(docId, clock, '# Notes\n\nAlpha EDITED.\n\nBeta.'), {
        query: '?mode=sync',
      });
      await drain();
      expect(res.status).toBe(200);

      const token = presenceDouble.sessions[0].agentToken;
      expect(labelFor(token, 'Presence Owner')).toBe('Repo Sync (Presence Owner)');
      expect(await agentNameOnLatestRow(docId)).toBe('Repo Sync');
      // T026 / ledger RBD-7: a FIXED agent id, so repeated pushes from any CI
      // token dedup per user+document rather than per token — and the label
      // never inherits the token's own display name.
      expect(token.agentId).toBe('repo-sync');
      expect(token.agentName).not.toBe('Claude Code');
    });

    test('FR-016: no request-supplied parameter can influence the label', async () => {
      const { docId } = await seedDoc('# Notes\n\nOne.');
      await request(app)
        .put(`/api/docs/${docId}/import?agentName=Totally%20Legit%20Human`)
        .set('Authorization', `Bearer ${patDefault}`)
        .set('X-Squire-Agent-Name', 'Totally Legit Human')
        .set('Content-Type', 'text/markdown')
        .send('## Added\n\nText.\n');
      await drain();

      const token = presenceDouble.sessions[0].agentToken;
      expect(token.agentName).toBe('Claude Code');
      expect(labelFor(token, 'Presence Owner')).toBe('Claude Code (Presence Owner)');
    });
  });
});
