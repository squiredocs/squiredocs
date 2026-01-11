/**
 * Tests for document title denormalization and sync functionality
 */
const Y = require('yjs');
const documents = require('../documents');
const { createPool, createPersistence } = require('./helpers/db');

describe('Document Titles', () => {
  let pool;
  let persistence;
  let testUserId;
  let testDocId;

  beforeAll(async () => {
    // Use shared test database configuration
    pool = createPool();
    persistence = createPersistence();
    await persistence._init();

    documents.init(pool);

    // Create test user
    const user = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-title-google-id', 'test-title@example.com', 'Test Title User', NULL)
       RETURNING id`
    );
    testUserId = user.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query("DELETE FROM document_shares WHERE doc_id IN (SELECT id FROM documents WHERE creator_id = $1)", [testUserId]);
    await pool.query("DELETE FROM documents WHERE creator_id = $1", [testUserId]);
    await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
    await persistence.destroy();
    await pool.end();
  });

  beforeEach(async () => {
    testDocId = require('crypto').randomUUID();
  });

  afterEach(async () => {
    // Clean up document after each test
    if (testDocId) {
      await persistence.clearDocument(testDocId);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [testDocId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [testDocId]);
    }
  });

  describe('PostgresPersistence.updateDocumentTitle', () => {
    beforeEach(async () => {
      // Create a document record
      await documents.createDocument(testDocId, testUserId);
    });

    test('updates document title in database', async () => {
      await persistence.updateDocumentTitle(testDocId, 'Test Title');

      const result = await pool.query(
        'SELECT title FROM documents WHERE id = $1',
        [testDocId]
      );

      expect(result.rows[0].title).toBe('Test Title');
    });

    test('updates title to null', async () => {
      // Set initial title
      await persistence.updateDocumentTitle(testDocId, 'Initial Title');

      // Update to null
      await persistence.updateDocumentTitle(testDocId, null);

      const result = await pool.query(
        'SELECT title FROM documents WHERE id = $1',
        [testDocId]
      );

      expect(result.rows[0].title).toBeNull();
    });

    test('updates title multiple times', async () => {
      await persistence.updateDocumentTitle(testDocId, 'Title 1');
      await persistence.updateDocumentTitle(testDocId, 'Title 2');
      await persistence.updateDocumentTitle(testDocId, 'Title 3');

      const result = await pool.query(
        'SELECT title FROM documents WHERE id = $1',
        [testDocId]
      );

      expect(result.rows[0].title).toBe('Title 3');
    });

    test('handles long titles', async () => {
      const longTitle = 'A'.repeat(255); // Max length
      await persistence.updateDocumentTitle(testDocId, longTitle);

      const result = await pool.query(
        'SELECT title FROM documents WHERE id = $1',
        [testDocId]
      );

      expect(result.rows[0].title).toBe(longTitle);
    });
  });

  describe('getAccessibleDocuments with titles', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
    });

    test('includes title in results', async () => {
      // Set a title
      await pool.query(
        'UPDATE documents SET title = $1 WHERE id = $2',
        ['My Test Document', testDocId]
      );

      const { rows: docs } = await documents.getAccessibleDocuments(testUserId);
      const doc = docs.find(d => d.doc_id === testDocId);

      expect(doc).toBeDefined();
      expect(doc.title).toBe('My Test Document');
    });

    test('includes null title for documents without titles', async () => {
      const { rows: docs } = await documents.getAccessibleDocuments(testUserId);
      const doc = docs.find(d => d.doc_id === testDocId);

      expect(doc).toBeDefined();
      expect(doc.title).toBeNull();
    });

    test('returns titles for multiple documents', async () => {
      const doc2Id = require('crypto').randomUUID();
      const doc3Id = require('crypto').randomUUID();

      await documents.createDocument(doc2Id, testUserId);
      await documents.createDocument(doc3Id, testUserId);

      await pool.query('UPDATE documents SET title = $1 WHERE id = $2', ['Doc 1', testDocId]);
      await pool.query('UPDATE documents SET title = $1 WHERE id = $2', ['Doc 2', doc2Id]);
      await pool.query('UPDATE documents SET title = $1 WHERE id = $2', ['Doc 3', doc3Id]);

      const { rows: docs } = await documents.getAccessibleDocuments(testUserId);

      expect(docs.length).toBeGreaterThanOrEqual(3);

      const titles = docs
        .filter(d => [testDocId, doc2Id, doc3Id].includes(d.doc_id))
        .map(d => d.title)
        .sort();

      expect(titles).toEqual(['Doc 1', 'Doc 2', 'Doc 3']);

      // Clean up
      await pool.query('DELETE FROM document_shares WHERE doc_id IN ($1, $2)', [doc2Id, doc3Id]);
      await pool.query('DELETE FROM documents WHERE id IN ($1, $2)', [doc2Id, doc3Id]);
    });
  });

  describe('Title extraction from Yjs meta', () => {
    test('getDocumentMeta extracts title from Yjs document', async () => {
      // Create a Yjs document with a title
      const ydoc = new Y.Doc();
      const meta = ydoc.getMap('meta');
      meta.set('title', 'Test Document Title');

      // Store it
      const update = Y.encodeStateAsUpdate(ydoc);
      await persistence.storeUpdate(testDocId, update, testUserId);

      // Retrieve the meta
      const retrievedMeta = await persistence.getDocumentMeta(testDocId);

      expect(retrievedMeta.title).toBe('Test Document Title');
    });

    test('getDocumentMeta returns null for document without title', async () => {
      // Create a Yjs document without setting a title
      const ydoc = new Y.Doc();
      const content = ydoc.get('default', Y.XmlFragment);
      const paragraph = new Y.XmlElement('paragraph');
      content.insert(0, [paragraph]);

      // Store it
      const update = Y.encodeStateAsUpdate(ydoc);
      await persistence.storeUpdate(testDocId, update, testUserId);

      // Retrieve the meta
      const retrievedMeta = await persistence.getDocumentMeta(testDocId);

      expect(retrievedMeta.title).toBeNull();
    });

    test('getDocumentMeta returns null for non-existent document', async () => {
      const randomDocId = require('crypto').randomUUID();
      const meta = await persistence.getDocumentMeta(randomDocId);

      expect(meta.title).toBeNull();
    });
  });

  describe('Title sync integration', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
    });

    test('title syncs when Yjs meta.title is updated', async () => {
      // Create a Yjs document with a title
      const ydoc = new Y.Doc();
      const meta = ydoc.getMap('meta');
      meta.set('title', 'Initial Title');

      // Store initial update
      const update1 = Y.encodeStateAsUpdate(ydoc);
      await persistence.storeUpdate(testDocId, update1, testUserId);

      // Manually sync the title (simulating what the server does)
      await persistence.updateDocumentTitle(testDocId, 'Initial Title');

      // Verify initial title
      let result = await pool.query('SELECT title FROM documents WHERE id = $1', [testDocId]);
      expect(result.rows[0].title).toBe('Initial Title');

      // Update the title in Yjs
      meta.set('title', 'Updated Title');
      const update2 = Y.encodeStateAsUpdate(ydoc);
      await persistence.storeUpdate(testDocId, update2, testUserId);

      // Manually sync the updated title
      await persistence.updateDocumentTitle(testDocId, 'Updated Title');

      // Verify updated title
      result = await pool.query('SELECT title FROM documents WHERE id = $1', [testDocId]);
      expect(result.rows[0].title).toBe('Updated Title');
    });

    test('title can be cleared by setting to empty string', async () => {
      // Set initial title
      const ydoc = new Y.Doc();
      const meta = ydoc.getMap('meta');
      meta.set('title', 'Initial Title');

      const update1 = Y.encodeStateAsUpdate(ydoc);
      await persistence.storeUpdate(testDocId, update1, testUserId);
      await persistence.updateDocumentTitle(testDocId, 'Initial Title');

      // Clear the title
      meta.set('title', '');
      const update2 = Y.encodeStateAsUpdate(ydoc);
      await persistence.storeUpdate(testDocId, update2, testUserId);
      await persistence.updateDocumentTitle(testDocId, '');

      // Verify title is empty
      const result = await pool.query('SELECT title FROM documents WHERE id = $1', [testDocId]);
      expect(result.rows[0].title).toBe('');
    });
  });

  describe('Performance - title retrieval', () => {
    test('retrieving titles does not reconstruct Yjs documents', async () => {
      // This is a design test - getAccessibleDocuments should read titles
      // directly from the documents table, not call getDocumentMeta()

      await documents.createDocument(testDocId, testUserId);
      await pool.query('UPDATE documents SET title = $1 WHERE id = $2', ['Fast Title', testDocId]);

      const startTime = Date.now();
      const { rows: docs } = await documents.getAccessibleDocuments(testUserId);
      const endTime = Date.now();

      const doc = docs.find(d => d.doc_id === testDocId);
      expect(doc.title).toBe('Fast Title');

      // Should be very fast (< 100ms) since it's just a SQL query
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(100);
    });
  });
});
