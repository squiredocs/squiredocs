/**
 * update_document tool tests
 *
 * Tests the MCP tool for updating document content with structured nodes.
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
const { toStructured } = require('../../yjs/serialization');
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

  const agentToken = () => ({
    userId: testUserId,
    delegationId: 'test-delegation-id',
    agentId: 'claude-code:test',
    scopes: ['documents:write'],
  });

  describe('replace operation', () => {
    test('replaces document with structured nodes', async () => {
      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'replace',
          nodes: [
            { type: 'heading', level: 1, content: 'New Document' },
            { type: 'paragraph', content: 'This is the new content.' },
          ],
        },
        agentToken()
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Replaced');
      expect(result.message).toContain('2 nodes');

      // Verify content
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const content = toStructured(xmlFragment);

      expect(content).toHaveLength(2);
      expect(content[0].type).toBe('heading');
      expect(content[0].level).toBe(1);
      expect(content[0].content).toBe('New Document');
      expect(content[1].type).toBe('paragraph');
      expect(content[1].content).toBe('This is the new content.');
    });

    test('requires nodes array for replace', async () => {
      await expect(
        updateDocument.handler(
          {
            docGuid: testDocId,
            operation: 'replace',
          },
          agentToken()
        )
      ).rejects.toThrow(/nodes array required/);
    });
  });

  describe('append operation', () => {
    test('appends nodes to document', async () => {
      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'append',
          nodes: [
            { type: 'heading', level: 2, content: 'Conclusion' },
            { type: 'paragraph', content: 'The end.' },
          ],
        },
        agentToken()
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Appended');

      // Verify content
      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const content = toStructured(xmlFragment);

      expect(content).toHaveLength(3); // Original + 2 appended
      expect(content[0].type).toBe('paragraph');
      expect(content[0].content).toBe('Initial content');
      expect(content[1].type).toBe('heading');
      expect(content[2].type).toBe('paragraph');
    });

    test('appends list nodes', async () => {
      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'append',
          nodes: [
            {
              type: 'bulletList',
              children: [
                { type: 'listItem', content: 'First item' },
                { type: 'listItem', content: 'Second item' },
              ],
            },
          ],
        },
        agentToken()
      );

      expect(result.success).toBe(true);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const content = toStructured(xmlFragment);

      expect(content).toHaveLength(2);
      expect(content[1].type).toBe('bulletList');
      expect(content[1].children).toHaveLength(2);
      expect(content[1].children[0].content).toBe('First item');
    });
  });

  describe('insert operation', () => {
    test('inserts nodes at position', async () => {
      // First add more content
      await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'append',
          nodes: [{ type: 'paragraph', content: 'Second paragraph' }],
        },
        agentToken()
      );

      // Insert between first and second
      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'insert',
          position: 1,
          nodes: [{ type: 'heading', level: 2, content: 'Inserted Heading' }],
        },
        agentToken()
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Inserted');
      expect(result.message).toContain('position 1');

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const content = toStructured(xmlFragment);

      expect(content).toHaveLength(3);
      expect(content[0].content).toBe('Initial content');
      expect(content[1].type).toBe('heading');
      expect(content[1].content).toBe('Inserted Heading');
      expect(content[2].content).toBe('Second paragraph');
    });

    test('requires position for insert', async () => {
      await expect(
        updateDocument.handler(
          {
            docGuid: testDocId,
            operation: 'insert',
            nodes: [{ type: 'paragraph', content: 'Test' }],
          },
          agentToken()
        )
      ).rejects.toThrow(/position required/);
    });

    test('insert at position 0 prepends', async () => {
      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'insert',
          position: 0,
          nodes: [{ type: 'heading', level: 1, content: 'Title' }],
        },
        agentToken()
      );

      expect(result.success).toBe(true);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const content = toStructured(xmlFragment);

      expect(content[0].type).toBe('heading');
      expect(content[0].content).toBe('Title');
      expect(content[1].content).toBe('Initial content');
    });
  });

  describe('delete operation', () => {
    test('deletes nodes at position', async () => {
      // Add more content
      await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'append',
          nodes: [
            { type: 'paragraph', content: 'Second' },
            { type: 'paragraph', content: 'Third' },
          ],
        },
        agentToken()
      );

      // Delete the middle node
      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'delete',
          position: 1,
          count: 1,
        },
        agentToken()
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Deleted');
      expect(result.message).toContain('1 node');

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const content = toStructured(xmlFragment);

      expect(content).toHaveLength(2);
      expect(content[0].content).toBe('Initial content');
      expect(content[1].content).toBe('Third');
    });

    test('requires position and count for delete', async () => {
      await expect(
        updateDocument.handler(
          {
            docGuid: testDocId,
            operation: 'delete',
            count: 1,
          },
          agentToken()
        )
      ).rejects.toThrow(/position required/);

      await expect(
        updateDocument.handler(
          {
            docGuid: testDocId,
            operation: 'delete',
            position: 0,
          },
          agentToken()
        )
      ).rejects.toThrow(/count required/);
    });

    test('handles out of range delete gracefully', async () => {
      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'delete',
          position: 100,
          count: 1,
        },
        agentToken()
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('No nodes deleted');
    });
  });

  describe('formatted text with marks', () => {
    test('creates text with bold and italic marks', async () => {
      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'replace',
          nodes: [
            {
              type: 'paragraph',
              content: [
                'Plain text ',
                { text: 'bold text', marks: ['bold'] },
                ' and ',
                { text: 'italic text', marks: ['italic'] },
              ],
            },
          ],
        },
        agentToken()
      );

      expect(result.success).toBe(true);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const content = toStructured(xmlFragment);

      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('paragraph');
      expect(Array.isArray(content[0].content)).toBe(true);

      // Check that marks are preserved
      const boldItem = content[0].content.find(
        (item) => typeof item === 'object' && item.marks && item.marks.includes('bold')
      );
      expect(boldItem).toBeDefined();
      expect(boldItem.text).toBe('bold text');
    });

    test('creates links', async () => {
      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'replace',
          nodes: [
            {
              type: 'paragraph',
              content: [
                'Check out ',
                { text: 'this link', marks: [{ type: 'link', href: 'https://example.com' }] },
                ' for more info.',
              ],
            },
          ],
        },
        agentToken()
      );

      expect(result.success).toBe(true);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const content = toStructured(xmlFragment);

      const linkItem = content[0].content.find(
        (item) =>
          typeof item === 'object' &&
          item.marks &&
          item.marks.some((m) => m.type === 'link')
      );
      expect(linkItem).toBeDefined();
      expect(linkItem.text).toBe('this link');
    });
  });

  describe('code blocks', () => {
    test('creates code block with language', async () => {
      const result = await updateDocument.handler(
        {
          docGuid: testDocId,
          operation: 'replace',
          nodes: [
            {
              type: 'codeBlock',
              language: 'javascript',
              content: 'const x = 42;\nconsole.log(x);',
            },
          ],
        },
        agentToken()
      );

      expect(result.success).toBe(true);

      const ydoc = documentService.getSharedDoc(testDocId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const content = toStructured(xmlFragment);

      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('codeBlock');
      expect(content[0].language).toBe('javascript');
      expect(content[0].content).toContain('const x = 42');
    });
  });

  describe('validation', () => {
    test('rejects invalid node type', async () => {
      await expect(
        updateDocument.handler(
          {
            docGuid: testDocId,
            operation: 'replace',
            nodes: [{ type: 'invalidType', content: 'Test' }],
          },
          agentToken()
        )
      ).rejects.toThrow(/Invalid node type/);
    });

    test('rejects invalid heading level', async () => {
      await expect(
        updateDocument.handler(
          {
            docGuid: testDocId,
            operation: 'replace',
            nodes: [{ type: 'heading', level: 5, content: 'Test' }],
          },
          agentToken()
        )
      ).rejects.toThrow(/level must be 1, 2, or 3/);
    });

    test('rejects empty list children', async () => {
      await expect(
        updateDocument.handler(
          {
            docGuid: testDocId,
            operation: 'replace',
            nodes: [{ type: 'bulletList', children: [] }],
          },
          agentToken()
        )
      ).rejects.toThrow(/non-empty children/);
    });

    test('rejects invalid mark', async () => {
      await expect(
        updateDocument.handler(
          {
            docGuid: testDocId,
            operation: 'replace',
            nodes: [
              {
                type: 'paragraph',
                content: [{ text: 'test', marks: ['invalid-mark'] }],
              },
            ],
          },
          agentToken()
        )
      ).rejects.toThrow(/Invalid mark/);
    });
  });

  describe('permissions', () => {
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

      await expect(
        updateDocument.handler(
          {
            docGuid: testDocId,
            operation: 'append',
            nodes: [{ type: 'paragraph', content: 'Unauthorized content' }],
          },
          {
            userId: viewerId,
            delegationId: 'test-delegation-id',
            agentId: 'claude-code:test',
            scopes: ['documents:write'],
          }
        )
      ).rejects.toThrow('You do not have edit permission');

      // Clean up
      await pool.query('DELETE FROM users WHERE id = $1', [viewerId]);
    });
  });
});
