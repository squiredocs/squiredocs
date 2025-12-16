/**
 * set_document_title tool tests
 *
 * Tests the MCP tool for setting document titles.
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
const setDocumentTitle = require('../../tools/set-document-title');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');

describe('set_document_title tool', () => {
  let testUserId;
  let testDocId;

  beforeAll(async () => {
    // Initialize y-websocket persistence for tests
    const ORIGIN_DB_LOAD = 'db-load';
    setPersistence({
      bindState: async (docName, ydoc) => {
        // Extract docGuid from docName (format: "s/{docGuid}")
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;

        // Set up update listener to persist changes
        ydoc.on('update', (update, origin) => {
          if (origin === ORIGIN_DB_LOAD) return;

          // Extract userId from origin if it's a string (passed from MCP tools)
          const userId = typeof origin === 'string' ? origin : null;

          persistenceProvider.storeUpdate(docGuid, update, userId).catch((err) => {
            console.error(`Error persisting update for ${docGuid}:`, err);
          });
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
    setDocumentTitle.init(persistenceProvider);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-set-title-test', 'set-title-test@example.com', 'Set Title Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM document_shares WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  beforeEach(async () => {
    // Clean up documents before each test
    await pool.query('DELETE FROM document_shares WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);

    // Create test document
    const docResult = await pool.query(
      `INSERT INTO documents (id, creator_id)
       VALUES (uuid_generate_v4(), $1)
       RETURNING id`,
      [testUserId]
    );
    testDocId = docResult.rows[0].id;
    await documents.setRole(testDocId, testUserId, 'owner');

    // Add initial content and title
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Initial content');
    paragraph.insert(0, [text]);
    xmlFragment.insert(0, [paragraph]);

    // Set initial title
    const meta = ydoc.getMap('meta');
    meta.set('title', 'Initial Title');

    const update = Y.encodeStateAsUpdate(ydoc);
    await pool.query(
      'INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, 0, $2)',
      [testDocId, Buffer.from(update)]
    );

    // Pre-load the document into y-websocket's cache to ensure bindState completes
    documentService.getSharedDoc(testDocId);
    // Wait for bindState to complete loading from database
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(setDocumentTitle.name).toBe('set_document_title');
      expect(setDocumentTitle.description).toBeDefined();
      expect(setDocumentTitle.inputSchema).toBeDefined();
      expect(setDocumentTitle.inputSchema.type).toBe('object');
    });

    test('requires docGuid and title parameters', () => {
      expect(setDocumentTitle.inputSchema.required).toContain('docGuid');
      expect(setDocumentTitle.inputSchema.required).toContain('title');
    });
  });

  describe('handler', () => {
    test('sets document title', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await setDocumentTitle.handler(
        {
          docGuid: testDocId,
          title: 'New Amazing Title',
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.title).toBe('New Amazing Title');
      expect(result.message).toContain('New Amazing Title');

      // Verify the title was actually saved - check the in-memory ydoc (source of truth)
      const ydoc = documentService.getSharedDoc(testDocId);
      const meta = ydoc.getMap('meta');
      expect(meta.get('title')).toBe('New Amazing Title');
    });

    test('updates existing title', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      // Verify initial title
      const ydoc = documentService.getSharedDoc(testDocId);
      const meta = ydoc.getMap('meta');
      expect(meta.get('title')).toBe('Initial Title');

      // Update title
      await setDocumentTitle.handler(
        {
          docGuid: testDocId,
          title: 'Updated Title',
        },
        agentToken
      );

      // Verify title was updated
      expect(meta.get('title')).toBe('Updated Title');
    });

    test('creates only incremental updates', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      // Get initial update count
      const beforeResult = await pool.query(
        'SELECT COUNT(*) as count FROM yjs_updates WHERE doc_guid = $1',
        [testDocId]
      );
      const initialCount = parseInt(beforeResult.rows[0].count, 10);

      // Set title
      await setDocumentTitle.handler(
        {
          docGuid: testDocId,
          title: 'Incremental Test Title',
        },
        agentToken
      );

      // Verify a new update was added
      const afterResult = await pool.query(
        'SELECT COUNT(*) as count FROM yjs_updates WHERE doc_guid = $1',
        [testDocId]
      );
      const finalCount = parseInt(afterResult.rows[0].count, 10);
      expect(finalCount).toBe(initialCount + 1);

      // Verify the update size is small (incremental, not full state)
      const updateResult = await pool.query(
        'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock DESC LIMIT 1',
        [testDocId]
      );
      const updateSize = updateResult.rows[0].update_data.length;

      // A title update should be very small, definitely less than 100 bytes
      expect(updateSize).toBeLessThan(100);
    });

    test('allows editors to set title', async () => {
      // Create editor user
      const editorResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-editor', 'editor@example.com', 'Editor User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const editorId = editorResult.rows[0].id;
      await documents.setRole(testDocId, editorId, 'editor');

      const agentToken = {
        userId: editorId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await setDocumentTitle.handler(
        {
          docGuid: testDocId,
          title: 'Editor Set Title',
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.title).toBe('Editor Set Title');

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [editorId]);
    });

    test('rejects title update without edit permission', async () => {
      // Create viewer user
      const viewerResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-viewer', 'viewer@example.com', 'Viewer User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const viewerId = viewerResult.rows[0].id;
      await documents.setRole(testDocId, viewerId, 'viewer');

      const agentToken = {
        userId: viewerId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      await expect(
        setDocumentTitle.handler(
          {
            docGuid: testDocId,
            title: 'Unauthorized Title',
          },
          agentToken
        )
      ).rejects.toThrow('You do not have edit permission');

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [viewerId]);
    });

    test('handles special characters in title', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const specialTitle = 'Title with "quotes" & <special> chars! 🎉';

      const result = await setDocumentTitle.handler(
        {
          docGuid: testDocId,
          title: specialTitle,
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.title).toBe(specialTitle);

      // Verify the title was saved correctly - check in-memory ydoc (source of truth)
      const ydoc = documentService.getSharedDoc(testDocId);
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

      const result = await setDocumentTitle.handler(
        {
          docGuid: testDocId,
          title: '',
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.title).toBe('');

      // Verify empty title was saved - check in-memory ydoc (source of truth)
      const ydoc = documentService.getSharedDoc(testDocId);
      const meta = ydoc.getMap('meta');
      expect(meta.get('title')).toBe('');
    });
  });
});
