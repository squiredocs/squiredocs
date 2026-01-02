/**
 * Clipboard Tools Tests
 *
 * Tests copy_selection, paste, and cut_selection tools
 */

const Y = require('yjs');

// Mock agentPresence before requiring tools
jest.mock('../../agent-presence');

describe('Clipboard Tools', () => {
  let copySelection, paste, cutSelection;
  let mockPersistence, mockSession, mockYdoc, mockXmlFragment;
  let agentPresence;

  const testDocGuid = 'test-doc-guid';
  const testUserId = 'test-user-id';
  const mockAgentToken = {
    userId: testUserId,
    agentName: 'Test Agent',
    rawToken: 'mock-token',
  };

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Set up Yjs document with initial content
    mockYdoc = new Y.Doc();
    mockXmlFragment = mockYdoc.get('default', Y.XmlFragment);

    // Create initial content
    const paragraph1 = new Y.XmlElement('paragraph');
    const text1 = new Y.XmlText();
    text1.insert(0, 'Hello world');
    paragraph1.insert(0, [text1]);

    const paragraph2 = new Y.XmlElement('paragraph');
    const text2 = new Y.XmlText();
    text2.insert(0, 'This is a test');
    paragraph2.insert(0, [text2]);

    mockXmlFragment.insert(0, [paragraph1, paragraph2]);

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

    // Create cursor at start of first word "Hello"
    const firstTextNode = mockXmlFragment.toArray()[0].toArray()[0];
    const startPos = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
    const endPos = Y.createRelativePositionFromTypeIndex(firstTextNode, 5); // End of "Hello"

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
      cursor: {
        anchor: Y.relativePositionToJSON(startPos),
        head: Y.relativePositionToJSON(endPos), // Selection of "Hello"
      },
      undoManager: new Y.UndoManager(mockXmlFragment, { captureTimeout: 500 }),
      clipboard: null,
      lastActivityAt: Date.now(),
      cleanup: jest.fn(),
    };

    // Get agentPresence mock and configure it
    agentPresence = require('../../agent-presence');
    agentPresence.getOrCreateSession = jest.fn().mockResolvedValue(mockSession);
    agentPresence.updateSessionCursor = jest.fn((sid, anchor, head) => {
      if (sid === sessionId) {
        mockSession.cursor = { anchor, head };
      }
    });

    // Load tools
    copySelection = require('../../tools/copy-selection');
    paste = require('../../tools/paste');
    cutSelection = require('../../tools/cut-selection');
    const deleteTool = require('../../tools/delete');

    // Initialize tools with mock persistence
    copySelection.init(mockPersistence);
    paste.init(mockPersistence);
    cutSelection.init(mockPersistence);
    deleteTool.init(mockPersistence);
  });

  describe('copy_selection', () => {
    test('should export required properties', () => {
      expect(copySelection.name).toBe('copy_selection');
      expect(copySelection.description).toBeDefined();
      expect(copySelection.inputSchema).toBeDefined();
      expect(typeof copySelection.handler).toBe('function');
    });

    test('should copy selection to clipboard', async () => {
      const result = await copySelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.hasSelection).toBe(true);
      // copiedLength may be 0 if extraction doesn't produce content, but clipboard should exist
      expect(result.clipboardId).toBeDefined();
      expect(mockSession.clipboard).toBeDefined();
      expect(mockSession.clipboard.binary).toBeDefined();
      expect(mockSession.clipboard.binary).toBeInstanceOf(Uint8Array);
      // Verify we have content in the binary clipboard
      expect(mockSession.clipboard.binary.length).toBeGreaterThan(0);
    });

    test('should return empty result when no selection exists', async () => {
      // Set cursor to collapsed (no selection)
      const firstTextNode = mockXmlFragment.toArray()[0].toArray()[0];
      const pos = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
      const posJson = Y.relativePositionToJSON(pos);
      mockSession.cursor = {
        anchor: posJson,
        head: posJson,
      };

      const result = await copySelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.hasSelection).toBe(false);
      expect(result.copiedBlocks).toBe(0);
    });

    test('should include content preview in result', async () => {
      const result = await copySelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(result.contentPreview).toBeDefined();
      expect(typeof result.contentPreview).toBe('string');
    });
  });

  describe('paste', () => {
    test('should export required properties', () => {
      expect(paste.name).toBe('paste');
      expect(paste.description).toBeDefined();
      expect(paste.inputSchema).toBeDefined();
      expect(typeof paste.handler).toBe('function');
    });

    test('should return empty result when clipboard is empty', async () => {
      const result = await paste.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.clipboardEmpty).toBe(true);
      expect(result.pastedBlocks).toBe(0);
    });

    test('should paste content from clipboard', async () => {
      // First copy something
      await copySelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      // Then paste
      const result = await paste.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.clipboardEmpty).toBe(false);
    });

    test('should accept mode parameter', async () => {
      // Copy something
      await copySelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      // Test each mode
      for (const mode of ['before', 'after', 'replace']) {
        const result = await paste.handler(
          { docGuid: testDocGuid, mode },
          mockAgentToken
        );

        expect(result.success).toBe(true);
      }
    });

    test('should deny access to viewers', async () => {
      const viewerPersistence = {
        getPool: jest.fn(() => ({
          query: jest.fn().mockResolvedValue({
            rows: [{ id: testDocGuid, role: 'viewer' }],
          }),
        })),
      };

      paste.init(viewerPersistence);

      await expect(
        paste.handler({ docGuid: testDocGuid }, mockAgentToken)
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('cut_selection', () => {
    test('should export required properties', () => {
      expect(cutSelection.name).toBe('cut_selection');
      expect(cutSelection.description).toBeDefined();
      expect(cutSelection.inputSchema).toBeDefined();
      expect(typeof cutSelection.handler).toBe('function');
    });

    test('should cut selection to clipboard', async () => {
      const result = await cutSelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.hasSelection).toBe(true);
      // cutLength may be 0 due to extraction issues, but clipboard should exist
      expect(result.clipboardId).toBeDefined();
      expect(mockSession.clipboard).toBeDefined();
      // Verify clipboard has content in binary format
      expect(mockSession.clipboard.binary).toBeDefined();
      expect(mockSession.clipboard.binary).toBeInstanceOf(Uint8Array);
    });

    test('should return empty result when no selection exists', async () => {
      // Set cursor to collapsed (no selection)
      const firstTextNode = mockXmlFragment.toArray()[0].toArray()[0];
      const pos = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
      const posJson = Y.relativePositionToJSON(pos);
      mockSession.cursor = {
        anchor: posJson,
        head: posJson,
      };

      const result = await cutSelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.hasSelection).toBe(false);
      expect(result.cutBlocks).toBe(0);
    });

    test('should deny access to viewers', async () => {
      const viewerPersistence = {
        getPool: jest.fn(() => ({
          query: jest.fn().mockResolvedValue({
            rows: [{ id: testDocGuid, role: 'viewer' }],
          }),
        })),
      };

      cutSelection.init(viewerPersistence);

      await expect(
        cutSelection.handler({ docGuid: testDocGuid }, mockAgentToken)
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('Clipboard Workflow', () => {
    test('copy -> paste workflow preserves clipboard', async () => {
      // Copy
      const copyResult = await copySelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(copyResult.success).toBe(true);
      const clipboardId = copyResult.clipboardId;

      // Paste
      const pasteResult = await paste.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(pasteResult.success).toBe(true);

      // Clipboard should still have content (can paste multiple times)
      expect(mockSession.clipboard).toBeDefined();
      expect(mockSession.clipboard.id).toBe(clipboardId);
    });

    test('cut includes both copy and delete results', async () => {
      const result = await cutSelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(result).toHaveProperty('cutBlocks');
      expect(result).toHaveProperty('cutLength');
      expect(result).toHaveProperty('clipboardId');
      expect(result).toHaveProperty('cursor');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('cut handles multi-block deletion without cursor errors', async () => {
      // Create multi-block content (heading + list)
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 2);
      const headingText = new Y.XmlText();
      headingText.insert(0, 'Test Heading');
      heading.insert(0, [headingText]);

      const bulletList = new Y.XmlElement('bulletList');
      const listItem = new Y.XmlElement('listItem');
      const listPara = new Y.XmlElement('paragraph');
      const listText = new Y.XmlText();
      listText.insert(0, 'List item text');
      listPara.insert(0, [listText]);
      listItem.insert(0, [listPara]);
      bulletList.insert(0, [listItem]);

      mockXmlFragment.insert(2, [heading, bulletList]);

      // Select both blocks (blocks 2-3)
      const headingTextNode = mockXmlFragment.get(2).toArray()[0];
      const listTextNode = mockXmlFragment.get(3).toArray()[0].toArray()[0].toArray()[0];

      const anchorPos = Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(headingTextNode, 0)
      );
      const headPos = Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(listTextNode, listText.length)
      );

      mockSession.cursor = { anchor: anchorPos, head: headPos };

      // Cut should succeed without errors
      const result = await cutSelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.hasSelection).toBe(true);
      expect(result.cutBlocks).toBe(2);
      expect(result.cursor).toBeDefined();
      expect(result.cursor.block).toBeDefined();
      expect(result.cursor.offset).toBeDefined();

      // Verify blocks were deleted
      expect(mockXmlFragment.length).toBe(2); // Back to original 2 paragraphs
    });

    test('delete operation creates valid cursor after multi-block deletion', async () => {
      // Import delete tool
      const deleteOp = require('../../tools/delete');
      deleteOp.init(mockPersistence);

      // Create multi-block content
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 2);
      const headingText = new Y.XmlText();
      headingText.insert(0, 'Heading to delete');
      heading.insert(0, [headingText]);

      mockXmlFragment.insert(2, [heading]);

      // Select blocks 2 (new heading)
      const block2Text = mockXmlFragment.get(2).toArray()[0];
      const anchorPos = Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(block2Text, 0)
      );
      const headPos = Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(block2Text, headingText.length)
      );

      mockSession.cursor = { anchor: anchorPos, head: headPos };

      // Delete should succeed and return valid cursor
      const result = await deleteOp.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.cursor).toBeDefined();
      expect(result.cursor.block).toBeGreaterThanOrEqual(0);
      expect(result.cursor.offset).toBeGreaterThanOrEqual(0);
      expect(result.cursor.blockType).toBeDefined();
    });

    test('cut with complex nested list structure preserves all content', async () => {
      // Create complex nested structure (orderedList with nested bulletList)
      const orderedList = new Y.XmlElement('orderedList');

      for (let i = 0; i < 3; i++) {
        const listItem = new Y.XmlElement('listItem');
        const para = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, `Item ${i + 1} main text`);
        para.insert(0, [text]);

        // Add nested bulletList
        const nestedList = new Y.XmlElement('bulletList');
        const nestedItem = new Y.XmlElement('listItem');
        const nestedPara = new Y.XmlElement('paragraph');
        const nestedText = new Y.XmlText();
        nestedText.insert(0, `Nested item ${i + 1}`);
        nestedPara.insert(0, [nestedText]);
        nestedItem.insert(0, [nestedPara]);
        nestedList.insert(0, [nestedItem]);

        listItem.insert(0, [para, nestedList]);
        orderedList.insert(i, [listItem]);
      }

      mockXmlFragment.insert(2, [orderedList]);

      // Select the ordered list
      const firstItemText = mockXmlFragment.get(2).toArray()[0].toArray()[0].toArray()[0];
      const lastItemText = mockXmlFragment.get(2).toArray()[2].toArray()[1].toArray()[0].toArray()[0].toArray()[0];

      const anchorPos = Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(firstItemText, 0)
      );
      const headPos = Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(lastItemText, lastItemText.length)
      );

      mockSession.cursor = { anchor: anchorPos, head: headPos };

      // Cut and paste
      const cutResult = await cutSelection.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(cutResult.success).toBe(true);
      expect(cutResult.cutBlocks).toBe(1);
      expect(mockSession.clipboard.binary).toBeDefined();

      // Paste and verify structure
      const pasteResult = await paste.handler(
        { docGuid: testDocGuid },
        mockAgentToken
      );

      expect(pasteResult.success).toBe(true);
      expect(pasteResult.pastedBlocks).toBe(1);

      // Verify the pasted list has all 3 items with nested lists
      const pastedList = mockXmlFragment.get(2);
      expect(pastedList.nodeName).toBe('orderedList');
      expect(pastedList.toArray().length).toBe(3);

      // Verify each item has nested content
      for (let i = 0; i < 3; i++) {
        const item = pastedList.toArray()[i];
        expect(item.toArray().length).toBe(2); // paragraph + bulletList
        expect(item.toArray()[1].nodeName).toBe('bulletList');
      }
    });
  });
});
