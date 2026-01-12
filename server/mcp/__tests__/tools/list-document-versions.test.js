/**
 * list_document_versions tool tests
 *
 * Tests the MCP tool for listing document version history.
 */
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const Y = require('yjs');

// Use shared test database configuration
const pool = createPool();
const persistenceProvider = createPersistence();

// Import modules
const listDocumentVersions = require('../../tools/list-document-versions');
const createDocument = require('../../tools/create-document');

describe('list_document_versions tool', () => {
  let testUserId;
  let testDocGuid;

  beforeAll(async () => {
    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-test-versions', 'test-versions@example.com', 'Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Initialize tools
    listDocumentVersions.init(persistenceProvider);
    createDocument.init(persistenceProvider);
  });

  afterAll(async () => {
    // Cleanup
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(listDocumentVersions.name).toBe('list_document_versions');
      expect(listDocumentVersions.description).toBeDefined();
      expect(listDocumentVersions.inputSchema).toBeDefined();
      expect(listDocumentVersions.inputSchema.type).toBe('object');
    });

    test('requires docGuid parameter', () => {
      expect(listDocumentVersions.inputSchema.required).toContain('docGuid');
    });

    test('has optional limit and offset parameters', () => {
      expect(listDocumentVersions.inputSchema.properties.limit).toBeDefined();
      expect(listDocumentVersions.inputSchema.properties.offset).toBeDefined();
      expect(listDocumentVersions.inputSchema.properties.limit.default).toBe(50);
      expect(listDocumentVersions.inputSchema.properties.offset.default).toBe(0);
    });
  });

  describe('handler', () => {
    beforeEach(async () => {
      // Create a test document
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler(
        { title: 'Test Document for Versions' },
        agentToken
      );
      testDocGuid = result.docGuid;
    });

    afterEach(async () => {
      // Cleanup document after each test
      if (testDocGuid) {
        await pool.query('DELETE FROM documents WHERE id = $1', [testDocGuid]);
        testDocGuid = null;
      }
    });

    test('lists versions for document with no edits', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid },
        agentToken
      );

      expect(result).toHaveProperty('versions');
      expect(result).toHaveProperty('totalEdits');
      expect(result).toHaveProperty('pagination');
      expect(Array.isArray(result.versions)).toBe(true);
      // New document may have initial version or be empty
      expect(result.totalEdits).toBeGreaterThanOrEqual(0);
    });

    test('enforces access control - unauthorized user', async () => {
      // Create another user
      const unauthorizedResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-unauthorized', 'unauthorized@example.com', 'Unauthorized User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const unauthorizedUserId = unauthorizedResult.rows[0].id;

      const agentToken = {
        userId: unauthorizedUserId,
        scopes: ['documents:read'],
      };

      await expect(
        listDocumentVersions.handler({ docGuid: testDocGuid }, agentToken)
      ).rejects.toThrow('do not have access');

      // Cleanup
      await pool.query('DELETE FROM users WHERE id = $1', [unauthorizedUserId]);
    });

    test('supports pagination - first page', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid, limit: 10, offset: 0 },
        agentToken
      );

      expect(result.pagination).toHaveProperty('total');
      expect(result.pagination).toHaveProperty('limit');
      expect(result.pagination).toHaveProperty('offset');
      expect(result.pagination).toHaveProperty('hasMore');
      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.offset).toBe(0);
    });

    test('clamps limit to maximum of 100', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid, limit: 200 },
        agentToken
      );

      expect(result.pagination.limit).toBe(100);
    });

    test('clamps limit to minimum of 1', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid, limit: 0 },
        agentToken
      );

      expect(result.pagination.limit).toBe(1);
    });
  });
});
