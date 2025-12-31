/**
 * replace_document_blocks tool tests
 *
 * Tests the MCP tool for replacing single or multiple blocks with new blocks.
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
const replaceDocumentBlocks = require('../../tools/replace-document-blocks');
const agentPresence = require('../../agent-presence');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');

// Mock agent presence to avoid WebSocket connections in tests
jest.mock('../../agent-presence');

describe('replace_document_blocks tool', () => {
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
    replaceDocumentBlocks.init(persistenceProvider);
    agentPresence.init(persistenceProvider);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-replace-blocks-test', 'replace-blocks-test@example.com', 'Replace Blocks Test User')
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

    // Add initial content - 5 paragraphs
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);

    for (let i = 0; i < 5; i++) {
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
      expect(replaceDocumentBlocks.name).toBe('replace_document_blocks');
      expect(replaceDocumentBlocks.description).toBeDefined();
      expect(replaceDocumentBlocks.inputSchema).toBeDefined();
      expect(replaceDocumentBlocks.inputSchema.type).toBe('object');
    });

    test('requires correct parameters', () => {
      expect(replaceDocumentBlocks.inputSchema.required).toContain('docGuid');
      expect(replaceDocumentBlocks.inputSchema.required).toContain('fromIndex');
      expect(replaceDocumentBlocks.inputSchema.required).toContain('blocks');
      expect(replaceDocumentBlocks.inputSchema.required).not.toContain('toIndex'); // Optional
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

    test('replaces single block with single block', async () => {
      const result = await replaceDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 2,
          blocks: [
            {
              type: 'heading',
              level: 2,
              content: 'Section Title',
            },
          ],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.replacedCount).toBe(1);
      expect(result.insertedCount).toBe(1);
      expect(result.insertedIndices).toEqual([2]);
      expect(result.totalElements).toBe(5);
      expect(result.replacedBlocks).toHaveLength(1);
      expect(result.replacedBlocks[0].content).toBe('Paragraph 2');

      // Verify the replacement
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.get(2).nodeName).toBe('heading');
      expect(xmlFragment.get(2).get(0).toString()).toBe('Section Title');
    });

    test('replaces multiple blocks with single block', async () => {
      const result = await replaceDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 1,
          toIndex: 3,
          blocks: [
            {
              type: 'bulletList',
              children: [
                { type: 'listItem', content: 'Item from paragraph 1' },
                { type: 'listItem', content: 'Item from paragraph 2' },
                { type: 'listItem', content: 'Item from paragraph 3' },
              ],
            },
          ],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.replacedCount).toBe(3); // Replaced 3 blocks
      expect(result.insertedCount).toBe(1); // Inserted 1 block
      expect(result.insertedIndices).toEqual([1]);
      expect(result.totalElements).toBe(3); // Was 5, replaced 3 with 1, now 3
      expect(result.replacedBlocks).toHaveLength(3);

      // Verify the replacement
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(3);
      expect(xmlFragment.get(0).get(0).toString()).toBe('Paragraph 0');
      expect(xmlFragment.get(1).nodeName).toBe('bulletList');
      expect(xmlFragment.get(2).get(0).toString()).toBe('Paragraph 4');
    });

    test('replaces single block with multiple blocks', async () => {
      const result = await replaceDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 2,
          blocks: [
            { type: 'heading', level: 2, content: 'Section' },
            { type: 'paragraph', content: 'First paragraph' },
            { type: 'paragraph', content: 'Second paragraph' },
          ],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.replacedCount).toBe(1);
      expect(result.insertedCount).toBe(3);
      expect(result.insertedIndices).toEqual([2, 3, 4]);
      expect(result.totalElements).toBe(7); // Was 5, replaced 1 with 3, now 7

      // Verify the replacement
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(7);
      expect(xmlFragment.get(2).nodeName).toBe('heading');
      expect(xmlFragment.get(3).get(0).toString()).toBe('First paragraph');
      expect(xmlFragment.get(4).get(0).toString()).toBe('Second paragraph');
      expect(xmlFragment.get(5).get(0).toString()).toBe('Paragraph 3');
    });

    test('replaces range with equal number of blocks', async () => {
      const result = await replaceDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 1,
          toIndex: 2,
          blocks: [
            { type: 'paragraph', content: 'New first' },
            { type: 'paragraph', content: 'New second' },
          ],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.replacedCount).toBe(2);
      expect(result.insertedCount).toBe(2);
      expect(result.totalElements).toBe(5);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.get(1).get(0).toString()).toBe('New first');
      expect(xmlFragment.get(2).get(0).toString()).toBe('New second');
    });

    test('replaces first block in document', async () => {
      const result = await replaceDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 0,
          blocks: [{ type: 'heading', level: 1, content: 'Title' }],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.insertedIndices).toEqual([0]);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.get(0).nodeName).toBe('heading');
    });

    test('replaces last block in document', async () => {
      const result = await replaceDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 4,
          blocks: [{ type: 'paragraph', content: 'Conclusion' }],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.replacedBlocks[0].content).toBe('Paragraph 4');

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.get(4).get(0).toString()).toBe('Conclusion');
    });

    test('rejects invalid range where fromIndex > toIndex', async () => {
      await expect(
        replaceDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 3,
            toIndex: 1,
            blocks: [{ type: 'paragraph', content: 'Test' }],
          },
          agentToken
        )
      ).rejects.toThrow('fromIndex (3) must be <= toIndex (1)');
    });

    test('rejects out of bounds fromIndex', async () => {
      await expect(
        replaceDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 10,
            blocks: [{ type: 'paragraph', content: 'Test' }],
          },
          agentToken
        )
      ).rejects.toThrow('out of bounds');
    });

    test('rejects out of bounds toIndex', async () => {
      await expect(
        replaceDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 2,
            toIndex: 10,
            blocks: [{ type: 'paragraph', content: 'Test' }],
          },
          agentToken
        )
      ).rejects.toThrow('out of bounds');
    });

    test('rejects empty blocks array', async () => {
      await expect(
        replaceDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 0,
            blocks: [],
          },
          agentToken
        )
      ).rejects.toThrow('non-empty array');
    });

    test('rejects replacement by viewer', async () => {
      // Create viewer user
      const viewerResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-viewer-rep', 'viewer-rep@example.com', 'Viewer User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const viewerId = viewerResult.rows[0].id;
      await documents.setRole(testDocId, viewerId, 'viewer');

      const viewerToken = { ...agentToken, userId: viewerId };

      await expect(
        replaceDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 0,
            blocks: [{ type: 'paragraph', content: 'Unauthorized' }],
          },
          viewerToken
        )
      ).rejects.toThrow('Viewer role cannot replace document blocks');

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [viewerId]);
    });

    test('allows editors to replace', async () => {
      // Create editor user
      const editorResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-editor-rep', 'editor-rep@example.com', 'Editor User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const editorId = editorResult.rows[0].id;
      await documents.setRole(testDocId, editorId, 'editor');

      const editorToken = { ...agentToken, userId: editorId };

      const result = await replaceDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 1,
          blocks: [{ type: 'paragraph', content: 'Editor replaced this' }],
        },
        editorToken
      );

      expect(result.success).toBe(true);

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [editorId]);
    });

    test('sets highlighted flag when highlight succeeds', async () => {
      const result = await replaceDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 1,
          toIndex: 2,
          blocks: [{ type: 'paragraph', content: 'Test' }],
          durationSeconds: 20,
        },
        agentToken
      );

      expect(result.highlighted).toBe(true);
    });
  });
});
