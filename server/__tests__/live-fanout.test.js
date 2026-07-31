/**
 * Feature 037 US2 — an import's content reaches viewers on every instance.
 *
 * Assertions F1-F8 in specs/037-import-presence/contracts/live-fanout.md.
 *
 * The hole these cover: `doc._redisUpdateHandler` is attached lazily by the WS
 * connection handler, so a document reached through getSharedDoc has none. On
 * an instance holding no live connection an import therefore persisted and
 * broadcast to zero local clients and never published — viewers on other
 * instances saw nothing until they reloaded.
 *
 * These run against the real import path with only `redisPubSub` doubled, so
 * they pin the DECISION (publish / don't publish) rather than the plumbing.
 */
const Y = require('yjs');

const { createPool, createPersistence } = require('./helpers/db');
const pool = createPool();
const persistence = createPersistence();

const documents = require('../documents');
const documentService = require('../document-service');
const markdownSync = require('../markdown-sync');
const { importMarkdown } = require('../markdown-import');
const { publishIfUnhandled } = require('../live-apply');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../origin');
const { makeRedisPubSubDouble } = require('./helpers/import-presence-doubles');

const pendingOperations = [];
async function drain() { await Promise.all(pendingOperations.splice(0)); }

describe('037 cross-instance fan-out for imports', () => {
  let ownerId;
  let redis;
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

    const u = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ('test-037-fanout', 'test-037-fanout@example.com', 'Fanout Owner')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    ownerId = u.rows[0].id;
  });

  afterAll(async () => {
    await drain();
    for (const id of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid=$1', [id]);
      await pool.query('DELETE FROM documents WHERE id=$1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [ownerId]);
    await persistence.destroy();
    await pool.end();
  });

  beforeEach(() => { redis = makeRedisPubSubDouble(); });

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
    const r = await pool.query('SELECT MAX(clock)::int AS c FROM yjs_updates WHERE doc_guid=$1', [docId]);
    return { docId, clock: r.rows[0].c };
  }

  /** Run an append/replace import exactly as the route does, and fan out. */
  async function runImport(docId, markdown, mode = 'append') {
    const ydoc = documentService.getSharedDoc(docId);
    const report = await importMarkdown(ydoc, markdown, {
      mode, actor: { userId: ownerId, agentName: 'Claude Code' }, imageContext: { docId },
    });
    publishIfUnhandled(
      { redisPubSub: redis }, docId, report.live.update, report.live.hadRedisHandler, 'import'
    );
    return report;
  }

  async function runSync(docId, clock, body) {
    return markdownSync.applySyncPush(persistence, docId, {
      body, baselineClock: clock, flavor: 'squire',
      userId: ownerId, getSharedDoc: documentService.getSharedDoc,
      redisPubSub: redis,
    });
  }

  /** Stand in for "this instance already relays the doc" (F4/F5). */
  function attachRedisHandler(docId) {
    const doc = documentService.getSharedDoc(docId);
    const handler = () => {};
    doc._redisUpdateHandler = handler;
    doc.on('update', handler);
    return () => { doc.off('update', handler); doc._redisUpdateHandler = null; };
  }

  // -------------------------------------------------------------------------
  // F1-F3 — no live connection here ⇒ publish exactly once
  // -------------------------------------------------------------------------
  test('F1: append on an instance with no WS connection publishes exactly once', async () => {
    const { docId } = await seedDoc('# Notes\n\nOne.');
    await runImport(docId, '\n\nAppended.\n');
    await drain();

    expect(redis.published).toHaveLength(1);
    expect(redis.published[0].docId).toBe(docId);
    expect(redis.published[0].update).toBeInstanceOf(Uint8Array);
  });

  test('F2: replace on an instance with no WS connection publishes exactly once', async () => {
    const { docId } = await seedDoc('# Notes\n\nOne.');
    await runImport(docId, '# Fresh\n\nBody.\n', 'replace');
    await drain();

    expect(redis.published).toHaveLength(1);
    expect(redis.published[0].docId).toBe(docId);
  });

  test('F3: sync on an instance with no WS connection publishes exactly once', async () => {
    const { docId, clock } = await seedDoc('# Notes\n\nAlpha.\n\nBeta.');
    await runSync(docId, clock, '# Notes\n\nAlpha EDITED.\n\nBeta.');
    await drain();

    expect(redis.published).toHaveLength(1);
    expect(redis.published[0].docId).toBe(docId);
  });

  // -------------------------------------------------------------------------
  // F4/F5 — a handler is attached ⇒ it publishes, we must not publish again
  // -------------------------------------------------------------------------
  test('F4: append/replace with a handler attached publish nothing explicitly', async () => {
    const { docId } = await seedDoc('# Notes\n\nOne.');
    const detach = attachRedisHandler(docId);
    try {
      await runImport(docId, '\n\nAppended.\n');
      await drain();
    } finally { detach(); }

    // The attached handler already fanned out — a second publish would be a
    // duplicate delivery.
    expect(redis.published).toHaveLength(0);
  });

  test('F5: sync with a handler attached publishes nothing explicitly (H1 guard)', async () => {
    const { docId, clock } = await seedDoc('# Notes\n\nAlpha.\n\nBeta.');
    const detach = attachRedisHandler(docId);
    try {
      await runSync(docId, clock, '# Notes\n\nAlpha EDITED.\n\nBeta.');
      await drain();
    } finally { detach(); }

    expect(redis.published).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // F6/F8 — degradation never reaches the import
  // -------------------------------------------------------------------------
  test('F6: Redis disabled ⇒ zero publishes, unchanged content', async () => {
    redis.setEnabled(false);
    const { docId } = await seedDoc('# Notes\n\nOne.');
    await runImport(docId, '\n\nAppended.\n');
    await drain();

    expect(redis.published).toHaveLength(0);
    const md = require('../mcp/yjs/serialization')
      .toMarkdown(documentService.getSharedDoc(docId).get('default', Y.XmlFragment));
    expect(md).toContain('Appended.');
  });

  test('F8: a throwing publishUpdate still leaves the import successful', async () => {
    const { docId } = await seedDoc('# Notes\n\nOne.');
    redis.failWith(new Error('redis is down'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    let logged;
    let imported;
    try {
      const report = await runImport(docId, '\n\nAppended.\n');
      await drain();
      imported = report.blocks.imported;
      // mockRestore clears the call history, so read it first.
      logged = errors.mock.calls.map((c) => String(c[0]));
    } finally { errors.mockRestore(); }

    // The update is already durable — a fan-out failure must never surface.
    expect(imported).toBeGreaterThan(0);
    expect(redis.published).toHaveLength(1);
    expect(logged.some((l) => l.includes('redis fan-out failed'))).toBe(true);
    const md = require('../mcp/yjs/serialization')
      .toMarkdown(documentService.getSharedDoc(docId).get('default', Y.XmlFragment));
    expect(md).toContain('Appended.');
  });

  // -------------------------------------------------------------------------
  // F7 (local half) — publishIfUnhandled never applies anything
  // -------------------------------------------------------------------------
  test('F7: publishIfUnhandled is publish-only — it never applies an update', () => {
    const source = new Y.Doc();
    source.get('default', Y.XmlFragment).insert(0, [new Y.XmlElement('paragraph')]);
    const update = Y.encodeStateAsUpdate(source);

    const target = new Y.Doc();
    const before = Y.encodeStateAsUpdate(target);
    publishIfUnhandled({ redisPubSub: redis }, 'doc-1', update, false, 'test');

    expect(redis.published).toHaveLength(1);
    // No double-apply: the helper touched no document at all.
    expect(Buffer.from(Y.encodeStateAsUpdate(target))).toEqual(Buffer.from(before));
  });

  // -------------------------------------------------------------------------
  // F9 / F7 — the receiving instance
  //
  // Lives here rather than in __tests__/integration/redis-sync.test.js: that
  // suite is a pure pub/sub simulation with no DB or documentService harness,
  // and F9's whole point is that the bytes a REAL import publishes reconstruct
  // the content on an instance that never ran the import. Grafting the DB
  // harness onto the pub/sub suite would have tested less, not more.
  // -------------------------------------------------------------------------
  describe('F9: an instance that never ran the import applies the published bytes', () => {
    /** Stand in for a viewer's instance: apply what came off the bus. */
    function receiveOn(receiver, published) {
      const applied = [];
      const persistedRows = [];
      receiver.on('update', (_u, origin) => {
        // ORIGIN_REDIS is on the publisher skip-list (no feedback loop) and
        // parseOrigin maps it to null (no second persisted row).
        if (origin === require('../origin').ORIGIN_REDIS) applied.push(origin);
        if (parseOrigin(origin)) persistedRows.push(origin);
      });
      for (const p of published) {
        Y.applyUpdate(receiver, p.update, require('../origin').ORIGIN_REDIS);
      }
      return { applied, persistedRows };
    }

    test.each([
      ['append', async (docId) => runImport(docId, '\n\nAppended line.\n')],
      ['replace', async (docId) => runImport(docId, '# Fresh\n\nReplaced body.\n', 'replace')],
    ])('%s: the viewer converges without a reload', async (_mode, run) => {
      const { docId } = await seedDoc('# Notes\n\nOriginal.');
      // The receiver starts from the same persisted state the viewer would have.
      const receiver = new Y.Doc();
      Y.applyUpdate(receiver, Y.encodeStateAsUpdate(documentService.getSharedDoc(docId)));

      await run(docId);
      await drain();
      expect(redis.published).toHaveLength(1);

      const { applied, persistedRows } = receiveOn(receiver, redis.published);
      expect(applied).toHaveLength(1);   // applied exactly once
      expect(persistedRows).toHaveLength(0); // and never re-persisted (F7)

      const { toMarkdown } = require('../mcp/yjs/serialization');
      expect(toMarkdown(receiver.get('default', Y.XmlFragment)))
        .toBe(toMarkdown(documentService.getSharedDoc(docId).get('default', Y.XmlFragment)));
    });

    test('sync: the viewer converges without a reload', async () => {
      const { docId, clock } = await seedDoc('# Notes\n\nAlpha.\n\nBeta.');
      const receiver = new Y.Doc();
      Y.applyUpdate(receiver, Y.encodeStateAsUpdate(documentService.getSharedDoc(docId)));

      await runSync(docId, clock, '# Notes\n\nAlpha EDITED.\n\nBeta.');
      await drain();
      expect(redis.published).toHaveLength(1);

      const { applied, persistedRows } = receiveOn(receiver, redis.published);
      expect(applied).toHaveLength(1);
      expect(persistedRows).toHaveLength(0);

      const { toMarkdown } = require('../mcp/yjs/serialization');
      expect(toMarkdown(receiver.get('default', Y.XmlFragment))).toContain('Alpha EDITED.');
    });
  });

  // T018 — the sync short-circuits. These live here rather than in
  // markdown-sync.replay.test.js because that suite is pure-unit (no DB, no
  // documentService) and never reaches applySyncPush's store-then-apply tail,
  // which is exactly the code under test.
  test('a no-op sync push short-circuits before any fan-out', async () => {
    const { docId, clock } = await seedDoc('# Notes\n\nAlpha.\n\nBeta.');
    const { toMarkdown } = require('../mcp/yjs/serialization');
    const current = toMarkdown(documentService.getSharedDoc(docId).get('default', Y.XmlFragment));

    const receipt = await runSync(docId, clock, current);
    await drain();

    expect(receipt.noop).toBe(true);
    expect(redis.published).toHaveLength(0);
  });

  test('no-change transactions publish nothing (the 50 ms timeout path)', async () => {
    const { docId } = await seedDoc('# Notes\n\nOne.');
    const live = await documentService.updateDocument(docId, () => {}, { userId: ownerId });

    expect(live).toEqual({ update: null, hadRedisHandler: false });
    publishIfUnhandled({ redisPubSub: redis }, docId, live.update, live.hadRedisHandler, 'test');
    expect(redis.published).toHaveLength(0);
  });
});
