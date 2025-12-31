/**
 * apply_marks Tool Tests
 *
 * Tests for the apply_marks MCP tool, including error handling
 * for invalid/stale positions.
 */
const Y = require('yjs');
const { handler, init } = require('../../tools/apply-marks');
const agentPresence = require('../../agent-presence');

// Mock dependencies
jest.mock('../../agent-presence');

describe('apply_marks tool', () => {
  let mockPersistence;
  let mockPool;
  let mockSession;
  let ydoc;
  let xmlFragment;

  beforeEach(() => {
    // Setup Yjs document
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);

    // Create a simple paragraph for testing
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('Hello world')]);
    xmlFragment.insert(0, [paragraph]);

    // Mock session
    mockSession = {
      provider: { doc: ydoc },
      awareness: {
        setLocalStateField: jest.fn(),
      },
    };

    // Mock database pool
    mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ role: 'editor' }],
      }),
    };

    // Mock persistence provider
    mockPersistence = {
      getPool: () => mockPool,
    };

    // Mock agent presence
    agentPresence.getOrCreateSession = jest.fn().mockResolvedValue(mockSession);

    // Initialize the tool
    init(mockPersistence);
  });

  describe('successful operations', () => {
    test('applies bold mark to text range', async () => {
      const result = await handler(
        {
          docGuid: 'test-guid',
          elementIndex: 0,
          startPosition: 0,
          endPosition: 5,
          addMarks: ['bold'],
        },
        { userId: 'user-123' }
      );

      expect(result.success).toBe(true);
      expect(result.affectedText).toBe('Hello');

      // Verify the formatting was applied
      const element = xmlFragment.get(0);
      const textNode = element.get(0);
      const formatted = textNode.toDelta();
      expect(formatted).toEqual([
        { insert: 'Hello', attributes: { bold: true } },
        { insert: ' world' },
      ]);
    });

    test('applies multiple marks to text range', async () => {
      const result = await handler(
        {
          docGuid: 'test-guid',
          elementIndex: 0,
          startPosition: 0,
          endPosition: 5,
          addMarks: ['bold', 'italic'],
        },
        { userId: 'user-123' }
      );

      expect(result.success).toBe(true);
      expect(result.affectedText).toBe('Hello');

      const element = xmlFragment.get(0);
      const textNode = element.get(0);
      const formatted = textNode.toDelta();
      expect(formatted).toEqual([
        { insert: 'Hello', attributes: { bold: true, italic: true } },
        { insert: ' world' },
      ]);
    });

    test('handles zero-length range (no-op)', async () => {
      const result = await handler(
        {
          docGuid: 'test-guid',
          elementIndex: 0,
          startPosition: 5,
          endPosition: 5,
          addMarks: ['bold'],
        },
        { userId: 'user-123' }
      );

      expect(result.success).toBe(true);
      expect(result.affectedText).toBe('');

      // Verify no formatting was applied
      const element = xmlFragment.get(0);
      const textNode = element.get(0);
      const formatted = textNode.toDelta();
      expect(formatted).toEqual([{ insert: 'Hello world' }]);
    });
  });

  describe('nested list items', () => {
    beforeEach(() => {
      // Clear the fragment and create a list structure
      xmlFragment.delete(0, xmlFragment.length);

      const orderedList = new Y.XmlElement('orderedList');
      orderedList.setAttribute('start', 1);

      const listItem = new Y.XmlElement('listItem');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Fix nut on car door')]);

      listItem.insert(0, [paragraph]);
      orderedList.insert(0, [listItem]);
      xmlFragment.insert(0, [orderedList]);
    });

    test('applies strikethrough to text in nested list item', async () => {
      const result = await handler(
        {
          docGuid: 'test-guid',
          elementIndex: 0,
          startPosition: 0,
          endPosition: 19,
          addMarks: ['strike'],
        },
        { userId: 'user-123' }
      );

      expect(result.success).toBe(true);
      expect(result.affectedText).toBe('Fix nut on car door');

      // Navigate to the text node
      const orderedList = xmlFragment.get(0);
      const listItem = orderedList.get(0);
      const paragraph = listItem.get(0);
      const textNode = paragraph.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([{ insert: 'Fix nut on car door', attributes: { strike: true } }]);
    });
  });

  describe('error handling - invalid positions', () => {
    test('throws error when non-zero range maps to no text', async () => {
      // Try to apply marks to a position range that's beyond the text length
      await expect(
        handler(
          {
            docGuid: 'test-guid',
            elementIndex: 0,
            startPosition: 100,
            endPosition: 120,
            addMarks: ['bold'],
          },
          { userId: 'user-123' }
        )
      ).rejects.toThrow(/Invalid position range/);
    });

    test('error message suggests refreshing positions', async () => {
      await expect(
        handler(
          {
            docGuid: 'test-guid',
            elementIndex: 0,
            startPosition: 100,
            endPosition: 120,
            addMarks: ['bold'],
          },
          { userId: 'user-123' }
        )
      ).rejects.toThrow(/get_document_structure or read_document_blocks/);
    });

    test('throws error for stale positions after document changes', async () => {
      // First, apply bold to the first word
      await handler(
        {
          docGuid: 'test-guid',
          elementIndex: 0,
          startPosition: 0,
          endPosition: 5,
          addMarks: ['bold'],
        },
        { userId: 'user-123' }
      );

      // Now manually change the document by inserting text at the beginning
      const element = xmlFragment.get(0);
      const textNode = element.get(0);
      ydoc.transact(() => {
        textNode.insert(0, 'Prefix ');
      });

      // Try to use the old positions (which are now stale)
      // Position 100-120 is way beyond the actual content
      await expect(
        handler(
          {
            docGuid: 'test-guid',
            elementIndex: 0,
            startPosition: 100,
            endPosition: 120,
            addMarks: ['italic'],
          },
          { userId: 'user-123' }
        )
      ).rejects.toThrow(/Invalid position range/);
    });
  });

  describe('permission checks', () => {
    test('throws error when user has no access', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        handler(
          {
            docGuid: 'test-guid',
            elementIndex: 0,
            startPosition: 0,
            endPosition: 5,
            addMarks: ['bold'],
          },
          { userId: 'user-123' }
        )
      ).rejects.toThrow(/Document not found or you do not have access/);
    });

    test('throws error when user has viewer role', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ role: 'viewer' }],
      });

      await expect(
        handler(
          {
            docGuid: 'test-guid',
            elementIndex: 0,
            startPosition: 0,
            endPosition: 5,
            addMarks: ['bold'],
          },
          { userId: 'user-123' }
        )
      ).rejects.toThrow(/Viewer role cannot apply formatting marks/);
    });
  });

  describe('boundary validation', () => {
    test('throws error when element index out of bounds', async () => {
      await expect(
        handler(
          {
            docGuid: 'test-guid',
            elementIndex: 999,
            startPosition: 0,
            endPosition: 5,
            addMarks: ['bold'],
          },
          { userId: 'user-123' }
        )
      ).rejects.toThrow(/Element index 999 out of bounds/);
    });
  });
});
