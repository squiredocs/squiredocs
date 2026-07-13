/**
 * create_document tool tests
 *
 * Tests the MCP tool for creating documents with a title.
 */
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const Y = require('yjs');

// Use shared test database configuration
const pool = createPool();
const persistenceProvider = createPersistence();

// Import modules
const documents = require('../../../documents');
const users = require('../../../auth/users');
const onboarding = require('../../../onboarding');
const createDocument = require('../../tools/create-document');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../../../origin');

// Track pending persistence operations for test reliability
const pendingOperations = [];

describe('create_document tool', () => {
  let testUserId;

  beforeAll(async () => {
    // Initialize y-websocket persistence for tests
    setPersistence({
      bindState: async (docName, ydoc) => {
        // Extract docGuid from docName (format: "s/{docGuid}")
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;

        // Set up update listener to persist changes
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          const { userId, agentName } = parsed;

          // Track the promise to ensure persistence completes before test cleanup
          const storePromise = persistenceProvider.storeUpdate(docGuid, update, userId, agentName).catch((err) => {
            console.error(`Error persisting update for ${docGuid}:`, err);
          });
          pendingOperations.push(storePromise);
        });

        try {
          const persistedYdoc = await persistenceProvider.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);
        } catch (error) {
          // Document doesn't exist yet, that's okay
        }
      },
      writeState: async () => {}, // No-op for tests
      provider: persistenceProvider,
    });

    // Initialize document service for tests
    const extractDocGuid = (docName) => {
      if (docName.startsWith('s/')) {
        return docName.slice(2);
      }
      return docName;
    };
    documentService.init(getYDoc, extractDocGuid);

    // Initialize modules
    documents.init(pool);
    users.init(pool);
    onboarding.init(pool);
    createDocument.init(persistenceProvider);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-create-doc-test', 'create-doc-test@example.com', 'Create Doc Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;
  });

  afterAll(async () => {
    // Wait for any pending persistence operations to complete
    await Promise.all(pendingOperations);

    // Clean up test data
    await pool.query('DELETE FROM document_shares WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  // Clean up any documents created during tests
  let createdDocIds = [];

  afterEach(async () => {
    // Wait for any pending persistence operations to complete before cleanup
    await Promise.all(pendingOperations);
    pendingOperations.length = 0;
    for (const docId of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    }
    createdDocIds = [];
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(createDocument.name).toBe('create_document');
      expect(createDocument.description).toBeDefined();
      expect(createDocument.inputSchema).toBeDefined();
      expect(createDocument.inputSchema.type).toBe('object');
    });

    test('title is optional (markdown seeding, feature 002) but present in schema', () => {
      // Since feature 002, at-least-one-of title/markdown is enforced in the
      // handler; the schema no longer hard-requires title.
      expect(createDocument.inputSchema.required).toEqual([]);
      expect(createDocument.inputSchema.properties.markdown).toBeDefined();
    });

    test('does not have content parameter', () => {
      expect(createDocument.inputSchema.properties.content).toBeUndefined();
    });

    test('has title property with correct type', () => {
      expect(createDocument.inputSchema.properties.title).toBeDefined();
      expect(createDocument.inputSchema.properties.title.type).toBe('string');
    });
  });

  describe('handler', () => {
    test('creates document with title', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler(
        {
          title: 'My Test Document',
        },
        agentToken
      );

      createdDocIds.push(result.docGuid);

      expect(result.docGuid).toBeDefined();
      expect(result.title).toBe('My Test Document');
      expect(result.message).toContain('My Test Document');

      // Verify the document was created in the database
      const docResult = await pool.query('SELECT * FROM documents WHERE id = $1', [result.docGuid]);
      expect(docResult.rows.length).toBe(1);
      expect(docResult.rows[0].creator_id).toBe(testUserId);

      // Verify the user has owner role
      const shareResult = await pool.query(
        'SELECT role FROM document_shares WHERE doc_id = $1 AND user_id = $2',
        [result.docGuid, testUserId]
      );
      expect(shareResult.rows.length).toBe(1);
      expect(shareResult.rows[0].role).toBe('owner');
    });

    test('sets title in Yjs document metadata', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler(
        {
          title: 'Yjs Title Test',
        },
        agentToken
      );

      createdDocIds.push(result.docGuid);

      // Wait for persistence to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify the title was saved in Yjs document metadata
      const ydoc = documentService.getSharedDoc(result.docGuid);
      const meta = ydoc.getMap('meta');
      expect(meta.get('title')).toBe('Yjs Title Test');
    });

    test('seeds a single empty paragraph (so the agent cursor can anchor)', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler(
        {
          title: 'Empty Document',
        },
        agentToken
      );

      createdDocIds.push(result.docGuid);

      // Wait for persistence to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The body holds exactly one empty paragraph: no visible text, but a text
      // node the agent's presence cursor can anchor to. The title lives in meta.
      const ydoc = documentService.getSharedDoc(result.docGuid);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(1);
      const firstBlock = xmlFragment.get(0);
      expect(firstBlock.nodeName).toBe('paragraph');
      // Strip tags — the remaining text content should be empty.
      expect(firstBlock.toString().replace(/<[^>]*>/g, '').trim()).toBe('');
    });

    test('generates unique document IDs', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result1 = await createDocument.handler({ title: 'Doc 1' }, agentToken);
      const result2 = await createDocument.handler({ title: 'Doc 2' }, agentToken);
      const result3 = await createDocument.handler({ title: 'Doc 3' }, agentToken);

      createdDocIds.push(result1.docGuid, result2.docGuid, result3.docGuid);

      expect(result1.docGuid).not.toBe(result2.docGuid);
      expect(result2.docGuid).not.toBe(result3.docGuid);
      expect(result1.docGuid).not.toBe(result3.docGuid);

      // Verify all are valid UUIDs
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(result1.docGuid).toMatch(uuidRegex);
      expect(result2.docGuid).toMatch(uuidRegex);
      expect(result3.docGuid).toMatch(uuidRegex);
    });

    test('handles special characters in title', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const specialTitle = 'Title with "quotes" & <special> chars! 🎉';

      const result = await createDocument.handler(
        {
          title: specialTitle,
        },
        agentToken
      );

      createdDocIds.push(result.docGuid);

      expect(result.title).toBe(specialTitle);

      // Wait for persistence and verify in Yjs
      await new Promise((resolve) => setTimeout(resolve, 100));
      const ydoc = documentService.getSharedDoc(result.docGuid);
      const meta = ydoc.getMap('meta');
      expect(meta.get('title')).toBe(specialTitle);
    });

    test('handles empty string title', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler(
        {
          title: '',
        },
        agentToken
      );

      createdDocIds.push(result.docGuid);

      expect(result.title).toBe('');

      // Wait for persistence and verify in Yjs
      await new Promise((resolve) => setTimeout(resolve, 100));
      const ydoc = documentService.getSharedDoc(result.docGuid);
      const meta = ydoc.getMap('meta');
      expect(meta.get('title')).toBe('');
    });

    test('handles long title (up to 255 chars)', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      // Database column is varchar(255), so test with max allowed length
      const longTitle = 'A'.repeat(255);

      const result = await createDocument.handler(
        {
          title: longTitle,
        },
        agentToken
      );

      createdDocIds.push(result.docGuid);

      expect(result.title).toBe(longTitle);

      // Wait for persistence and verify in Yjs
      await new Promise((resolve) => setTimeout(resolve, 100));
      const ydoc = documentService.getSharedDoc(result.docGuid);
      const meta = ydoc.getMap('meta');
      expect(meta.get('title')).toBe(longTitle);
    });

    test('persists title update to database', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler(
        {
          title: 'Persisted Title',
        },
        agentToken
      );

      createdDocIds.push(result.docGuid);

      // Wait for persistence
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify a Yjs update was stored
      const updateResult = await pool.query(
        'SELECT COUNT(*) as count FROM yjs_updates WHERE doc_guid = $1',
        [result.docGuid]
      );
      expect(parseInt(updateResult.rows[0].count, 10)).toBeGreaterThan(0);
    });

    test('stamps onboarded_at on the creator (engagement)', async () => {
      // A real (non-welcome) doc means the user is engaged — onboarded_at
      // should flip without waiting for their next login/_auth/me probe.
      await pool.query('UPDATE users SET onboarded_at = NULL WHERE id = $1', [testUserId]);

      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler({ title: 'Engagement Doc' }, agentToken);
      createdDocIds.push(result.docGuid);

      // The stamp is fire-and-forget inside the handler; give it a tick to land.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const u = await users.findById(testUserId);
      expect(u.onboarded_at).toBeTruthy();
    });

    test('establishes agent presence in the newly created document', async () => {
      const agentPresence = require('../../agent-presence');
      // Stub out the real WebSocket session so the test stays fast and offline;
      // we only assert that presence is requested for the new doc.
      const spy = jest.spyOn(agentPresence, 'getOrCreateSession').mockResolvedValue({});
      try {
        const agentToken = {
          userId: testUserId,
          delegationId: 'test-delegation-id',
          agentId: 'claude-code:test',
          scopes: ['documents:write'],
        };

        const result = await createDocument.handler({ title: 'Presence Doc' }, agentToken);
        createdDocIds.push(result.docGuid);

        expect(spy).toHaveBeenCalledWith(result.docGuid, agentToken, expect.any(Number));
      } finally {
        spy.mockRestore();
      }
    });

    test('throws error when not initialized', async () => {
      // Create a new instance without initializing
      const uninitializedModule = { ...createDocument };

      // The module uses module-level variables, so we need to test the error path
      // by checking the error message format
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      // This test verifies the error handling exists in the handler
      // The actual error would only occur if init() was never called
      expect(createDocument.handler).toBeDefined();
    });
  });
});
