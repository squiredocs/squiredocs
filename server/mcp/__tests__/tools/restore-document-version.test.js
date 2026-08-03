/**
 * restore_document_version tool tests
 *
 * Tests the MCP tool for restoring documents to previous versions.
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
const restoreDocumentVersion = require('../../tools/restore-document-version');
const createDocument = require('../../tools/create-document');
const agentPresence = require('../../agent-presence');

describe('restore_document_version tool', () => {
  let testUserId;
  let testDocGuid;
  const pendingOperations = [];
  let originalGetOrCreateSession;

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
       VALUES (uuid_generate_v4(), 'google-test-restore', 'test-restore@example.com', 'Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Initialize tools
    agentPresence.init(persistenceProvider);
    restoreDocumentVersion.init(persistenceProvider);
    createDocument.init(persistenceProvider);

    // Mock getOrCreateSession to avoid WebSocket connections in tests
    // but still enforce access control like the real implementation
    originalGetOrCreateSession = agentPresence.getOrCreateSession;
    agentPresence.getOrCreateSession = async (docGuid, agentToken, timeout, options = {}) => {
      const role = await documents.getRole(docGuid, agentToken.userId);
      if (!role) {
        throw new Error('Document not found or you do not have access');
      }
      if (options.requiredRole) {
        const ROLES = { viewer: 1, editor: 2, owner: 3 };
        if ((ROLES[role] || 0) < (ROLES[options.requiredRole] || 0)) {
          throw new Error(`Requires ${options.requiredRole} role, you have ${role}`);
        }
      }
      return {
        provider: { doc: getYDoc(docGuid) },
        sessionId: `test-session-${docGuid}`,
      };
    };
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);

    // Restore original getOrCreateSession
    if (originalGetOrCreateSession) {
      agentPresence.getOrCreateSession = originalGetOrCreateSession;
    }

    await pool.end();
  });

  afterEach(async () => {
    await Promise.all(pendingOperations);
    pendingOperations.length = 0;
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(restoreDocumentVersion.name).toBe('restore_document_version');
      expect(restoreDocumentVersion.description).toBeDefined();
      expect(restoreDocumentVersion.inputSchema).toBeDefined();
      expect(restoreDocumentVersion.inputSchema.type).toBe('object');
    });

    test('requires docGuid and versionId parameters', () => {
      expect(restoreDocumentVersion.inputSchema.required).toContain('docGuid');
      expect(restoreDocumentVersion.inputSchema.required).toContain('versionId');
    });
  });

  describe('handler', () => {
    let oldClock;
    let newClock;

    beforeEach(async () => {
      // Create a test document with multiple versions
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler(
        { title: 'Test Document for Restore' },
        agentToken
      );
      testDocGuid = result.docGuid;

      // Wait for createDocument's title update to persist
      await new Promise(resolve => setTimeout(resolve, 100));
      await Promise.all(pendingOperations);
      pendingOperations.length = 0;

      // Add initial content using documentService for proper persistence
      await documentService.updateDocument(
        testDocGuid,
        (ydoc) => {
          const xmlFragment = ydoc.get('default', Y.XmlFragment);
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, 'Original content');
          paragraph.insert(0, [text]);
          xmlFragment.insert(0, [paragraph]);
        },
        { userId: testUserId }
      );

      // Wait for persistence and verify content exists
      const updates = await waitForPersistence(testDocGuid, 1);
      oldClock = updates[updates.length - 1].clock;

      // Make a second edit to create a new version
      await documentService.updateDocument(
        testDocGuid,
        (ydoc) => {
          const xmlFragment = ydoc.get('default', Y.XmlFragment);
          const paragraph = xmlFragment.get(0);
          const text = paragraph.get(0);
          // Clear and replace text
          text.delete(0, text.length);
          text.insert(0, 'Modified content');
        },
        { userId: testUserId }
      );

      // Wait for persistence and verify we have at least 2 updates
      const updatedUpdates = await waitForPersistence(testDocGuid, 2);
      newClock = updatedUpdates[updatedUpdates.length - 1].clock;
    });

    afterEach(async () => {
      if (testDocGuid) {
        await pool.query('DELETE FROM documents WHERE id = $1', [testDocGuid]);
        testDocGuid = null;
      }
    });

    test('restores to previous version as editor', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-restore',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const oldVersionId = String(oldClock);

      const result = await restoreDocumentVersion.handler(
        { docGuid: testDocGuid, versionId: oldVersionId },
        agentToken
      );

      expect(result).toHaveProperty('success');
      expect(result.success).toBe(true);
      expect(result).toHaveProperty('newClock');
      expect(result).toHaveProperty('message');
      expect(typeof result.newClock).toBe('number');
      expect(result.newClock).toBeGreaterThan(newClock);
    });

    test('creates new update in database', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-restore-db',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const oldVersionId = String(oldClock);
      const updatesBeforeRestore = await persistenceProvider.getUpdatesWithUsers(testDocGuid);
      const countBefore = updatesBeforeRestore.length;

      await restoreDocumentVersion.handler(
        { docGuid: testDocGuid, versionId: oldVersionId },
        agentToken
      );

      await Promise.all(pendingOperations);
      pendingOperations.length = 0;

      const updatesAfterRestore = await persistenceProvider.getUpdatesWithUsers(testDocGuid);
      const countAfter = updatesAfterRestore.length;

      expect(countAfter).toBeGreaterThan(countBefore);
    });

    test('content is restored correctly', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-restore-content',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const oldVersionId = String(oldClock);

      await restoreDocumentVersion.handler(
        { docGuid: testDocGuid, versionId: oldVersionId },
        agentToken
      );

      await Promise.all(pendingOperations);
      pendingOperations.length = 0;

      // Add delay for persistence
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify content was restored
      const ydoc = await persistenceProvider.getYDoc(testDocGuid);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);

      expect(xmlFragment.length).toBeGreaterThan(0);
      const paragraph = xmlFragment.get(0);
      expect(paragraph).toBeDefined();
      expect(paragraph.length).toBeGreaterThan(0);

      const text = paragraph.get(0);
      expect(text).toBeDefined();

      const content = text.toString();
      expect(content).toBe('Original content');
    });

    test('rejects viewer role', async () => {
      // Create a viewer user
      const viewerResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-viewer-restore', 'viewer-restore@example.com', 'Viewer User')
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
        delegationId: 'test-delegation-viewer',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const oldVersionId = String(oldClock);

      await expect(
        restoreDocumentVersion.handler(
          { docGuid: testDocGuid, versionId: oldVersionId },
          agentToken
        )
      ).rejects.toThrow('Requires editor role, you have viewer');

      await pool.query('DELETE FROM users WHERE id = $1', [viewerUserId]);
    });

    test('enforces access control - unauthorized user', async () => {
      const unauthorizedResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-unauthorized-restore', 'unauthorized-restore@example.com', 'Unauthorized User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const unauthorizedUserId = unauthorizedResult.rows[0].id;

      const agentToken = {
        userId: unauthorizedUserId,
        delegationId: 'test-delegation-unauthorized',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const oldVersionId = String(oldClock);

      await expect(
        restoreDocumentVersion.handler(
          { docGuid: testDocGuid, versionId: oldVersionId },
          agentToken
        )
      ).rejects.toThrow('do not have access');

      await pool.query('DELETE FROM users WHERE id = $1', [unauthorizedUserId]);
    });

    test('handles invalid version ID', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-invalid',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      await expect(
        restoreDocumentVersion.handler(
          { docGuid: testDocGuid, versionId: 'invalid-format' },
          agentToken
        )
      ).rejects.toThrow();
    });

    test('can restore to named version', async () => {
      // First create a named version at the old state
      const namedVersionResult = await persistenceProvider.createNamedVersion(
        testDocGuid,
        oldClock,
        oldClock,
        'Saved State',
        testUserId
      );

      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-named',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await restoreDocumentVersion.handler(
        { docGuid: testDocGuid, versionId: namedVersionResult.id },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.newClock).toBeGreaterThan(newClock);
    });
  });
});
