/**
 * Feature 017 — content-hash gating of embedding regeneration (US1) and the
 * embedding-model watermark + targeted boot repair (US3).
 *
 * DB-backed suite following search.test.js conventions (shared test DB, serial).
 * The `ai` package is mocked so embedMany is a controllable spy: provider call
 * counts prove the gate (zero calls on unchanged content), a rejection switch
 * proves the no-lost-updates rule (hash advances only with a successful chunk
 * swap), and fake 1536-dim vectors stand in for real embeddings.
 *
 * Gate table: specs/017-search-index-efficiency/contracts/indexer-internal.md
 *
 * AMENDED by feature 018 (DR-1, design-ratified): the title joins the embedded
 * text, so the hash seam widened to buildEmbedHashInput(title, bodyText) and a
 * title-only change now BUSTS the gate (it must re-embed — the stored embedded
 * text leads with the title). Cases 2 and 7 below assert the new behavior;
 * their 017-era assertions (title-independent hash, title change = zero calls)
 * were deliberately inverted per design/content-search.md's Addition.
 */
const cryptoLib = require('crypto');
const Y = require('yjs');
const { createPool, createPersistence, createTestUser, cleanupTestUser } = require('./helpers/db');

const mockEmbedMany = jest.fn();
const mockEmbed = jest.fn();
jest.mock('ai', () => ({
  embedMany: (...args) => mockEmbedMany(...args),
  embed: (...args) => mockEmbed(...args),
}));
jest.mock('@ai-sdk/google', () => ({
  google: { textEmbeddingModel: jest.fn(() => 'mock-embedding-model') },
}));

const searchIndexer = require('../search-indexer');
const searchMod = require('../search');
const { buildEmbedHashInput, computeContentHash, EMBEDDING_MODEL } = searchIndexer;

const fakeVector = () => Array.from({ length: 1536 }, (_, i) => ((i % 7) + 1) * 0.001);

/** Default mock behavior: resolve one fake vector per input value. */
function resolveEmbeddings() {
  mockEmbedMany.mockImplementation(async ({ values }) => ({
    embeddings: values.map(() => fakeVector()),
  }));
}

