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
      expect(result.current.selection).toBeNull();
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

  // Feature 041 US2 (FR-005/FR-006): the two failure channels are independent,
  // and the timeline load is retryable.
  describe('041: error vs diffError independence and retry', () => {
    it('a timeline failure sets error only, and leaves diffError alone', async () => {
      mockApi.get.mockRejectedValue({ response: { data: { error: 'history boom' } } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => expect(result.current.error).toBe('history boom'));
      expect(result.current.diffError).toBeNull();
      expect(result.current.versions).toEqual([]);
    });

    it('a preview failure does not blank the already-loaded timeline', async () => {
      const versions = [{ id: 'v1', timestamp: new Date().toISOString(), clockStart: 1, clockEnd: 5, authors: [] }];
      mockApi.get
        .mockResolvedValueOnce({ data: { versions, totalEdits: 5 } })
        .mockRejectedValueOnce({ response: { data: { error: 'diff boom' } } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => {
        await result.current.selectVersion(versions[0]);
      });

      expect(result.current.diffError).toBe('diff boom');
      expect(result.current.error).toBeNull();
      expect(result.current.versions).toHaveLength(1);
    });

    it('selecting a new version clears a previous preview failure', async () => {
      const good = { document: 'ok', meta: { currentClock: 20 } };
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: [], totalEdits: 0 } })
        .mockRejectedValueOnce({ response: { data: { error: 'diff boom' } } })
        .mockResolvedValueOnce({ data: good });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.selectVersion({ id: 'v1', clockStart: 5, clockEnd: 10 });
      });
      expect(result.current.diffError).toBe('diff boom');

      await act(async () => {
        await result.current.selectVersion({ id: 'v2', clockStart: 15, clockEnd: 20 });
      });
      expect(result.current.diffError).toBeNull();
      expect(result.current.diffData).toEqual(good);
    });

    it('fetchHistory is a working retry: it clears the error and repopulates the list', async () => {
      const versions = [{ id: 'v1', timestamp: new Date().toISOString(), authors: [] }];
      mockApi.get
        .mockRejectedValueOnce({ response: { data: { error: 'history boom' } } })
        .mockResolvedValueOnce({ data: { versions, totalEdits: 3 } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.error).toBe('history boom'));

      await act(async () => {
        await result.current.fetchHistory();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.versions).toEqual(versions);
    });
  });

  describe('selectVersion', () => {
    it('selects a version and loads its diff data', async () => {
      const mockDiffData = {
        // Uses individual updates array to preserve deletion history
        updates: [[1, 2, 3], [4, 5, 6]],
        currentSnapshot: [7, 8, 9],
        previousSnapshot: [10, 11, 12],
        textIdentical: false,
      };
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: [], totalEdits: 0 } })
        .mockResolvedValueOnce({ data: mockDiffData });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.selectVersion({ id: 'v1', name: 'Test Version', clockStart: 5, clockEnd: 10 });
      });

      expect(result.current.selection).toEqual({ id: 'v1', name: 'Test Version', clockStart: 5, clockEnd: 10 });
      // Now uses the diff API that returns individual updates with snapshots
      expect(mockApi.get).toHaveBeenCalledWith('/api/docs/doc-123/history/diff?currentClock=10&previousClock=4');
    });

    it('ignores an out-of-order diff response so the latest selection wins (F4)', async () => {
      const diffA = { document: 'A', meta: { currentClock: 10 } };
      const diffB = { document: 'B', meta: { currentClock: 20 } };
      let resolveA;
      let resolveB;

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: [], totalEdits: 0 } }) // initial history
        .mockImplementationOnce(() => new Promise((r) => { resolveA = () => r({ data: diffA }); }))
        .mockImplementationOnce(() => new Promise((r) => { resolveB = () => r({ data: diffB }); }));

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let pA;
      let pB;
      act(() => {
        pA = result.current.selectVersion({ id: 'vA', clockStart: 5, clockEnd: 10 });
        pB = result.current.selectVersion({ id: 'vB', clockStart: 15, clockEnd: 20 });
      });

      // Newer selection (B) resolves first, then the slower older one (A).
      await act(async () => { resolveB(); await pB; });
      await act(async () => { resolveA(); await pA; });

      // The stale A response must NOT clobber B's preview.
      expect(result.current.diffData).toEqual(diffB);
    });

    it('sets diffError and clears diffData on a diff fetch failure (F4; 041 FR-006)', async () => {
      const goodDiff = { document: 'ok', meta: { currentClock: 10 } };
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: [], totalEdits: 0 } }) // initial history
        .mockResolvedValueOnce({ data: goodDiff }) // first selection succeeds
        .mockRejectedValueOnce({ response: { data: { error: 'diff boom' } } }); // second fails

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.selectVersion({ id: 'v1', clockStart: 5, clockEnd: 10 });
      });
      expect(result.current.diffData).toEqual(goodDiff);

      await act(async () => {
        await result.current.selectVersion({ id: 'v2', clockStart: 15, clockEnd: 20 });
      });

      // No stale preview retained; the failure lands on the PREVIEW channel.
      expect(result.current.diffData).toBeNull();
      expect(result.current.diffError).toBe('diff boom');
      // ...and never blanks the timeline (041 FR-005/FR-006 are independent).
      expect(result.current.error).toBeNull();
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

      expect(result.current.selection).toBeNull();
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

  describe('groupedVersions', () => {
    it('groups versions by month', async () => {
      // Use dates from two different months
      const jan2025 = new Date('2025-01-15T10:00:00Z');
      const dec2024 = new Date('2024-12-15T10:00:00Z');

      const mockVersions = [
        { id: 'v1', timestamp: jan2025.toISOString(), authors: [] },
        { id: 'v2', timestamp: dec2024.toISOString(), authors: [] },
      ];

      // Clear any previous mocks and set up fresh
      mockApi.get.mockReset();
      mockApi.get.mockResolvedValue({
        data: { versions: mockVersions, totalEdits: 2 },
      });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.versions.length).toBe(2);
      });

      // Should have month-based groups
      const labels = result.current.groupedVersions.map((g) => g.label);
      expect(labels).toContain('January 2025');
      expect(labels).toContain('December 2024');
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

  describe('versionUpdates cache', () => {
    it('clears versionUpdates cache when createNamedVersion refreshes history', async () => {
      // This tests the fix for the bug where naming a clock would leave stale
      // cached updates, causing the UI to show wrong clock ranges
      const mockUpdates = [
        { clock: 57, timestamp: '2025-01-01T10:00:00Z', author: { id: 'u1', name: 'Alice' } },
        { clock: 58, timestamp: '2025-01-01T10:01:00Z', author: { id: 'u1', name: 'Alice' } },
        { clock: 59, timestamp: '2025-01-01T10:02:00Z', author: { id: 'u1', name: 'Alice' } },
        { clock: 60, timestamp: '2025-01-01T10:03:00Z', author: { id: 'u1', name: 'Alice' } },
      ];

      // Before: one auto version 57-60. After naming clock 59: a named version
      // 57-59 plus a 60-60 fragment — the structural change that invalidates
      // the drill-down cache (feature 041 keeps the cache when the structure is
      // unchanged, so the payloads here must be realistic).
      const before = [{ id: 'auto-60', name: null, clockStart: 57, clockEnd: 60, timestamp: '2025-01-01T10:03:00Z', isCurrent: true }];
      const after = [
        { id: '60', name: null, clockStart: 60, clockEnd: 60, timestamp: '2025-01-01T10:03:00Z', isCurrent: true },
        { id: 'new-v1', name: 'Named Version', clockStart: 57, clockEnd: 59, timestamp: '2025-01-01T10:02:00Z', isCurrent: false },
      ];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 4 } }) // Initial fetch
        .mockResolvedValueOnce({ data: { updates: mockUpdates } }) // Load updates for version
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 4 } }); // Refresh after naming

      mockApi.post.mockResolvedValue({
        data: { version: { id: 'new-v1', name: 'Named Version' } },
      });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Load updates for a version (this caches them in versionUpdates)
      await act(async () => {
        await result.current.loadUpdatesForVersion(57, 60, 'auto-60');
      });

      // Verify updates are cached
      expect(result.current.versionUpdates['auto-60']).toEqual(mockUpdates);

      // Now create a named version - this should clear the cache
      await act(async () => {
        await result.current.createNamedVersion('Named Version', 59);
      });

      // The cache should be cleared
      expect(result.current.versionUpdates).toEqual({});
    });

    it('clears versionUpdates cache when refresh is called', async () => {
      const mockUpdates = [
        { clock: 1, timestamp: '2025-01-01T10:00:00Z', author: null },
      ];

      const before = [{ id: 'auto-1', name: null, clockStart: 1, clockEnd: 1, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];
      const after = [{ id: 'auto-2', name: null, clockStart: 1, clockEnd: 2, timestamp: '2025-01-01T10:05:00Z', isCurrent: true }];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 1 } }) // Initial fetch
        .mockResolvedValueOnce({ data: { updates: mockUpdates } }) // Load updates
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 2 } }); // Manual refresh

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Load updates for a version
      await act(async () => {
        await result.current.loadUpdatesForVersion(1, 1, 'auto-1');
      });

      expect(result.current.versionUpdates['auto-1']).toEqual(mockUpdates);

      // Refresh history - the structure moved, so the cache must be cleared
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.versionUpdates).toEqual({});
    });

    it('041: a refresh that returns the SAME structure keeps the cache (no per-tick wipe)', async () => {
      const versions = [{ id: 'auto-1', name: null, clockStart: 1, clockEnd: 1, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];
      const mockUpdates = [{ clock: 1, timestamp: '2025-01-01T10:00:00Z', author: null }];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions, totalEdits: 1 } })
        .mockResolvedValueOnce({ data: { updates: mockUpdates } })
        .mockResolvedValueOnce({ data: { versions, totalEdits: 1 } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.loadUpdatesForVersion(1, 1, 'auto-1');
      });
      expect(result.current.versionUpdates['auto-1']).toEqual(mockUpdates);

      await act(async () => {
        await result.current.refresh();
      });

      // An idle refresh must not blank an expanded row's contents.
      expect(result.current.versionUpdates['auto-1']).toEqual(mockUpdates);
    });
  });

  // ── Feature 041 US3 ────────────────────────────────────────────────────────
  describe('041 FR-008: live-refresh poll', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls the history endpoint on a 10s cadence while open', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });

      renderHook(() => useVersionHistory('doc-123'));
      await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(1));

      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(mockApi.get).toHaveBeenCalledTimes(2);

      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(mockApi.get).toHaveBeenCalledTimes(3);
    });

    it('skips ticks while the tab is hidden', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });

      renderHook(() => useVersionHistory('doc-123'));
      await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(1));

      const spy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(mockApi.get).toHaveBeenCalledTimes(1);

      spy.mockReturnValue(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(mockApi.get).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it('stops polling once the panel closes (docGuid goes away)', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });

      const { unmount } = renderHook(() => useVersionHistory('doc-123'));
      await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(1));

      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(mockApi.get).toHaveBeenCalledTimes(1);
    });

    it('a failed tick keeps the last-good list and surfaces the error', async () => {
      const versions = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];
      mockApi.get
        .mockResolvedValueOnce({ data: { versions, totalEdits: 5 } })
        .mockRejectedValueOnce({ response: { data: { error: 'poll boom' } } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await vi.waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });

      expect(result.current.error).toBe('poll boom');
      expect(result.current.versions).toEqual(versions);
      // A background tick never flips the loading flag — that would tear the
      // rendered list down and take scroll/expansions with it.
      expect(result.current.isLoading).toBe(false);
    });
  });

  // ── Review M3: the timeline applies only the freshest response ────────────
  // fetchHistory runs from three places at once (mount, the 10 s poll, and every
  // CRUD action's refresh), so a slow poll could land AFTER a fresher refresh
  // and overwrite the newer list with a pre-rename one — a stale world for up to
  // a full poll interval, a second cache wipe, and a selection reconciled
  // against history that no longer exists. Mirrors the F4 diff-race guard.
  describe('review M3: out-of-order history responses', () => {
    it('discards a slow poll response that lands after a fresher refresh', async () => {
      const stale = [{ id: 'v-old', name: null, clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];
      const fresh = [{ id: 'v-new', name: 'Draft', clockStart: 1, clockEnd: 6, timestamp: '2025-01-01T10:01:00Z', isCurrent: true }];

      let resolvePoll;
      let resolveRefresh;
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: [], totalEdits: 0 } }) // mount
        .mockImplementationOnce(() => new Promise((r) => { resolvePoll = () => r({ data: { versions: stale, totalEdits: 5 } }); }))
        .mockImplementationOnce(() => new Promise((r) => { resolveRefresh = () => r({ data: { versions: fresh, totalEdits: 6 } }); }));

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let pPoll;
      let pRefresh;
      act(() => {
        pPoll = result.current.fetchHistory({ background: true });
        pRefresh = result.current.refresh();
      });

      // The newer refresh answers first; the slow poll answers second.
      await act(async () => { resolveRefresh(); await pRefresh; });
      await act(async () => { resolvePoll(); await pPoll; });

      expect(result.current.versions).toEqual(fresh);
      expect(result.current.totalEdits).toBe(6);
      expect(result.current.isLoading).toBe(false);
    });

    it('discards a stale FAILURE so it cannot alarm over a fresher good list', async () => {
      const fresh = [{ id: 'v-new', name: null, clockStart: 1, clockEnd: 6, timestamp: '2025-01-01T10:01:00Z', isCurrent: true }];

      let rejectPoll;
      let resolveRefresh;
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: [], totalEdits: 0 } }) // mount
        .mockImplementationOnce(() => new Promise((_r, rej) => { rejectPoll = () => rej({ response: { data: { error: 'poll boom' } } }); }))
        .mockImplementationOnce(() => new Promise((r) => { resolveRefresh = () => r({ data: { versions: fresh, totalEdits: 6 } }); }));

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let pPoll;
      let pRefresh;
      act(() => {
        pPoll = result.current.fetchHistory({ background: true });
        pRefresh = result.current.refresh();
      });

      await act(async () => { resolveRefresh(); await pRefresh; });
      await act(async () => { rejectPoll(); await pPoll; });

      expect(result.current.versions).toEqual(fresh);
      expect(result.current.error).toBeNull();
    });
  });

  // ── Review L1: drill-down failures stay off the panel's error channel ─────
  // They used to call setError, so one failed expanded row rendered "Couldn't
  // load version history." + Retry over a perfectly healthy timeline.
  describe('review L1: per-row drill-down failures', () => {
    it('records the failure against the version, and leaves the timeline error alone', async () => {
      const versions = [{ id: 'auto-1', name: null, clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];
      mockApi.get
        .mockResolvedValueOnce({ data: { versions, totalEdits: 5 } })
        .mockRejectedValueOnce({ response: { data: { error: 'updates boom' } } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      let updates;
      await act(async () => {
        updates = await result.current.loadUpdatesForVersion(1, 5, 'auto-1');
      });

      expect(updates).toBeNull();
      expect(result.current.versionUpdatesError['auto-1']).toBe('updates boom');
      expect(result.current.error).toBeNull();
      expect(result.current.versions).toEqual(versions); // timeline untouched
    });

    it('clears the row failure when the row is requested again', async () => {
      const versions = [{ id: 'auto-1', name: null, clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];
      const updates = [{ id: '5', clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z' }];
      mockApi.get
        .mockResolvedValueOnce({ data: { versions, totalEdits: 5 } })
        .mockRejectedValueOnce({ response: { data: { error: 'updates boom' } } })
        .mockResolvedValueOnce({ data: { updates } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.loadUpdatesForVersion(1, 5, 'auto-1'); });
      expect(result.current.versionUpdatesError['auto-1']).toBe('updates boom');

      await act(async () => { await result.current.loadUpdatesForVersion(1, 5, 'auto-1'); });
      expect(result.current.versionUpdatesError['auto-1']).toBeUndefined();
      expect(result.current.versionUpdates['auto-1']).toEqual(updates);
    });

  });

  describe('041 FR-007: selection reconciliation after every refresh', () => {
    const diffOk = { data: { document: 'doc', meta: {} } };

    it('re-resolves the selection to the post-split version containing its clockEnd', async () => {
      const before = [{ id: '60', name: null, clockStart: 57, clockEnd: 60, timestamp: '2025-01-01T10:03:00Z', isCurrent: true }];
      const after = [
        { id: '60', name: null, clockStart: 60, clockEnd: 60, timestamp: '2025-01-01T10:03:00Z', isCurrent: true },
        { id: 'named-uuid', name: 'Draft', clockStart: 57, clockEnd: 59, timestamp: '2025-01-01T10:02:00Z', isCurrent: false },
      ];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 4 } })
        .mockResolvedValueOnce(diffOk)               // select 57-60
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 4 } })
        .mockResolvedValue(diffOk);                  // any reconcile-driven refetch

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.selectVersion(before[0]); });
      expect(result.current.selection.id).toBe('60');
      expect(result.current.selection.clockStart).toBe(57);

      await act(async () => { await result.current.refresh(); });

      // The old 57-60 range no longer exists. clockEnd 60 now lives in the
      // 60-60 fragment, and the selection must be that POST-split object —
      // which is the id the header restore button posts.
      await waitFor(() => expect(result.current.selection.clockStart).toBe(60));
      expect(result.current.selection.id).toBe('60');
      expect(after.some(v => v.id === result.current.selection.id)).toBe(true);
    });

    it('adopts a renamed version without re-fetching an identical preview', async () => {
      const before = [{ id: 'nv', name: 'Old name', clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];
      const after = [{ id: 'nv', name: 'New name', clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 5 } })
        .mockResolvedValueOnce(diffOk)
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 5 } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.selectVersion(before[0]); });
      const callsAfterSelect = mockApi.get.mock.calls.length;

      await act(async () => { await result.current.refresh(); });
      await waitFor(() => expect(result.current.selection.name).toBe('New name'));

      // One extra call: the refresh itself. No diff re-fetch — same range.
      expect(mockApi.get.mock.calls.length).toBe(callsAfterSelect + 1);
    });

    it('never keeps a deleted selection: it falls back to the current version', async () => {
      const before = [
        { id: 'gone', name: 'Doomed', clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z', isCurrent: false },
        { id: '10', name: null, clockStart: 6, clockEnd: 10, timestamp: '2025-01-01T10:05:00Z', isCurrent: true },
      ];
      const after = [
        { id: '10', name: null, clockStart: 6, clockEnd: 10, timestamp: '2025-01-01T10:05:00Z', isCurrent: true },
      ];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 10 } })
        .mockResolvedValueOnce(diffOk)
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 10 } })
        .mockResolvedValue(diffOk);

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(2));

      await act(async () => { await result.current.selectVersion(before[0]); });
      expect(result.current.selection.id).toBe('gone');

      await act(async () => { await result.current.refresh(); });

      await waitFor(() => expect(result.current.selection.id).toBe('10'));
      expect(result.current.selection.isCurrent).toBe(true);
    });

    it('clears the selection when the refreshed list is empty', async () => {
      const before = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 5 } })
        .mockResolvedValueOnce(diffOk)
        .mockResolvedValueOnce({ data: { versions: [], totalEdits: 0 } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.selectVersion(before[0]); });
      await act(async () => { await result.current.refresh(); });

      await waitFor(() => expect(result.current.selection).toBeNull());
      expect(result.current.diffData).toBeNull();
    });
  });
});
