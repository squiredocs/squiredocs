/**
 * API-level sync-push tests (feature 004) — PUT /api/docs/:docId/import?mode=sync.
 *
 * Exercises the real import router end to end: requireAuth (JWT + sk_sqd_ tokens,
 * scope enforcement), the editor-role gate, the Yjs-backed document service, and
 * the sync engine (baseline replay, store-then-apply, receipt shaping).
 *
 * US1 (T011): text/structural push, receipt shape, live visibility, auth matrix.
 * US2/US3/US4/US5 blocks are appended by later tasks.
 */
const request = require('supertest');
const express = require('express');
const Y = require('yjs');

const { createPool, createPersistence } = require('../../server/__tests__/helpers/db');
const pool = createPool();
const persistence = createPersistence();

const documents = require('../../server/documents');
const documentService = require('../../server/document-service');
const apiTokens = require('../../server/mcp/auth/api-tokens');
const { generateAccessToken } = require('../../server/auth/jwt');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../../server/origin');
const { toMarkdown, buildFrontmatter } = require('../../server/mcp/yjs/serialization');
const { createImportRouter, setCanReconstruct } = require('../../server/api/docs-import');
const { setExternalImagePass } = require('../../server/markdown-import');
const { setOverlapDetector, detectOverlaps: realOverlapDetector } = require('../../server/markdown-sync');
const { getVersionTimeline, createAuthor } = require('../../server/version-history');

const pendingOperations = [];

/** Build a pushed file: squire frontmatter (docGuid+clock) + body. */
function fileFor(docId, clock, body, extra = {}) {
  const fm = buildFrontmatter({
    docGuid: docId, title: 'T', clock,
    exportedAt: '2026-01-01T00:00:00Z', lastModifiedBy: '', flavor: 'squire',
    ...extra,
  });
  return fm + '\n' + body;
}

async function drain() { await Promise.all(pendingOperations.splice(0)); }
async function currentBody(docId) {
  const doc = await persistence.getYDoc(docId);
  const md = toMarkdown(doc.get('default', Y.XmlFragment));
  doc.destroy();
  return md;
}
async function maxClock(docId) {
  const r = await pool.query('SELECT MAX(clock)::int AS c FROM yjs_updates WHERE doc_guid=$1', [docId]);
  return r.rows[0].c;
}

