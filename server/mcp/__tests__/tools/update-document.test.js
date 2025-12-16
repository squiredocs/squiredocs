/**
 * update_document tool tests
 *
 * Tests the MCP tool for updating document content.
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
const updateDocument = require('../../tools/update-document');
const { loadYDoc } = require('../../yjs/serialization');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');

describe('update_document tool', () => {
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
    updateDocument.init(persistenceProvider);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-update-doc-test', 'update-doc-test@example.com', 'Update Doc Test User')
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

    // Create test document with initial content
    const docResult = await pool.query(
      `INSERT INTO documents (id, creator_id)
       VALUES (uuid_generate_v4(), $1)
       RETURNING id`,
      [testUserId]
    );
    testDocId = docResult.rows[0].id;
    await documents.setRole(testDocId, testUserId, 'owner');

    // Add initial content
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Initial content');
    paragraph.insert(0, [text]);
    xmlFragment.insert(0, [paragraph]);

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

  describe('handler', () => {
    test('appends content to document', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'append',
          content: 'Appended text',
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Appended');

      // Verify the content was actually saved - use the in-memory ydoc (source of truth)
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const elements = xmlFragment.toArray();
      expect(elements.length).toBe(2); // Original + appended paragraph
    });

    test('replaces document content', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'replace',
          content: 'Completely new content',
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Replaced');

      // Verify the content was replaced - use the in-memory ydoc (source of truth)
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const elements = xmlFragment.toArray();
      expect(elements.length).toBe(1); // Only new paragraph

      const firstPara = elements[0];
      const textContent = firstPara.firstChild.toString();
      expect(textContent).toBe('Completely new content');
    });

    test('creates only incremental updates, not full state', async () => {
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      // Get the initial update count
      const beforeResult = await pool.query(
        'SELECT COUNT(*) as count FROM yjs_updates WHERE doc_guid = $1',
        [testDocId]
      );
      const initialCount = parseInt(beforeResult.rows[0].count, 10);

      // Append content
      await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'append',
          content: 'New paragraph',
        },
        agentToken
      );

      // Verify a new update was added
      const afterResult = await pool.query(
        'SELECT COUNT(*) as count, MAX(clock) as max_clock FROM yjs_updates WHERE doc_guid = $1',
        [testDocId]
      );
      const finalCount = parseInt(afterResult.rows[0].count, 10);
      expect(finalCount).toBe(initialCount + 1);

      // Verify the update size is reasonable (incremental, not full state)
      const updateResult = await pool.query(
        'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock DESC LIMIT 1',
        [testDocId]
      );
      const updateSize = updateResult.rows[0].update_data.length;

      // An incremental append should be much smaller than the full document
      // The full document would be >100 bytes, incremental should be <100 bytes
      expect(updateSize).toBeLessThan(100);
    });

    test('rejects update without edit permission', async () => {
      // Create another user with viewer access
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
        updateDocument.handler(
          {
            docGuid: testDocId,
            operation: 'append',
            content: 'Unauthorized content',
          },
          agentToken
        )
      ).rejects.toThrow('You do not have edit permission');

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [viewerId]);
    });
  });
});
