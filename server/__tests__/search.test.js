/**
 * Tests for the search query module
 */
const { createPool, createTestUser, cleanupTestUser } = require('./helpers/db');
const search = require('../search');

describe('search module', () => {
  let pool;
  let userId1;
  let userId2;
  let docId1;
  let docId2;
  let docId3;

  beforeAll(async () => {
    pool = createPool();
    search.init(pool);

    userId1 = await createTestUser(pool, 'search-test-1@example.com');
    userId2 = await createTestUser(pool, 'search-test-2@example.com');

    // Create test documents
    const doc1 = await pool.query(
      `INSERT INTO documents (id, title, creator_id) VALUES (uuid_generate_v4(), 'Authentication Guide', $1) RETURNING id`,
      [userId1]
    );
    docId1 = doc1.rows[0].id;

    const doc2 = await pool.query(
      `INSERT INTO documents (id, title, creator_id) VALUES (uuid_generate_v4(), 'Database Migration Notes', $1) RETURNING id`,
      [userId1]
    );
    docId2 = doc2.rows[0].id;

    const doc3 = await pool.query(
      `INSERT INTO documents (id, title, creator_id) VALUES (uuid_generate_v4(), 'Private Document', $1) RETURNING id`,
      [userId2]
    );
    docId3 = doc3.rows[0].id;

    // Grant access: user1 owns doc1 and doc2, user2 owns doc3
    await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`, [docId1, userId1]);
    await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`, [docId2, userId1]);
    await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`, [docId3, userId2]);

    // Insert search index entries
    await pool.query(
      `INSERT INTO document_search_index (doc_id, content_text, search_vector)
       VALUES ($1, $2,
         setweight(to_tsvector('english', 'Authentication Guide'), 'A') ||
         setweight(to_tsvector('english', $2), 'B'))`,
      [docId1, 'This document covers OAuth 2.0 authentication flows including login, token refresh, and session management.']
    );

    await pool.query(
      `INSERT INTO document_search_index (doc_id, content_text, search_vector)
       VALUES ($1, $2,
         setweight(to_tsvector('english', 'Database Migration Notes'), 'A') ||
         setweight(to_tsvector('english', $2), 'B'))`,
      [docId2, 'Notes on database migrations including PostgreSQL schema changes and data backfill procedures.']
    );

    await pool.query(
      `INSERT INTO document_search_index (doc_id, content_text, search_vector)
       VALUES ($1, $2,
         setweight(to_tsvector('english', 'Private Document'), 'A') ||
         setweight(to_tsvector('english', $2), 'B'))`,
      [docId3, 'This is a private document about authentication that only user2 should see.']
    );
  });

  afterAll(async () => {
    // Clean up search index entries first (FK constraint)
    await pool.query('DELETE FROM document_embeddings WHERE doc_id IN ($1, $2, $3)', [docId1, docId2, docId3]);
    await pool.query('DELETE FROM document_search_index WHERE doc_id IN ($1, $2, $3)', [docId1, docId2, docId3]);
    await pool.query('DELETE FROM document_shares WHERE doc_id IN ($1, $2, $3)', [docId1, docId2, docId3]);
    await pool.query('DELETE FROM documents WHERE id IN ($1, $2, $3)', [docId1, docId2, docId3]);
    await cleanupTestUser(pool, userId1);
    await cleanupTestUser(pool, userId2);
    search._resetCache();
    await pool.end();
  });

  test('fulltext search returns matching documents with snippets', async () => {
    const results = await search.searchDocuments(userId1, 'authentication', { mode: 'fulltext' });

    expect(results.rows.length).toBe(1);
    expect(results.rows[0].doc_id).toBe(docId1);
    expect(results.rows[0].title).toBe('Authentication Guide');
    expect(results.rows[0].snippet).toBeDefined();
    expect(results.rows[0].snippet).toContain('<mark>');
    expect(results.rows[0].score).toBeGreaterThan(0);
  });

  test('fulltext search respects permissions', async () => {
    // user1 searches for 'authentication' — should find doc1 but NOT doc3 (user2 private)
    const results = await search.searchDocuments(userId1, 'authentication', { mode: 'fulltext' });
    const docIds = results.rows.map((r) => r.doc_id);
    expect(docIds).toContain(docId1);
    expect(docIds).not.toContain(docId3);
  });

  test('user2 can find their own private document', async () => {
    const results = await search.searchDocuments(userId2, 'authentication', { mode: 'fulltext' });
    const docIds = results.rows.map((r) => r.doc_id);
    expect(docIds).toContain(docId3);
    expect(docIds).not.toContain(docId1);
  });

  test('search for database returns migration notes', async () => {
    const results = await search.searchDocuments(userId1, 'database migration', { mode: 'fulltext' });
    expect(results.rows.length).toBe(1);
    expect(results.rows[0].doc_id).toBe(docId2);
  });

  test('empty query returns empty results', async () => {
    const results = await search.searchDocuments(userId1, '', { mode: 'fulltext' });
    expect(results.rows).toEqual([]);
  });

  test('no-match query returns empty results', async () => {
    const results = await search.searchDocuments(userId1, 'xyznonexistent', { mode: 'fulltext' });
    expect(results.rows).toEqual([]);
  });

  test('pagination works correctly', async () => {
    // Insert extra docs so we can paginate
    const results1 = await search.searchDocuments(userId1, 'authentication', { mode: 'fulltext', limit: 1, offset: 0 });
    expect(results1.rows.length).toBe(1);
    expect(results1.pagination.total).toBe(1);
    expect(results1.pagination.hasMore).toBe(false);
  });

  test('hybrid mode falls back to fulltext when no embeddings exist', async () => {
    // No embeddings inserted — hybrid should auto-fall back to fulltext
    search._resetCache();
    const results = await search.searchDocuments(userId1, 'authentication', { mode: 'hybrid' });
    expect(results.rows.length).toBe(1);
    expect(results.rows[0].doc_id).toBe(docId1);
  });

  test('result includes expected fields', async () => {
    const results = await search.searchDocuments(userId1, 'OAuth', { mode: 'fulltext' });
    expect(results.rows.length).toBeGreaterThan(0);
    const row = results.rows[0];
    expect(row).toHaveProperty('doc_id');
    expect(row).toHaveProperty('title');
    expect(row).toHaveProperty('updated_at');
    expect(row).toHaveProperty('role');
    expect(row).toHaveProperty('snippet');
    expect(row).toHaveProperty('score');
    expect(results).toHaveProperty('pagination');
    expect(results.pagination).toHaveProperty('total');
    expect(results.pagination).toHaveProperty('limit');
    expect(results.pagination).toHaveProperty('offset');
    expect(results.pagination).toHaveProperty('hasMore');
  });
});
