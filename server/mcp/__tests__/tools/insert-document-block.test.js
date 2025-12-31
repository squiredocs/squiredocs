/**
 * insert_document_block tool tests
 *
 * Tests the MCP tool for inserting new blocks into documents.
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
const insertDocumentBlock = require('../../tools/insert-document-block');
const agentPresence = require('../../agent-presence');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');

// Mock agent presence to avoid WebSocket connections in tests
jest.mock('../../agent-presence');

describe('insert_document_block tool', () => {
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
    insertDocumentBlock.init(persistenceProvider);
    agentPresence.init(persistenceProvider);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-insert-test', 'insert-test@example.com', 'Insert Test User')
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
      expect(insertDocumentBlock.name).toBe('insert_document_block');
      expect(insertDocumentBlock.description).toBeDefined();
      expect(insertDocumentBlock.inputSchema).toBeDefined();
      expect(insertDocumentBlock.inputSchema.type).toBe('object');
    });

    test('requires correct parameters', () => {
      expect(insertDocumentBlock.inputSchema.required).toContain('docGuid');
      expect(insertDocumentBlock.inputSchema.required).toContain('position');
      expect(insertDocumentBlock.inputSchema.required).toContain('newContent');
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

    test('inserts block at the end with position "end"', async () => {
      const result = await insertDocumentBlock.handler(
        {
          docGuid: testDocId,
          position: 'end',
          newContent: {
            type: 'paragraph',
            content: 'Third paragraph',
          },
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.newElementIndex).toBe(2);
      expect(result.totalElements).toBe(3);
      expect(result.blockType).toBe('paragraph');

      // Verify the block was inserted
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(3);

      const newBlock = xmlFragment.get(2);
      expect(newBlock.nodeName).toBe('paragraph');
      const textContent = newBlock.get(0).toString();
      expect(textContent).toBe('Third paragraph');
    });

    test('inserts block at the start with position "start"', async () => {
      const result = await insertDocumentBlock.handler(
        {
          docGuid: testDocId,
          position: 'start',
          newContent: {
            type: 'heading',
            level: 1,
            content: 'Document Title',
          },
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.newElementIndex).toBe(0);
      expect(result.totalElements).toBe(3);
      expect(result.blockType).toBe('heading');

      // Verify the block was inserted at the start
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(3);

      const newBlock = xmlFragment.get(0);
      expect(newBlock.nodeName).toBe('heading');
      expect(newBlock.getAttribute('level')).toBe(1);

      // Old first paragraph should now be at index 1
      const oldFirst = xmlFragment.get(1);
      expect(oldFirst.nodeName).toBe('paragraph');
      expect(oldFirst.get(0).toString()).toBe('First paragraph');
    });

    test('inserts block at specific index', async () => {
      const result = await insertDocumentBlock.handler(
        {
          docGuid: testDocId,
          position: 1,
          newContent: {
            type: 'paragraph',
            content: 'Middle paragraph',
          },
        },
        agentToken
      );

      expect(result.success).toBe(true);
      expect(result.newElementIndex).toBe(1);
      expect(result.totalElements).toBe(3);

      // Verify the block was inserted in the middle
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      expect(xmlFragment.length).toBe(3);

      expect(xmlFragment.get(0).get(0).toString()).toBe('First paragraph');
      expect(xmlFragment.get(1).get(0).toString()).toBe('Middle paragraph');
      expect(xmlFragment.get(2).get(0).toString()).toBe('Second paragraph');
    });

    test('inserts heading with level', async () => {
      const result = await insertDocumentBlock.handler(
        {
          docGuid: testDocId,
          position: 0,
          newContent: {
            type: 'heading',
            level: 2,
            content: 'Section Header',
          },
        },
        agentToken
      );

      expect(result.success).toBe(true);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const heading = xmlFragment.get(0);

      expect(heading.nodeName).toBe('heading');
      expect(heading.getAttribute('level')).toBe(2);
      expect(heading.get(0).toString()).toBe('Section Header');
    });

    test('inserts bullet list with items', async () => {
      const result = await insertDocumentBlock.handler(
        {
          docGuid: testDocId,
          position: 'end',
          newContent: {
            type: 'bulletList',
            children: [
              { type: 'listItem', content: 'Item 1' },
              { type: 'listItem', content: 'Item 2' },
            ],
          },
        },
        agentToken
      );

      expect(result.success).toBe(true);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const list = xmlFragment.get(2);

      expect(list.nodeName).toBe('bulletList');
      expect(list.length).toBe(2);

      const item1 = list.get(0);
      const item2 = list.get(1);
      expect(item1.nodeName).toBe('listItem');
      expect(item2.nodeName).toBe('listItem');
      // ListItems now contain paragraphs (TipTap schema requirement)
      expect(item1.get(0).nodeName).toBe('paragraph');
      expect(item2.get(0).nodeName).toBe('paragraph');
      expect(item1.get(0).get(0).toString()).toBe('Item 1');
      expect(item2.get(0).get(0).toString()).toBe('Item 2');
    });

    test('inserts paragraph with formatting marks', async () => {
      const result = await insertDocumentBlock.handler(
        {
          docGuid: testDocId,
          position: 'end',
          newContent: {
            type: 'paragraph',
            content: [
              'Normal text with ',
              { text: 'bold', marks: ['bold'] },
              ' and ',
              { text: 'italic', marks: ['italic'] },
            ],
          },
        },
        agentToken
      );

      expect(result.success).toBe(true);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const para = xmlFragment.get(2);

      expect(para.nodeName).toBe('paragraph');
      expect(para.length).toBe(4); // 4 text nodes

      // Verify the paragraph was inserted with content
      // (Testing specific formatting is implementation-dependent)
      const { getTextContent } = require('../../yjs/block-structure');
      const textContent = getTextContent(para);
      expect(textContent).toContain('Normal text with');
      expect(textContent).toContain('bold');
      expect(textContent).toContain('italic');
    });

    test('inserts code block with language', async () => {
      const result = await insertDocumentBlock.handler(
        {
          docGuid: testDocId,
          position: 'end',
          newContent: {
            type: 'codeBlock',
            language: 'javascript',
            content: 'const x = 42;',
          },
        },
        agentToken
      );

      expect(result.success).toBe(true);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const code = xmlFragment.get(2);

      expect(code.nodeName).toBe('codeBlock');
      expect(code.getAttribute('language')).toBe('javascript');
      expect(code.get(0).toString()).toBe('const x = 42;');
    });

    test('rejects insertion by viewer', async () => {
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
        insertDocumentBlock.handler(
          {
            docGuid: testDocId,
            position: 'end',
            newContent: { type: 'paragraph', content: 'Unauthorized' },
          },
          viewerToken
        )
      ).rejects.toThrow('Viewer role cannot insert document blocks');

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [viewerId]);
    });

    test('rejects out of bounds index', async () => {
      await expect(
        insertDocumentBlock.handler(
          {
            docGuid: testDocId,
            position: 10,
            newContent: { type: 'paragraph', content: 'Too far' },
          },
          agentToken
        )
      ).rejects.toThrow('out of bounds');
    });

    test('allows editors to insert', async () => {
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

      const result = await insertDocumentBlock.handler(
        {
          docGuid: testDocId,
          position: 'end',
          newContent: { type: 'paragraph', content: 'Editor added this' },
        },
        editorToken
      );

      expect(result.success).toBe(true);

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [editorId]);
    });
  });
});
