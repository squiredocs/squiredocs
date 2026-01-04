/**
 * Integration test for document editing workflow using execute_script
 *
 * Tests the complete workflow reported in bug:
 * 1. Open existing document
 * 2. Insert text content
 * 3. Insert new blocks
 *
 * This exercises the V3 sandboxed TypeScript execution API.
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

describe('Document Editing Workflow Integration Test (execute_script)', () => {
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
    test('Complete workflow: open, execute_script (insert text + block), verify, close', async () => {
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

      // Step 2: Execute script to add text and create ordered list
      console.log('\n=== Step 2: Execute script to add text and ordered list ===');
      const executeScript = toolRegistry.getTool('execute_script');
      expect(executeScript).toBeDefined();

      const script = `
export default function edit(doc) {
  // Get the first paragraph (containing "Come join me in the playground!")
  const firstParagraph = doc.get(0);
  const firstText = firstParagraph.get(0);

  // Add text to the end: "\\n\\nHere are some fun activities:"
  const currentLength = firstText.length;
  firstText.insert(currentLength, '\\n\\nHere are some fun activities:');

  // Create a new ordered list item with content
  const orderedList = new Y.XmlElement('orderedList');
  const listText = new Y.XmlText();
  listText.insert(0, 'Watch the sunrise together as a family');
  orderedList.insert(0, [listText]);

  // Insert the ordered list after the first paragraph
  doc.insert(1, [orderedList]);
}
`;

      result = await executeScript.handler(
        {
          docGuid: testDocGuid,
          script,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.operationCount).toBeGreaterThan(0);

      console.log('✓ Step 2: execute_script succeeded');
      console.log(`  Operations: ${result.operationCount}`);
      console.log(`  Summary: ${result.summary}`);

      // Step 3: Verify final document state
      console.log('\n=== Step 3: Verify final document state ===');
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
      expect(result.content).toContain('Watch the sunrise together as a family');

      console.log('✓ Step 3: Document state verified');
      console.log('\nFinal document content:');
      console.log(result.content);

      // Step 4: Close document
      console.log('\n=== Step 4: Close document ===');
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

      console.log('✓ Step 4: close_document succeeded');
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

    test('execute_script: append text to existing paragraph', async () => {
      const executeScript = toolRegistry.getTool('execute_script');
      expect(executeScript).toBeDefined();

      const script = `
export default function edit(doc) {
  // Get the first paragraph and append text
  const firstParagraph = doc.get(0);
  const text = firstParagraph.get(0);
  text.insert(text.length, ' Extra text!');
}
`;

      const result = await executeScript.handler(
        {
          docGuid: testDocGuid,
          script,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ execute_script: append text succeeded');
    }, 10000);

    test('execute_script: format text with bold marks', async () => {
      const executeScript = toolRegistry.getTool('execute_script');
      expect(executeScript).toBeDefined();

      const script = `
export default function edit(doc) {
  // Format the first 4 characters as bold
  const firstParagraph = doc.get(0);
  const text = firstParagraph.get(0);
  text.format(0, 4, { bold: true });
}
`;

      const result = await executeScript.handler(
        {
          docGuid: testDocGuid,
          script,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ execute_script: format text succeeded');
    }, 10000);

    test('execute_script: delete text range', async () => {
      const executeScript = toolRegistry.getTool('execute_script');
      expect(executeScript).toBeDefined();

      const script = `
export default function edit(doc) {
  // Delete 5 characters from position 0
  const firstParagraph = doc.get(0);
  const text = firstParagraph.get(0);
  text.delete(0, 5);
}
`;

      const result = await executeScript.handler(
        {
          docGuid: testDocGuid,
          script,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ execute_script: delete text succeeded');
    }, 10000);

    test('execute_script: delete entire block', async () => {
      const executeScript = toolRegistry.getTool('execute_script');
      expect(executeScript).toBeDefined();

      // First add a block to delete
      const addScript = `
export default function edit(doc) {
  const newParagraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, 'This block will be deleted');
  newParagraph.insert(0, [text]);
  doc.insert(doc.length, [newParagraph]);
}
`;

      let result = await executeScript.handler(
        {
          docGuid: testDocGuid,
          script: addScript,
        },
        mockAgentToken
      );

      expect(result.success).toBe(true);

      // Now delete the block
      const deleteScript = `
export default function edit(doc) {
  // Delete the last block
  doc.delete(doc.length - 1, 1);
}
`;

      result = await executeScript.handler(
        {
          docGuid: testDocGuid,
          script: deleteScript,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ execute_script: delete block succeeded');
    }, 10000);

    test('execute_script: insert bulletList', async () => {
      const executeScript = toolRegistry.getTool('execute_script');
      expect(executeScript).toBeDefined();

      const script = `
export default function edit(doc) {
  // Create a bulletList item
  const bulletList = new Y.XmlElement('bulletList');
  const text = new Y.XmlText();
  text.insert(0, 'First bullet item');
  bulletList.insert(0, [text]);

  // Insert at the end
  doc.insert(doc.length, [bulletList]);
}
`;

      const result = await executeScript.handler(
        {
          docGuid: testDocGuid,
          script,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ execute_script: insert bulletList succeeded');
    }, 10000);

    test('execute_script: insert orderedList', async () => {
      const executeScript = toolRegistry.getTool('execute_script');
      expect(executeScript).toBeDefined();

      const script = `
export default function edit(doc) {
  // Create an orderedList item
  const orderedList = new Y.XmlElement('orderedList');
  const text = new Y.XmlText();
  text.insert(0, 'First numbered item');
  orderedList.insert(0, [text]);

  // Insert at the end
  doc.insert(doc.length, [orderedList]);
}
`;

      const result = await executeScript.handler(
        {
          docGuid: testDocGuid,
          script,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ execute_script: insert orderedList succeeded');
    }, 10000);

    test('execute_script: complex workflow with multiple list items (bug scenario)', async () => {
      // This is the EXACT bug scenario from the original report:
      // Creating an ordered list, then inserting bullet and ordered lists after it

      const executeScript = toolRegistry.getTool('execute_script');
      expect(executeScript).toBeDefined();

      const script = `
export default function edit(doc) {
  // Create an orderedList item
  const orderedList1 = new Y.XmlElement('orderedList');
  const text1 = new Y.XmlText();
  text1.insert(0, 'Watch the sunrise together as a family');
  orderedList1.insert(0, [text1]);
  doc.insert(doc.length, [orderedList1]);

  // Insert a bulletList after it
  const bulletList = new Y.XmlElement('bulletList');
  const text2 = new Y.XmlText();
  text2.insert(0, 'Sub-item A');
  bulletList.insert(0, [text2]);
  doc.insert(doc.length, [bulletList]);

  // Insert another orderedList
  const orderedList2 = new Y.XmlElement('orderedList');
  const text3 = new Y.XmlText();
  text3.insert(0, 'Next numbered item');
  orderedList2.insert(0, [text3]);
  doc.insert(doc.length, [orderedList2]);
}
`;

      const result = await executeScript.handler(
        {
          docGuid: testDocGuid,
          script,
        },
        mockAgentToken
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      console.log('✓ execute_script: complex workflow succeeded');
    }, 10000);

    test('undo should succeed', async () => {
      // First make a change
      const executeScript = toolRegistry.getTool('execute_script');
      await executeScript.handler(
        {
          docGuid: testDocGuid,
          script: `
export default function edit(doc) {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, 'Undo test');
  p.insert(0, [t]);
  doc.insert(doc.length, [p]);
}
`,
        },
        mockAgentToken
      );

      // Now undo it
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
