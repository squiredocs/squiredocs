/**
 * read_document_blocks tool tests
 *
 * Tests the MCP tool for reading single or multiple blocks from documents.
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
const readDocumentBlocks = require('../../tools/read-document-blocks');
const agentPresence = require('../../agent-presence');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');

// Mock agent presence to avoid WebSocket connections in tests
jest.mock('../../agent-presence');

describe('read_document_blocks tool', () => {
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
    readDocumentBlocks.init(persistenceProvider);
    agentPresence.init(persistenceProvider);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-read-blocks-test', 'read-blocks-test@example.com', 'Read Blocks Test User')
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

    // Add initial content - heading, 3 paragraphs, and a bullet list
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);

    // Heading
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', 1);
    const headingText = new Y.XmlText();
    headingText.insert(0, 'Document Title');
    heading.insert(0, [headingText]);
    xmlFragment.insert(0, [heading]);

    // Paragraphs
    for (let i = 0; i < 3; i++) {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, `Paragraph ${i + 1}`);
      para.insert(0, [text]);
      xmlFragment.insert(i + 1, [para]);
    }

    // Bullet list
    const bulletList = new Y.XmlElement('bulletList');
    for (let i = 0; i < 2; i++) {
      const listItem = new Y.XmlElement('listItem');
      const itemPara = new Y.XmlElement('paragraph');
      const itemText = new Y.XmlText();
      itemText.insert(0, `Item ${i + 1}`);
      itemPara.insert(0, [itemText]);
      listItem.insert(0, [itemPara]);
      bulletList.insert(i, [listItem]);
    }
    xmlFragment.insert(4, [bulletList]);

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
      expect(readDocumentBlocks.name).toBe('read_document_blocks');
      expect(readDocumentBlocks.description).toBeDefined();
      expect(readDocumentBlocks.inputSchema).toBeDefined();
      expect(readDocumentBlocks.inputSchema.type).toBe('object');
    });

    test('requires correct parameters', () => {
      expect(readDocumentBlocks.inputSchema.required).toContain('docGuid');
      expect(readDocumentBlocks.inputSchema.required).toContain('fromIndex');
      expect(readDocumentBlocks.inputSchema.required).not.toContain('toIndex'); // Optional
    });
  });

  describe('handler', () => {
    const agentToken = {
      userId: null,
      delegationId: 'test-delegation-id',
      agentId: 'claude-code:test',
      scopes: ['documents:read'],
    };

    beforeEach(() => {
      agentToken.userId = testUserId;
    });

    test('reads single block when only fromIndex is provided', async () => {
      const result = await readDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 0,
        },
        agentToken
      );

      expect(result.readCount).toBe(1);
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].elementIndex).toBe(0);
      expect(result.blocks[0].type).toBe('heading');
      expect(result.blocks[0].textContent).toBe('Document Title');
      expect(result.blocks[0].attributes.level).toBe(1);
      expect(result.highlighted).toBe(true);
    });

    test('reads multiple blocks when fromIndex and toIndex provided', async () => {
      const result = await readDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 1,
          toIndex: 3,
        },
        agentToken
      );

      expect(result.readCount).toBe(3);
      expect(result.blocks).toHaveLength(3);
      expect(result.blocks[0].elementIndex).toBe(1);
      expect(result.blocks[0].textContent).toBe('Paragraph 1');
      expect(result.blocks[1].elementIndex).toBe(2);
      expect(result.blocks[1].textContent).toBe('Paragraph 2');
      expect(result.blocks[2].elementIndex).toBe(3);
      expect(result.blocks[2].textContent).toBe('Paragraph 3');
      expect(result.highlighted).toBe(true);
    });

    test('reads bullet list block', async () => {
      const result = await readDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 4,
        },
        agentToken
      );

      expect(result.readCount).toBe(1);
      expect(result.blocks[0].type).toBe('bulletList');
      expect(result.blocks[0].textContent).toContain('Item 1');
      expect(result.blocks[0].textContent).toContain('Item 2');
    });

    test('reads all blocks from start to end', async () => {
      const result = await readDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 0,
          toIndex: 4,
        },
        agentToken
      );

      expect(result.readCount).toBe(5);
      expect(result.blocks[0].type).toBe('heading');
      expect(result.blocks[1].type).toBe('paragraph');
      expect(result.blocks[2].type).toBe('paragraph');
      expect(result.blocks[3].type).toBe('paragraph');
      expect(result.blocks[4].type).toBe('bulletList');
    });

    test('rejects invalid range where fromIndex > toIndex', async () => {
      await expect(
        readDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 3,
            toIndex: 1,
          },
          agentToken
        )
      ).rejects.toThrow('fromIndex (3) must be <= toIndex (1)');
    });

    test('rejects out of bounds fromIndex', async () => {
      await expect(
        readDocumentBlocks.handler(
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
        readDocumentBlocks.handler(
          {
            docGuid: testDocId,
            fromIndex: 2,
            toIndex: 10,
          },
          agentToken
        )
      ).rejects.toThrow('out of bounds');
    });

    test('allows viewers to read', async () => {
      // Create viewer user
      const viewerResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-viewer-read', 'viewer-read@example.com', 'Viewer User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const viewerId = viewerResult.rows[0].id;
      await documents.setRole(testDocId, viewerId, 'viewer');

      const viewerToken = { ...agentToken, userId: viewerId };

      const result = await readDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 0,
        },
        viewerToken
      );

      expect(result.readCount).toBe(1);

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [viewerId]);
    });

    test('includes structure information for each block', async () => {
      const result = await readDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 0,
          toIndex: 1,
        },
        agentToken
      );

      expect(result.blocks[0].structure).toBeDefined();
      expect(result.blocks[1].structure).toBeDefined();
      expect(typeof result.blocks[0].structure).toBe('string');
    });

    test('includes textLength for each block', async () => {
      const result = await readDocumentBlocks.handler(
        {
          docGuid: testDocId,
          fromIndex: 1,
        },
        agentToken
      );

      expect(result.blocks[0].textLength).toBe(11); // "Paragraph 1"
    });
  });
});
