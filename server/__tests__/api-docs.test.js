/**
 * Tests for /api/docs endpoint
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const documents = require('../documents');
const search = require('../search');
const { createPool, createPersistence } = require('./helpers/db');

// Mock JWT secret for testing
const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

describe('API: /api/docs', () => {
  let app;
  let pool;
  let persistence;
  let testUserId;
  let testUser2Id;
  let testDocId1;
  let testDocId2;
  let testDocId3;
  let authToken;
  let authToken2;

  // Rate limiter stub mirroring rateLimit.enforceUser('search', req, res) in
  // server/index.js — resolves true (allowed); spied on to prove the content
  // branch stays metered for updatedAfter-filtered searches (FR-021).
  const enforceUser = jest.fn(async () => true);

  beforeAll(async () => {
    // Use shared test database configuration
    pool = createPool();
    persistence = createPersistence();
    await persistence._init();

    documents.init(pool);
    search.init(pool);

    // Create test users
    const user1 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-api-docs-1', 'test-api-docs-1@example.com', 'API Test User 1', NULL)
       RETURNING id`
    );
    testUserId = user1.rows[0].id;

    const user2 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-api-docs-2', 'test-api-docs-2@example.com', 'API Test User 2', NULL)
       RETURNING id`
    );
    testUser2Id = user2.rows[0].id;

    // Create auth tokens
    authToken = jwt.sign({ userId: testUserId }, JWT_SECRET);
    authToken2 = jwt.sign({ userId: testUser2Id }, JWT_SECRET);

    // Set up Express app with the /api/docs endpoint
    app = express();
    app.use(express.json());

    // Simple auth middleware for testing
    const requireAuth = (req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
      } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    };

    // Implement the /api/docs endpoint (same as in server/index.js, with the
    // real rate limiter replaced by the enforceUser stub above)
    app.get('/api/docs', requireAuth, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { search: searchQuery, searchMode, filter, sortBy, sortOrder, limit, offset, mode, distanceThreshold } = req.query;

        // Feature 017: validate updatedAfter up front — before the rate
        // limiter — so misuse 400s cheaply and never silently no-ops (CN-3).
        let updatedAfter;
        if (req.query.updatedAfter !== undefined) {
          try {
            updatedAfter = search.parseUpdatedAfter(req.query.updatedAfter, {
              hasContentSearch: !!(searchQuery && searchMode === 'content'),
            });
          } catch (err) {
            return res.status(400).json({ error: err.message });
          }
        }

        // Content search: delegate to the search module for hybrid FTS + vector search.
        if (searchQuery && searchMode === 'content') {
          if (!(await enforceUser('search', req, res))) return; // 429 sent

          const results = await search.searchDocuments(userId, searchQuery, {
            mode: mode || 'hybrid',
            filter: filter || 'all',
            sortBy: sortBy || 'relevance',
            sortOrder: sortOrder || 'desc',
            limit: limit ? parseInt(limit, 10) : 10,
            offset: offset ? parseInt(offset, 10) : 0,
            distanceThreshold: distanceThreshold ? parseFloat(distanceThreshold) : undefined,
            updatedAfter,
          });

          const docs = results.rows.map((doc) => ({
            docGuid: doc.doc_id,
            title: doc.title || null,
            updatedAt: doc.updated_at,
            role: doc.role,
            ownerName: doc.owner_name,
            ownerEmail: doc.owner_email,
            snippet: doc.snippet,
            score: doc.score,
            shareCount: doc.share_count,
          }));

          return res.json({ docs, pagination: results.pagination });
        }

        // Default: title-based search
        const { rows: accessibleDocs } = await documents.getAccessibleDocuments(userId, {
          search: searchQuery || null,
          filter: filter || 'all',
          sortBy: sortBy || 'updatedAt',
          sortOrder: sortOrder || 'desc',
          limit: limit ? parseInt(limit, 10) : null,
          offset: offset ? parseInt(offset, 10) : 0,
        });

        // Transform to response format
        const docs = accessibleDocs.map((doc) => ({
          docGuid: doc.doc_id,
          title: doc.title || null,
          updatedAt: doc.updated_at || doc.created_at,
          role: doc.role,
          ownerName: doc.owner_name,
          ownerEmail: doc.owner_email,
          shareCount: parseInt(doc.share_count, 10) || 0,
        }));

        res.json({ docs });
      } catch (error) {
        console.error('Error fetching documents:', error);
        res.status(500).json({ error: 'Failed to fetch documents' });
      }
    });
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query("DELETE FROM document_shares WHERE doc_id IN (SELECT id FROM documents WHERE creator_id IN ($1, $2))", [testUserId, testUser2Id]);
    await pool.query("DELETE FROM documents WHERE creator_id IN ($1, $2)", [testUserId, testUser2Id]);
    await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [testUserId, testUser2Id]);
    await persistence.destroy();
    await pool.end();
  });

  beforeEach(async () => {
    testDocId1 = require('crypto').randomUUID();
    testDocId2 = require('crypto').randomUUID();
    testDocId3 = require('crypto').randomUUID();
  });

  afterEach(async () => {
    // Clean up documents after each test
    await pool.query('DELETE FROM document_shares WHERE doc_id IN ($1, $2, $3)', [testDocId1, testDocId2, testDocId3]);
    await pool.query('DELETE FROM documents WHERE id IN ($1, $2, $3)', [testDocId1, testDocId2, testDocId3]);
    await persistence.clearDocument(testDocId1);
    await persistence.clearDocument(testDocId2);
    await persistence.clearDocument(testDocId3);
  });

  describe('GET /api/docs', () => {
    test('requires authentication', async () => {
      const response = await request(app)
        .get('/api/docs');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    test('returns empty array when user has no documents', async () => {
      const response = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.docs).toEqual([]);
    });

    test('returns documents with titles', async () => {
      // Create documents with titles
      await documents.createDocument(testDocId1, testUserId);
      await documents.createDocument(testDocId2, testUserId);

      await pool.query('UPDATE documents SET title = $1 WHERE id = $2', ['My First Doc', testDocId1]);
      await pool.query('UPDATE documents SET title = $1 WHERE id = $2', ['My Second Doc', testDocId2]);

      const response = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.docs).toHaveLength(2);

      const doc1 = response.body.docs.find(d => d.docGuid === testDocId1);
      const doc2 = response.body.docs.find(d => d.docGuid === testDocId2);

      expect(doc1.title).toBe('My First Doc');
      expect(doc2.title).toBe('My Second Doc');
    });

    test('returns null for documents without titles', async () => {
      // Create document without setting title
      await documents.createDocument(testDocId1, testUserId);

      const response = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.docs).toHaveLength(1);
      expect(response.body.docs[0].title).toBeNull();
    });

    test('includes role information', async () => {
      await documents.createDocument(testDocId1, testUserId);

      const response = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.docs[0].role).toBe('owner');
    });

    test('includes owner information', async () => {
      await documents.createDocument(testDocId1, testUserId);

      const response = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.docs[0].ownerName).toBe('API Test User 1');
      expect(response.body.docs[0].ownerEmail).toBe('test-api-docs-1@example.com');
    });

    test('includes share count', async () => {
      await documents.createDocument(testDocId1, testUserId);
      await documents.setRole(testDocId1, testUser2Id, 'editor');

      const response = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.docs[0].shareCount).toBe(2); // owner + editor
    });

    test('sorts documents by updatedAt descending', async () => {
      // Create documents with different update times
      await documents.createDocument(testDocId1, testUserId);
      await documents.createDocument(testDocId2, testUserId);
      await documents.createDocument(testDocId3, testUserId);

      // Update timestamps to ensure specific order
      await pool.query('UPDATE documents SET updated_at = NOW() - INTERVAL \'3 days\' WHERE id = $1', [testDocId1]);
      await pool.query('UPDATE documents SET updated_at = NOW() - INTERVAL \'1 day\' WHERE id = $1', [testDocId2]);
      await pool.query('UPDATE documents SET updated_at = NOW() WHERE id = $1', [testDocId3]);

      const response = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.docs).toHaveLength(3);

      // Most recently updated should be first
      expect(response.body.docs[0].docGuid).toBe(testDocId3);
      expect(response.body.docs[1].docGuid).toBe(testDocId2);
      expect(response.body.docs[2].docGuid).toBe(testDocId1);
    });

    test('returns only documents user has access to', async () => {
      // User 1 creates a document
      await documents.createDocument(testDocId1, testUserId);

      // User 2 creates a document
      await documents.createDocument(testDocId2, testUser2Id);

      // User 1 should only see their own document
      const response1 = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response1.status).toBe(200);
      expect(response1.body.docs.some(d => d.docGuid === testDocId1)).toBe(true);
      expect(response1.body.docs.some(d => d.docGuid === testDocId2)).toBe(false);

      // User 2 should only see their own document
      const response2 = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken2}`);

      expect(response2.status).toBe(200);
      expect(response2.body.docs.some(d => d.docGuid === testDocId1)).toBe(false);
      expect(response2.body.docs.some(d => d.docGuid === testDocId2)).toBe(true);
    });

    test('returns shared documents with correct role', async () => {
      // User 1 creates and shares with User 2
      await documents.createDocument(testDocId1, testUserId);
      await pool.query('UPDATE documents SET title = $1 WHERE id = $2', ['Shared Doc', testDocId1]);
      await documents.setRole(testDocId1, testUser2Id, 'editor');

      // User 2 should see the shared document
      const response = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken2}`);

      expect(response.status).toBe(200);
      const sharedDoc = response.body.docs.find(d => d.docGuid === testDocId1);

      expect(sharedDoc).toBeDefined();
      expect(sharedDoc.title).toBe('Shared Doc');
      expect(sharedDoc.role).toBe('editor');
      expect(sharedDoc.ownerEmail).toBe('test-api-docs-1@example.com');
    });

    test('handles special characters in titles', async () => {
      await documents.createDocument(testDocId1, testUserId);
      const specialTitle = 'Test "quoted" & <special> characters';
      await pool.query('UPDATE documents SET title = $1 WHERE id = $2', [specialTitle, testDocId1]);

      const response = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.docs[0].title).toBe(specialTitle);
    });
  });

  // Feature 017 US2: updatedAfter on the content-search branch.
  // Contract: specs/017-search-index-efficiency/contracts/rest-api-docs.md
  describe('GET /api/docs updatedAfter (017 US2)', () => {
    const OLD_TS = '2026-01-10T00:00:00Z';
    const NEW_TS = '2026-06-05T00:00:00Z';
    const CUTOFF = '2026-03-01T00:00:00Z';

    beforeEach(() => {
      enforceUser.mockClear();
    });

    async function seedContentDoc(docId, title, updatedAt, body) {
      // Direct INSERT (not createDocument + UPDATE): the documents table has a
      // BEFORE UPDATE trigger that overwrites updated_at with now().
      await pool.query(
        'INSERT INTO documents (id, title, creator_id, updated_at) VALUES ($1, $2, $3, $4)',
        [docId, title, testUserId, updatedAt]
      );
      await pool.query(
        `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [docId, testUserId]
      );
      await pool.query(
        `INSERT INTO document_search_index (doc_id, content_text, search_vector)
         VALUES ($1, $2,
           setweight(to_tsvector('english', $3), 'A') ||
           setweight(to_tsvector('english', $2), 'B'))`,
        [docId, body, title]
      );
    }

    test('updatedAfter without a content search → 400 with the normative message', async () => {
      const response = await request(app)
        .get('/api/docs?updatedAfter=2026-07-01T00:00:00Z')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('updatedAfter requires a content search: pass search=<query> with searchMode=content');
      expect(enforceUser).not.toHaveBeenCalled(); // rejected before the rate limiter
    });

    test('updatedAfter with search but non-content searchMode → 400', async () => {
      const response = await request(app)
        .get('/api/docs?search=kangaroo&updatedAfter=2026-07-01T00:00:00Z')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('updatedAfter requires a content search: pass search=<query> with searchMode=content');
    });

    test('unparseable updatedAfter → 400 with the normative message', async () => {
      const response = await request(app)
        .get('/api/docs?search=kangaroo&searchMode=content&updatedAfter=banana')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('updatedAfter must be a valid ISO-8601 timestamp');
      expect(enforceUser).not.toHaveBeenCalled();
    });

    test('valid updatedAfter + content search → 200 filtered results with filtered totals', async () => {
      await seedContentDoc(testDocId1, 'Old Kangaroo Notes', OLD_TS, 'kangaroo tracks from the old survey');
      await seedContentDoc(testDocId2, 'New Kangaroo Notes', NEW_TS, 'kangaroo tracks from the new survey');

      const response = await request(app)
        .get(`/api/docs?search=kangaroo&searchMode=content&mode=fulltext&updatedAfter=${encodeURIComponent(CUTOFF)}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      const ids = response.body.docs.map((d) => d.docGuid);
      expect(ids).toContain(testDocId2);
      expect(ids).not.toContain(testDocId1);
      expect(response.body.pagination.total).toBe(1);
    });

    test('future cutoff → 200 with empty docs and total 0', async () => {
      await seedContentDoc(testDocId1, 'Old Kangaroo Notes', OLD_TS, 'kangaroo tracks from the old survey');

      const response = await request(app)
        .get('/api/docs?search=kangaroo&searchMode=content&mode=fulltext&updatedAfter=2030-01-01T00:00:00Z')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.docs).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    test('updatedAfter-filtered content searches still pass through the rate limiter (FR-021)', async () => {
      await seedContentDoc(testDocId1, 'New Kangaroo Notes', NEW_TS, 'kangaroo tracks from the new survey');

      const response = await request(app)
        .get(`/api/docs?search=kangaroo&searchMode=content&mode=fulltext&updatedAfter=${encodeURIComponent(CUTOFF)}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(enforceUser).toHaveBeenCalledTimes(1);
      expect(enforceUser).toHaveBeenCalledWith('search', expect.anything(), expect.anything());
    });

    test('requests without the new params are unchanged (SC-005)', async () => {
      await seedContentDoc(testDocId1, 'New Kangaroo Notes', NEW_TS, 'kangaroo tracks from the new survey');

      const listResponse = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${authToken}`);
      expect(listResponse.status).toBe(200);
      expect(listResponse.body.docs).toHaveLength(1);
      expect(listResponse.body.docs[0]).not.toHaveProperty('snippet');

      const searchResponse = await request(app)
        .get('/api/docs?search=kangaroo&searchMode=content&mode=fulltext')
        .set('Authorization', `Bearer ${authToken}`);
      expect(searchResponse.status).toBe(200);
      expect(searchResponse.body.docs.map((d) => d.docGuid)).toEqual([testDocId1]);
      expect(searchResponse.body.pagination.total).toBe(1);
    });
  });
});
