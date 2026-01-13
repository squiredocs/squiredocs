/**
 * create_document_version tool tests
 *
 * Tests the MCP tool for creating named document versions.
 */
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const Y = require('yjs');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');

// Use shared test database configuration
const pool = createPool();
const persistenceProvider = createPersistence();

// Import modules
const documents = require('../../../documents');
const createDocumentVersion = require('../../tools/create-document-version');
const createDocument = require('../../tools/create-document');

describe('create_document_version tool', () => {
  let testUserId;
  let testDocGuid;
  const pendingOperations = [];

  beforeAll(async () => {
    // Set up y-websocket persistence
    const ORIGIN_DB_LOAD = 'db-load';
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
        ydoc.on('update', (update, origin) => {
          if (origin === ORIGIN_DB_LOAD) return;
          const userId = typeof origin === 'string' ? origin : null;
          const storePromise = persistenceProvider.storeUpdate(docGuid, update, userId);
          pendingOperations.push(storePromise);
        });
        try {
          const persistedYdoc = await persistenceProvider.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);
        } catch (error) {
          // Document doesn't exist yet
        }
      },
      writeState: async () => {},
      provider: persistenceProvider,
    });

    // Initialize document service
    const extractDocGuid = (docName) => {
      if (docName.startsWith('s/')) {
        return docName.slice(2);
      }
      return docName;
    };
    documentService.init(getYDoc, extractDocGuid);

    // Initialize documents module
    documents.init(pool);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-test-create-version', 'test-create-version@example.com', 'Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Initialize tools
    createDocumentVersion.init(persistenceProvider);
    createDocument.init(persistenceProvider);
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  afterEach(async () => {
    await Promise.all(pendingOperations);
    pendingOperations.length = 0;
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(createDocumentVersion.name).toBe('create_document_version');
      expect(createDocumentVersion.description).toBeDefined();
      expect(createDocumentVersion.inputSchema).toBeDefined();
      expect(createDocumentVersion.inputSchema.type).toBe('object');
    });

    test('requires docGuid and name parameters', () => {
      expect(createDocumentVersion.inputSchema.required).toContain('docGuid');
      expect(createDocumentVersion.inputSchema.required).toContain('name');
    });

    test('name has length constraints', () => {
      expect(createDocumentVersion.inputSchema.properties.name.minLength).toBe(1);
      expect(createDocumentVersion.inputSchema.properties.name.maxLength).toBe(255);
    });
  });

  describe('handler', () => {
    beforeEach(async () => {
      // Create a test document with some content
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler(
        { title: 'Test Document for Named Versions' },
        agentToken
      );
      testDocGuid = result.docGuid;

      // Add content to create a version using documentService to ensure proper persistence
      await documentService.updateDocument(
        testDocGuid,
        (ydoc) => {
          const xmlFragment = ydoc.get('default', Y.XmlFragment);
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, 'Content for named version');
          paragraph.insert(0, [text]);
          xmlFragment.insert(0, [paragraph]);
        },
        testUserId
      );

      // Wait for all updates to be persisted
      await Promise.all(pendingOperations);
      pendingOperations.length = 0;

      // Add a delay to ensure database writes complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Force a read from persistence to ensure updates are stored
      await persistenceProvider.getYDoc(testDocGuid);
    });

    afterEach(async () => {
      if (testDocGuid) {
        await pool.query('DELETE FROM documents WHERE id = $1', [testDocGuid]);
        testDocGuid = null;
      }
    });

    test('creates named version as editor', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:write'],
      };

      const result = await createDocumentVersion.handler(
        { docGuid: testDocGuid, name: 'Draft 1' },
        agentToken
      );

      expect(result).toHaveProperty('success');
      expect(result.success).toBe(true);
      expect(result).toHaveProperty('version');
      expect(result.version).toHaveProperty('id');
      expect(result.version).toHaveProperty('name');
      expect(result.version.name).toBe('Draft 1');
      expect(result.version).toHaveProperty('clockStart');
      expect(result.version).toHaveProperty('clockEnd');
      expect(result.version).toHaveProperty('timestamp');
      expect(result).toHaveProperty('message');
    });

    test('creates named version as owner', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:write'],
      };

      const result = await createDocumentVersion.handler(
        { docGuid: testDocGuid, name: 'Final Version' },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.version.name).toBe('Final Version');
    });

    test('rejects viewer role', async () => {
      // Create a viewer user
      const viewerResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-viewer-create', 'viewer-create@example.com', 'Viewer User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const viewerUserId = viewerResult.rows[0].id;

      // Share document as viewer
      await pool.query(
        `INSERT INTO document_shares (doc_id, user_id, role)
         VALUES ($1, $2, 'viewer')`,
        [testDocGuid, viewerUserId]
      );

      const agentToken = {
        userId: viewerUserId,
        scopes: ['documents:write'],
      };

      await expect(
        createDocumentVersion.handler(
          { docGuid: testDocGuid, name: 'Draft 1' },
          agentToken
        )
      ).rejects.toThrow('viewers cannot create document versions');

      await pool.query('DELETE FROM users WHERE id = $1', [viewerUserId]);
    });

    test('rejects empty name', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:write'],
      };

      await expect(
        createDocumentVersion.handler(
          { docGuid: testDocGuid, name: '   ' },
          agentToken
        )
      ).rejects.toThrow('cannot be empty');
    });

    test('rejects name exceeding 255 characters', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:write'],
      };

      const longName = 'a'.repeat(256);

      await expect(
        createDocumentVersion.handler(
          { docGuid: testDocGuid, name: longName },
          agentToken
        )
      ).rejects.toThrow('cannot exceed 255 characters');
    });

    test('handles special characters in name', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:write'],
      };

      const result = await createDocumentVersion.handler(
        { docGuid: testDocGuid, name: 'Version "Final" - 2024/01/15 (approved)' },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.version.name).toBe('Version "Final" - 2024/01/15 (approved)');
    });

    test('persists version to database', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:write'],
      };

      const result = await createDocumentVersion.handler(
        { docGuid: testDocGuid, name: 'Database Test' },
        agentToken
      );

      // Verify in database
      const dbResult = await pool.query(
        'SELECT * FROM document_versions WHERE id = $1',
        [result.version.id]
      );

      expect(dbResult.rows.length).toBe(1);
      expect(dbResult.rows[0].name).toBe('Database Test');
      expect(dbResult.rows[0].doc_id).toBe(testDocGuid);
      expect(dbResult.rows[0].created_by).toBe(testUserId);
    });

    test('enforces access control - unauthorized user', async () => {
      const unauthorizedResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-unauthorized-create', 'unauthorized-create@example.com', 'Unauthorized User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const unauthorizedUserId = unauthorizedResult.rows[0].id;

      const agentToken = {
        userId: unauthorizedUserId,
        scopes: ['documents:write'],
      };

      await expect(
        createDocumentVersion.handler(
          { docGuid: testDocGuid, name: 'Draft 1' },
          agentToken
        )
      ).rejects.toThrow('do not have access');

      await pool.query('DELETE FROM users WHERE id = $1', [unauthorizedUserId]);
    });
  });
});
