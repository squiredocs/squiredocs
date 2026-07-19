/**
 * Tests for the search indexer module
 */
const crypto = require('crypto');
const Y = require('yjs');
const { createPool, createPersistence, createTestUser, cleanupTestUser } = require('./helpers/db');

// Mock the ai SDK: embedMany is a controllable spy (fake 1536-dim vectors),
// so pipeline tests prove provider-call counts without any provider.
const mockEmbedMany = jest.fn();
const mockEmbed = jest.fn();
const mockGenerateObject = jest.fn();
jest.mock('ai', () => ({
  embedMany: (...args) => mockEmbedMany(...args),
  embed: (...args) => mockEmbed(...args),
  generateObject: (...args) => mockGenerateObject(...args),
  jsonSchema: (s) => s,
}));
jest.mock('@ai-sdk/google', () => ({
  google: { textEmbeddingModel: jest.fn(() => 'mock-embedding-model') },
}));
// The contextualizer reaches its model through the chat-models registry; mock
// the registry so preamble-path tests never construct a real provider client.
jest.mock('../api/chat-models', () => ({
  getContextualizerModel: jest.fn(() => 'mock-contextualizer-model'),
}));

const searchIndexer = require('../search-indexer');
const searchMod = require('../search');
const { chunkText, buildEmbedHashInput, computeContentHash, EMBEDDING_MODEL } = searchIndexer;

const fakeVector = () => Array.from({ length: 1536 }, (_, i) => ((i % 5) + 1) * 0.001);

function resolveEmbeddings() {
  mockEmbedMany.mockImplementation(async ({ values }) => ({
    embeddings: values.map(() => fakeVector()),
  }));
}

describe('chunkText', () => {
  test('returns single chunk for short text', () => {
    const text = 'Hello world';
    const chunks = chunkText(text);
    expect(chunks).toEqual(['Hello world']);
  });

  test('returns empty array for empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText(null)).toEqual([]);
    expect(chunkText(undefined)).toEqual([]);
  });

  test('returns single chunk when text equals chunk size', () => {
    const text = 'a'.repeat(6000);
    const chunks = chunkText(text);
    expect(chunks).toEqual([text]);
  });

  test('splits text into overlapping chunks', () => {
    // 10000 chars with 6000 chunk size and 500 overlap = 5500 step
    // chunk 0: 0-6000, chunk 1: 5500-11500 (but text is 10000, so 5500-10000)
    const text = 'a'.repeat(10000);
    const chunks = chunkText(text, 6000, 500);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(6000);
    expect(chunks[1].length).toBe(4500); // 10000 - 5500
  });

  test('skips chunks shorter than minimum length', () => {
    // chunkSize=5500, overlap=500, step=5000
    // text=10050: i=0 => 5500 chars, i=5000 => 5050 chars, i=10000 => 50 chars (<100, skipped)
    const text = 'a'.repeat(10050);
    const chunks = chunkText(text, 5500, 500);
    expect(chunks.length).toBe(2);

    // Verify the 50-char trailing fragment was indeed skipped
    expect(chunks[0].length).toBe(5500);
    expect(chunks[1].length).toBe(5050);
  });

  test('chunks overlap correctly', () => {
    const text = 'abcdefghij'.repeat(1000); // 10000 chars
    const chunks = chunkText(text, 6000, 500);

    // The end of chunk 0 should match the start of chunk 1
    const overlap0End = chunks[0].slice(-500);
    const overlap1Start = chunks[1].slice(0, 500);
    expect(overlap0End).toBe(overlap1Start);
  });

  test('handles custom chunk size and overlap', () => {
    const text = 'x'.repeat(1000);
    const chunks = chunkText(text, 300, 50);
    // step = 250, so chunks at 0, 250, 500, 750
    expect(chunks.length).toBe(4);
    expect(chunks[0].length).toBe(300);
    expect(chunks[1].length).toBe(300);
    expect(chunks[2].length).toBe(300);
    expect(chunks[3].length).toBe(250); // 1000 - 750
  });
});

