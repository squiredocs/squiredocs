/**
 * read_document_version tool tests
 *
 * Tests the MCP tool for reading document content at a specific version.
 */
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const Y = require('yjs');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../../../origin');

// Use shared test database configuration
const pool = createPool();
const persistenceProvider = createPersistence();

// Import modules
const documents = require('../../../documents');
const readDocumentVersion = require('../../tools/read-document-version');
const createDocument = require('../../tools/create-document');

describe('read_document_version tool', () => {
  let testUserId;
  let testDocGuid;
  const pendingOperations = [];

  // Helper to wait for persistence and verify content exists
  async function waitForPersistence(docGuid, expectedMinUpdates = 1) {
    await Promise.all(pendingOperations);
    pendingOperations.length = 0;

    // Wait with multiple retries for persistence to complete
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const updates = await persistenceProvider.getUpdatesWithUsers(docGuid);
      if (updates.length >= expectedMinUpdates) {
        return updates;
      }
    }

    // Final check
    const updates = await persistenceProvider.getUpdatesWithUsers(docGuid);
    if (updates.length < expectedMinUpdates) {
      throw new Error(`Expected at least ${expectedMinUpdates} updates, got ${updates.length}`);
    }
    return updates;
  }

  beforeAll(async () => {
    // Set up y-websocket persistence
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          const { userId, agentName } = parsed;
          const storePromise = persistenceProvider.storeUpdate(docGuid, update, userId, agentName);
          pendingOperations.push(storePromise);
        });
        try {
          const persistedYdoc = await persistenceProvider.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);
        } catch (error) {
          // Document doesn't exist yet
        }
        // Mirrors the real createBindState's completion mark, which the 048
        // bind-readiness gate in updateDocument waits on.
        ydoc._bindComplete = true;
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
       VALUES (uuid_generate_v4(), 'google-test-read-version', 'test-read-version@example.com', 'Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Initialize tools
    readDocumentVersion.init(persistenceProvider);
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
      expect(readDocumentVersion.name).toBe('read_document_version');
      expect(readDocumentVersion.description).toBeDefined();
      expect(readDocumentVersion.inputSchema).toBeDefined();
      expect(readDocumentVersion.inputSchema.type).toBe('object');
    });

    test('requires docGuid and versionId parameters', () => {
      expect(readDocumentVersion.inputSchema.required).toContain('docGuid');
      expect(readDocumentVersion.inputSchema.required).toContain('versionId');
    });

    test('has optional xpath and format parameters', () => {
      expect(readDocumentVersion.inputSchema.properties.xpath).toBeDefined();
      expect(readDocumentVersion.inputSchema.properties.format).toBeDefined();
      expect(readDocumentVersion.inputSchema.properties.format.enum).toContain('markdown');
      expect(readDocumentVersion.inputSchema.properties.format.enum).toContain('structured');
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
        { title: 'Test Document for Version Reading' },
        agentToken
      );
      testDocGuid = result.docGuid;

      // Wait for createDocument's title update to persist
      await new Promise(resolve => setTimeout(resolve, 100));
      await Promise.all(pendingOperations);
      pendingOperations.length = 0;

      // Add some content to the document to create a version using documentService
      await documentService.updateDocument(
        testDocGuid,
        (ydoc) => {
          const xmlFragment = ydoc.get('default', Y.XmlFragment);
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, 'Test content for version');
          paragraph.insert(0, [text]);
          xmlFragment.insert(0, [paragraph]);
        },
        { userId: testUserId }
      );

      // Wait for persistence and verify content exists
      await waitForPersistence(testDocGuid, 1);
    });

    afterEach(async () => {
      if (testDocGuid) {
        await pool.query('DELETE FROM documents WHERE id = $1', [testDocGuid]);
        testDocGuid = null;
      }
    });

    test('reads version content in structured format', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      // Get the current version ID
      const updates = await persistenceProvider.getUpdatesWithUsers(testDocGuid);
      const latestClock = updates[updates.length - 1].clock;
      const versionId = String(latestClock);

      const result = await readDocumentVersion.handler(
        { docGuid: testDocGuid, versionId, format: 'structured' },
        agentToken
      );

      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('blockCount');
      expect(result).toHaveProperty('characterCount');
      expect(result).toHaveProperty('version');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.blockCount).toBeGreaterThan(0);
      expect(result.version.id).toBe(versionId);
    });

    test('reads version content in markdown format', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const updates = await persistenceProvider.getUpdatesWithUsers(testDocGuid);
      const latestClock = updates[updates.length - 1].clock;
      const versionId = String(latestClock);

      const result = await readDocumentVersion.handler(
        { docGuid: testDocGuid, versionId, format: 'markdown' },
        agentToken
      );

      expect(result).toHaveProperty('content');
      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('Test content for version');
    });

    test('supports xpath filtering on historical version', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const updates = await persistenceProvider.getUpdatesWithUsers(testDocGuid);
      const latestClock = updates[updates.length - 1].clock;
      const versionId = String(latestClock);

      const result = await readDocumentVersion.handler(
        {
          docGuid: testDocGuid,
          versionId,
          xpath: '//paragraph',
          format: 'structured'
        },
        agentToken
      );

      expect(result).toHaveProperty('matchCount');
      expect(result.matchCount).toBeGreaterThan(0);
      expect(Array.isArray(result.content)).toBe(true);
    });

    test('enforces access control - unauthorized user', async () => {
      const unauthorizedResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-unauthorized-read-ver', 'unauthorized-read-ver@example.com', 'Unauthorized User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const unauthorizedUserId = unauthorizedResult.rows[0].id;

      const agentToken = {
        userId: unauthorizedUserId,
        scopes: ['documents:read'],
      };

      await expect(
        readDocumentVersion.handler(
          { docGuid: testDocGuid, versionId: '0' },
          agentToken
        )
      ).rejects.toThrow('do not have access');

      await pool.query('DELETE FROM users WHERE id = $1', [unauthorizedUserId]);
    });

    test('throws error for invalid version ID', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      await expect(
        readDocumentVersion.handler(
          { docGuid: testDocGuid, versionId: 'invalid-format' },
          agentToken
        )
      ).rejects.toThrow();
    });

    test('counts characters correctly', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const updates = await persistenceProvider.getUpdatesWithUsers(testDocGuid);
      const latestClock = updates[updates.length - 1].clock;
      const versionId = String(latestClock);

      const result = await readDocumentVersion.handler(
        { docGuid: testDocGuid, versionId },
        agentToken
      );

      expect(result.characterCount).toBeGreaterThan(0);
      expect(typeof result.characterCount).toBe('number');
    });
  });
});