describe('search indexer content-hash gating (017)', () => {
  let pool;
  let persistence;
  let userId;
  let savedApiKey;
  const liveDocs = new Map(); // docGuid -> local Y.Doc mirror
  const createdDocIds = [];

  beforeAll(async () => {
    savedApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key-017';

    pool = createPool();
    persistence = createPersistence();
    await persistence._init();
    searchIndexer.init(persistence);

    userId = await createTestUser(pool, 'search-gating-017@example.com');
  });

  afterAll(async () => {
    if (savedApiKey === undefined) {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    } else {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = savedApiKey;
    }
    if (createdDocIds.length > 0) {
      await pool.query('DELETE FROM document_embeddings WHERE doc_id = ANY($1)', [createdDocIds]);
      await pool.query('DELETE FROM document_search_index WHERE doc_id = ANY($1)', [createdDocIds]);
      for (const docGuid of createdDocIds) {
        await persistence.clearDocument(docGuid);
      }
      await pool.query('DELETE FROM documents WHERE id = ANY($1)', [createdDocIds]);
    }
    await cleanupTestUser(pool, userId);
    await persistence.destroy();
    await pool.end();
  });

  beforeEach(() => {
    mockEmbedMany.mockReset();
    resolveEmbeddings();
  });

  /** Create a documents row + persisted Yjs doc with a title and body text. */
  async function createDoc(title, body) {
    const docGuid = cryptoLib.randomUUID();
    await pool.query(
      'INSERT INTO documents (id, title, creator_id) VALUES ($1, $2, $3)',
      [docGuid, title, userId]
    );
    const ydoc = new Y.Doc();
    ydoc.getMap('meta').set('title', title);
    if (body) {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText(body)]);
      ydoc.getXmlFragment('default').insert(0, [para]);
    }
    await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(ydoc), userId);
    liveDocs.set(docGuid, ydoc);
    createdDocIds.push(docGuid);
    return docGuid;
  }

  /** Persist the current local Y.Doc state for docGuid. */
  async function syncDoc(docGuid) {
    await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(liveDocs.get(docGuid)), userId);
  }

  function setTitle(docGuid, title) {
    liveDocs.get(docGuid).getMap('meta').set('title', title);
  }

  function setBody(docGuid, body) {
    const frag = liveDocs.get(docGuid).getXmlFragment('default');
    frag.delete(0, frag.length);
    if (body) {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText(body)]);
      frag.insert(0, [para]);
    }
  }

  async function getIndexRow(docGuid) {
    const r = await pool.query(
      `SELECT content_hash, content_text, indexed_at::text AS indexed_at
       FROM document_search_index WHERE doc_id = $1`,
      [docGuid]
    );
    return r.rows[0];
  }

  async function getChunks(docGuid) {
    const r = await pool.query(
      `SELECT id, chunk_index, chunk_text, embedding_model
       FROM document_embeddings WHERE doc_id = $1 ORDER BY chunk_index`,
      [docGuid]
    );
    return r.rows;
  }

  async function ftsMatches(docGuid, word) {
    const r = await pool.query(
      `SELECT search_vector @@ websearch_to_tsquery('english', $2) AS m
       FROM document_search_index WHERE doc_id = $1`,
      [docGuid, word]
    );
    return r.rows[0].m;
  }

  describe('gate semantics (US1)', () => {
    test('case 1: first index embeds and stores a 64-char hex content_hash', async () => {
      const docGuid = await createDoc('Gating One', 'the quick brown fox jumps over the lazy dog');
      await searchIndexer.indexDocument(docGuid);

      expect(mockEmbedMany).toHaveBeenCalledTimes(1);
      const row = await getIndexRow(docGuid);
      expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
      const chunks = await getChunks(docGuid);
      expect(chunks.length).toBe(1);
    });

    test('case 2 (018 DR-1): title-only change → BUSTS the gate: one regeneration, hash advances, embedded text leads with the new title', async () => {
      const docGuid = await createDoc('Original Title', 'stable body text about penguins and glaciers');
      await searchIndexer.indexDocument(docGuid);
      const before = await getIndexRow(docGuid);
      mockEmbedMany.mockClear();

      setTitle(docGuid, 'Zebra Renamed Title');
      await syncDoc(docGuid);
      await searchIndexer.indexDocument(docGuid);

      // The title is part of the embedded text (DR-1), so a title change must
      // re-embed — exactly once.
      expect(mockEmbedMany).toHaveBeenCalledTimes(1);
      const after = await getIndexRow(docGuid);
      expect(after.content_hash).not.toBe(before.content_hash);
      expect(after.content_hash).toBe(
        computeContentHash(buildEmbedHashInput('Zebra Renamed Title', after.content_text))
      );
      // FTS row refreshed: new title findable, freshness watermark advanced
      expect(await ftsMatches(docGuid, 'zebra')).toBe(true);
      expect(after.indexed_at >= before.indexed_at).toBe(true);
      expect(after.indexed_at).not.toBe(before.indexed_at);
      // The stored embedded text now leads with the new title
      const embedded = await pool.query(
        'SELECT embedded_text FROM document_embeddings WHERE doc_id = $1', [docGuid]
      );
      for (const row of embedded.rows) {
        expect(row.embedded_text.startsWith('Zebra Renamed Title')).toBe(true);
      }

      // A second pass with nothing changed is gated again: zero calls
      mockEmbedMany.mockClear();
      await searchIndexer.indexDocument(docGuid);
      expect(mockEmbedMany).not.toHaveBeenCalled();
    });

    test('case 3: body change → exactly one regeneration, hash advances to the new text hash', async () => {
      const docGuid = await createDoc('Body Change Doc', 'first draft of the essay');
      await searchIndexer.indexDocument(docGuid);
      const before = await getIndexRow(docGuid);
      mockEmbedMany.mockClear();

      setBody(docGuid, 'second draft of the essay with much better arguments');
      await syncDoc(docGuid);
      await searchIndexer.indexDocument(docGuid);

      expect(mockEmbedMany).toHaveBeenCalledTimes(1);
      const after = await getIndexRow(docGuid);
      expect(after.content_hash).not.toBe(before.content_hash);
      expect(after.content_hash).toBe(computeContentHash(buildEmbedHashInput('Body Change Doc', after.content_text)));
    });

    test('case 4: embed failure → chunks untouched, hash NOT advanced, fulltext still works; next pass retries and succeeds', async () => {
      const docGuid = await createDoc('Failure Doc', 'original resilient body text');
      await searchIndexer.indexDocument(docGuid);
      const before = await getIndexRow(docGuid);
      const chunksBefore = await getChunks(docGuid);
      mockEmbedMany.mockClear();

      setBody(docGuid, 'updated wonderful body text that fails to embed');
      await syncDoc(docGuid);
      mockEmbedMany.mockRejectedValueOnce(new Error('provider down'));
      await searchIndexer.indexDocument(docGuid);

      expect(mockEmbedMany).toHaveBeenCalledTimes(1);
      const afterFail = await getIndexRow(docGuid);
      expect(afterFail.content_hash).toBe(before.content_hash); // not advanced
      expect(await getChunks(docGuid)).toEqual(chunksBefore); // rollback: untouched
      expect(await ftsMatches(docGuid, 'wonderful')).toBe(true); // FTS refreshed regardless

      // Next indexing pass detects the mismatch and succeeds
      mockEmbedMany.mockClear();
      await searchIndexer.indexDocument(docGuid);
      expect(mockEmbedMany).toHaveBeenCalledTimes(1);
      const afterRetry = await getIndexRow(docGuid);
      expect(afterRetry.content_hash).toBe(computeContentHash(buildEmbedHashInput('Failure Doc', afterRetry.content_text)));
      expect(afterRetry.content_hash).not.toBe(before.content_hash);
    });

    test('case 5: emptied body → chunks deleted, hash advances; further no-change passes cost nothing', async () => {
      const docGuid = await createDoc('Emptied Doc', 'text that will be deleted entirely soon');
      await searchIndexer.indexDocument(docGuid);
      expect((await getChunks(docGuid)).length).toBe(1);
      mockEmbedMany.mockClear();

      setBody(docGuid, null);
      await syncDoc(docGuid);
      await searchIndexer.indexDocument(docGuid);

      expect(mockEmbedMany).not.toHaveBeenCalled();
      expect((await getChunks(docGuid)).length).toBe(0); // ghost chunks removed (CN-6)
      const settled = await getIndexRow(docGuid);
      expect(settled.content_hash).toBe(computeContentHash(buildEmbedHashInput('Emptied Doc', '')));

      // Second no-change pass: zero provider calls AND no delete transaction
      const connectSpy = jest.spyOn(pool, 'connect');
      await searchIndexer.indexDocument(docGuid);
      expect(mockEmbedMany).not.toHaveBeenCalled();
      expect(connectSpy).not.toHaveBeenCalled(); // settled: no repeated cleanup
      connectSpy.mockRestore();
      expect((await getIndexRow(docGuid)).content_hash).toBe(settled.content_hash);
    });

    test('case 6: no API key + changed content → zero calls, hash NOT advanced', async () => {
      const docGuid = await createDoc('Disabled Embeddings Doc', 'body before the key disappears');
      await searchIndexer.indexDocument(docGuid);
      const before = await getIndexRow(docGuid);
      mockEmbedMany.mockClear();

      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      try {
        setBody(docGuid, 'body changed while embeddings are disabled');
        await syncDoc(docGuid);
        await searchIndexer.indexDocument(docGuid);

        expect(mockEmbedMany).not.toHaveBeenCalled();
        const after = await getIndexRow(docGuid);
        expect(after.content_hash).toBe(before.content_hash); // CN-4: never recorded as done
      } finally {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key-017';
      }
    });

    test('case 7 (CN-7 seam, 018 DR-1): stored hash equals the seam output and is TITLE-AWARE', async () => {
      const body = 'identical body text shared by two differently titled documents';
      const docA = await createDoc('Title Alpha', body);
      const docB = await createDoc('Completely Different Beta', body);
      await searchIndexer.indexDocument(docA);
      await searchIndexer.indexDocument(docB);

      const rowA = await getIndexRow(docA);
      const rowB = await getIndexRow(docB);
      // The gate consumes ONLY the seam function's output
      expect(rowA.content_hash).toBe(computeContentHash(buildEmbedHashInput('Title Alpha', rowA.content_text)));
      expect(rowB.content_hash).toBe(computeContentHash(buildEmbedHashInput('Completely Different Beta', rowB.content_text)));
      // Same body, DIFFERENT titles → different seam output → different hash
      // (DR-1: the title is embedded, so it must be fingerprinted)
      expect(rowA.content_text).toBe(rowB.content_text);
      expect(rowA.content_hash).not.toBe(rowB.content_hash);
    });

    test('case 8: pre-feature row (content_hash IS NULL) regenerates on next pass', async () => {
      const docGuid = await createDoc('Pre Feature Doc', 'content indexed before feature 017 existed');
      await searchIndexer.indexDocument(docGuid);
      await pool.query('UPDATE document_search_index SET content_hash = NULL WHERE doc_id = $1', [docGuid]);
      mockEmbedMany.mockClear();

      await searchIndexer.indexDocument(docGuid);

      expect(mockEmbedMany).toHaveBeenCalledTimes(1);
      const row = await getIndexRow(docGuid);
      expect(row.content_hash).toBe(computeContentHash(buildEmbedHashInput('Pre Feature Doc', row.content_text)));
    });
  });

  describe('model watermark + targeted boot repair (US3)', () => {
    const HEX64 = /^[0-9a-f]{64}$/;

    async function flipModel(docGuid, model) {
      await pool.query('UPDATE document_embeddings SET embedding_model = $2 WHERE doc_id = $1', [docGuid, model]);
    }

    async function bumpUpdatedAt(docGuid) {
      // The documents BEFORE UPDATE trigger sets updated_at = now()
      await pool.query('UPDATE documents SET title = title WHERE id = $1', [docGuid]);
    }

    test('watermark 1: chunk inserts list embedding_model explicitly, not via column default (FR-009)', async () => {
      // Discriminating setup: point the column default somewhere else — an
      // insert relying on the default would record the sentinel, an explicit
      // insert records the configured model.
      await pool.query(`ALTER TABLE document_embeddings ALTER COLUMN embedding_model SET DEFAULT 'default-model-sentinel'`);
      try {
        const docGuid = await createDoc('Watermark Fresh Doc', 'fresh body text for the watermark write test');
        await searchIndexer.indexDocument(docGuid);
        const chunks = await getChunks(docGuid);
        expect(chunks.length).toBe(1);
        for (const chunk of chunks) {
          expect(chunk.embedding_model).toBe(EMBEDDING_MODEL);
        }
      } finally {
        await pool.query(`ALTER TABLE document_embeddings ALTER COLUMN embedding_model SET DEFAULT 'gemini-embedding-001'`);
      }
    });

    test('watermark 2: model staleness overrides the hash gate — re-embed despite equal hash (CN-5, FR-011)', async () => {
      const docGuid = await createDoc('Override Doc', 'unchanged body that must re-embed on model staleness');
      await searchIndexer.indexDocument(docGuid);
      const before = await getIndexRow(docGuid);
      await flipModel(docGuid, 'old-model-test');
      mockEmbedMany.mockClear();

      await searchIndexer.indexDocument(docGuid); // content unchanged

      expect(mockEmbedMany).toHaveBeenCalledTimes(1); // override beats the gate
      const chunks = await getChunks(docGuid);
      expect(chunks.length).toBe(1);
      for (const chunk of chunks) {
        expect(chunk.embedding_model).toBe(EMBEDDING_MODEL);
      }
      expect((await getIndexRow(docGuid)).content_hash).toBe(before.content_hash); // same text, same hash
    });

    // reindexStale() scans this worker's WHOLE database, so documents left
    // behind by any suite that ran earlier on the same worker can inflate the
    // global embed-call counts asserted below. Heal first, so only THIS suite's
    // fixtures are repair-eligible (post-merge review F4; extended by 052).
    //
    // The heal must cover every branch of reindexStale's predicate, or it
    // silently covers only some leftovers. There are three.
    async function healStragglers() {
      // Branch 1: `si.doc_id IS NULL` — a leftover document with no index row
      // at all. Give it one, dated now, so it is not repair-eligible. This is
      // the branch that was missing, and it is the expensive one: each such
      // document costs a full embed cycle.
      await pool.query(
        `INSERT INTO document_search_index (doc_id, indexed_at)
         SELECT d.id, now() FROM documents d
         LEFT JOIN document_search_index si ON si.doc_id = d.id
         WHERE si.doc_id IS NULL`
      );
      // Branch 2: `si.indexed_at < d.updated_at` — an index row older than its
      // document.
      await pool.query(
        `UPDATE document_search_index SET indexed_at = now()
         WHERE doc_id IN (SELECT id FROM documents)`
      );
      // Branch 3: a chunk row on the wrong model, or (per 018's legacy
      // predicate) with no embedded_text — both make their document repair-
      // eligible however fresh its index row is.
      await pool.query('UPDATE document_embeddings SET embedding_model = $1', [EMBEDDING_MODEL]);
      await pool.query('DELETE FROM document_embeddings WHERE embedded_text IS NULL');
    }

    test('watermark 3: reindexStale selects missing-row, edit-stale, and model-stale docs — fresh docs cost zero calls (FR-010/011, SC-002)', async () => {
      await healStragglers();
      const docFresh = await createDoc('Repair Fresh', 'fresh fully matched document body');
      await searchIndexer.indexDocument(docFresh);
      const docModelStale = await createDoc('Repair Model Stale', 'model stale document body');
      await searchIndexer.indexDocument(docModelStale);
      await flipModel(docModelStale, 'old-model-test');
      const docEditStale = await createDoc('Repair Edit Stale', 'edit stale document body');
      await searchIndexer.indexDocument(docEditStale);
      await bumpUpdatedAt(docEditStale); // updated_at > indexed_at, content unchanged
      const docMissing = await createDoc('Repair Missing', 'never indexed document body');

      const freshBefore = await getIndexRow(docFresh);
      const editStaleBefore = await getIndexRow(docEditStale);
      mockEmbedMany.mockClear();

      await searchIndexer.reindexStale();

      // Exactly two embed cycles: the missing doc and the model-stale doc.
      // The edit-stale doc is selected but hash-gated (0 calls); the fresh doc
      // is not selected at all.
      expect(mockEmbedMany).toHaveBeenCalledTimes(2);
      expect((await getIndexRow(docMissing)).content_hash).toMatch(HEX64);
      for (const chunk of await getChunks(docModelStale)) {
        expect(chunk.embedding_model).toBe(EMBEDDING_MODEL);
      }
      const editStaleAfter = await getIndexRow(docEditStale);
      expect(editStaleAfter.indexed_at).not.toBe(editStaleBefore.indexed_at); // selected + refreshed
      expect((await getIndexRow(docFresh)).indexed_at).toBe(freshBefore.indexed_at); // untouched
    });

    test('watermark 4: NULL embedding_model counts as stale (IS DISTINCT FROM)', async () => {
      const docGuid = await createDoc('Null Model Doc', 'body whose chunk rows lose their model id');
      await searchIndexer.indexDocument(docGuid);
      await flipModel(docGuid, null);
      mockEmbedMany.mockClear();

      await searchIndexer.reindexStale();

      expect(mockEmbedMany).toHaveBeenCalledTimes(1);
      for (const chunk of await getChunks(docGuid)) {
        expect(chunk.embedding_model).toBe(EMBEDDING_MODEL);
      }
    });

    test('watermark 5: a doc both edit-stale and model-stale is processed once — one embed cycle', async () => {
      const docGuid = await createDoc('Doubly Stale Doc', 'first body of the doubly stale document');
      await searchIndexer.indexDocument(docGuid);
      await flipModel(docGuid, 'old-model-test');
      setBody(docGuid, 'second body of the doubly stale document with edits');
      await syncDoc(docGuid);
      await bumpUpdatedAt(docGuid);
      mockEmbedMany.mockClear();

      await searchIndexer.reindexStale();

      expect(mockEmbedMany).toHaveBeenCalledTimes(1); // converges in a single pass
      const row = await getIndexRow(docGuid);
      expect(row.content_hash).toBe(computeContentHash(buildEmbedHashInput('Doubly Stale Doc', row.content_text)));
      for (const chunk of await getChunks(docGuid)) {
        expect(chunk.embedding_model).toBe(EMBEDDING_MODEL);
      }
    });

    test('watermark 6: mixed-model rows stay queryable mid-repair (FR-012)', async () => {
      const docA = await createDoc('Mixed Flamingo Alpha', 'flamingo colony report from the north lagoon');
      const docB = await createDoc('Mixed Flamingo Beta', 'flamingo colony report from the south lagoon');
      await searchIndexer.indexDocument(docA);
      await searchIndexer.indexDocument(docB);
      await flipModel(docA, 'old-model-test'); // simulated mid-repair state
      for (const docGuid of [docA, docB]) {
        await pool.query(
          `INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)`,
          [docGuid, userId]
        );
      }
      searchMod.init(pool);
      searchMod._resetCache();
      mockEmbed.mockImplementation(async () => ({ embedding: fakeVector() }));

      const fulltext = await searchMod.searchDocuments(userId, 'flamingo', { mode: 'fulltext' });
      expect(fulltext.rows.map((r) => r.doc_id).sort()).toEqual([docA, docB].sort());

      const semantic = await searchMod.searchDocuments(userId, 'flamingo colonies', { mode: 'semantic' });
      expect(semantic.rows.map((r) => r.doc_id).sort()).toEqual([docA, docB].sort());

      // Settle the simulated repair so the idempotency test below starts clean
      await searchIndexer.reindexStale();
      searchMod._resetCache();
    });

    test('watermark 7: second boot after a completed repair does zero embedding work (SC-002)', async () => {
      await healStragglers(); // guard against leaked stale fixtures (review F4)
      await searchIndexer.reindexStale();
      mockEmbedMany.mockClear();
      await searchIndexer.reindexStale();
      expect(mockEmbedMany).not.toHaveBeenCalled();
    });
  });

  describe('hash seam unit behavior (CN-7)', () => {
    test('computeContentHash is deterministic sha256 hex (64 chars)', () => {
      const a = computeContentHash('hello world');
      const b = computeContentHash('hello world');
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(computeContentHash('hello worlds')).not.toBe(a);
      expect(a).toBe(cryptoLib.createHash('sha256').update('hello world', 'utf8').digest('hex'));
    });

    test('buildEmbedHashInput is title + \\n + body since 018 (DR-1)', () => {
      expect(buildEmbedHashInput('A Title', 'some extracted text')).toBe('A Title\nsome extracted text');
      expect(buildEmbedHashInput('', '')).toBe('\n');
    });
  });
});
