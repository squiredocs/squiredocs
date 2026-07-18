/**
 * Tests for the search indexer module
 */
const crypto = require('crypto');
const { createPool, createTestUser, cleanupTestUser } = require('./helpers/db');
const { chunkText } = require('../search-indexer');

const fakeVector = () => Array.from({ length: 1536 }, (_, i) => ((i % 5) + 1) * 0.001);

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
