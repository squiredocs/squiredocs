/**
 * insert_document_blocks tool tests
 *
 * Tests the MCP tool for inserting single or multiple blocks into documents.
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
const insertDocumentBlocks = require('../../tools/insert-document-blocks');
const agentPresence = require('../../agent-presence');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');

// Mock agent presence to avoid WebSocket connections in tests
jest.mock('../../agent-presence');

describe('insert_document_blocks tool', () => {
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
    insertDocumentBlocks.init(persistenceProvider);
    agentPresence.init(persistenceProvider);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-insert-blocks-test', 'insert-blocks-test@example.com', 'Insert Blocks Test User')
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

    // Add initial content - 2 paragraphs
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);

    // First paragraph
    const para1 = new Y.XmlElement('paragraph');
    const text1 = new Y.XmlText();
    text1.insert(0, 'First paragraph');
    para1.insert(0, [text1]);
    xmlFragment.insert(0, [para1]);

    // Second paragraph
    const para2 = new Y.XmlElement('paragraph');
    const text2 = new Y.XmlText();
    text2.insert(0, 'Second paragraph');
    para2.insert(0, [text2]);
    xmlFragment.insert(1, [para2]);

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
      expect(insertDocumentBlocks.name).toBe('insert_document_blocks');
      expect(insertDocumentBlocks.description).toBeDefined();
      expect(insertDocumentBlocks.inputSchema).toBeDefined();
      expect(insertDocumentBlocks.inputSchema.type).toBe('object');
    });

    test('requires correct parameters', () => {
      expect(insertDocumentBlocks.inputSchema.required).toContain('docGuid');
      expect(insertDocumentBlocks.inputSchema.required).toContain('position');
      expect(insertDocumentBlocks.inputSchema.required).toContain('blocks');
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

    test('inserts single block at specific position', async () => {
      const result = await insertDocumentBlocks.handler(
        {
          docGuid: testDocId,
          position: 1,
          blocks: [
            {
              type: 'paragraph',
              content: 'New paragraph',
            },
          ],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.insertedIndices).toEqual([1]);
      expect(result.insertedCount).toBe(1);
      expect(result.totalElements).toBe(3);

      // Verify the block was inserted
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(3);

      expect(xmlFragment.get(0).get(0).toString()).toBe('First paragraph');
      expect(xmlFragment.get(1).get(0).toString()).toBe('New paragraph');
      expect(xmlFragment.get(2).get(0).toString()).toBe('Second paragraph');
    });

    test('inserts multiple blocks at once', async () => {
      const result = await insertDocumentBlocks.handler(
        {
          docGuid: testDocId,
          position: 1,
          blocks: [
            { type: 'heading', level: 2, content: 'Section Title' },
            { type: 'paragraph', content: 'First new paragraph' },
            { type: 'paragraph', content: 'Second new paragraph' },
          ],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.insertedIndices).toEqual([1, 2, 3]);
      expect(result.insertedCount).toBe(3);
      expect(result.totalElements).toBe(5);

      // Verify all blocks were inserted
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(5);

      expect(xmlFragment.get(0).get(0).toString()).toBe('First paragraph');
      expect(xmlFragment.get(1).nodeName).toBe('heading');
      expect(xmlFragment.get(1).get(0).toString()).toBe('Section Title');
      expect(xmlFragment.get(2).get(0).toString()).toBe('First new paragraph');
      expect(xmlFragment.get(3).get(0).toString()).toBe('Second new paragraph');
      expect(xmlFragment.get(4).get(0).toString()).toBe('Second paragraph');
    });

    test('inserts at start with position "start"', async () => {
      const result = await insertDocumentBlocks.handler(
        {
          docGuid: testDocId,
          position: 'start',
          blocks: [
            { type: 'heading', level: 1, content: 'Document Title' },
            { type: 'paragraph', content: 'Introduction' },
          ],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.insertedIndices).toEqual([0, 1]);
      expect(result.totalElements).toBe(4);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.get(0).nodeName).toBe('heading');
      expect(xmlFragment.get(0).get(0).toString()).toBe('Document Title');
      expect(xmlFragment.get(1).get(0).toString()).toBe('Introduction');
      expect(xmlFragment.get(2).get(0).toString()).toBe('First paragraph');
    });

    test('appends at end with position "end"', async () => {
      const result = await insertDocumentBlocks.handler(
        {
          docGuid: testDocId,
          position: 'end',
          blocks: [
            { type: 'paragraph', content: 'Conclusion' },
            { type: 'paragraph', content: 'Final thoughts' },
          ],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.insertedIndices).toEqual([2, 3]);
      expect(result.totalElements).toBe(4);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.get(2).get(0).toString()).toBe('Conclusion');
      expect(xmlFragment.get(3).get(0).toString()).toBe('Final thoughts');
    });

    test('inserts bullet list with multiple items', async () => {
      const result = await insertDocumentBlocks.handler(
        {
          docGuid: testDocId,
          position: 'end',
          blocks: [
            {
              type: 'bulletList',
              children: [
                { type: 'listItem', content: 'Item 1' },
                { type: 'listItem', content: 'Item 2' },
                { type: 'listItem', content: 'Item 3' },
              ],
            },
          ],
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.insertedIndices).toEqual([2]);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const list = xmlFragment.get(2);

      expect(list.nodeName).toBe('bulletList');
      expect(list.length).toBe(3);
    });

    test('inserts code block with language', async () => {
      const result = await insertDocumentBlocks.handler(
        {
          docGuid: testDocId,
          position: 1,
          blocks: [
            {
              type: 'codeBlock',
              language: 'javascript',
              content: 'const x = 42;\nconsole.log(x);',
            },
          ],
        },
        agentToken
      );

      expect(result.success).toBe(true);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const code = xmlFragment.get(1);

      expect(code.nodeName).toBe('codeBlock');
      expect(code.getAttribute('language')).toBe('javascript');
    });

    test('rejects empty blocks array', async () => {
      await expect(
        insertDocumentBlocks.handler(
          {
            docGuid: testDocId,
            position: 0,
            blocks: [],
          },
          agentToken
        )
      ).rejects.toThrow('non-empty array');
    });

    test('rejects out of bounds position', async () => {
      await expect(
        insertDocumentBlocks.handler(
          {
            docGuid: testDocId,
            position: 10,
            blocks: [{ type: 'paragraph', content: 'Test' }],
          },
          agentToken
        )
      ).rejects.toThrow('out of bounds');
    });

    test('rejects insertion by viewer', async () => {
      // Create viewer user
      const viewerResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-viewer-ins', 'viewer-ins@example.com', 'Viewer User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const viewerId = viewerResult.rows[0].id;
      await documents.setRole(testDocId, viewerId, 'viewer');

      const viewerToken = { ...agentToken, userId: viewerId };

      await expect(
        insertDocumentBlocks.handler(
          {
            docGuid: testDocId,
            position: 0,
            blocks: [{ type: 'paragraph', content: 'Unauthorized' }],
          },
          viewerToken
        )
      ).rejects.toThrow('Viewer role cannot insert document blocks');

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [viewerId]);
    });

    test('allows editors to insert', async () => {
      // Create editor user
      const editorResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-editor-ins', 'editor-ins@example.com', 'Editor User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const editorId = editorResult.rows[0].id;
      await documents.setRole(testDocId, editorId, 'editor');

      const editorToken = { ...agentToken, userId: editorId };

      const result = await insertDocumentBlocks.handler(
        {
          docGuid: testDocId,
          position: 'end',
          blocks: [{ type: 'paragraph', content: 'Editor added this' }],
        },
        editorToken
      );

      expect(result.success).toBe(true);

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [editorId]);
    });

    test('sets highlighted flag when highlight succeeds', async () => {
      const result = await insertDocumentBlocks.handler(
        {
          docGuid: testDocId,
          position: 1,
          blocks: [{ type: 'paragraph', content: 'Test' }],
          durationSeconds: 20,
        },
        agentToken
      );

      expect(result.highlighted).toBe(true);
    });
  });
});
