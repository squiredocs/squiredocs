/**
 * list_documents tool tests
 *
 * Tests the MCP tool for listing documents accessible to an agent.
 */
const { Pool } = require('pg');
const { PostgresPersistence } = require('../../../postgres-persistence');

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
const listDocuments = require('../../tools/list-documents');

describe('list_documents tool', () => {
  let testUser1Id;
  let testUser2Id;
  let testDoc1Id;
  let testDoc2Id;
  let testDoc3Id;

  beforeAll(async () => {
    // Initialize modules
    documents.init(pool);
    listDocuments.init(persistenceProvider);

    // Create test users
    const user1Result = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-list-test-1', 'list-test-1@example.com', 'List Test User 1')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUser1Id = user1Result.rows[0].id;

    const user2Result = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-list-test-2', 'list-test-2@example.com', 'List Test User 2')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUser2Id = user2Result.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM document_shares WHERE user_id IN ($1, $2)', [
      testUser1Id,
      testUser2Id,
    ]);
    await pool.query('DELETE FROM documents WHERE creator_id IN ($1, $2)', [
      testUser1Id,
      testUser2Id,
    ]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [testUser1Id, testUser2Id]);
    await pool.end();
  });

  beforeEach(async () => {
    // Clean up documents before each test
    await pool.query('DELETE FROM document_shares WHERE user_id IN ($1, $2)', [
      testUser1Id,
      testUser2Id,
    ]);
    await pool.query('DELETE FROM documents WHERE creator_id IN ($1, $2)', [
      testUser1Id,
      testUser2Id,
    ]);

    // Create test documents
    // Doc 1: owned by user 1
    const doc1Result = await pool.query(
      `INSERT INTO documents (id, creator_id)
       VALUES (uuid_generate_v4(), $1)
       RETURNING id`,
      [testUser1Id]
    );
    testDoc1Id = doc1Result.rows[0].id;
    await documents.setRole(testDoc1Id, testUser1Id, 'owner');

    // Doc 2: owned by user 1, shared with user 2 as editor
    const doc2Result = await pool.query(
      `INSERT INTO documents (id, creator_id)
       VALUES (uuid_generate_v4(), $1)
       RETURNING id`,
      [testUser1Id]
    );
    testDoc2Id = doc2Result.rows[0].id;
    await documents.setRole(testDoc2Id, testUser1Id, 'owner');
    await documents.setRole(testDoc2Id, testUser2Id, 'editor');

    // Doc 3: owned by user 2
    const doc3Result = await pool.query(
      `INSERT INTO documents (id, creator_id)
       VALUES (uuid_generate_v4(), $1)
       RETURNING id`,
      [testUser2Id]
    );
    testDoc3Id = doc3Result.rows[0].id;
    await documents.setRole(testDoc3Id, testUser2Id, 'owner');
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(listDocuments.name).toBe('list_documents');
      expect(listDocuments.description).toBeDefined();
      expect(listDocuments.inputSchema).toBeDefined();
      expect(listDocuments.inputSchema.type).toBe('object');
    });

    test('filter property has correct enum values', () => {
      const filterProp = listDocuments.inputSchema.properties.filter;
      expect(filterProp.enum).toContain('owned');
      expect(filterProp.enum).toContain('shared_with_me');
      expect(filterProp.enum).toContain('all');
    });
  });

  describe('handler', () => {
    test('returns all accessible documents by default', async () => {
      const agentToken = {
        userId: testUser1Id,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await listDocuments.handler({}, agentToken);

      expect(result.documents).toBeDefined();
      expect(result.documents).toHaveLength(2); // Doc 1 and Doc 2
      expect(result.documents.map((d) => d.id)).toContain(testDoc1Id);
      expect(result.documents.map((d) => d.id)).toContain(testDoc2Id);
    });

    test('returns only owned documents when filter is "owned"', async () => {
      const agentToken = {
        userId: testUser1Id,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await listDocuments.handler({ filter: 'owned' }, agentToken);

      expect(result.documents).toHaveLength(2); // User 1 owns Doc 1 and Doc 2
      result.documents.forEach((doc) => {
        expect(doc.role).toBe('owner');
      });
    });

    test('returns only shared documents when filter is "shared_with_me"', async () => {
      const agentToken = {
        userId: testUser2Id,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await listDocuments.handler({ filter: 'shared_with_me' }, agentToken);

      expect(result.documents).toHaveLength(1); // User 2 has Doc 2 shared with them
      expect(result.documents[0].id).toBe(testDoc2Id);
      expect(result.documents[0].role).toBe('editor');
    });

    test('returns document metadata', async () => {
      const agentToken = {
        userId: testUser1Id,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await listDocuments.handler({}, agentToken);

      const doc = result.documents.find((d) => d.id === testDoc1Id);
      expect(doc).toBeDefined();
      expect(doc.id).toBe(testDoc1Id);
      expect(doc.role).toBe('owner');
      expect(doc.createdAt).toBeDefined();
      expect(doc.updatedAt).toBeDefined();
    });

    test('returns document titles from Yjs metadata', async () => {
      const agentToken = {
        userId: testUser1Id,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await listDocuments.handler({}, agentToken);

      expect(result.documents).toBeDefined();
      result.documents.forEach((doc) => {
        // title field should be present (may be null if document has no title set)
        expect(doc).toHaveProperty('title');
      });
    });

    test('returns empty array when user has no documents', async () => {
      // Create a new user with no documents
      const emptyUserResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-empty-' || random(), 'empty-test@example.com', 'Empty User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const emptyUserId = emptyUserResult.rows[0].id;

      const agentToken = {
        userId: emptyUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await listDocuments.handler({}, agentToken);

      expect(result.documents).toEqual([]);

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [emptyUserId]);
    });

    test('includes share count for each document', async () => {
      const agentToken = {
        userId: testUser1Id,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:read'],
      };

      const result = await listDocuments.handler({}, agentToken);

      const doc1 = result.documents.find((d) => d.id === testDoc1Id);
      const doc2 = result.documents.find((d) => d.id === testDoc2Id);

      expect(doc1.shareCount).toBe(1); // Only owner
      expect(doc2.shareCount).toBe(2); // Owner + editor
    });
  });
});
