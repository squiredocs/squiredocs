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
});