// ————————————————————————————————————————————————————————————————————————
// Feature 018 Phase 2 (T006): migration 1798000000000_chunk-structure-columns
// Legacy-shaped inserts (only doc_id/chunk_index/chunk_text/embedding) must
// still succeed with every new column NULL — the rollout discriminator is
// `embedded_text IS NULL` (contracts/chunk-record.md).
// ————————————————————————————————————————————————————————————————————————
describe('chunk-structure-columns migration (018 T006)', () => {
  let pool;
  let userId;
  let docId;

  beforeAll(async () => {
    pool = createPool();
    userId = await createTestUser(pool, 'search-migration-018@example.com');
    docId = crypto.randomUUID();
    await pool.query(
      'INSERT INTO documents (id, title, creator_id) VALUES ($1, $2, $3)',
      [docId, 'Migration Shape Doc', userId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM document_embeddings WHERE doc_id = $1', [docId]);
    await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    await cleanupTestUser(pool, userId);
    await pool.end();
  });

  test('legacy-shaped insert succeeds; new columns are NULL (rollout discriminator)', async () => {
    await pool.query(
      `INSERT INTO document_embeddings (doc_id, chunk_index, chunk_text, embedding)
       VALUES ($1, 0, $2, $3)`,
      [docId, 'legacy fixed-window chunk text', JSON.stringify(fakeVector())]
    );
    const r = await pool.query(
      `SELECT heading_path, preamble_text, embedded_text, token_estimate, search_vector,
              (embedded_text IS NULL) AS is_legacy
       FROM document_embeddings WHERE doc_id = $1`,
      [docId]
    );
    expect(r.rows.length).toBe(1);
    const row = r.rows[0];
    expect(row.heading_path).toBeNull();
    expect(row.preamble_text).toBeNull();
    expect(row.embedded_text).toBeNull();
    expect(row.token_estimate).toBeNull();
    expect(row.search_vector).toBeNull();
    expect(row.is_legacy).toBe(true);
  });

  test('new-scheme insert stores all chunk-record contract fields', async () => {
    await pool.query(
      `INSERT INTO document_embeddings
         (doc_id, chunk_index, chunk_text, embedding, embedding_model,
          heading_path, preamble_text, embedded_text, token_estimate, search_vector)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, to_tsvector('english', $7))`,
      [
        docId,
        'new scheme chunk body',
        JSON.stringify(fakeVector()),
        'gemini-embedding-001',
        ['Operations Runbook', 'Deployment'],
        'This chunk covers the rollback procedure.',
        'Doc Title > Operations Runbook > Deployment\nnew scheme chunk body',
        16,
      ]
    );
    const r = await pool.query(
      `SELECT heading_path, preamble_text, token_estimate,
              search_vector @@ websearch_to_tsquery('english', 'deployment') AS chunk_kw_match
       FROM document_embeddings WHERE doc_id = $1 AND chunk_index = 1`,
      [docId]
    );
    expect(r.rows[0].heading_path).toEqual(['Operations Runbook', 'Deployment']);
    expect(r.rows[0].preamble_text).toContain('rollback');
    expect(r.rows[0].token_estimate).toBe(16);
    expect(r.rows[0].chunk_kw_match).toBe(true);
  });

  test('GIN index on search_vector exists', async () => {
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'document_embeddings' AND indexname = 'idx_embeddings_search_vector_gin'`
    );
    expect(r.rows.length).toBe(1);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Feature 018 US1 — indexer pipeline integration (T011) and rollout
// continuity (T012). DB-backed, following search-indexer-gating conventions.
// Preambles are disabled here (SEARCH_PREAMBLES=off) — the preamble gating
// tests live in their own describe (T019); this block proves the structure
// pipeline itself.
// ————————————————————————————————————————————————————————————————————————
describe('structure-aware indexing pipeline (018 T011/T012)', () => {
  let pool;
  let persistence;
  let userId;
  let savedApiKey;
  let savedPreambles;
  const liveDocs = new Map();
  const createdDocIds = [];

  beforeAll(async () => {
    savedApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key-018';
    savedPreambles = process.env.SEARCH_PREAMBLES;
    process.env.SEARCH_PREAMBLES = 'off';

    pool = createPool();
    persistence = createPersistence();
    await persistence._init();
    searchIndexer.init(persistence);
    userId = await createTestUser(pool, 'search-pipeline-018@example.com');
  });

  afterAll(async () => {
    if (savedApiKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = savedApiKey;
    if (savedPreambles === undefined) delete process.env.SEARCH_PREAMBLES;
    else process.env.SEARCH_PREAMBLES = savedPreambles;

    if (createdDocIds.length > 0) {
      await pool.query('DELETE FROM document_embeddings WHERE doc_id = ANY($1)', [createdDocIds]);
      await pool.query('DELETE FROM document_search_index WHERE doc_id = ANY($1)', [createdDocIds]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = ANY($1)', [createdDocIds]);
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
    mockEmbed.mockReset();
    resolveEmbeddings();
  });

  /** Build Yjs blocks: strings become paragraphs; {h: level, text} become headings. */
  function buildBlocks(frag, blocks) {
    const els = blocks.map((b) => {
      if (typeof b === 'string') {
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [new Y.XmlText(b)]);
        return para;
      }
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', String(b.h));
      heading.insert(0, [new Y.XmlText(b.text)]);
      return heading;
    });
    frag.insert(0, els);
  }

  async function createDoc(title, blocks) {
    const docGuid = crypto.randomUUID();
    await pool.query(
      'INSERT INTO documents (id, title, creator_id) VALUES ($1, $2, $3)',
      [docGuid, title, userId]
    );
    const ydoc = new Y.Doc();
    ydoc.getMap('meta').set('title', title);
    if (blocks && blocks.length) buildBlocks(ydoc.getXmlFragment('default'), blocks);
    await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(ydoc), userId);
    liveDocs.set(docGuid, ydoc);
    createdDocIds.push(docGuid);
    return docGuid;
  }

  async function setBlocks(docGuid, blocks) {
    const ydoc = liveDocs.get(docGuid);
    const frag = ydoc.getXmlFragment('default');
    frag.delete(0, frag.length);
    buildBlocks(frag, blocks);
    await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(ydoc), userId);
  }

  async function getChunks(docGuid) {
    const r = await pool.query(
      `SELECT chunk_index, chunk_text, heading_path, preamble_text, embedded_text,
              token_estimate, embedding_model,
              (search_vector IS NOT NULL) AS has_vector
       FROM document_embeddings WHERE doc_id = $1 ORDER BY chunk_index`,
      [docGuid]
    );
    return r.rows;
  }

  async function getHash(docGuid) {
    const r = await pool.query('SELECT content_hash FROM document_search_index WHERE doc_id = $1', [docGuid]);
    return r.rows[0] && r.rows[0].content_hash;
  }

  const longSection = (tag) =>
    Array.from({ length: 40 }, (_, i) => `This is sentence ${i + 1} about ${tag} with plenty of detail.`).join(' ');

  test('T011a: indexDocument writes new-scheme rows — trails, title-headed embedded_text, tokens, vectors, model (FR-008/FR-009)', async () => {
    const docGuid = await createDoc('Ops Runbook', [
      { h: 1, text: 'Operations' },
      longSection('operations overview'),
      { h: 2, text: 'Deployment' },
      longSection('deployment steps'),
    ]);
    await searchIndexer.indexDocument(docGuid);

    const chunks = await getChunks(docGuid);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(Array.isArray(chunk.heading_path)).toBe(true);
      expect(chunk.embedded_text).not.toBeNull();
      expect(chunk.embedded_text.startsWith('Ops Runbook')).toBe(true);
      const headerLine = chunk.embedded_text.split('\n')[0];
      expect(headerLine).toBe(['Ops Runbook', ...chunk.heading_path].join(' > '));
      expect(chunk.token_estimate).toBeGreaterThan(0);
      expect(chunk.has_vector).toBe(true);
      expect(chunk.embedding_model).toBe(EMBEDDING_MODEL);
      // chunk_text is raw document-authored text: no header, no title prefix
      expect(chunk.chunk_text.startsWith('Ops Runbook >')).toBe(false);
    }
    const paths = chunks.map((c) => c.heading_path);
    expect(paths).toContainEqual(['Operations']);
    expect(paths).toContainEqual(['Operations', 'Deployment']);
    // What was embedded is the composed embedded_text, not bare chunk text
    const embeddedValues = mockEmbedMany.mock.calls.flatMap(([{ values }]) => values);
    expect(embeddedValues.length).toBe(chunks.length);
    for (const v of embeddedValues) {
      expect(v.startsWith('Ops Runbook')).toBe(true);
    }
  });

  test('T011b: whole-set swap is transactional — mid-swap INSERT failure leaves the complete OLD set serving (FR-010, RBD-7)', async () => {
    const docGuid = await createDoc('Swap Doc', [
      { h: 1, text: 'Alpha' },
      longSection('alpha material'),
      { h: 1, text: 'Beta' },
      longSection('beta material'),
    ]);
    await searchIndexer.indexDocument(docGuid);
    const before = await getChunks(docGuid);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const hashBefore = await getHash(docGuid);

    // New content whose SECOND chunk trips a sentinel insert failure
    await setBlocks(docGuid, [
      { h: 1, text: 'Alpha' },
      longSection('replacement alpha'),
      { h: 1, text: 'Beta' },
      `${longSection('replacement beta')} FAILSWAP sentinel.`,
    ]);
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_on_sentinel() RETURNS trigger AS $$
      BEGIN
        IF NEW.chunk_text LIKE '%FAILSWAP%' THEN
          RAISE EXCEPTION 'sentinel insert failure';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await pool.query(`
      CREATE TRIGGER trg_fail_sentinel BEFORE INSERT ON document_embeddings
      FOR EACH ROW EXECUTE FUNCTION fail_on_sentinel()`);
    try {
      await searchIndexer.indexDocument(docGuid); // swap fails mid-INSERT, must roll back
      const after = await getChunks(docGuid);
      expect(after).toEqual(before); // complete old set still serves
      expect(await getHash(docGuid)).toBe(hashBefore); // hash not advanced
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS trg_fail_sentinel ON document_embeddings');
      await pool.query('DROP FUNCTION IF EXISTS fail_on_sentinel');
    }

    // With the fault removed, the next pass completes the swap
    await searchIndexer.indexDocument(docGuid);
    const swapped = await getChunks(docGuid);
    expect(swapped.map((c) => c.chunk_text).join(' ')).toContain('replacement alpha');
    expect(await getHash(docGuid)).not.toBe(hashBefore);
  });

  test('T011c: unchanged title+body re-persist ⇒ zero embedding calls (017 gate intact, SC-007)', async () => {
    const docGuid = await createDoc('Gate Doc', [{ h: 1, text: 'Only' }, 'stable body text.']);
    await searchIndexer.indexDocument(docGuid);
    expect(mockEmbedMany).toHaveBeenCalledTimes(1);
    mockEmbedMany.mockClear();

    await searchIndexer.indexDocument(docGuid);
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });

  test('T011d: empty doc ⇒ zero chunk rows, FTS row maintained (edge case)', async () => {
    const docGuid = await createDoc('Empty Doc', []);
    await searchIndexer.indexDocument(docGuid);
    expect((await getChunks(docGuid)).length).toBe(0);
    const fts = await pool.query('SELECT 1 FROM document_search_index WHERE doc_id = $1', [docGuid]);
    expect(fts.rows.length).toBe(1);
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });

  test('T011e (017-F3): backfill-path default hash equals indexDocument-path hash — no doubled re-embed', async () => {
    const { toStructured, toPlainText } = require('../mcp/yjs/serialization');
    const docGuid = await createDoc('Backfill Parity Doc', [{ h: 1, text: 'Body' }, 'backfill parity content.']);
    const ydoc = liveDocs.get(docGuid);
    const frag = ydoc.getXmlFragment('default');
    const contentText = toPlainText(frag);
    const nodes = toStructured(frag);

    // The real backfill only ever selects docs that already have an FTS row —
    // seed it first, exactly as production state would be.
    await pool.query(
      `INSERT INTO document_search_index (doc_id, content_text, search_vector)
       VALUES ($1, $2, to_tsvector('english', $2)) ON CONFLICT (doc_id) DO NOTHING`,
      [docGuid, contentText]
    );
    // Backfill path: generateAndStoreEmbeddings without an explicit hash —
    // the default-param producer must be title-aware (017 review finding F3).
    await searchIndexer.generateAndStoreEmbeddings(docGuid, { title: 'Backfill Parity Doc', contentText, nodes });
    const storedHash = await getHash(docGuid);
    expect(storedHash).toBe(computeContentHash(buildEmbedHashInput('Backfill Parity Doc', contentText)));

    // The very next indexDocument pass must be a no-op (hash parity)
    mockEmbedMany.mockClear();
    await searchIndexer.indexDocument(docGuid);
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });

  describe('rollout continuity (T012, FR-011/SC-012)', () => {
    let docLegacy;
    let docFresh;

    async function simulateLegacy(docGuid, bodyText) {
      // Rewind the doc's rows to the pre-018 shape: fixed-window columns only,
      // hash computed body-only (the 017 producer) — exactly what a pre-018
      // deploy leaves behind.
      await pool.query(
        `UPDATE document_embeddings
         SET heading_path = NULL, preamble_text = NULL, embedded_text = NULL,
             token_estimate = NULL, search_vector = NULL
         WHERE doc_id = $1`,
        [docGuid]
      );
      await pool.query(
        'UPDATE document_search_index SET content_hash = $2 WHERE doc_id = $1',
        [docGuid, computeContentHash(bodyText)]
      );
    }

    beforeAll(async () => {
      docLegacy = await createDoc('Legacy Rollout Doc', [
        { h: 1, text: 'Legacy Heading' },
        'legacy walrus content that was indexed under the fixed-window scheme.',
      ]);
      await searchIndexer.indexDocument(docLegacy);
      await simulateLegacy(docLegacy, 'Legacy Heading\nlegacy walrus content that was indexed under the fixed-window scheme.\n');

      docFresh = await createDoc('Fresh Rollout Doc', [
        { h: 1, text: 'Fresh Heading' },
        'fresh narwhal content indexed under the structure scheme.',
      ]);
      await searchIndexer.indexDocument(docFresh);

      for (const docGuid of [docLegacy, docFresh]) {
        await pool.query(
          `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [docGuid, userId]
        );
      }
    });

    test('T012a: legacy rows (embedded_text IS NULL) keep serving semantic search (SC-012)', async () => {
      const legacyRows = await getChunks(docLegacy);
      expect(legacyRows.length).toBeGreaterThan(0);
      for (const row of legacyRows) expect(row.embedded_text).toBeNull();

      searchMod.init(pool);
      searchMod._resetCache();
      mockEmbed.mockImplementation(async () => ({ embedding: fakeVector() }));
      const results = await searchMod.searchDocuments(userId, 'walrus content', { mode: 'semantic' });
      expect(results.rows.map((r) => r.doc_id)).toContain(docLegacy);
    });

    test('T012b: reindexStale selects exactly the legacy-owning docs and re-chunks them', async () => {
      mockEmbedMany.mockClear();
      await searchIndexer.reindexStale();

      // Exactly one embed cycle: the legacy doc. The fresh doc is untouched.
      expect(mockEmbedMany).toHaveBeenCalledTimes(1);
      const migrated = await getChunks(docLegacy);
      expect(migrated.length).toBeGreaterThan(0);
      for (const row of migrated) {
        expect(row.embedded_text).not.toBeNull();
        expect(row.embedded_text.startsWith('Legacy Rollout Doc')).toBe(true);
        expect(row.has_vector).toBe(true);
      }
    });

    test('T012c: after full migration a second reindexStale does zero chunking work (FR-011)', async () => {
      mockEmbedMany.mockClear();
      await searchIndexer.reindexStale();
      expect(mockEmbedMany).not.toHaveBeenCalled();
    });
  });

  // ——————————————————————————————————————————————————————————————————————
  // Feature 018 US3 (T027/D12) — the eval-only fixed-chunking baseline
  // faithfully reproduces the pre-018 pipeline through the new writer.
  // ——————————————————————————————————————————————————————————————————————
  test('T027/D12: reindexAllForEval with chunking:fixed writes legacy-faithful baseline rows', async () => {
    const docGuid = await createDoc('Fixed Baseline Doc', [
      { h: 1, text: 'Heading Ignored By Fixed' },
      'baseline body text for the fixed-window variant.',
    ]);
    const summary = await searchIndexer.reindexAllForEval({ chunking: 'fixed', preambles: false });
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.done).toBeGreaterThan(0);

    const chunks = await getChunks(docGuid);
    expect(chunks.length).toBe(1); // short doc → one fixed window
    const chunk = chunks[0];
    expect(chunk.heading_path).toEqual([]); // '{}' — no trails in the old pipeline
    expect(chunk.preamble_text).toBeNull();
    // The old pipeline embedded bare chunk text: no title header
    expect(chunk.embedded_text).toBe(chunk.chunk_text);
    expect(chunk.embedded_text.startsWith('Fixed Baseline Doc')).toBe(false);
    expect(chunk.embedding_model).toBe(EMBEDDING_MODEL);

    // Restore the structure scheme for any later tests
    await searchIndexer.reindexAllForEval({ preambles: false });
    const restored = await getChunks(docGuid);
    expect(restored[0].embedded_text.startsWith('Fixed Baseline Doc')).toBe(true);
  });

  // ——————————————————————————————————————————————————————————————————————
  // Feature 018 US2 — preamble gating in the indexer (T019).
  // Preambles ON here (inner beforeAll flips the env the outer block set off).
  // ——————————————————————————————————————————————————————————————————————
  describe('preamble gating (T019, FR-012/RBD-7)', () => {
    beforeAll(() => {
      process.env.SEARCH_PREAMBLES = 'on';
    });

    afterAll(() => {
      process.env.SEARCH_PREAMBLES = 'off'; // outer block's setting
    });

    beforeEach(() => {
      mockGenerateObject.mockReset();
      mockGenerateObject.mockImplementation(async ({ prompt }) => {
        const count = (prompt.match(/\[\d+\] section:/g) || []).length;
        return {
          object: { contexts: Array.from({ length: count }, (_, i) => `Situating sentence for chunk ${i}.`) },
        };
      });
    });

    const multiBlocks = () => [
      { h: 1, text: 'Part One' },
      longSection('first part material'),
      { h: 1, text: 'Part Two' },
      longSection('second part material'),
    ];

    test('(a) multi-chunk doc ⇒ every row stores a preamble, composed into embedded_text (SC-003)', async () => {
      const docGuid = await createDoc('Preamble Multi Doc', multiBlocks());
      await searchIndexer.indexDocument(docGuid);

      const chunks = await getChunks(docGuid);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(mockGenerateObject).toHaveBeenCalledTimes(1); // ≤25 chunks → one batch
      for (const chunk of chunks) {
        expect(chunk.preamble_text).toMatch(/^Situating sentence for chunk \d+\.$/);
        // Contract composition: header \n preamble \n\n chunk text
        const headerLine = ['Preamble Multi Doc', ...chunk.heading_path].join(' > ');
        expect(chunk.embedded_text).toBe(`${headerLine}\n${chunk.preamble_text}\n\n${chunk.chunk_text}`);
      }
    });

    test('(b) single-chunk doc ⇒ NULL preamble AND the contextualizer is never called (FR-012)', async () => {
      const docGuid = await createDoc('Preamble Single Doc', [{ h: 1, text: 'Solo' }, 'a short self-situating body.']);
      await searchIndexer.indexDocument(docGuid);

      const chunks = await getChunks(docGuid);
      expect(chunks.length).toBe(1);
      expect(chunks[0].preamble_text).toBeNull();
      expect(mockGenerateObject).not.toHaveBeenCalled(); // zero-call assertion
      // embedded_text still title-headed (DR-1 applies to single-chunk docs too)
      expect(chunks[0].embedded_text.startsWith('Preamble Single Doc')).toBe(true);
    });

    test('(c) preamble generation failure ⇒ chunks index and search without preambles (SC-006)', async () => {
      mockGenerateObject.mockRejectedValue(new Error('contextualizer down'));
      const docGuid = await createDoc('Preamble Failure Doc', multiBlocks());
      await searchIndexer.indexDocument(docGuid);

      const chunks = await getChunks(docGuid);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of chunks) {
        expect(chunk.preamble_text).toBeNull();
        expect(chunk.embedded_text.startsWith('Preamble Failure Doc')).toBe(true);
        expect(chunk.has_vector).toBe(true);
      }
      // Keyword-searchable via the doc-level FTS row regardless
      const fts = await pool.query(
        `SELECT search_vector @@ websearch_to_tsquery('english', 'material') AS m
         FROM document_search_index WHERE doc_id = $1`,
        [docGuid]
      );
      expect(fts.rows[0].m).toBe(true);
    });

    test('(d) RBD-7 transitions: multi→single drops the preamble; single→multi gains them, same pass', async () => {
      const docGuid = await createDoc('Transition Doc', multiBlocks());
      await searchIndexer.indexDocument(docGuid);
      expect((await getChunks(docGuid)).every((c) => c.preamble_text)).toBe(true);

      // Shrink to a single chunk: the very next pass stores ONE row, NULL preamble
      mockGenerateObject.mockClear();
      await setBlocks(docGuid, [{ h: 1, text: 'Tiny Now' }, 'just one small paragraph left.']);
      await searchIndexer.indexDocument(docGuid);
      const shrunk = await getChunks(docGuid);
      expect(shrunk.length).toBe(1);
      expect(shrunk[0].preamble_text).toBeNull(); // no stale preamble survives
      expect(mockGenerateObject).not.toHaveBeenCalled();

      // Grow back to multi: preambles appear on the same pass
      await setBlocks(docGuid, multiBlocks());
      await searchIndexer.indexDocument(docGuid);
      const grown = await getChunks(docGuid);
      expect(grown.length).toBeGreaterThanOrEqual(2);
      expect(grown.every((c) => c.preamble_text)).toBe(true);
    });

    test('(e) 017-gate ride-along: unchanged re-persist ⇒ zero contextualizer calls (SC-007)', async () => {
      const docGuid = await createDoc('Preamble Gate Doc', multiBlocks());
      await searchIndexer.indexDocument(docGuid);
      mockGenerateObject.mockClear();
      mockEmbedMany.mockClear();

      await searchIndexer.indexDocument(docGuid); // nothing changed

      expect(mockEmbedMany).not.toHaveBeenCalled();
      expect(mockGenerateObject).not.toHaveBeenCalled();
    });
  });
});
