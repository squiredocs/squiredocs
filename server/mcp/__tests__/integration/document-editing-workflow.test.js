/**
 * Integration test for document editing workflow
 *
 * Tests the complete workflow reported in bug:
 * 1. Open existing document
 * 2. Insert text content
 * 3. Insert new blocks
 *
 * This exercises the full V2 cursor-based editing API.
 */

const { Pool } = require('pg');
const Y = require('yjs');
const WebSocket = require('ws');
const http = require('http');
const toolRegistry = require('../../tools/index');
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils');
const { PostgresPersistence } = require('../../../postgres-persistence');
const agentPresence = require('../../agent-presence');

// Mock agent token
const mockAgentToken = {
  userId: null, // Will be set in beforeAll
  agentName: 'Test Agent',
  rawToken: null, // Will be set in beforeAll
};

describe('Document Editing Workflow Integration Test', () => {
  let pool;
  let testUserId;
  let testDocGuid;
  let persistence;
  let httpServer;
  let wss;

  beforeAll(async () => {
    // Set up database connection
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://localhost/collab_test_db',
    });

    persistence = new PostgresPersistence(process.env.DATABASE_URL || 'postgresql://localhost/collab_test_db');

    // Set up y-websocket persistence
    const extractDocGuid = (docName) => {
      if (docName.startsWith('s/')) {
        return docName.slice(2);
      }
      return docName;
    };

    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = extractDocGuid(docName);
        const persistedYdoc = await persistence.getYDoc(docGuid);
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
      },
      writeState: async (docName, ydoc) => {
        const docGuid = extractDocGuid(docName);
        await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(ydoc));
      },
    });

    // Initialize tool registry
    toolRegistry.init({ getPool: () => pool });

    // Initialize agent presence with persistence
    agentPresence.init(persistence);

    // Create HTTP server
    httpServer = http.createServer();

    // Create WebSocket server (accept all connections in test mode)
    wss = new WebSocket.Server({
      server: httpServer,
      verifyClient: () => true // Accept all connections in test mode
    });

    wss.on('connection', (ws, req) => {
      setupWSConnection(ws, req, {
        gc: false // Disable garbage collection to keep documents in memory
      });
    });

    // Start server on random port
    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        const port = httpServer.address().port;
        process.env.WS_PORT = port;
        process.env.WS_HOST = 'localhost';
        process.env.WS_PROTOCOL = 'ws';
        console.log(`Test WebSocket server started on port ${port}`);
        resolve();
      });
    });

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (google_id, name, email, picture)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      ['test-google-id-' + Date.now(), 'Test User', 'test-' + Date.now() + '@example.com', 'https://example.com/avatar.jpg']
    );
    testUserId = userResult.rows[0].id;
    mockAgentToken.userId = testUserId;
    mockAgentToken.rawToken = 'mock-jwt-token-' + Date.now(); // Set token for WebSocket auth

    // Create test document with initial content
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);

    // Create initial content: "Come join me in the playground!"
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Come join me in the playground!');
    paragraph.insert(0, [text]);
    xmlFragment.insert(0, [paragraph]);

    const docResult = await pool.query(
      `INSERT INTO documents (id, title, creator_id)
       VALUES (uuid_generate_v4(), $1, $2)
       RETURNING id`,
      ['Playground', testUserId]
    );
    testDocGuid = docResult.rows[0].id;

    // Share document with test user (as editor)
    await pool.query(
      `INSERT INTO document_shares (doc_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [testDocGuid, testUserId, 'editor']
    );

    // Store initial document state
    const update = Y.encodeStateAsUpdate(ydoc);
    await pool.query(
      `INSERT INTO yjs_updates (doc_guid, clock, update_data, created_at)
       VALUES ($1, 0, $2, NOW())`,
      [testDocGuid, Buffer.from(update)]
    );
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [testDocGuid]);
    await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [testDocGuid]);
    await pool.query('DELETE FROM documents WHERE id = $1', [testDocGuid]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();

    // Close WebSocket server
    wss.close();
    await new Promise((resolve) => {
      httpServer.close(resolve);
    });

    // Cleanup persistence
    await persistence.destroy();
  });

  describe('Bug Report Workflow', () => {
    test('Complete workflow: open, goto, insert, insert_block, verify, close', async () => {
      let sessionId;

      // Step 1: Open document
      console.log('\n=== Step 1: Open document ===');
      const openDoc = toolRegistry.getTool('open_document');
      expect(openDoc).toBeDefined();

      let result = await openDoc.handler(
        {
          docGuid: testDocGuid,
          position: 'end',
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.documentInfo).toBeDefined();
      expect(result.documentInfo.title).toBe('Playground');
      expect(result.sessionId).toBeDefined();
      expect(result.cursor).toBeDefined();

      sessionId = result.sessionId;
      console.log('✓ Step 1: open_document succeeded');

      // Step 2: goto document_end
      console.log('\n=== Step 2: goto document_end ===');
      const goto = toolRegistry.getTool('goto');
      expect(goto).toBeDefined();

      result = await goto.handler(
        {
          docGuid: testDocGuid,
          target: { type: 'document_end' },
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.cursor).toBeDefined();
      expect(result.cursor.block).toBe(0);
      expect(result.cursor.offset).toBe(31); // End of "Come join me in the playground!"

      console.log('✓ Step 2: goto document_end succeeded');

      // Step 3: insert text
      console.log('\n=== Step 3: insert text ===');
      const insert = toolRegistry.getTool('insert');
      expect(insert).toBeDefined();

      const textToInsert = '\n\nHere are some fun activities:';

      result = await insert.handler(
        {
          docGuid: testDocGuid,
          text: textToInsert,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.insertedLength).toBe(textToInsert.length);
      expect(result.cursor).toBeDefined();

      console.log('✓ Step 3: insert text succeeded');

      // Step 4: insert_block with orderedList
      console.log('\n=== Step 4: insert_block with orderedList ===');
      const insertBlock = toolRegistry.getTool('insert_block');
      expect(insertBlock).toBeDefined();

      result = await insertBlock.handler(
        {
          docGuid: testDocGuid,
          position: 'after',
          type: 'orderedList',
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.cursor).toBeDefined();

      console.log('✓ Step 4: insert_block succeeded');

      // Step 5: Verify final document state
      console.log('\n=== Step 5: Verify final document state ===');
      const readDoc = toolRegistry.getTool('read_document');
      expect(readDoc).toBeDefined();

      result = await readDoc.handler(
        {
          docGuid: testDocGuid,
          format: 'text',
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.content).toContain('Come join me in the playground!');
      expect(result.content).toContain('Here are some fun activities');

      console.log('✓ Step 5: Document state verified');
      console.log('\nFinal document content:');
      console.log(result.content);

      // Step 6: Close document
      console.log('\n=== Step 6: Close document ===');
      const closeDoc = toolRegistry.getTool('close_document');
      expect(closeDoc).toBeDefined();

      result = await closeDoc.handler(
        {
          docGuid: testDocGuid,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ Step 6: close_document succeeded');
    }, 60000); // Increased timeout for full workflow
  });

  describe('Additional Write Operations', () => {
    let sessionId;

    beforeEach(async () => {
      // Open document before each test
      const openDoc = toolRegistry.getTool('open_document');
      const result = await openDoc.handler(
        {
          docGuid: testDocGuid,
          position: 'start',
        },
        mockAgentToken
      );
      sessionId = result.sessionId;
    });

    afterEach(async () => {
      // Close document after each test
      const closeDoc = toolRegistry.getTool('close_document');
      await closeDoc.handler({ docGuid: testDocGuid }, mockAgentToken);
    });

    test('move cursor forward should succeed', async () => {
      const move = toolRegistry.getTool('move');
      expect(move).toBeDefined();

      const result = await move.handler(
        {
          docGuid: testDocGuid,
          direction: 'forward',
          unit: 'char',
          count: 5,
          extend: false,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.cursor).toBeDefined();

      console.log('✓ move cursor succeeded');
    }, 10000);

    test('select text should succeed', async () => {
      const select = toolRegistry.getTool('select');
      expect(select).toBeDefined();

      // Add a small delay to ensure session is fully ready
      await new Promise(resolve => setTimeout(resolve, 100));

      const result = await select.handler(
        {
          docGuid: testDocGuid,
          mode: 'word',
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.selection).toBeDefined();

      console.log('✓ select text succeeded');
    }, 10000);

    test('format text should succeed', async () => {
      // First select some text
      const select = toolRegistry.getTool('select');
      await select.handler(
        {
          docGuid: testDocGuid,
          mode: 'word',
        },
        mockAgentToken
      );

      // Then format it
      const format = toolRegistry.getTool('format');
      expect(format).toBeDefined();

      const result = await format.handler(
        {
          docGuid: testDocGuid,
          marks: { bold: true },
          action: 'add',
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ format text succeeded');
    }, 10000);

    test('delete text should succeed', async () => {
      // First select some text
      const select = toolRegistry.getTool('select');
      await select.handler(
        {
          docGuid: testDocGuid,
          mode: 'word',
        },
        mockAgentToken
      );

      // Then delete it
      const deleteTool = toolRegistry.getTool('delete');
      expect(deleteTool).toBeDefined();

      const result = await deleteTool.handler(
        {
          docGuid: testDocGuid,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ delete text succeeded');
    }, 10000);

    test('delete block selection should succeed', async () => {
      // This test covers the bug scenario from the bug report:
      // Selecting a block with mode: "block" and then deleting it

      // First, insert a new block with some content
      const insertBlock = toolRegistry.getTool('insert_block');
      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          position: 'after',
          type: 'paragraph',
        },
        mockAgentToken
      );

      const insert = toolRegistry.getTool('insert');
      await insert.handler(
        {
          docGuid: testDocGuid,
          text: 'This block will be deleted',
        },
        mockAgentToken
      );

      // Select the entire block
      const select = toolRegistry.getTool('select');
      await select.handler(
        {
          docGuid: testDocGuid,
          mode: 'block',
        },
        mockAgentToken
      );

      // Now delete the selected block
      const deleteTool = toolRegistry.getTool('delete');
      const result = await deleteTool.handler(
        {
          docGuid: testDocGuid,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.deletedText).toBe('This block will be deleted');

      console.log('✓ delete block selection succeeded');
    }, 10000);


    test('delete by direction should succeed', async () => {
      // Test direction-based deletion (without selection)

      // Insert some text
      const insert = toolRegistry.getTool('insert');
      await insert.handler(
        {
          docGuid: testDocGuid,
          text: 'Delete this backward',
        },
        mockAgentToken
      );

      // Cursor is now at end of text
      // Delete 5 characters backward (should delete "kward")
      const deleteTool = toolRegistry.getTool('delete');
      const result = await deleteTool.handler(
        {
          docGuid: testDocGuid,
          direction: 'backward',
          unit: 'char',
          count: 5,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.deletedText).toBe('kward');
      expect(result.deletedLength).toBe(5);

      console.log('✓ delete by direction succeeded');
    }, 10000);

    test('insert_block with bulletList should succeed', async () => {
      // Test inserting a bulletList block (reproduces reported bug)
      const insertBlock = toolRegistry.getTool('insert_block');
      const insert = toolRegistry.getTool('insert');

      // First insert some content
      await insert.handler(
        {
          docGuid: testDocGuid,
          text: 'Before list',
        },
        mockAgentToken
      );

      // Insert a bulletList after current block
      const result = await insertBlock.handler(
        {
          docGuid: testDocGuid,
          position: 'after',
          type: 'bulletList',
          content: 'First bullet item',
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.newBlockIndex).toBeDefined();
      expect(result.cursor).toBeDefined();

      console.log('✓ insert_block with bulletList succeeded');
    }, 10000);

    test('insert_block with orderedList should succeed', async () => {
      // Test inserting an orderedList block (reproduces reported bug)
      const insertBlock = toolRegistry.getTool('insert_block');
      const insert = toolRegistry.getTool('insert');

      // First insert some content
      await insert.handler(
        {
          docGuid: testDocGuid,
          text: 'Before numbered list',
        },
        mockAgentToken
      );

      // Insert an orderedList after current block
      const result = await insertBlock.handler(
        {
          docGuid: testDocGuid,
          position: 'after',
          type: 'orderedList',
          content: 'First numbered item',
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.newBlockIndex).toBeDefined();
      expect(result.cursor).toBeDefined();

      console.log('✓ insert_block with orderedList succeeded');
    }, 10000);

    test('insert_block after orderedList should succeed', async () => {
      // This is the EXACT bug scenario from the bug report:
      // Converting a block to orderedList, then inserting new blocks after it

      const setBlockType = toolRegistry.getTool('set_block_type');
      const insertBlock = toolRegistry.getTool('insert_block');
      const insert = toolRegistry.getTool('insert');

      // Insert a paragraph
      await insertBlock.handler(
        {
          docGuid: testDocGuid,
          position: 'after',
          type: 'paragraph',
          content: 'Watch the sunrise together as a family',
        },
        mockAgentToken
      );

      // Convert it to orderedList (this is what the bug report did)
      const setResult = await setBlockType.handler(
        {
          docGuid: testDocGuid,
          newType: 'orderedList',
        },
        mockAgentToken
      );

      expect(setResult).toBeDefined();
      expect(setResult.success).toBe(true);

      // Now try to insert a bulletList after it (this was failing)
      const insertResult1 = await insertBlock.handler(
        {
          docGuid: testDocGuid,
          position: 'after',
          type: 'bulletList',
          content: 'Sub-item A',
        },
        mockAgentToken
      );

      expect(insertResult1).toBeDefined();
      expect(insertResult1.success).toBe(true);

      // Try to insert another orderedList (this was also failing)
      const insertResult2 = await insertBlock.handler(
        {
          docGuid: testDocGuid,
          position: 'after',
          type: 'orderedList',
          content: 'Next numbered item',
        },
        mockAgentToken
      );

      expect(insertResult2).toBeDefined();
      expect(insertResult2.success).toBe(true);

      console.log('✓ insert_block after orderedList succeeded');
    }, 10000);

    test('undo should succeed', async () => {
      const undo = toolRegistry.getTool('undo');
      expect(undo).toBeDefined();

      const result = await undo.handler(
        {
          docGuid: testDocGuid,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ undo succeeded');
    }, 10000);

    test('redo should succeed', async () => {
      const redo = toolRegistry.getTool('redo');
      expect(redo).toBeDefined();

      const result = await redo.handler(
        {
          docGuid: testDocGuid,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ redo succeeded');
    }, 10000);
  });
});
