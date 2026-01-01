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
const toolRegistry = require('../../tools/index');

// Mock agent token
const mockAgentToken = {
  userId: null, // Will be set in beforeAll
  agentName: 'Test Agent',
  rawToken: 'mock-token-for-testing',
};

describe('Document Editing Workflow Integration Test', () => {
  let pool;
  let testUserId;
  let testDocGuid;
  let persistence;

  beforeAll(async () => {
    // Set up database connection
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://localhost/collab_test',
    });

    persistence = { getPool: () => pool };

    // Initialize all tools
    toolRegistry.init(persistence);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (name, email, picture)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ['Test User', 'test@example.com', 'https://example.com/avatar.jpg']
    );
    testUserId = userResult.rows[0].id;
    mockAgentToken.userId = testUserId;

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
      `INSERT INTO documents (title, created_by)
       VALUES ($1, $2)
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
      `INSERT INTO yjs_updates (doc_id, update_data, created_at)
       VALUES ($1, $2, NOW())`,
      [testDocGuid, Buffer.from(update)]
    );
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM yjs_updates WHERE doc_id = $1', [testDocGuid]);
    await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [testDocGuid]);
    await pool.query('DELETE FROM documents WHERE id = $1', [testDocGuid]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  describe('Bug Report Workflow', () => {
    let sessionId;

    test('Step 1: Open document should succeed', async () => {
      const openDoc = toolRegistry.getTool('open_document');
      expect(openDoc).toBeDefined();

      const result = await openDoc.handler(
        {
          docGuid: testDocGuid,
          position: 'end',
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.title).toBe('Playground');
      expect(result.blockCount).toBe(1);
      expect(result.characterCount).toBe(31);
      expect(result.sessionId).toBeDefined();
      expect(result.cursor).toBeDefined();
      expect(result.cursor.block).toBe(0);

      sessionId = result.sessionId;
      console.log('✓ open_document succeeded');
    }, 30000);

    test('Step 2: goto document_end should succeed', async () => {
      const goto = toolRegistry.getTool('goto');
      expect(goto).toBeDefined();

      const result = await goto.handler(
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

      console.log('✓ goto document_end succeeded');
    }, 10000);

    test('Step 3: insert text should succeed', async () => {
      const insert = toolRegistry.getTool('insert');
      expect(insert).toBeDefined();

      const textToInsert = '\n\nHere are some fun activities:';

      const result = await insert.handler(
        {
          docGuid: testDocGuid,
          text: textToInsert,
          streaming: false,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.insertedLength).toBe(textToInsert.length);
      expect(result.cursor).toBeDefined();

      console.log('✓ insert text succeeded');
    }, 10000);

    test('Step 4: insert_block with orderedList should succeed', async () => {
      const insertBlock = toolRegistry.getTool('insert_block');
      expect(insertBlock).toBeDefined();

      const result = await insertBlock.handler(
        {
          docGuid: testDocGuid,
          position: 'after',
          blockType: 'orderedList',
          content: [
            { type: 'listItem', content: 'Swimming in the pool' },
            { type: 'listItem', content: 'Building sandcastles' },
            { type: 'listItem', content: 'Playing tag' },
          ],
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.cursor).toBeDefined();

      console.log('✓ insert_block with orderedList succeeded');
    }, 10000);

    test('Step 5: Verify final document state', async () => {
      const readDoc = toolRegistry.getTool('read_document');
      expect(readDoc).toBeDefined();

      const result = await readDoc.handler(
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
      expect(result.content).toContain('Swimming');
      expect(result.content).toContain('sandcastles');
      expect(result.content).toContain('tag');

      console.log('✓ Document state verified');
      console.log('\nFinal document content:');
      console.log(result.content);
    }, 10000);

    test('Step 6: Close document should succeed', async () => {
      const closeDoc = toolRegistry.getTool('close_document');
      expect(closeDoc).toBeDefined();

      const result = await closeDoc.handler(
        {
          docGuid: testDocGuid,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ close_document succeeded');
    }, 10000);
  });

  describe('Additional Write Operations', () => {
    beforeEach(async () => {
      // Open document before each test
      const openDoc = toolRegistry.getTool('open_document');
      await openDoc.handler(
        {
          docGuid: testDocGuid,
          position: 'start',
        },
        mockAgentToken
      );
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
