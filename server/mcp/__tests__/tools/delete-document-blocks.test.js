/**
 * delete_document_blocks tool tests
 *
 * Tests the MCP tool for deleting single or multiple blocks from documents.
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
const deleteDocumentBlocks = require('../../tools/delete-document-blocks');
const agentPresence = require('../../agent-presence');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');

// Mock agent presence to avoid WebSocket connections in tests
jest.mock('../../agent-presence');

describe('delete_document_blocks tool', () => {
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
    deleteDocumentBlocks.init(persistenceProvider);
    agentPresence.init(persistenceProvider);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-delete-blocks-test', 'delete-blocks-test@example.com', 'Delete Blocks Test User')
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

    // Add initial content - 7 blocks for testing
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);

    // Create 7 paragraphs
    for (let i = 0; i < 7; i++) {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, `Paragraph ${i}`);
      para.insert(0, [text]);
      xmlFragment.insert(i, [para]);
    }

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
      expect(deleteDocumentBlocks.name).toBe('delete_document_blocks');
      expect(deleteDocumentBlocks.description).toBeDefined();
      expect(deleteDocumentBlocks.inputSchema).toBeDefined();
      expect(deleteDocumentBlocks.inputSchema.type).toBe('object');
    });

    test('requires correct parameters', () => {
      expect(deleteDocumentBlocks.inputSchema.required).toContain('docGuid');
      expect(deleteDocumentBlocks.inputSchema.required).toContain('fromIndex');
      expect(deleteDocumentBlocks.inputSchema.required).not.toContain('toIndex'); // Optional
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

    test('deletes single block when only fromIndex is provided', async () => {
      const result = await deleteDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 3,
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(1);
      expect(result.totalElements).toBe(6); // Was 7, deleted 1
      expect(result.deletedBlocks).toHaveLength(1);
      expect(result.deletedBlocks[0].type).toBe('paragraph');
      expect(result.deletedBlocks[0].content).toBe('Paragraph 3');

      // Verify the block was deleted
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(6);

      // Verify surrounding blocks are intact
      expect(xmlFragment.get(2).get(0).toString()).toBe('Paragraph 2');
      expect(xmlFragment.get(3).get(0).toString()).toBe('Paragraph 4');
    });

    test('deletes range of blocks when both fromIndex and toIndex provided', async () => {
      const result = await deleteDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 2,
          toIndex: 4,
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(3); // Indices 2, 3, 4 (inclusive)
      expect(result.totalElements).toBe(4); // Was 7, deleted 3
      expect(result.deletedBlocks).toHaveLength(3);
      expect(result.deletedBlocks[0].content).toBe('Paragraph 2');
      expect(result.deletedBlocks[1].content).toBe('Paragraph 3');
      expect(result.deletedBlocks[2].content).toBe('Paragraph 4');

      // Verify the blocks were deleted
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(4);

      // Verify remaining blocks
      expect(xmlFragment.get(0).get(0).toString()).toBe('Paragraph 0');
      expect(xmlFragment.get(1).get(0).toString()).toBe('Paragraph 1');
      expect(xmlFragment.get(2).get(0).toString()).toBe('Paragraph 5'); // Was index 5
      expect(xmlFragment.get(3).get(0).toString()).toBe('Paragraph 6'); // Was index 6
    });

    test('deletes from beginning of document', async () => {
      const result = await deleteDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 0,
          toIndex: 2,
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(3);
      expect(result.totalElements).toBe(4);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.get(0).get(0).toString()).toBe('Paragraph 3');
    });

    test('deletes from end of document', async () => {
      const result = await deleteDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 5,
          toIndex: 6,
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(2);
      expect(result.totalElements).toBe(5);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(5);
      expect(xmlFragment.get(4).get(0).toString()).toBe('Paragraph 4');
    });

    test('deletes last block in document', async () => {
      const result = await deleteDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 6,
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(1);
      expect(result.deletedBlocks[0].content).toBe('Paragraph 6');
      expect(result.totalElements).toBe(6);
    });

    test('rejects invalid range where fromIndex > toIndex', async () => {
      await expect(
        deleteDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 5,
            toIndex: 2,
          },
          agentToken
        )
      ).rejects.toThrow('fromIndex (5) must be <= toIndex (2)');
    });

    test('rejects out of bounds fromIndex', async () => {
      await expect(
        deleteDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 10,
          },
          agentToken
        )
      ).rejects.toThrow('out of bounds');
    });

    test('rejects out of bounds toIndex', async () => {
      await expect(
        deleteDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 2,
            toIndex: 10,
          },
          agentToken
        )
      ).rejects.toThrow('out of bounds');
    });

    test('rejects deletion by viewer', async () => {
      // Create viewer user
      const viewerResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-viewer-delete', 'viewer-delete@example.com', 'Viewer User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const viewerId = viewerResult.rows[0].id;
      await documents.setRole(testDocId, viewerId, 'viewer');

      const viewerToken = { ...agentToken, userId: viewerId };

      await expect(
        deleteDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 2,
          },
          viewerToken
        )
      ).rejects.toThrow('Viewer role cannot delete document blocks');

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [viewerId]);
    });

    test('allows editors to delete', async () => {
      // Create editor user
      const editorResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-editor-delete', 'editor-delete@example.com', 'Editor User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const editorId = editorResult.rows[0].id;
      await documents.setRole(testDocId, editorId, 'editor');

      const editorToken = { ...agentToken, userId: editorId };

      const result = await deleteDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 2,
          toIndex: 3,
        },
        editorToken
      );

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(2);

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [editorId]);
    });

    test('multiple deletions from end to beginning (safe pattern)', async () => {
      // Delete from end first, then earlier blocks (indices won't invalidate)

      // Delete blocks 5-6
      let result = await deleteDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 5,
          toIndex: 6,
        },
        agentToken
      );
      expect(result.success).toBe(true);
      expect(result.totalElements).toBe(5); // Now have 0-4

      // Delete blocks 2-3
      result = await deleteDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 2,
          toIndex: 3,
        },
        agentToken
      );
      expect(result.success).toBe(true);
      expect(result.totalElements).toBe(3); // Now have 0, 1, 4

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(3);
      expect(xmlFragment.get(0).get(0).toString()).toBe('Paragraph 0');
      expect(xmlFragment.get(1).get(0).toString()).toBe('Paragraph 1');
      expect(xmlFragment.get(2).get(0).toString()).toBe('Paragraph 4');
    });

    test('sets highlighted flag when highlight succeeds', async () => {
      const result = await deleteDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 2,
          toIndex: 4,
          durationSeconds: 20,
        },
        agentToken
      );

      expect(result.highlighted).toBe(true);
    });
  });
});
