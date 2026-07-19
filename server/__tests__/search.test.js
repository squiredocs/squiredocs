/**
 * Tests for the search query module
 */
const { createPool, createTestUser, cleanupTestUser } = require('./helpers/db');

// Feature 017 (updatedAfter): mock the ai SDK so semantic/hybrid coverage can
// run without a provider — embed/embedMany are controllable spies. Existing
// tests never reach these (fulltext mode, or hybrid fallback with no key).
const mockEmbed = jest.fn();
const mockEmbedMany = jest.fn();
jest.mock('ai', () => ({
  embed: (...args) => mockEmbed(...args),
  embedMany: (...args) => mockEmbedMany(...args),
}));
jest.mock('@ai-sdk/google', () => ({
  google: { textEmbeddingModel: jest.fn(() => 'mock-embedding-model') },
}));

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

    // Grant access: user1 owns doc1 and doc2, user2 owns doc3, doc3 shared with user1 as editor
    await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`, [docId1, userId1]);
    await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`, [docId2, userId1]);
    await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`, [docId3, userId2]);
    await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'editor')`, [docId3, userId1]);

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

    // user1 can see doc1 (owned) and doc3 (shared as editor) — both contain "authentication"
    expect(results.rows.length).toBe(2);
    const docIds = results.rows.map((r) => r.doc_id);
    expect(docIds).toContain(docId1);
    expect(docIds).toContain(docId3);
    expect(results.rows[0].snippet).toBeDefined();
    expect(results.rows[0].snippet).toContain('<mark>');
    expect(results.rows[0].score).toBeGreaterThan(0);
  });

  test('fulltext search respects permissions', async () => {
    // user2 searches for 'authentication' — should find doc3 (owned) but NOT doc1 (not shared with user2)
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
    const results1 = await search.searchDocuments(userId1, 'authentication', { mode: 'fulltext', limit: 1, offset: 0 });
    expect(results1.rows.length).toBe(1);
    expect(results1.pagination.total).toBe(2);
    expect(results1.pagination.hasMore).toBe(true);

    const results2 = await search.searchDocuments(userId1, 'authentication', { mode: 'fulltext', limit: 1, offset: 1 });
    expect(results2.rows.length).toBe(1);
    expect(results2.pagination.hasMore).toBe(false);
  });

  test('hybrid mode falls back to fulltext when no embeddings exist', async () => {
    // No embeddings inserted — hybrid should auto-fall back to fulltext
    search._resetCache();
    const results = await search.searchDocuments(userId1, 'authentication', { mode: 'hybrid' });
    expect(results.rows.length).toBe(2);
    const docIds = results.rows.map((r) => r.doc_id);
    expect(docIds).toContain(docId1);
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

  test('filter: owned returns only owned docs', async () => {
    // user1 searches for "authentication" with filter=owned
    // doc1 (owned) matches, doc3 (shared as editor) also matches but should be excluded
    const results = await search.searchDocuments(userId1, 'authentication', { mode: 'fulltext', filter: 'owned' });
    const docIds = results.rows.map((r) => r.doc_id);
    expect(docIds).toContain(docId1);
    expect(docIds).not.toContain(docId3);
  });

  test('filter: shared_with_me returns only shared docs', async () => {
    // user1 searches for "authentication" with filter=shared_with_me
    // doc3 (shared as editor) matches, doc1 (owned) should be excluded
    const results = await search.searchDocuments(userId1, 'authentication', { mode: 'fulltext', filter: 'shared_with_me' });
    const docIds = results.rows.map((r) => r.doc_id);
    expect(docIds).toContain(docId3);
    expect(docIds).not.toContain(docId1);
  });

  test('sortBy: updatedAt sorts by date instead of relevance', async () => {
    // Both doc1 and doc3 match "authentication" for user1
    const results = await search.searchDocuments(userId1, 'authentication', { mode: 'fulltext', sortBy: 'updatedAt', sortOrder: 'desc' });
    expect(results.rows.length).toBe(2);
    // Verify sorted by updated_at descending
    const dates = results.rows.map((r) => new Date(r.updated_at).getTime());
    expect(dates[0]).toBeGreaterThanOrEqual(dates[1]);
  });

  test('sortBy: updatedAt with asc order', async () => {
    const results = await search.searchDocuments(userId1, 'authentication', { mode: 'fulltext', sortBy: 'updatedAt', sortOrder: 'asc' });
    expect(results.rows.length).toBe(2);
    const dates = results.rows.map((r) => new Date(r.updated_at).getTime());
    expect(dates[0]).toBeLessThanOrEqual(dates[1]);
  });

  // ————————————————————————————————————————————————————————————————————————
  // Feature 017 US2: updatedAfter recency pre-filter (engine level).
  // Own fixtures — the shared beforeAll documents above are never mutated.
  // ————————————————————————————————————————————————————————————————————————
  describe('updatedAfter recency pre-filter (017 US2)', () => {
    const DIMS = 1536;
    // Query vector and two document vectors: docOld's chunk is IDENTICAL to
    // the query (distance 0 — the nearest vector in the corpus); docNew's is
    // slightly off (distance ≈ 0.006). Both well inside the 0.5 threshold.
    const vecQuery = [1, ...Array(DIMS - 1).fill(0)];
    const vecExact = [1, ...Array(DIMS - 1).fill(0)];
    const vecNear = [0.9, 0.1, ...Array(DIMS - 2).fill(0)];

    const OLD_TS = '2026-01-01T00:00:00Z';
    const NEW_TS = '2026-06-15T12:00:00Z';
    const NEW2_TS = '2026-07-01T00:00:00Z';
    const SHARED_TS = '2026-06-20T00:00:00Z';
    const CUTOFF = '2026-03-01T00:00:00Z';

    let uaUser1;
    let uaUser2;
    let docOld; // owned by uaUser1, updated OLD_TS, has the nearest vector
    let docNew; // owned by uaUser1, updated NEW_TS, has a near vector
    let docNew2; // owned by uaUser1, updated NEW2_TS, FTS only
    let docShared; // owned by uaUser2, shared to uaUser1, updated SHARED_TS, FTS only
    let uaDocIds;
    let savedApiKey;

    async function seedDoc(title, ownerId, updatedAt, body) {
      const r = await pool.query(
        `INSERT INTO documents (id, title, creator_id, updated_at) VALUES (uuid_generate_v4(), $1, $2, $3) RETURNING id`,
        [title, ownerId, updatedAt]
      );
      const id = r.rows[0].id;
      await pool.query(
        `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [id, ownerId]
      );
      await pool.query(
        `INSERT INTO document_search_index (doc_id, content_text, search_vector)
         VALUES ($1, $2,
           setweight(to_tsvector('english', $3), 'A') ||
           setweight(to_tsvector('english', $2), 'B'))`,
        [id, body, title]
      );
      return id;
    }

    beforeAll(async () => {
      savedApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key-updated-after';

      uaUser1 = await createTestUser(pool, 'updated-after-1@example.com');
      uaUser2 = await createTestUser(pool, 'updated-after-2@example.com');

      docOld = await seedDoc('Quokka Field Notes Old', uaUser1, OLD_TS, 'quokka habitats observed on the old expedition');
      docNew = await seedDoc('Quokka Field Notes New', uaUser1, NEW_TS, 'quokka behavior recorded on the recent expedition');
      docNew2 = await seedDoc('Quokka Appendix', uaUser1, NEW2_TS, 'quokka diet appendix from july');
      docShared = await seedDoc('Shared Quokka Survey', uaUser2, SHARED_TS, 'quokka survey shared with collaborators');
      await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'editor')`, [docShared, uaUser1]);
      uaDocIds = [docOld, docNew, docNew2, docShared];

      // Vector fixtures: docOld gets the exact-match vector, docNew a near one.
      await pool.query(
        `INSERT INTO document_embeddings (doc_id, chunk_index, chunk_text, embedding) VALUES ($1, 0, $2, $3)`,
        [docOld, 'quokka habitats observed on the old expedition', JSON.stringify(vecExact)]
      );
      await pool.query(
        `INSERT INTO document_embeddings (doc_id, chunk_index, chunk_text, embedding) VALUES ($1, 0, $2, $3)`,
        [docNew, 'quokka behavior recorded on the recent expedition', JSON.stringify(vecNear)]
      );
      search._resetCache();
    });

    afterAll(async () => {
      if (savedApiKey === undefined) {
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      } else {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = savedApiKey;
      }
      await pool.query('DELETE FROM document_embeddings WHERE doc_id = ANY($1)', [uaDocIds]);
      await pool.query('DELETE FROM document_search_index WHERE doc_id = ANY($1)', [uaDocIds]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = ANY($1)', [uaDocIds]);
      await pool.query('DELETE FROM documents WHERE id = ANY($1)', [uaDocIds]);
      await cleanupTestUser(pool, uaUser1);
      await cleanupTestUser(pool, uaUser2);
      search._resetCache();
    });

    beforeEach(() => {
      mockEmbed.mockReset();
      mockEmbed.mockImplementation(async () => ({ embedding: vecQuery }));
    });

    test('fulltext: excludes docs at/before the cutoff and totals count only the filtered set', async () => {
      const results = await search.searchDocuments(uaUser1, 'quokka', { mode: 'fulltext', updatedAfter: CUTOFF });
      const ids = results.rows.map((r) => r.doc_id);
      expect(ids).not.toContain(docOld);
      expect(ids).toContain(docNew);
      expect(ids).toContain(docNew2);
      expect(ids).toContain(docShared);
      expect(results.pagination.total).toBe(3);
    });

    test('boundary: cutoff equal to a doc\'s exact updated_at excludes it (strictly-after, CN-2)', async () => {
      const results = await search.searchDocuments(uaUser1, 'quokka', { mode: 'fulltext', updatedAfter: NEW_TS });
      const ids = results.rows.map((r) => r.doc_id);
      expect(ids).not.toContain(docNew); // equal timestamp → excluded
      expect(ids).toContain(docShared); // strictly after → included
      expect(ids).toContain(docNew2);
      expect(results.pagination.total).toBe(2);
    });

    test('future cutoff: empty rows, total 0', async () => {
      const results = await search.searchDocuments(uaUser1, 'quokka', { mode: 'fulltext', updatedAfter: '2030-01-01T00:00:00Z' });
      expect(results.rows).toEqual([]);
      expect(results.pagination.total).toBe(0);
    });

    test('composes with filter, sort, and pagination (FR-017)', async () => {
      // owned + cutoff → docNew, docNew2 (docShared excluded by role, docOld by recency)
      const page1 = await search.searchDocuments(uaUser1, 'quokka', {
        mode: 'fulltext', updatedAfter: CUTOFF, filter: 'owned', sortBy: 'updatedAt', sortOrder: 'asc', limit: 1, offset: 0,
      });
      expect(page1.rows.length).toBe(1);
      expect(page1.rows[0].doc_id).toBe(docNew); // oldest of the filtered owned set
      expect(page1.pagination.total).toBe(2);
      expect(page1.pagination.hasMore).toBe(true);

      const page2 = await search.searchDocuments(uaUser1, 'quokka', {
        mode: 'fulltext', updatedAfter: CUTOFF, filter: 'owned', sortBy: 'updatedAt', sortOrder: 'asc', limit: 1, offset: 1,
      });
      expect(page2.rows.length).toBe(1);
      expect(page2.rows[0].doc_id).toBe(docNew2);
      expect(page2.pagination.hasMore).toBe(false);
    });

    test('subset property: filtered ⊆ unfiltered ⊆ accessible, for both users (FR-020, SC-004)', async () => {
      for (const user of [uaUser1, uaUser2]) {
        const unfiltered = await search.searchDocuments(user, 'quokka', { mode: 'fulltext' });
        const filtered = await search.searchDocuments(user, 'quokka', { mode: 'fulltext', updatedAfter: CUTOFF });
        const unfilteredIds = unfiltered.rows.map((r) => r.doc_id);
        const filteredIds = filtered.rows.map((r) => r.doc_id);
        for (const id of filteredIds) {
          expect(unfilteredIds).toContain(id);
        }
        expect(filtered.pagination.total).toBeLessThanOrEqual(unfiltered.pagination.total);
      }
      // The filter never widens access: uaUser2 still sees only their doc
      const u2 = await search.searchDocuments(uaUser2, 'quokka', { mode: 'fulltext', updatedAfter: CUTOFF });
      expect(u2.rows.map((r) => r.doc_id)).toEqual([docShared]);
    });

    test('invalid updatedAfter throws from searchDocuments (defensive re-validation)', async () => {
      await expect(
        search.searchDocuments(uaUser1, 'quokka', { mode: 'fulltext', updatedAfter: 'banana' })
      ).rejects.toThrow('updatedAfter must be a valid ISO-8601 timestamp');
    });

    test('absent updatedAfter: results identical to a call without the option (SC-005)', async () => {
      const plain = await search.searchDocuments(uaUser1, 'quokka', { mode: 'fulltext' });
      const explicitUndefined = await search.searchDocuments(uaUser1, 'quokka', { mode: 'fulltext', updatedAfter: undefined });
      expect(explicitUndefined).toEqual(plain);
      expect(plain.pagination.total).toBe(4);
    });

    test('semantic: the vector leg filters before ranking — nearest vector outside the window is absent (FR-016, SC-003)', async () => {
      // Unfiltered: docOld (distance 0) is the top-ranked semantic hit
      const unfiltered = await search.searchDocuments(uaUser1, 'quokka creatures', { mode: 'semantic' });
      expect(unfiltered.rows.map((r) => r.doc_id)).toEqual([docOld, docNew]);
      expect(unfiltered.pagination.total).toBe(2);

      // Filtered: docOld is excluded inside the CTE even though it is nearest
      const filtered = await search.searchDocuments(uaUser1, 'quokka creatures', { mode: 'semantic', updatedAfter: CUTOFF });
      expect(filtered.rows.map((r) => r.doc_id)).toEqual([docNew]);
      expect(filtered.pagination.total).toBe(1);
    });

    test('hybrid: chunk-keyword leg also carries the recency filter (018 D4 + 017)', async () => {
      // Seed a chunk-level keyword row on docOld: term appears ONLY in the
      // chunk's embedded_text. Unfiltered fulltext finds it via the chunk leg;
      // with a cutoff after docOld's update, it must vanish (updatedAfter on
      // the chunk sub-select too).
      await pool.query(
        `INSERT INTO document_embeddings
           (doc_id, chunk_index, chunk_text, embedding, embedded_text, search_vector)
         VALUES ($1, 7, $2, $3, $4, to_tsvector('english', $4))`,
        [docOld, 'plain chunk body', JSON.stringify(vecExact),
          'Quokka Field Notes Old\nchronotrigger expedition notes\n\nplain chunk body']
      );
      try {
        const unfiltered = await search.searchDocuments(uaUser1, 'chronotrigger', { mode: 'fulltext' });
        expect(unfiltered.rows.map((r) => r.doc_id)).toEqual([docOld]);
        const filtered = await search.searchDocuments(uaUser1, 'chronotrigger', { mode: 'fulltext', updatedAfter: CUTOFF });
        expect(filtered.rows).toEqual([]);
        expect(filtered.pagination.total).toBe(0);
      } finally {
        await pool.query('DELETE FROM document_embeddings WHERE doc_id = $1 AND chunk_index = 7', [docOld]);
      }
    });

    test('hybrid: both legs filter before fusion — totals reflect the filtered set (FR-016, SC-003)', async () => {
      const unfiltered = await search.searchDocuments(uaUser1, 'quokka', { mode: 'hybrid' });
      expect(unfiltered.rows.map((r) => r.doc_id)).toContain(docOld);
      expect(unfiltered.pagination.total).toBe(4);

      const filtered = await search.searchDocuments(uaUser1, 'quokka', { mode: 'hybrid', updatedAfter: CUTOFF });
      const ids = filtered.rows.map((r) => r.doc_id);
      expect(ids).not.toContain(docOld); // excluded from BOTH legs (fts + nearest vector)
      expect(ids).toContain(docNew);
      expect(ids).toContain(docNew2);
      expect(ids).toContain(docShared);
      expect(filtered.pagination.total).toBe(3);
    });
  });

  // ————————————————————————————————————————————————————————————————————————
  // Feature 018 US2 (T020): chunk-keyword leg, snippet provenance, auth
  // probe, and the response-shape freeze. Own fixtures; DIMS vectors seeded
  // directly (embeddings are storage here, provider mocked).
  // ————————————————————————————————————————————————————————————————————————
  describe('preamble retrieval + contract freeze (018 T020)', () => {
    const DIMS = 1536;
    const vecQuery = [1, ...Array(DIMS - 1).fill(0)];
    const vecExact = [1, ...Array(DIMS - 1).fill(0)];

    // The sentinel term appears ONLY in the preamble / embedded_text —
    // never in chunk_text, never in document_search_index.content_text.
    const SENTINEL = 'xylotherium';
    const CONTENT_TEXT = 'The relocation playbook describes moving colonies between reserves with careful staging.';
    const CHUNK_TEXT = 'moving colonies between reserves requires staging pens and transport crates.';
    const PREAMBLE = `This chunk situates the ${SENTINEL} relocation project within the playbook.`;

    let ownerUser;
    let strangerUser;
    let docId;
    let savedApiKey;

    beforeAll(async () => {
      savedApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key-t020';

      ownerUser = await createTestUser(pool, 'preamble-owner@example.com');
      strangerUser = await createTestUser(pool, 'preamble-stranger@example.com');

      const doc = await pool.query(
        `INSERT INTO documents (id, title, creator_id) VALUES (uuid_generate_v4(), 'Relocation Playbook', $1) RETURNING id`,
        [ownerUser]
      );
      docId = doc.rows[0].id;
      await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`, [docId, ownerUser]);

      await pool.query(
        `INSERT INTO document_search_index (doc_id, content_text, search_vector)
         VALUES ($1, $2,
           setweight(to_tsvector('english', 'Relocation Playbook'), 'A') ||
           setweight(to_tsvector('english', $2), 'B'))`,
        [docId, CONTENT_TEXT]
      );
      const embeddedText = `Relocation Playbook > Staging\n${PREAMBLE}\n\n${CHUNK_TEXT}`;
      await pool.query(
        `INSERT INTO document_embeddings
           (doc_id, chunk_index, chunk_text, embedding, embedding_model,
            heading_path, preamble_text, embedded_text, token_estimate, search_vector)
         VALUES ($1, 0, $2, $3, 'gemini-embedding-001', $4, $5, $6, $7, to_tsvector('english', $6))`,
        [docId, CHUNK_TEXT, JSON.stringify(vecExact), ['Staging'], PREAMBLE, embeddedText,
          Math.ceil(embeddedText.length / 4)]
      );
      search._resetCache();
    });

    afterAll(async () => {
      if (savedApiKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = savedApiKey;
      await pool.query('DELETE FROM document_embeddings WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM document_search_index WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
      await cleanupTestUser(pool, ownerUser);
      await cleanupTestUser(pool, strangerUser);
      search._resetCache();
    });

    beforeEach(() => {
      mockEmbed.mockReset();
      mockEmbed.mockImplementation(async () => ({ embedding: vecQuery }));
    });

    test('SC-005a: a preamble-only term retrieves the document via KEYWORD matching (chunk leg)', async () => {
      // Sanity: the term is truly absent from doc-level text and chunk text
      expect(CONTENT_TEXT).not.toContain(SENTINEL);
      expect(CHUNK_TEXT).not.toContain(SENTINEL);

      const results = await search.searchDocuments(ownerUser, SENTINEL, { mode: 'fulltext' });
      expect(results.rows.map((r) => r.doc_id)).toContain(docId);
    });

    test('SC-005b: the same term retrieves the document via SEMANTIC matching', async () => {
      const results = await search.searchDocuments(ownerUser, `${SENTINEL} relocation`, { mode: 'semantic' });
      expect(results.rows.map((r) => r.doc_id)).toContain(docId);
    });

    test('SC-005c: hybrid mode fuses the chunk-keyword hit into doc-level RRF results', async () => {
      const results = await search.searchDocuments(ownerUser, SENTINEL, { mode: 'hybrid' });
      expect(results.rows.map((r) => r.doc_id)).toContain(docId);
    });

    test('FR-018: snippets NEVER contain preamble text — document-authored text only', async () => {
      for (const mode of ['fulltext', 'semantic', 'hybrid']) {
        const results = await search.searchDocuments(ownerUser, SENTINEL, { mode });
        const row = results.rows.find((r) => r.doc_id === docId);
        expect(row).toBeDefined();
        expect(row.snippet || '').not.toContain(SENTINEL);
        expect(row.snippet || '').not.toContain('situates');
      }
      // Keyword-path snippet comes from content_text (headline leading text)
      const ft = await search.searchDocuments(ownerUser, SENTINEL, { mode: 'fulltext' });
      const ftRow = ft.rows.find((r) => r.doc_id === docId);
      expect(ftRow.snippet).toContain('playbook');
    });

    test('SC-011: unshared user gets ZERO rows for the preamble-only term in every mode', async () => {
      for (const mode of ['fulltext', 'semantic', 'hybrid']) {
        const results = await search.searchDocuments(strangerUser, SENTINEL, { mode });
        expect(results.rows.map((r) => r.doc_id)).not.toContain(docId);
        expect(results.rows).toEqual([]);
      }
    });

    test('SC-004: response field set and pagination shape are frozen', async () => {
      const FROZEN_ROW_KEYS = ['doc_id', 'title', 'updated_at', 'role', 'owner_name', 'owner_email', 'snippet', 'score', 'share_count'];
      const FROZEN_PAGINATION_KEYS = ['total', 'limit', 'offset', 'hasMore'];
      for (const mode of ['fulltext', 'hybrid']) {
        const results = await search.searchDocuments(ownerUser, 'relocation playbook', { mode });
        expect(results.rows.length).toBeGreaterThan(0);
        for (const row of results.rows) {
          expect(Object.keys(row)).toEqual(FROZEN_ROW_KEYS);
        }
        expect(Object.keys(results.pagination)).toEqual(FROZEN_PAGINATION_KEYS);
      }
    });

    test('keyword rank is GREATEST(doc, chunk): doc-level matches keep working with chunk rows present', async () => {
      const results = await search.searchDocuments(ownerUser, 'staging', { mode: 'fulltext' });
      // 'staging' appears in BOTH content_text and the chunk vector — one row per doc
      const hits = results.rows.filter((r) => r.doc_id === docId);
      expect(hits.length).toBe(1);
      expect(hits[0].score).toBeGreaterThan(0);
    });
  });
});
