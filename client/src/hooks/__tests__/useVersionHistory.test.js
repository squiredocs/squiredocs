import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useVersionHistory } from '../useVersionHistory';

// Mock the AuthContext
const mockApi = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    api: mockApi,
  }),
}));

describe('useVersionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns initial state with empty versions', () => {
      const { result } = renderHook(() => useVersionHistory(null));

      expect(result.current.versions).toEqual([]);
      expect(result.current.groupedVersions).toEqual([]);
      expect(result.current.totalEdits).toBe(0);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.selectedVersion).toBeNull();
      expect(result.current.versionContent).toBeNull();
    });

    it('does not fetch when docGuid is null', () => {
      renderHook(() => useVersionHistory(null));

      expect(mockApi.get).not.toHaveBeenCalled();
    });
  });

  describe('fetchHistory', () => {
    it('fetches version history when docGuid is provided', async () => {
      const mockVersions = [
        { id: 'v1', timestamp: new Date().toISOString(), authors: [] },
      ];
      mockApi.get.mockResolvedValue({
        data: { versions: mockVersions, totalEdits: 5 },
      });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.versions).toEqual(mockVersions);
      });

      expect(mockApi.get).toHaveBeenCalledWith('/api/docs/doc-123/history');
      expect(result.current.totalEdits).toBe(5);
    });

    it('sets loading state during fetch', async () => {
      let resolvePromise;
      mockApi.get.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePromise = () => resolve({ data: { versions: [], totalEdits: 0 } });
          })
      );

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      // Should be loading initially
      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      // Resolve the promise
      await act(async () => {
        resolvePromise();
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('handles fetch errors', async () => {
      mockApi.get.mockRejectedValue({
        response: { data: { error: 'Failed to load' } },
      });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load');
      });

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('selectVersion', () => {
    it('selects a version and loads its content', async () => {
      const mockContent = {
        content: [1, 2, 3],
        version: { id: 'v1', name: 'Test Version' },
      };
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: [], totalEdits: 0 } })
        .mockResolvedValueOnce({ data: mockContent });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.selectVersion({ id: 'v1', name: 'Test Version' });
      });

      expect(result.current.selectedVersion).toEqual({ id: 'v1', name: 'Test Version' });
      expect(mockApi.get).toHaveBeenCalledWith('/api/docs/doc-123/versions/v1');
    });

    it('clears content when selecting null', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.selectVersion(null);
      });

      expect(result.current.selectedVersion).toBeNull();
      expect(result.current.versionContent).toBeNull();
    });
  });

  describe('restoreVersion', () => {
    it('restores a version and refreshes history', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });
      mockApi.post.mockResolvedValue({ data: { success: true } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let success;
      await act(async () => {
        success = await result.current.restoreVersion('v1');
      });

      expect(success).toBe(true);
      expect(mockApi.post).toHaveBeenCalledWith('/api/docs/doc-123/restore', {
        versionId: 'v1',
      });
    });

    it('returns false on restore failure', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });
      mockApi.post.mockRejectedValue({
        response: { data: { error: 'Restore failed' } },
      });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let success;
      await act(async () => {
        success = await result.current.restoreVersion('v1');
      });

      expect(success).toBe(false);
      expect(result.current.error).toBe('Restore failed');
    });
  });

  describe('clearSelection', () => {
    it('clears selected version and content', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // First set a selection
      await act(async () => {
        result.current.setSelectedVersion({ id: 'v1' });
      });

      expect(result.current.selectedVersion).toEqual({ id: 'v1' });

      // Clear it
      act(() => {
        result.current.clearSelection();
      });

      expect(result.current.selectedVersion).toBeNull();
      expect(result.current.versionContent).toBeNull();
    });
  });

  describe('groupedVersions', () => {
    it('groups versions by time period', async () => {
      const today = new Date();
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

      const mockVersions = [
        { id: 'v1', timestamp: today.toISOString(), authors: [] },
        { id: 'v2', timestamp: yesterday.toISOString(), authors: [] },
      ];

      mockApi.get.mockResolvedValue({
        data: { versions: mockVersions, totalEdits: 2 },
      });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.groupedVersions.length).toBeGreaterThan(0);
      });

      // Should have Today and Yesterday groups
      const labels = result.current.groupedVersions.map((g) => g.label);
      expect(labels).toContain('Today');
      expect(labels).toContain('Yesterday');
    });

    it('returns empty array when no versions', () => {
      const { result } = renderHook(() => useVersionHistory(null));

      expect(result.current.groupedVersions).toEqual([]);
    });
  });

  describe('createNamedVersion', () => {
    it('creates a named version', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });
      mockApi.post.mockResolvedValue({
        data: { version: { id: 'new-v1', name: 'My Version' } },
      });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let version;
      await act(async () => {
        version = await result.current.createNamedVersion('My Version');
      });

      expect(version).toEqual({ id: 'new-v1', name: 'My Version' });
      expect(mockApi.post).toHaveBeenCalledWith('/api/docs/doc-123/versions', {
        name: 'My Version',
      });
    });

    it('includes clockEnd when provided', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });
      mockApi.post.mockResolvedValue({
        data: { version: { id: 'new-v1', name: 'My Version' } },
      });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.createNamedVersion('My Version', 42);
      });

      expect(mockApi.post).toHaveBeenCalledWith('/api/docs/doc-123/versions', {
        name: 'My Version',
        clockEnd: 42,
      });
    });
  });

  describe('renameVersion', () => {
    it('renames a version', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });
      mockApi.put.mockResolvedValue({ data: { success: true } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let success;
      await act(async () => {
        success = await result.current.renameVersion('v1', 'New Name');
      });

      expect(success).toBe(true);
      expect(mockApi.put).toHaveBeenCalledWith('/api/docs/doc-123/versions/v1', {
        name: 'New Name',
      });
    });
  });

  describe('deleteNamedVersion', () => {
    it('deletes a named version', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });
      mockApi.delete.mockResolvedValue({ data: { success: true } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let success;
      await act(async () => {
        success = await result.current.deleteNamedVersion('v1');
      });

      expect(success).toBe(true);
      expect(mockApi.delete).toHaveBeenCalledWith('/api/docs/doc-123/versions/v1');
    });
  });
});
