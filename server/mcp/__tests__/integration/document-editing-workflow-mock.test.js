/**
 * Integration test for document editing workflow (Mock version)
 *
 * Tests the workflow without requiring actual database/WebSocket connections.
 * This helps identify logic issues in the tool implementations.
 */

const Y = require('yjs');

describe('Document Editing Workflow - Mock Test', () => {
  let goto, insert, insertBlock, move, deleteTool, format, select;
  let mockPersistence, mockSession, mockYdoc, mockXmlFragment;
  let mockAgentPresence;

  const testDocGuid = 'test-doc-guid';
  const testUserId = 'test-user-id';
  const mockAgentToken = {
    userId: testUserId,
    agentName: 'Test Agent',
    rawToken: 'mock-token',
  };

  beforeAll(() => {
    // Set up Yjs document with initial content
    mockYdoc = new Y.Doc();
    mockXmlFragment = mockYdoc.get('default', Y.XmlFragment);

    // Create initial content: "Come join me in the playground!"
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Come join me in the playground!');
    paragraph.insert(0, [text]);
    mockXmlFragment.insert(0, [paragraph]);

    // Mock persistence
    mockPersistence = {
      getPool: jest.fn(() => ({
        query: jest.fn().mockResolvedValue({
          rows: [{ id: testDocGuid, role: 'editor' }],
        }),
      })),
    };

    // Mock session
    const sessionId = 'test-session-id';
    mockSession = {
      sessionId,
      docGuid: testDocGuid,
      userId: testUserId,
      key: `${testUserId}-${testDocGuid}`,
      provider: {
        doc: mockYdoc,
        awareness: {
          setLocalStateField: jest.fn(),
        },
      },
      cursor: null,
      undoManager: new Y.UndoManager(mockXmlFragment, { captureTimeout: 500 }),
      lastActivityAt: Date.now(),
      cleanup: jest.fn(),
    };

    // Initialize cursor at start
    const firstTextNode = mockXmlFragment.toArray()[0].toArray()[0];
    const relPos = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
    const posJson = Y.relativePositionToJSON(relPos);
    mockSession.cursor = {
      anchor: posJson,
      head: posJson,
    };

    // Mock agent presence
    const activeSessions = new Map([[sessionId, mockSession]]);
    mockAgentPresence = {
      getActiveSessions: jest.fn(() => activeSessions),
      getOrCreateSession: jest.fn(async () => mockSession),
      updateSessionCursor: jest.fn((sid, anchor, head) => {
        const session = activeSessions.get(sid);
        if (session) {
          session.cursor = { anchor, head };
        }
      }),
    };

    // Load tools and inject mocks
    goto = require('../../tools/goto');
    insert = require('../../tools/insert');
    insertBlock = require('../../tools/insert-block');
    move = require('../../tools/move');
    deleteTool = require('../../tools/delete');
    format = require('../../tools/format');
    select = require('../../tools/select');

    // Initialize tools with mock persistence
    goto.init(mockPersistence);
    insert.init(mockPersistence);
    insertBlock.init(mockPersistence);
    move.init(mockPersistence);
    deleteTool.init(mockPersistence);
    format.init(mockPersistence);
    select.init(mockPersistence);

    // Mock agentPresence module
    jest.mock('../../agent-presence', () => mockAgentPresence);
  });

  test('1. goto document_end should calculate correct position', async () => {
    try {
      const result = await goto.handler(
        {
          docGuid: testDocGuid,
          target: { type: 'document_end' },
        },
        mockAgentToken
      );

      console.log('goto result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.cursor).toBeDefined();
      expect(result.cursor.block).toBe(0);
      expect(result.cursor.offset).toBe(31); // End of "Come join me in the playground!"
    } catch (error) {
      console.error('goto error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('2. insert text should add content', async () => {
    try {
      const textToInsert = '\n\nHere are some fun activities:';

      const result = await insert.handler(
        {
          docGuid: testDocGuid,
          text: textToInsert,
          streaming: false,
        },
        mockAgentToken
      );

      console.log('insert result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.insertedLength).toBe(textToInsert.length);

      // Verify text was actually inserted
      const blocks = mockXmlFragment.toArray();
      const firstBlock = blocks[0];
      const textNode = firstBlock.toArray()[0];
      const content = textNode.toString();

      console.log('Document content after insert:', content);
      expect(content).toContain('Come join me in the playground!');
      expect(content).toContain('Here are some fun activities');
    } catch (error) {
      console.error('insert error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('3. insert_block should create new block', async () => {
    try {
      const result = await insertBlock.handler(
        {
          docGuid: testDocGuid,
          position: 'after',
          type: 'paragraph',  // Changed from blockType to type, simplified to paragraph
          content: 'Here is a new paragraph',
        },
        mockAgentToken
      );

      console.log('insert_block result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      // Verify block was created
      const blocks = mockXmlFragment.toArray();
      console.log('Number of blocks after insert_block:', blocks.length);
      expect(blocks.length).toBe(2); // Should now have 2 blocks

      // Check if new paragraph was created
      const lastBlock = blocks[blocks.length - 1];
      expect(lastBlock.nodeName).toBe('paragraph');
    } catch (error) {
      console.error('insert_block error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('4. move cursor should update position', async () => {
    try {
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

      console.log('move result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.cursor).toBeDefined();
      expect(result.moved).toBeDefined();
      expect(result.moved).toBeLessThanOrEqual(5);
    } catch (error) {
      console.error('move error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });

  test('5. select word should create selection', async () => {
    try {
      const result = await select.handler(
        {
          docGuid: testDocGuid,
          mode: 'word',
        },
        mockAgentToken
      );

      console.log('select result:', JSON.stringify(result, null, 2));

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.selection).toBeDefined();
      expect(result.selection.text).toBeDefined();
      expect(result.selection.text.length).toBeGreaterThan(0);
    } catch (error) {
      console.error('select error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  });
});
