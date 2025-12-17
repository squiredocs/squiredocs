/**
 * get_document tool tests
 *
 * Tests the MCP tool for reading document content.
 */
const { Pool } = require('pg');
const { PostgresPersistence } = require('../../../postgres-persistence');
const Y = require('yjs');

// Test database configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// Create persistence provider
const persistenceProvider = new PostgresPersistence({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// Import modules
const documents = require('../../../documents');
const getDocument = require('../../tools/get-document');

describe('get_document tool', () => {
  let testUserId;
  let testUser2Id;
  let testDocId;

  beforeAll(async () => {
    // Initialize modules
    documents.init(pool);
    getDocument.init(persistenceProvider);

    // Create test users
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-get-doc-test', 'get-doc-test@example.com', 'Get Doc Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    const user2Result = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-get-doc-test-2', 'get-doc-test-2@example.com', 'Get Doc Test User 2')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUser2Id = user2Result.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [testDocId]);
    await pool.query('DELETE FROM document_shares WHERE user_id IN ($1, $2)', [
      testUserId,
      testUser2Id,
    ]);
    await pool.query('DELETE FROM documents WHERE creator_id IN ($1, $2)', [
      testUserId,
      testUser2Id,
    ]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [testUserId, testUser2Id]);
    await pool.end();
  });

  beforeEach(async () => {
    // Clean up and create fresh test document
    if (testDocId) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [testDocId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [testDocId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [testDocId]);
    }

    // Create test document
    const docResult = await pool.query(
      `INSERT INTO documents (id, creator_id)
       VALUES (uuid_generate_v4(), $1)
       RETURNING id`,
      [testUserId]
    );
    testDocId = docResult.rows[0].id;
    await documents.setRole(testDocId, testUserId, 'owner');

    // Create a Yjs document with some content and store it
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);

    // Add a paragraph with text
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Hello, this is test content.');
    paragraph.insert(0, [text]);
    xmlFragment.insert(0, [paragraph]);

    // Store the update
    const update = Y.encodeStateAsUpdate(ydoc);
    await pool.query(
      'INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id) VALUES ($1, $2, $3, $4)',
      [testDocId, 1, Buffer.from(update), testUserId]
    );
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(getDocument.name).toBe('get_document');
      expect(getDocument.description).toBeDefined();
      expect(getDocument.inputSchema).toBeDefined();
      expect(getDocument.inputSchema.type).toBe('object');
      expect(getDocument.inputSchema.required).toContain('docGuid');
    });

    test('does not have format parameter (always structured)', () => {
      expect(getDocument.inputSchema.properties.format).toBeUndefined();
    });
  });

  describe('handler', () => {
    test('returns document content in structured format', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await getDocument.handler({ docGuid: testDocId }, agentToken);

      expect(result.docGuid).toBe(testDocId);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);

      // Check structure
      const paragraph = result.content.find((node) => node.type === 'paragraph');
      expect(paragraph).toBeDefined();
      expect(paragraph.content).toContain('Hello, this is test content.');
    });

    test('returns document metadata', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await getDocument.handler({ docGuid: testDocId }, agentToken);

      expect(result.role).toBe('owner');
      expect(result.updatedAt).toBeDefined();
    });

    test('throws error when user has no access', async () => {
      const agentToken = {
        userId: testUser2Id, // User 2 has no access
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      await expect(getDocument.handler({ docGuid: testDocId }, agentToken)).rejects.toThrow(
        /access/i
      );
    });

    test('throws error for non-existent document', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      await expect(
        getDocument.handler({ docGuid: '00000000-0000-0000-0000-000000000000' }, agentToken)
      ).rejects.toThrow(/not found|access/i);
    });

    test('returns empty array for new document', async () => {
      // Create a document with no Yjs updates
      const emptyDocResult = await pool.query(
        `INSERT INTO documents (id, creator_id)
         VALUES (uuid_generate_v4(), $1)
         RETURNING id`,
        [testUserId]
      );
      const emptyDocId = emptyDocResult.rows[0].id;
      await documents.setRole(emptyDocId, testUserId, 'owner');

      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await getDocument.handler({ docGuid: emptyDocId }, agentToken);

      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(0);

      // Clean up
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [emptyDocId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [emptyDocId]);
    });

    test('works with viewer role', async () => {
      // Share document with user 2 as viewer
      await documents.setRole(testDocId, testUser2Id, 'viewer');

      const agentToken = {
        userId: testUser2Id,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await getDocument.handler({ docGuid: testDocId }, agentToken);

      expect(result.role).toBe('viewer');
      expect(Array.isArray(result.content)).toBe(true);
    });

    test('returns formatted text with marks', async () => {
      // Create a document with formatted text
      const ydoc = new Y.Doc();
      const xmlFragment = ydoc.get('default', Y.XmlFragment);

      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'plain ');
      const boldText = new Y.XmlText();
      boldText.insert(0, 'bold text', { bold: true });
      paragraph.insert(0, [text, boldText]);
      xmlFragment.insert(0, [paragraph]);

      // Create new document for this test
      const formattedDocResult = await pool.query(
        `INSERT INTO documents (id, creator_id)
         VALUES (uuid_generate_v4(), $1)
         RETURNING id`,
        [testUserId]
      );
      const formattedDocId = formattedDocResult.rows[0].id;
      await documents.setRole(formattedDocId, testUserId, 'owner');

      const update = Y.encodeStateAsUpdate(ydoc);
      await pool.query(
        'INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, $2, $3)',
        [formattedDocId, 1, Buffer.from(update)]
      );

      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await getDocument.handler({ docGuid: formattedDocId }, agentToken);

      expect(Array.isArray(result.content)).toBe(true);
      const paragraph2 = result.content[0];
      expect(paragraph2.type).toBe('paragraph');
      // Content should be an array with formatted items
      expect(Array.isArray(paragraph2.content)).toBe(true);

      // Clean up
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [formattedDocId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [formattedDocId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [formattedDocId]);
    });
  });
});
