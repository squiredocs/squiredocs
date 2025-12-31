/**
 * delete_document_block tool tests
 *
 * Tests the MCP tool for deleting blocks from documents.
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
const deleteDocumentBlock = require('../../tools/delete-document-block');
const agentPresence = require('../../agent-presence');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');

// Mock agent presence to avoid WebSocket connections in tests
jest.mock('../../agent-presence');

describe('delete_document_block tool', () => {
  let testUserId;
  let testDocId;

  beforeAll(async () => {
    // Initialize y-websocket persistence for tests
    const ORIGIN_DB_LOAD = 'db-load';
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;

        ydoc.on('update', (update, origin) => {
          if (origin === ORIGIN_DB_LOAD) return;

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
      writeState: async () => {},
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
    deleteDocumentBlock.init(persistenceProvider);
    agentPresence.init(persistenceProvider);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-delete-test', 'delete-test@example.com', 'Delete Test User')
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

    // Add initial content - 3 blocks for testing deletion
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);

    // Heading
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', '1');
    const headingText = new Y.XmlText();
    headingText.insert(0, 'Document Title');
    heading.insert(0, [headingText]);
    xmlFragment.insert(0, [heading]);

    // First paragraph
    const para1 = new Y.XmlElement('paragraph');
    const text1 = new Y.XmlText();
    text1.insert(0, 'First paragraph');
    para1.insert(0, [text1]);
    xmlFragment.insert(1, [para1]);

    // Second paragraph
    const para2 = new Y.XmlElement('paragraph');
    const text2 = new Y.XmlText();
    text2.insert(0, 'Second paragraph');
    para2.insert(0, [text2]);
    xmlFragment.insert(2, [para2]);

    const update = Y.encodeStateAsUpdate(ydoc);
    await pool.query(
      'INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, 0, $2)',
      [testDocId, Buffer.from(update)]
    );

    // Pre-load the document into y-websocket's cache
    documentService.getSharedDoc(testDocId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Mock getOrCreateSession to return a mock session with the real ydoc
    const mockYdoc = documentService.getSharedDoc(testDocId);
    agentPresence.getOrCreateSession.mockResolvedValue({
      provider: {
        doc: mockYdoc,
      },
      awareness: {
        setLocalStateField: jest.fn(),
      },
    });
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(deleteDocumentBlock.name).toBe('delete_document_block');
      expect(deleteDocumentBlock.description).toBeDefined();
      expect(deleteDocumentBlock.inputSchema).toBeDefined();
      expect(deleteDocumentBlock.inputSchema.type).toBe('object');
    });

    test('requires correct parameters', () => {
      expect(deleteDocumentBlock.inputSchema.required).toContain('docGuid');
      expect(deleteDocumentBlock.inputSchema.required).toContain('elementIndex');
    });
  });

  describe('handler', () => {
    const agentToken = {
      userId: null,
      delegationId: 'test-delegation-id',
      agentId: 'claude-code:test',
      scopes: ['documents:write'],
    };

    beforeEach(() => {
      agentToken.userId = testUserId;
    });

    test('deletes first block', async () => {
      const result = await deleteDocumentBlock.handler(
        {
          docGuid: testDocId,
          elementIndex: 0,
          durationSeconds: 1, // Short duration for tests
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.deletedContent).toBe('Document Title');
      expect(result.deletedType).toBe('heading');
      expect(result.totalElements).toBe(2);

      // Verify the block was deleted
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(2);

      // First block should now be the first paragraph
      const newFirst = xmlFragment.get(0);
      expect(newFirst.nodeName).toBe('paragraph');
      expect(newFirst.get(0).toString()).toBe('First paragraph');
    });

    test('deletes middle block', async () => {
      const result = await deleteDocumentBlock.handler(
        {
          docGuid: testDocId,
          elementIndex: 1,
          durationSeconds: 1,
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.deletedContent).toBe('First paragraph');
      expect(result.deletedType).toBe('paragraph');
      expect(result.totalElements).toBe(2);

      // Verify the correct block was deleted
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(2);

      expect(xmlFragment.get(0).nodeName).toBe('heading');
      expect(xmlFragment.get(1).nodeName).toBe('paragraph');
      expect(xmlFragment.get(1).get(0).toString()).toBe('Second paragraph');
    });

    test('deletes last block', async () => {
      const result = await deleteDocumentBlock.handler(
        {
          docGuid: testDocId,
          elementIndex: 2,
          durationSeconds: 1,
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.deletedContent).toBe('Second paragraph');
      expect(result.deletedType).toBe('paragraph');
      expect(result.totalElements).toBe(2);

      // Verify the last block was deleted
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(2);

      expect(xmlFragment.get(0).get(0).toString()).toBe('Document Title');
      expect(xmlFragment.get(1).get(0).toString()).toBe('First paragraph');
    });

    test('deletes all blocks sequentially', async () => {
      // Delete from the end to avoid index shifting issues in this test
      await deleteDocumentBlock.handler(
        { docGuid: testDocId, elementIndex: 2, durationSeconds: 1 },
        agentToken
      );

      await deleteDocumentBlock.handler(
        { docGuid: testDocId, elementIndex: 1, durationSeconds: 1 },
        agentToken
      );

      const result = await deleteDocumentBlock.handler(
        { docGuid: testDocId, elementIndex: 0, durationSeconds: 1 },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.totalElements).toBe(0);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(0);
    });

    test('rejects deletion by viewer', async () => {
      // Create viewer user
      const viewerResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-viewer', 'viewer@example.com', 'Viewer User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const viewerId = viewerResult.rows[0].id;
      await documents.setRole(testDocId, viewerId, 'viewer');

      const viewerToken = { ...agentToken, userId: viewerId };

      await expect(
        deleteDocumentBlock.handler(
          {
            docGuid: testDocId,
            elementIndex: 0,
            durationSeconds: 1,
          },
          viewerToken
        )
      ).rejects.toThrow('Viewer role cannot delete document blocks');

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [viewerId]);
    });

    test('rejects out of bounds index', async () => {
      await expect(
        deleteDocumentBlock.handler(
          {
            docGuid: testDocId,
            elementIndex: 10,
            durationSeconds: 1,
          },
          agentToken
        )
      ).rejects.toThrow('out of bounds');
    });

    test('allows editors to delete', async () => {
      // Create editor user
      const editorResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-editor', 'editor@example.com', 'Editor User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const editorId = editorResult.rows[0].id;
      await documents.setRole(testDocId, editorId, 'editor');

      const editorToken = { ...agentToken, userId: editorId };

      const result = await deleteDocumentBlock.handler(
        {
          docGuid: testDocId,
          elementIndex: 1,
          durationSeconds: 1,
        },
        editorToken
      );

      expect(result.success).toBe(true);

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [editorId]);
    });

    test('returns correct content for complex blocks', async () => {
      // Add a bullet list to test
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);

      const list = new Y.XmlElement('bulletList');
      const item1 = new Y.XmlElement('listItem');
      const item1Text = new Y.XmlText();
      item1Text.insert(0, 'Item 1');
      item1.insert(0, [item1Text]);

      const item2 = new Y.XmlElement('listItem');
      const item2Text = new Y.XmlText();
      item2Text.insert(0, 'Item 2');
      item2.insert(0, [item2Text]);

      list.insert(0, [item1, item2]);
      xmlFragment.insert(3, [list]);

      const result = await deleteDocumentBlock.handler(
        {
          docGuid: testDocId,
          elementIndex: 3,
          durationSeconds: 1,
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.deletedContent).toBe('Item 1Item 2');
      expect(result.deletedType).toBe('bulletList');
    });
  });
});
