/**
 * Tests for set_document_version_name MCP tool
 */

const tool = require('../../tools/set-document-version-name');
const versionHistory = require('../../../version-history');

// Mock dependencies
jest.mock('../../../version-history');

describe('set_document_version_name', () => {
  let mockPersistence;
  let mockPool;
  let mockAgentToken;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    };

    mockPersistence = {
      getPool: () => mockPool,
      getVersionById: jest.fn(),
      createNamedVersion: jest.fn(),
      updateVersionName: jest.fn(),
      deleteNamedVersion: jest.fn(),
    };

    mockAgentToken = {
      userId: 'user-123',
    };

    tool.init(mockPersistence);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('CREATE mode (no versionId)', () => {
    beforeEach(() => {
      mockPool.query.mockResolvedValue({
        rows: [{ role: 'editor' }],
      });

      versionHistory.getVersionTimeline.mockResolvedValue({
        versions: [
          { clockStart: 0, clockEnd: 10 },
        ],
      });

      mockPersistence.createNamedVersion.mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Draft 1',
        clock_start: 0,
        clock_end: 10,
        created_at: '2024-01-01T00:00:00Z',
      });
    });

    test('creates new version from current state', async () => {
      const result = await tool.handler(
        { docGuid: 'doc-123', name: 'Draft 1' },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
      expect(result.version.name).toBe('Draft 1');
      expect(result.message).toBe('Version "Draft 1" created successfully');
      expect(mockPersistence.createNamedVersion).toHaveBeenCalledWith(
        'doc-123',
        0,
        10,
        'Draft 1',
        'user-123'
      );
    });

    test('trims whitespace from name', async () => {
      await tool.handler(
        { docGuid: 'doc-123', name: '  Draft 1  ' },
        mockAgentToken
      );

      expect(mockPersistence.createNamedVersion).toHaveBeenCalledWith(
        'doc-123',
        0,
        10,
        'Draft 1',
        'user-123'
      );
    });

    test('throws error for empty name', async () => {
      await expect(
        tool.handler({ docGuid: 'doc-123', name: '' }, mockAgentToken)
      ).rejects.toThrow('Version name cannot be empty');
    });

    test('throws error for whitespace-only name', async () => {
      await expect(
        tool.handler({ docGuid: 'doc-123', name: '   ' }, mockAgentToken)
      ).rejects.toThrow('Version name cannot be empty');
    });

    test('throws error for name too long', async () => {
      const longName = 'a'.repeat(256);
      await expect(
        tool.handler({ docGuid: 'doc-123', name: longName }, mockAgentToken)
      ).rejects.toThrow('Version name cannot exceed 255 characters');
    });

    test('throws error for name: null', async () => {
      await expect(
        tool.handler({ docGuid: 'doc-123', name: null }, mockAgentToken)
      ).rejects.toThrow('Cannot create unnamed version');
    });

    test('throws error for document with no history', async () => {
      versionHistory.getVersionTimeline.mockResolvedValue({ versions: [] });

      await expect(
        tool.handler({ docGuid: 'doc-123', name: 'Draft 1' }, mockAgentToken)
      ).rejects.toThrow('Cannot create version: document has no edit history');
    });

    test('throws error for viewer role', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ role: 'viewer' }],
      });

      await expect(
        tool.handler({ docGuid: 'doc-123', name: 'Draft 1' }, mockAgentToken)
      ).rejects.toThrow('Permission denied: viewers cannot manage document versions');
    });

    test('throws error for document not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(
        tool.handler({ docGuid: 'doc-123', name: 'Draft 1' }, mockAgentToken)
      ).rejects.toThrow('Document not found or you do not have access');
    });
  });

  describe('UPDATE mode (versionId + name)', () => {
    beforeEach(() => {
      mockPool.query.mockResolvedValue({
        rows: [{ role: 'editor' }],
      });

      mockPersistence.getVersionById.mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        doc_id: 'doc-123',
        name: 'Draft 1',
        clock_start: 0,
        clock_end: 10,
      });

      mockPersistence.updateVersionName.mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Final',
        clock_start: 0,
        clock_end: 10,
        created_at: '2024-01-01T00:00:00Z',
      });
    });

    test('updates existing named version', async () => {
      const result = await tool.handler(
        { docGuid: 'doc-123', versionId: '550e8400-e29b-41d4-a716-446655440000', name: 'Final' },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.updated).toBe(true);
      expect(result.version.name).toBe('Final');
      expect(result.message).toBe('Version renamed to "Final"');
      expect(mockPersistence.updateVersionName).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000', 'Final');
    });

    test('throws error for empty name', async () => {
      await expect(
        tool.handler({ docGuid: 'doc-123', versionId: '550e8400-e29b-41d4-a716-446655440000', name: '' }, mockAgentToken)
      ).rejects.toThrow('Version name cannot be empty');
    });

    test('throws error for name too long', async () => {
      const longName = 'a'.repeat(256);
      await expect(
        tool.handler({ docGuid: 'doc-123', versionId: '550e8400-e29b-41d4-a716-446655440000', name: longName }, mockAgentToken)
      ).rejects.toThrow('Version name cannot exceed 255 characters');
    });

    test('throws error for version not found', async () => {
      mockPersistence.getVersionById.mockResolvedValue(null);

      await expect(
        tool.handler({ docGuid: 'doc-123', versionId: '550e8400-e29b-41d4-a716-446655440000', name: 'Final' }, mockAgentToken)
      ).rejects.toThrow('Version not found');
    });

    test('throws error for version from different document', async () => {
      mockPersistence.getVersionById.mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        doc_id: 'different-doc',
        name: 'Draft 1',
      });

      await expect(
        tool.handler({ docGuid: 'doc-123', versionId: '550e8400-e29b-41d4-a716-446655440000', name: 'Final' }, mockAgentToken)
      ).rejects.toThrow('Version not found');
    });

    test('throws error for auto-version (not UUID)', async () => {
      await expect(
        tool.handler({ docGuid: 'doc-123', versionId: 'not-a-uuid', name: 'Final' }, mockAgentToken)
      ).rejects.toThrow('Cannot modify auto-generated versions');
    });

    test('throws error for viewer role', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ role: 'viewer' }],
      });

      await expect(
        tool.handler({ docGuid: 'doc-123', versionId: '550e8400-e29b-41d4-a716-446655440000', name: 'Final' }, mockAgentToken)
      ).rejects.toThrow('Permission denied: viewers cannot manage document versions');
    });
  });

  describe('DELETE mode (versionId + name: null)', () => {
    beforeEach(() => {
      mockPool.query.mockResolvedValue({
        rows: [{ role: 'editor' }],
      });

      mockPersistence.getVersionById.mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        doc_id: 'doc-123',
        name: 'Draft 1',
        clock_start: 0,
        clock_end: 10,
      });

      mockPersistence.deleteNamedVersion.mockResolvedValue(true);
    });

    test('deletes named version successfully', async () => {
      const result = await tool.handler(
        { docGuid: 'doc-123', versionId: '550e8400-e29b-41d4-a716-446655440000', name: null },
        mockAgentToken
      );

      expect(result.success).toBe(true);
      expect(result.deleted).toBe(true);
      expect(result.message).toBe('Named version removed from timeline');
      expect(result.version).toBeUndefined();
      expect(mockPersistence.deleteNamedVersion).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000');
    });

    test('throws error for version not found', async () => {
      mockPersistence.getVersionById.mockResolvedValue(null);

      await expect(
        tool.handler({ docGuid: 'doc-123', versionId: '550e8400-e29b-41d4-a716-446655440000', name: null }, mockAgentToken)
      ).rejects.toThrow('Version not found');
    });

    test('throws error for auto-version (not UUID)', async () => {
      await expect(
        tool.handler({ docGuid: 'doc-123', versionId: 'not-a-uuid', name: null }, mockAgentToken)
      ).rejects.toThrow('Cannot modify auto-generated versions');
    });

    test('throws error for viewer role', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ role: 'viewer' }],
      });

      await expect(
        tool.handler({ docGuid: 'doc-123', versionId: '550e8400-e29b-41d4-a716-446655440000', name: null }, mockAgentToken)
      ).rejects.toThrow('Permission denied: viewers cannot manage document versions');
    });

    test('throws error for version from different document', async () => {
      mockPersistence.getVersionById.mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        doc_id: 'different-doc',
        name: 'Draft 1',
      });

      await expect(
        tool.handler({ docGuid: 'doc-123', versionId: '550e8400-e29b-41d4-a716-446655440000', name: null }, mockAgentToken)
      ).rejects.toThrow('Version not found');
    });
  });

  describe('Edge cases', () => {
    test('accepts maximum length name (255 chars)', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ role: 'editor' }],
      });

      versionHistory.getVersionTimeline.mockResolvedValue({
        versions: [{ clockStart: 0, clockEnd: 10 }],
      });

      mockPersistence.createNamedVersion.mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'a'.repeat(255),
        clock_start: 0,
        clock_end: 10,
        created_at: '2024-01-01T00:00:00Z',
      });

      const maxName = 'a'.repeat(255);
      const result = await tool.handler(
        { docGuid: 'doc-123', name: maxName },
        mockAgentToken
      );

      expect(result.success).toBe(true);
    });

    test('allows editor role for all operations', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ role: 'editor' }],
      });

      versionHistory.getVersionTimeline.mockResolvedValue({
        versions: [{ clockStart: 0, clockEnd: 10 }],
      });

      mockPersistence.createNamedVersion.mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Draft',
        clock_start: 0,
        clock_end: 10,
        created_at: '2024-01-01T00:00:00Z',
      });

      const result = await tool.handler(
        { docGuid: 'doc-123', name: 'Draft' },
        mockAgentToken
      );

      expect(result.success).toBe(true);
    });

    test('allows owner role for all operations', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ role: 'owner' }],
      });

      versionHistory.getVersionTimeline.mockResolvedValue({
        versions: [{ clockStart: 0, clockEnd: 10 }],
      });

      mockPersistence.createNamedVersion.mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Draft',
        clock_start: 0,
        clock_end: 10,
        created_at: '2024-01-01T00:00:00Z',
      });

      const result = await tool.handler(
        { docGuid: 'doc-123', name: 'Draft' },
        mockAgentToken
      );

      expect(result.success).toBe(true);
    });
  });
});