describe('sync-push route (mode=sync)', () => {
  let app;
  let ownerId; let otherId;
  let patDefault; let patReadOnly; let otherJwt;
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
        } catch { /* fresh doc */ }
      },
      writeState: async () => {},
      provider: persistence,
    });
    documentService.init(getYDoc, (docName) => (docName.startsWith('s/') ? docName.slice(2) : docName));
    documents.init(pool);
    apiTokens.init(pool);

    const u1 = await pool.query(
      `INSERT INTO users (google_id, email, name) VALUES ('sync-1','sync-api-1@example.com','Sync One')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id, email, name, is_admin`);
    ownerId = u1.rows[0].id;
    const u2 = await pool.query(
      `INSERT INTO users (google_id, email, name) VALUES ('sync-2','sync-api-2@example.com','Sync Two')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id, email, name, is_admin`);
    otherId = u2.rows[0].id;
    otherJwt = generateAccessToken(u2.rows[0]);
    patDefault = (await apiTokens.createToken(ownerId, 'sync default')).token;
    patReadOnly = (await apiTokens.createToken(ownerId, 'sync ro', { scopes: ['documents:read'] })).token;

    app = express();
    app.use(createImportRouter(persistence));
  });

  afterEach(() => setExternalImagePass(null));

  afterAll(async () => {
    await drain();
    for (const id of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [id]);
      await pool.query('DELETE FROM documents WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id IN ($1,$2)', [ownerId, otherId]);
    await pool.query('DELETE FROM users WHERE id IN ($1,$2)', [ownerId, otherId]);
    await persistence.destroy();
    await pool.end();
  });

  /** Seed a document owned by ownerId with the given markdown body. */
  async function seedDoc(body) {
    const docId = await documentService.createSeededDocument({
      userId: ownerId, title: 'Doc',
      nodes: require('../../server/mcp/yjs/pm-json-to-nodes').pmJsonToNodes(
        require('../../shared/markdown').markdownToPm(body)
      ),
    });
    createdDocIds.push(docId);
    await drain();
    return { docId, clock: await maxClock(docId), body: await currentBody(docId) };
  }

  function put(docId, body, { auth = `Bearer ${patDefault}`, query = '?mode=sync', headers = {} } = {}) {
    let req = request(app).put(`/api/docs/${docId}/import${query}`);
    if (auth) req = req.set('Authorization', auth);
    req = req.set('Content-Type', 'text/markdown');
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req.send(body);
  }

  test('scenario 1: single-sentence text edit — receipt shape, live visibility', async () => {
    const { docId, clock, body } = await seedDoc('# Notes\n\nRetries use exponential backoff here.\n\nKeep this line.');
    // open the shared doc first (a "connected live editor")
    const shared = documentService.getSharedDoc(docId);

    const edited = body.replace('exponential backoff', 'fixed 5s intervals');
    const res = await put(docId, fileFor(docId, clock, edited));
    await drain();

    expect(res.status).toBe(200);
    expect(res.body.noop).toBe(false);
    expect(res.body.clock).toBeGreaterThan(clock);
    expect(res.body.operations.textHunks).toBeGreaterThanOrEqual(1);
    expect(res.body.operations.structuralHunks).toBe(0);
    expect(res.body.overlaps).toEqual([]);
    // receipt re-export carries the edit + refreshed frontmatter
    expect(res.body.markdown).toContain('fixed 5s intervals');
    expect(res.body.markdown).toContain('squire:');
    expect(res.body.markdown).toContain('Keep this line.');
    // live shared doc reflects the edit through the normal update path
    expect(toMarkdown(shared.get('default', Y.XmlFragment))).toContain('fixed 5s intervals');
    // version history: a Repo Sync entry authored by the token owner
    const rows = await pool.query(
      "SELECT user_id, agent_name FROM yjs_updates WHERE doc_guid=$1 AND agent_name='Repo Sync'", [docId]);
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.rows[0].user_id).toBe(ownerId);
  });

  test('scenario 2: heading+paragraph insertion; scenario 3: block deletion recoverable', async () => {
    const { docId, clock, body } = await seedDoc('# A\n\npara one\n\npara two');
    // insert a new section between blocks
    const edited = body.replace('para one\n\n', 'para one\n\n## New\n\nmore\n\n');
    const res = await put(docId, fileFor(docId, clock, edited));
    await drain();
    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain('## New');
    expect(await currentBody(docId)).toContain('## New');

    // block deletion (from the new baseline)
    const clock2 = res.body.clock;
    const body2 = await currentBody(docId);
    const del = body2.replace('\n\npara two', '');
    const res2 = await put(docId, fileFor(docId, clock2, del));
    await drain();
    expect(res2.status).toBe(200);
    expect(await currentBody(docId)).not.toContain('para two');
    // recoverable: the deleted content still exists in the update log history
    const hist = await persistence.getYDocAtClock(docId, clock2);
    expect(toMarkdown(hist.get('default', Y.XmlFragment))).toContain('para two');
    hist.destroy();
  });

  test('auth: read-only scoped token → 403 (documents:write required)', async () => {
    const { docId, clock, body } = await seedDoc('# X\n\nbody');
    const res = await put(docId, fileFor(docId, clock, body.replace('body', 'edit')),
      { auth: `Bearer ${patReadOnly}` });
    expect(res.status).toBe(403);
  });

  test('auth: user without editor role → 403', async () => {
    const { docId, clock, body } = await seedDoc('# Y\n\nbody');
    const res = await put(docId, fileFor(docId, clock, body.replace('body', 'edit')),
      { auth: `Bearer ${otherJwt}` });
    expect(res.status).toBe(403);
  });

  // ------------------------------------------------------------------------
  // US2 (T016): concurrent flow — pull, live edit, push, overlaps, both visible
  // ------------------------------------------------------------------------
  test('concurrent live edit before push: both streams visible; overlap flagged for same block', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nblock alpha here\n\nblock bravo here');
    // a "second Yjs client" edits block alpha on the live doc
    const shared = documentService.getSharedDoc(docId);
    const para = shared.get('default', Y.XmlFragment).toArray()
      .find((n) => n.nodeName === 'paragraph' && n.get(0).toString().includes('alpha'));
    shared.transact(() => para.get(0).insert(para.get(0).length, ' LIVE'), { userId: ownerId });
    await drain();

    // push edits the SAME block alpha (disjoint span) from the file baseline
    const edited = body.replace('block alpha here', 'block alpha CHANGED');
    const res = await put(docId, fileFor(docId, clock, edited));
    await drain();

    expect(res.status).toBe(200);
    // both edit streams present in a follow-up export
    const after = await currentBody(docId);
    expect(after).toContain('LIVE');
    expect(after).toContain('CHANGED');
    // overlap flagged for block alpha (edited both sides)
    expect(res.body.overlaps.length).toBeGreaterThanOrEqual(1);
    expect(res.body.overlaps.some((o) => o.docSide === 'edited')).toBe(true);
  });

  // ------------------------------------------------------------------------
  // US3 (T017): no-op pushes store nothing, create no version entry
  // ------------------------------------------------------------------------
  test('byte-identical re-push is a no-op: clock unchanged, no new update row', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nunchanged body here');
    const rowsBefore = (await pool.query('SELECT COUNT(*)::int c FROM yjs_updates WHERE doc_guid=$1', [docId])).rows[0].c;
    const res = await put(docId, fileFor(docId, clock, body));
    await drain();
    expect(res.status).toBe(200);
    expect(res.body.noop).toBe(true);
    expect(res.body.clock).toBe(clock); // current clock, unchanged
    expect(res.body.operations).toEqual({ textHunks: 0, structuralHunks: 0 });
    expect(res.body.markdown).toContain('unchanged body here'); // current re-export
    const rowsAfter = (await pool.query('SELECT COUNT(*)::int c FROM yjs_updates WHERE doc_guid=$1', [docId])).rows[0].c;
    expect(rowsAfter).toBe(rowsBefore); // no update stored
  });

  test('formatting-only push (delimiter style) is a no-op', async () => {
    const { docId, clock } = await seedDoc('# Doc\n\ntext with **bold** word');
    const rowsBefore = (await pool.query('SELECT COUNT(*)::int c FROM yjs_updates WHERE doc_guid=$1', [docId])).rows[0].c;
    // __bold__ is the same as **bold** after canonicalization
    const res = await put(docId, fileFor(docId, clock, '# Doc\n\ntext with __bold__ word'));
    await drain();
    expect(res.body.noop).toBe(true);
    expect((await pool.query('SELECT COUNT(*)::int c FROM yjs_updates WHERE doc_guid=$1', [docId])).rows[0].c).toBe(rowsBefore);
  });

  // ------------------------------------------------------------------------
  // US4 (T024): attribution + on-behalf-of provenance (SC-005)
  // ------------------------------------------------------------------------
  test('content-changing push → version entry authored by token identity (agent-style)', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nattribute this');
    await put(docId, fileFor(docId, clock, body.replace('this', 'that')));
    await drain();
    const row = (await pool.query(
      "SELECT user_id, agent_name FROM yjs_updates WHERE doc_guid=$1 AND agent_name='Repo Sync' ORDER BY clock DESC LIMIT 1", [docId])).rows[0];
    expect(row.user_id).toBe(ownerId);
    // indistinguishable in mechanism from other agent edits: createAuthor yields
    // "Repo Sync (<user>)" via the standard agent path.
    const author = createAuthor({ userId: ownerId, userName: 'Sync One', agentName: row.agent_name });
    expect(author.isAgent).toBe(true);
    expect(author.name).toBe('Repo Sync (Sync One)');
  });

  test('on-behalf-of headers → stored + surfaced as plain text; hostile value inert, over-length capped', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nprovenance body');
    const hostile = '<img src=x onerror=alert(1)>';
    const longEmail = 'a'.repeat(300) + '@x.com';
    const res = await put(docId, fileFor(docId, clock, body.replace('body', 'edit')), {
      headers: {
        'X-Squire-On-Behalf-Of-Name': hostile,
        'X-Squire-On-Behalf-Of-Email': longEmail,
        'X-Squire-On-Behalf-Of-Commit': 'a1b2c3d',
      },
    });
    await drain();
    expect(res.status).toBe(200);

    // stored on the update row, whitelisted + capped, verbatim (inert) text
    const stored = (await pool.query(
      "SELECT on_behalf_of FROM yjs_updates WHERE doc_guid=$1 AND agent_name='Repo Sync' ORDER BY clock DESC LIMIT 1", [docId])).rows[0].on_behalf_of;
    expect(stored.name).toBe(hostile); // stored as-is; rendering escapes it (no execution)
    expect(stored.email.length).toBe(256); // over-length capped
    expect(stored.commit).toBe('a1b2c3d');
    expect(stored.url).toBeUndefined(); // not supplied → absent

    // surfaced through the version timeline (visible in version history)
    const timeline = await getVersionTimeline(persistence, docId);
    const withProv = timeline.versions.find((v) => (v.onBehalfOf || []).length > 0);
    expect(withProv).toBeTruthy();
    expect(withProv.onBehalfOf[0].name).toBe(hostile);
  });

  test('push without on-behalf-of → token identity alone (no provenance row)', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nno provenance');
    await put(docId, fileFor(docId, clock, body.replace('no', 'zero')));
    await drain();
    const stored = (await pool.query(
      "SELECT on_behalf_of FROM yjs_updates WHERE doc_guid=$1 AND agent_name='Repo Sync' ORDER BY clock DESC LIMIT 1", [docId])).rows[0].on_behalf_of;
    expect(stored).toBeNull();
  });

  test('disjoint concurrent edits: no overlap flagged', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\npara one text\n\npara two text');
    const shared = documentService.getSharedDoc(docId);
    const p1 = shared.get('default', Y.XmlFragment).toArray()
      .find((n) => n.nodeName === 'paragraph' && n.get(0).toString().includes('one'));
    shared.transact(() => p1.get(0).insert(p1.get(0).length, ' LIVE'), { userId: ownerId });
    await drain();

    const edited = body.replace('para two text', 'para two CHANGED'); // different block
    const res = await put(docId, fileFor(docId, clock, edited));
    await drain();
    expect(res.status).toBe(200);
    expect(res.body.overlaps).toEqual([]);
    const after = await currentBody(docId);
    expect(after).toContain('LIVE');
    expect(after).toContain('CHANGED');
  });

  // ------------------------------------------------------------------------
  // US5 (T025): stale/invalid baselines rejected; zero mutation (SC-008)
  // ------------------------------------------------------------------------
  async function expectNoMutation(docId, fn) {
    const beforeRows = (await pool.query('SELECT COUNT(*)::int c, MAX(clock)::int m FROM yjs_updates WHERE doc_guid=$1', [docId])).rows[0];
    const res = await fn();
    await drain();
    const afterRows = (await pool.query('SELECT COUNT(*)::int c, MAX(clock)::int m FROM yjs_updates WHERE doc_guid=$1', [docId])).rows[0];
    expect(afterRows.c).toBe(beforeRows.c); // no update stored
    expect(afterRows.m).toBe(beforeRows.m); // clock unchanged
    return res;
  }

  test('baseline beyond current clock → 400 sync_baseline_invalid + guidance + currentClock; no mutation', async () => {
    const { docId, body } = await seedDoc('# Doc\n\nstale test');
    const res = await expectNoMutation(docId, () =>
      put(docId, fileFor(docId, 999999, body), { query: '?mode=sync&baselineClock=999999' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sync_baseline_invalid');
    expect(res.body.guidance).toMatch(/re-pull/i);
    expect(typeof res.body.currentClock).toBe('number');
  });

  test('negative baseline → 400 sync_baseline_invalid', async () => {
    const { docId, body } = await seedDoc('# Doc\n\nneg');
    const res = await expectNoMutation(docId, () =>
      put(docId, fileFor(docId, 0, body), { query: '?mode=sync&baselineClock=-3' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sync_baseline_invalid');
  });

  test('no baseline (frontmatter stripped, no param) → 400 sync_baseline_missing', async () => {
    const { docId } = await seedDoc('# Doc\n\nno baseline');
    const res = await expectNoMutation(docId, () =>
      put(docId, 'no frontmatter here')); // no squire block, no param
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sync_baseline_missing');
  });

  test('frontmatter docGuid ≠ target → 409 sync_doc_mismatch; rejected before processing', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nmismatch');
    const wrongFile = fileFor('00000000-0000-0000-0000-000000000000', clock, body.replace('mismatch', 'x'));
    const res = await expectNoMutation(docId, () => put(docId, wrongFile));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('sync_doc_mismatch');
  });

  test('forced-unavailable baseline → 410 sync_baseline_unavailable; no mutation', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nunavailable');
    setCanReconstruct(async () => false);
    try {
      const res = await expectNoMutation(docId, () => put(docId, fileFor(docId, clock, body.replace('unavailable', 'x'))));
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('sync_baseline_unavailable');
    } finally {
      setCanReconstruct(null); // restore default (always true)
    }
  });

  test('rejections never whole-document-replace as a fallback', async () => {
    // grep-level guard on the route + engine sources.
    const fs = require('fs');
    const path = require('path');
    const route = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'api', 'docs-import.js'), 'utf8');
    // the sync handler must not fall through to mode=replace on a rejection
    expect(/sync[\s\S]*mode\s*=\s*['"]replace['"]/i.test(route)).toBe(false);
  });

  // ------------------------------------------------------------------------
  // Hostile / edge input (T028, Constitution V, spec edge cases)
  // ------------------------------------------------------------------------
  test('hostile HTML in pushed content is inert (whitelist); push still succeeds', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nsafe paragraph');
    const res = await put(docId, fileFor(docId, clock, body + '\n\nBefore <script>alert(1)</script> after'));
    await drain();
    expect(res.status).toBe(200);
    const after = await currentBody(docId);
    // never-lose-content: the words survive. The <script> is materialized as
    // inert TEXT (001's whitelist admits no <script> node/mark), so it can never
    // execute — verify no script ELEMENT entered the document structure.
    expect(after).toContain('Before');
    expect(after).toContain('after');
    const doc = await persistence.getYDoc(docId);
    const structured = JSON.stringify(require('../../server/mcp/yjs/serialization').toStructured(doc.get('default', Y.XmlFragment)));
    doc.destroy();
    expect(structured).not.toMatch(/"type":"script"/);
  });

  test('pushed file that empties the document deletes all blocks (recoverable)', async () => {
    const { docId, clock } = await seedDoc('# Doc\n\none\n\ntwo\n\nthree');
    const res = await put(docId, fileFor(docId, clock, ''));
    await drain();
    expect(res.status).toBe(200);
    expect((await currentBody(docId)).trim()).toBe('');
    // recoverable via history: the content still exists at the baseline clock
    const hist = await persistence.getYDocAtClock(docId, clock);
    expect(toMarkdown(hist.get('default', Y.XmlFragment))).toContain('three');
    hist.destroy();
  });

  test('non-Squire frontmatter alongside squire causes no spurious edit', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nstable body');
    // build a file whose frontmatter carries a foreign key beside squire:
    const fm = buildFrontmatter(
      { docGuid: docId, title: 'T', clock, exportedAt: '2026-01-01T00:00:00Z', lastModifiedBy: '', flavor: 'squire' },
      'author: Someone\ntags: [a, b]');
    const res = await put(docId, fm + '\n' + body); // body unchanged
    await drain();
    expect(res.status).toBe(200);
    expect(res.body.noop).toBe(true); // foreign frontmatter is ignored, not a diff
  });

  // ------------------------------------------------------------------------
  // F5: pushing the SAME file twice (same baseline) is idempotent — the second
  // push short-circuits to a no-op receipt, storing no duplicate version row and
  // duplicating no content (the pinned synthetic clientID dedupes the replay).
  // ------------------------------------------------------------------------
  test('double-push of the same file: no content duplication, no duplicate version row', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nidempotent target line');
    const file = fileFor(docId, clock, body.replace('target', 'CHANGED'));

    // First push lands the edit.
    const res1 = await put(docId, file);
    await drain();
    expect(res1.status).toBe(200);
    expect(res1.body.noop).toBe(false);
    expect(res1.body.clock).toBeGreaterThan(clock);
    const rowsAfter1 = (await pool.query(
      'SELECT COUNT(*)::int c FROM yjs_updates WHERE doc_guid=$1', [docId])).rows[0].c;

    // Second push of the byte-identical file (same baseline clock).
    const res2 = await put(docId, file);
    await drain();
    expect(res2.status).toBe(200);
    // Short-circuit: no-op receipt, clock unchanged from after the first push.
    expect(res2.body.noop).toBe(true);
    expect(res2.body.clock).toBe(res1.body.clock);
    expect(res2.body.operations).toEqual({ textHunks: 0, structuralHunks: 0 });

    // No duplicate update row stored by the second push.
    const rowsAfter2 = (await pool.query(
      'SELECT COUNT(*)::int c FROM yjs_updates WHERE doc_guid=$1', [docId])).rows[0].c;
    expect(rowsAfter2).toBe(rowsAfter1);

    // No content duplication: the edit appears exactly once.
    const after = await currentBody(docId);
    expect(after.match(/CHANGED/g)).toHaveLength(1);
    expect(after).not.toContain('target line');
  });

  // ------------------------------------------------------------------------
  // F4: overlap detection is strictly advisory — a failure must never gate the
  // push; the receipt reports overlaps=[] + overlapsUnavailable:true instead.
  // ------------------------------------------------------------------------
  test('overlap detector failure does not gate the push; receipt marks it unavailable', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\noverlap advisory body');
    setOverlapDetector(async () => { throw new Error('injected overlap failure'); });
    try {
      const res = await put(docId, fileFor(docId, clock, body.replace('body', 'edited')));
      await drain();
      expect(res.status).toBe(200);
      expect(res.body.noop).toBe(false);
      expect(res.body.overlaps).toEqual([]); // advisory defaulted, not gated
      expect(res.body.overlapsUnavailable).toBe(true);
      // the edit still landed durably
      expect(res.body.clock).toBeGreaterThan(clock);
      expect(await currentBody(docId)).toContain('edited');
    } finally {
      setOverlapDetector(realOverlapDetector); // restore the REAL detector
    }
  });

  // ------------------------------------------------------------------------
  // F1 (image policy): materialized sync nodes run the SAME staged image
  // pipeline import uses — data: rejected, external rehosted/degraded, cross-doc
  // access-checked. The receipt itemizes what the policy did (002 report shape).
  // ------------------------------------------------------------------------
  test('data: image in a push is dropped to alt text and itemized in the receipt', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nintro paragraph');
    const evil = '![evil](data:image/svg+xml;base64,AAAA)';
    const res = await put(docId, fileFor(docId, clock, body + '\n\n' + evil));
    await drain();

    expect(res.status).toBe(200);
    expect(res.body.noop).toBe(false);
    // itemized in the receipt's image report
    expect(res.body.images.rejected).toEqual([
      { src: 'data:image/svg+xml;base64,AAAA', reason: 'data-url' },
    ]);
    // the data: payload never entered the document; the alt survives as text
    const after = await currentBody(docId);
    expect(after).not.toContain('data:image');
    expect(after).toContain('evil');
    // receipt re-export likewise carries no data: src
    expect(res.body.markdown).not.toContain('data:image');
  });

  test('external image src degrades to a link when storage is disabled; itemized as degraded', async () => {
    // Force the storage-disabled policy path deterministically (no network).
    const s3Images = require('../../server/s3-images');
    const spy = jest.spyOn(s3Images, 'isEnabled').mockReturnValue(false);
    try {
      const { docId, clock, body } = await seedDoc('# Doc\n\nintro');
      const res = await put(docId, fileFor(docId, clock,
        body + '\n\n![pix](https://evil.example/track.png)'));
      await drain();

      expect(res.status).toBe(200);
      expect(res.body.images.degraded).toEqual([
        { src: 'https://evil.example/track.png', reason: 'storage-disabled' },
      ]);
      const after = await currentBody(docId);
      // no image node with the tracking URL as its src survived; it degraded to
      // a link on the alt text (never a browser-loaded external image).
      expect(after).not.toContain('![pix](https://evil.example/track.png)');
      expect(after).toContain('[pix](https://evil.example/track.png)');
    } finally {
      spy.mockRestore();
    }
  });

  test('external image is rehosted to an app URL when the rehost pass succeeds; itemized as rehosted', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\nintro here');
    // Same-doc app URL — a successful fetch-and-store yields THIS doc's URL, so
    // cross-doc reconciliation leaves it untouched.
    const appUrl = `/api/docs/${docId}/images/${'a'.repeat(8)}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
    // Inject a deterministic external pass (no network): rewrite the src to the
    // app URL, exactly as a successful fetch-and-store would.
    setExternalImagePass(async (stagingFragment) => {
      const { findByNodeName } = require('../../server/mcp/sandbox/helpers');
      const imgs = findByNodeName(stagingFragment, 'image');
      const rehosted = [];
      for (const node of imgs) {
        const src = node.getAttribute('src');
        node.setAttribute('src', appUrl);
        rehosted.push({ src, url: appUrl });
      }
      return { rehosted, degraded: [] };
    });
    const res = await put(docId, fileFor(docId, clock,
      body + '\n\n![diagram](https://cdn.example/d.png)'));
    await drain();

    expect(res.status).toBe(200);
    expect(res.body.images.rehosted).toEqual([
      { src: 'https://cdn.example/d.png', url: appUrl },
    ]);
    const after = await currentBody(docId);
    expect(after).toContain(appUrl);
    expect(after).not.toContain('https://cdn.example/d.png');
  });

  test('unparseable markdown degrades (never-lose-content), push proceeds', async () => {
    const { docId, clock, body } = await seedDoc('# Doc\n\ncontent');
    // a pathological unclosed-everything payload — the tolerant parser must not
    // throw; the push proceeds (words survive somewhere in the doc).
    const nasty = body + '\n\n**unclosed [and](broken ` ``` <u><b>nested';
    const res = await put(docId, fileFor(docId, clock, nasty));
    await drain();
    expect(res.status).toBe(200);
    expect(await currentBody(docId)).toContain('unclosed');
  });

  // Feature 019, US4 (T022/FR-022/SC-008): the highest-intent failure —
  // a first-ever sync push with no baseline — must explain the way in, and
  // following that remedy verbatim must yield an accepted push.
  describe('first-sync remedy (sync_baseline_missing)', () => {
    const REMEDY =
      'First sync of this file? Do an initial import with frontmatter=true and '
      + 'write the returned markdown receipt back over the file — it is then a '
      + 'valid sync baseline.';

    test('the 400 body message includes the verbatim remedy sentence', async () => {
      const { docId } = await seedDoc('# Doc\n\nremedy test');
      const res = await put(docId, '# Doc\n\nno frontmatter, no baseline');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('sync_baseline_missing');
      expect(res.body.message).toContain(REMEDY);
    });

    test('following the remedy verbatim yields an accepted sync push (SC-008)', async () => {
      const source = '# Remedy Doc\n\nfirst-ever sync attempt\n';

      // Step 1 (remedy): initial import with frontmatter=true.
      const imported = await request(app)
        .post('/api/docs/import?frontmatter=true')
        .set('Authorization', `Bearer ${patDefault}`)
        .set('Content-Type', 'text/markdown')
        .send(source);
      expect(imported.status).toBe(201);
      const docId = imported.body.docId;
      createdDocIds.push(docId);
      await drain();

      // Step 2 (remedy): "write the returned markdown receipt back over the
      // file" — the receipt is the file now.
      const file = imported.body.markdown;
      expect(file).toContain('squire:');

      // Step 3: an edited copy of that file passes mode=sync.
      const edited = file.replace('first-ever sync attempt', 'first sync now works');
      const res = await put(docId, edited);
      await drain();
      expect(res.status).toBe(200);
      expect(res.body.markdown).toContain('first sync now works');
    });
  });
});
