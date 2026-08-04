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

    // ── Review 2026-08-03 LOW-4: ONE owner for a restore failure ─────────────
    // Both entry points confirm through useRestoreFlow, whose dialog stays open
    // carrying the failure. Also raising the action-error banner reported the
    // same failure twice, and the banner outlived the modal the user cancelled.
    it('hands a restore failure to the confirm dialog, and raises no banner behind it', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });
      mockApi.post.mockRejectedValue({
        response: { data: { error: 'Restore failed' } },
      });

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // The server's message travels to the dialog, which is the surface with
      // the user's attention.
      await act(async () => {
        await expect(result.current.restoreVersion('v1')).rejects.toThrow('Restore failed');
      });

      expect(result.current.actionError).toBeNull();
      expect(result.current.error).toBeNull();
    });

    // ── Review 2026-08-03 LOW-5: no silent hole ──────────────────────────────
    it('reports a 200 that does not confirm the restore, instead of failing silently', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });
      mockApi.post.mockResolvedValue({ data: {} }); // 200, no `success`

      const { result } = renderHook(() => useVersionHistory('doc-123'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await expect(result.current.restoreVersion('v1'))
          .rejects.toThrow('The server did not confirm the restore.');
      });

      // A restore that did nothing must not read as one that worked: no
      // refresh-and-navigate, no silent `false`.
      expect(mockApi.get).toHaveBeenCalledTimes(1); // the mount fetch only
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
      expect(result.current.versionUpdates['auto-60:57-60']).toEqual(mockUpdates);

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

      expect(result.current.versionUpdates['auto-1:1-1']).toEqual(mockUpdates);

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
      expect(result.current.versionUpdates['auto-1:1-1']).toEqual(mockUpdates);

      await act(async () => {
        await result.current.refresh();
      });

      // An idle refresh must not blank an expanded row's contents.
      expect(result.current.versionUpdates['auto-1:1-1']).toEqual(mockUpdates);
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

    // ── Review 2026-08-03 LOW-7: poll hygiene ───────────────────────────────
    it('skips a tick while the previous poll is still in flight', async () => {
      let resolveSlow;
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: [], totalEdits: 0 } }) // mount
        .mockImplementationOnce(() => new Promise((r) => {
          resolveSlow = () => r({ data: { versions: [], totalEdits: 0 } });
        }))
        .mockResolvedValue({ data: { versions: [], totalEdits: 0 } });

      renderHook(() => useVersionHistory('doc-123'));
      await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(1));

      // First tick goes out and stalls.
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(mockApi.get).toHaveBeenCalledTimes(2);

      // Two further ticks pass while it is still out: no requests stack up.
      await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
      expect(mockApi.get).toHaveBeenCalledTimes(2);

      // Once it answers, the cadence resumes.
      await act(async () => { resolveSlow(); await vi.advanceTimersByTimeAsync(10000); });
      expect(mockApi.get).toHaveBeenCalledTimes(3);
    });

    it('refreshes on the way back to a visible tab, without waiting for the next tick', async () => {
      mockApi.get.mockResolvedValue({ data: { versions: [], totalEdits: 0 } });

      renderHook(() => useVersionHistory('doc-123'));
      await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(1));

      const spy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(mockApi.get).toHaveBeenCalledTimes(1); // three ticks skipped

      // The tab comes back after 30 s away: the panel is stale NOW, not in 10 s.
      spy.mockReturnValue(false);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      expect(mockApi.get).toHaveBeenCalledTimes(2);
      spy.mockRestore();
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
      expect(result.current.versionUpdatesError['auto-1:1-5']).toBe('updates boom');
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
      expect(result.current.versionUpdatesError['auto-1:1-5']).toBe('updates boom');

      await act(async () => { await result.current.loadUpdatesForVersion(1, 5, 'auto-1'); });
      expect(result.current.versionUpdatesError['auto-1:1-5']).toBeUndefined();
      expect(result.current.versionUpdates['auto-1:1-5']).toEqual(updates);
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

    it('keeps an older NAMED version selected when named ranges nest (live E2E HIGH)', async () => {
      // Versions named through the UI all begin at clock 0, so their ranges
      // nest and every one of them contains an older selection's clockEnd.
      // Resolving to the FIRST containing match silently switched the panel to
      // the newest version about two seconds after the user clicked an older
      // one, and re-applied it on every poll so re-clicking never stuck.
      const nested = [
        { id: 'n3', name: 'Draft three', clockStart: 0, clockEnd: 77, timestamp: '2025-01-01T10:03:00Z', isCurrent: true },
        { id: 'n2', name: 'Draft two', clockStart: 0, clockEnd: 47, timestamp: '2025-01-01T10:02:00Z', isCurrent: false },
        { id: 'n1', name: 'Draft one', clockStart: 0, clockEnd: 23, timestamp: '2025-01-01T10:01:00Z', isCurrent: false },
      ];

      // The refresh must return a FRESH array, as the real fetch does — the
      // reconcile effect is keyed on the versions array identity, so reusing
      // the same object makes React bail out and the effect never runs (which
      // would make this test pass against the bug).
      const refreshed = nested.map(v => ({ ...v }));

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: nested, totalEdits: 9 } })
        .mockResolvedValueOnce(diffOk)               // select Draft one
        .mockResolvedValueOnce({ data: { versions: refreshed, totalEdits: 9 } })
        .mockResolvedValue(diffOk);

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(3));

      await act(async () => { await result.current.selectVersion(nested[2]); });
      expect(result.current.selection.id).toBe('n1');

      // The poll must not move the user off the version they chose.
      await act(async () => { await result.current.refresh(); });
      expect(result.current.selection.id).toBe('n1');
      expect(result.current.selection.clockEnd).toBe(23);
    });

    it('still follows the CURRENT version as it grows', async () => {
      // The narrowest-containing rule must not break the case reconciliation
      // exists for: the auto-version the panel selects by default advances as
      // collaborators type, and the preview has to follow it.
      const before = [{ id: '77', name: null, clockStart: 0, clockEnd: 77, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];
      const after = [{ id: '90', name: null, clockStart: 0, clockEnd: 90, timestamp: '2025-01-01T10:01:00Z', isCurrent: true }];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 9 } })
        .mockResolvedValueOnce(diffOk)
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 12 } })
        .mockResolvedValue(diffOk);

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.selectVersion(before[0]); });
      await act(async () => { await result.current.refresh(); });

      await waitFor(() => expect(result.current.selection.clockEnd).toBe(90));
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

  // ── Review 2026-08-03 HIGH-1: a drill-down answer belongs to its RANGE ─────
  // Auto-version ids are String(clockEnd), so naming a version at a clock inside
  // an existing range re-splits it while the id survives. With an id-only cache
  // key, an in-flight /history/updates response for the OLD range landed as the
  // sub-rows — and the AUTHORS — of the range that replaced it, and stayed
  // there: the row could not re-request while its own loading flag was up.
  describe('review HIGH-1: drill-down data is keyed by the range it answers', () => {
    const rows = (name) => [{
      id: '58', clockStart: 58, clockEnd: 58, previousClock: 57,
      timestamp: '2025-01-01T10:01:00Z',
      authors: [{ id: 'u1', name, color: '#112233' }],
      updateCount: 1,
    }];

    it('never applies an in-flight response to a range the version no longer has', async () => {
      const before = [{ id: '60', name: null, clockStart: 57, clockEnd: 60, timestamp: '2025-01-01T10:03:00Z', isCurrent: true }];
      // Someone names clock 59 mid-range: id '60' survives, its range does not.
      const after = [
        { id: '60', name: null, clockStart: 60, clockEnd: 60, timestamp: '2025-01-01T10:03:00Z', isCurrent: true },
        { id: 'named-uuid', name: 'Draft', clockStart: 57, clockEnd: 59, timestamp: '2025-01-01T10:02:00Z', isCurrent: false },
      ];

      let resolveUpdates;
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 4 } })
        .mockImplementationOnce(() => new Promise((r) => {
          resolveUpdates = () => r({ data: { updates: rows('Alice') } });
        }))
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 4 } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      let pending;
      act(() => { pending = result.current.loadUpdatesForVersion(57, 60, '60'); });

      // A poll lands the re-split (and wipes the cache) while the drill-down is
      // still out; only then does the drill-down answer.
      await act(async () => { await result.current.fetchHistory({ background: true }); });
      await act(async () => { resolveUpdates(); await pending; });

      // Nothing the list reads for version '60' (now 60-60) may be the 57-60
      // answer — crediting Alice for edits outside the row would be the worst
      // outcome this panel has.
      expect(result.current.versionUpdates['60']).toBeUndefined();
      expect(result.current.versionUpdates['60:60-60']).toBeUndefined();
      expect(result.current.versionUpdatesMeta['60:60-60']).toBeUndefined();
      // The answer is only ever readable under the range it answered.
      expect(result.current.versionUpdates['60:57-60']).toEqual(rows('Alice'));
    });

    it('lets the row re-fetch its new range: the loading flag is per range, not per id', async () => {
      const before = [{ id: '60', name: null, clockStart: 57, clockEnd: 60, timestamp: '2025-01-01T10:03:00Z', isCurrent: true }];

      let resolveUpdates;
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 4 } })
        .mockImplementationOnce(() => new Promise((r) => {
          resolveUpdates = () => r({ data: { updates: rows('Alice') } });
        }));

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      let pending;
      act(() => { pending = result.current.loadUpdatesForVersion(57, 60, '60'); });

      // The old range is loading; the NEW range is not — which is what lets the
      // list's auto-refetch fire instead of skipping.
      expect(result.current.loadingVersionUpdates['60:57-60']).toBe(true);
      expect(result.current.loadingVersionUpdates['60:60-60']).toBeUndefined();

      await act(async () => { resolveUpdates(); await pending; });
    });

    it('applies only the newest request for a range (a retry mid-flight wins)', async () => {
      const versions = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];
      let resolveFirst;
      let resolveSecond;
      mockApi.get
        .mockResolvedValueOnce({ data: { versions, totalEdits: 5 } })
        .mockImplementationOnce(() => new Promise((r) => { resolveFirst = () => r({ data: { updates: rows('Stale') } }); }))
        .mockImplementationOnce(() => new Promise((r) => { resolveSecond = () => r({ data: { updates: rows('Fresh') } }); }));

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      let first;
      let second;
      act(() => {
        first = result.current.loadUpdatesForVersion(1, 5, 'v1');
        second = result.current.loadUpdatesForVersion(1, 5, 'v1');
      });

      await act(async () => { resolveSecond(); await second; });
      await act(async () => { resolveFirst(); await first; });

      expect(result.current.versionUpdates['v1:1-5']).toEqual(rows('Fresh'));
      // A superseded response is not a failure: it reports neither.
      expect(await first).toBeUndefined();
      expect(result.current.versionUpdatesError['v1:1-5']).toBeUndefined();
    });
  });

  // ── Review 2026-08-03 MED-2: the reconcile refreshes in the background ─────
  // With the current version auto-selected, every poll during live editing grows
  // clockEnd, so the reconcile reselected — in the FOREGROUND, replacing the
  // preview with "Loading version…" and tearing TipTap down every 10 s.
  describe('review MED-2: live reconcile keeps the preview on screen', () => {
    const stamp = '2025-01-01T10:00:00Z';

    it('keeps the last-good preview visible while a moved range re-fetches', async () => {
      const before = [{ id: '5', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true }];
      const after = [{ id: '6', name: null, clockStart: 1, clockEnd: 6, timestamp: stamp, isCurrent: true }];
      const diffA = { document: 'A', meta: { currentClock: 5 } };
      const diffB = { document: 'B', meta: { currentClock: 6 } };

      let resolveB;
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 5 } })
        .mockResolvedValueOnce({ data: diffA })
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 6 } })
        .mockImplementationOnce(() => new Promise((r) => { resolveB = () => r({ data: diffB }); }));

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.selectVersion(before[0]); });
      expect(result.current.diffData).toEqual(diffA);

      await act(async () => { await result.current.fetchHistory({ background: true }); });
      await waitFor(() => expect(result.current.selection.clockEnd).toBe(6));

      // A collaborator typing must not blank the reader's preview.
      expect(result.current.isLoadingContent).toBe(false);
      expect(result.current.diffData).toEqual(diffA);

      await act(async () => { resolveB(); });
      await waitFor(() => expect(result.current.diffData).toEqual(diffB));
    });

    it('keeps the payload identity when the refetched document is unchanged', async () => {
      // `diffData` feeds the preview's editor as a dependency: a new-but-equal
      // object rebuilds TipTap and resets the reader's scroll position.
      const before = [{ id: '5', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true }];
      const after = [{ id: '6', name: null, clockStart: 1, clockEnd: 6, timestamp: stamp, isCurrent: true }];
      const doc = { document: { type: 'doc', content: [] }, meta: { currentClock: 5 } };

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 5 } })
        .mockResolvedValueOnce({ data: doc })
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 6 } })
        .mockResolvedValueOnce({ data: JSON.parse(JSON.stringify(doc)) }); // equal, not identical

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.selectVersion(before[0]); });
      const rendered = result.current.diffData;

      await act(async () => { await result.current.fetchHistory({ background: true }); });
      await waitFor(() => expect(result.current.selection.clockEnd).toBe(6));

      expect(result.current.diffData).toBe(rendered);
    });

    // ── Review 2026-08-03 MED-2 (second round) ───────────────────────────────
    // The background flag reached the loading state but not the catch, so a
    // background refetch that failed destroyed the preview the reader had.
    it('a FAILED background refetch keeps the preview the reader is looking at', async () => {
      const before = [{ id: '5', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true }];
      const after = [{ id: '6', name: null, clockStart: 1, clockEnd: 6, timestamp: stamp, isCurrent: true }];
      const diffA = { document: 'A', meta: { currentClock: 5 } };

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 5 } })
        .mockResolvedValueOnce({ data: diffA })
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 6 } })
        .mockRejectedValueOnce({ response: { status: 429, data: { error: 'Too many requests' } } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.selectVersion(before[0]); });
      expect(result.current.diffData).toEqual(diffA);

      await act(async () => { await result.current.fetchHistory({ background: true }); });
      await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(4));

      // The user did nothing; a collaborator's edit rate-limited a refetch they
      // never asked for. Their preview stays, and the pane shows no error
      // telling them to "select the version again" — it still IS selected.
      expect(result.current.diffData).toEqual(diffA);
      expect(result.current.diffError).toBeNull();
      expect(result.current.selection).not.toBeNull();
    });

    it('a FOREGROUND failure still clears the preview and says so', async () => {
      const versions = [
        { id: '5', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: false },
        { id: '9', name: null, clockStart: 6, clockEnd: 9, timestamp: stamp, isCurrent: true },
      ];
      mockApi.get
        .mockResolvedValueOnce({ data: { versions, totalEdits: 9 } })
        .mockResolvedValueOnce({ data: { document: 'A', meta: {} } })
        .mockRejectedValueOnce({ response: { data: { error: 'diff boom' } } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(2));

      await act(async () => { await result.current.selectVersion(versions[1]); });
      await act(async () => { await result.current.selectVersion(versions[0]); });

      // The user asked for THIS version: showing the previous one's content
      // under its header would be a lie.
      expect(result.current.diffData).toBeNull();
      expect(result.current.diffError).toBe('diff boom');
    });

    it('a user-initiated selection is still foreground (the placeholder is honest there)', async () => {
      const versions = [
        { id: '5', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: false },
        { id: '9', name: null, clockStart: 6, clockEnd: 9, timestamp: stamp, isCurrent: true },
      ];
      let resolveDiff;
      mockApi.get
        .mockResolvedValueOnce({ data: { versions, totalEdits: 9 } })
        .mockImplementationOnce(() => new Promise((r) => { resolveDiff = () => r({ data: { document: 'X', meta: {} } }); }));

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(2));

      let pending;
      act(() => { pending = result.current.selectVersion(versions[0]); });
      expect(result.current.isLoadingContent).toBe(true);

      await act(async () => { resolveDiff(); await pending; });
      expect(result.current.isLoadingContent).toBe(false);
    });
  });

  // ── Review 2026-08-03 MED-3: attribution-only changes propagate ────────────
  // The structural signature deliberately excludes authors (so an idle poll does
  // not wipe the drill-down cache), and `metadataMoved` ignored them too — so a
  // "Synced content" entry that later resolved to a person, or an account
  // deletion collapsing one to "Unknown author", never reached the screen.
  describe('review MED-3: attribution changes reach the preview and the rows', () => {
    const stamp = '2025-01-01T10:00:00Z';
    const synced = [{ id: null, name: 'Synced content', color: '#888888', isSynced: true }];
    const person = [{ id: 'u1', name: 'Ada Lovelace', color: '#112233' }];

    it('adopts an attribution-only change on an unchanged range, with no diff refetch', async () => {
      const before = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true, authors: synced }];
      const after = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true, authors: person }];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 5 } })
        .mockResolvedValueOnce({ data: { document: 'doc', meta: {} } })
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 5 } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.selectVersion(before[0]); });
      expect(result.current.selection.authors[0].name).toBe('Synced content');
      const callsAfterSelect = mockApi.get.mock.calls.length;

      await act(async () => { await result.current.refresh(); });

      // The contributors footer reads the selection, so it must now say the
      // person the server resolved.
      await waitFor(() => expect(result.current.selection.authors[0].name).toBe('Ada Lovelace'));
      // The content did not move: exactly one extra call, the refresh itself.
      expect(mockApi.get.mock.calls.length).toBe(callsAfterSelect + 1);
    });

    it('refreshes cached drill-down rows in the background, without blanking them', async () => {
      const before = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true, authors: synced }];
      const after = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true, authors: person }];
      const staleRows = [{ id: '5', clockStart: 5, clockEnd: 5, timestamp: stamp, authors: synced, updateCount: 1 }];
      const freshRows = [{ id: '5', clockStart: 5, clockEnd: 5, timestamp: stamp, authors: person, updateCount: 1 }];

      let resolveRefreshedRows;
      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 5 } })
        .mockResolvedValueOnce({ data: { updates: staleRows } })
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 5 } })
        .mockImplementationOnce(() => new Promise((r) => {
          resolveRefreshedRows = () => r({ data: { updates: freshRows } });
        }));

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.loadUpdatesForVersion(1, 5, 'v1'); });
      expect(result.current.versionUpdates['v1:1-5']).toEqual(staleRows);

      await act(async () => { await result.current.refresh(); });

      // While the corrected rows are in flight the expanded row keeps showing
      // what it had: no wipe, no spinner over data that is still readable.
      await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(4));
      expect(result.current.versionUpdates['v1:1-5']).toEqual(staleRows);
      expect(result.current.loadingVersionUpdates['v1:1-5']).toBeFalsy();

      await act(async () => { resolveRefreshedRows(); });
      await waitFor(() => expect(result.current.versionUpdates['v1:1-5']).toEqual(freshRows));
    });

    it('a failed background row refresh keeps the last-good rows and raises no row error', async () => {
      const before = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true, authors: synced }];
      const after = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true, authors: person }];
      const staleRows = [{ id: '5', clockStart: 5, clockEnd: 5, timestamp: stamp, authors: synced, updateCount: 1 }];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 5 } })
        .mockResolvedValueOnce({ data: { updates: staleRows } })
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 5 } })
        .mockRejectedValueOnce({ response: { data: { error: 'updates boom' } } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.loadUpdatesForVersion(1, 5, 'v1'); });
      await act(async () => { await result.current.refresh(); });
      await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(4));

      expect(result.current.versionUpdates['v1:1-5']).toEqual(staleRows);
      expect(result.current.versionUpdatesError['v1:1-5']).toBeUndefined();
    });

    it('corrects a selected sub-version\'s footer when its row\'s attribution is corrected', async () => {
      // A sub-version selection is never reconciled against the timeline (the
      // timeline does not contain it), so the corrected row is the only thing
      // that can correct what the footer credits.
      const before = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true, authors: synced }];
      const after = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true, authors: person }];
      const staleRows = [{ id: '5', clockStart: 5, clockEnd: 5, previousClock: 4, timestamp: stamp, authors: synced, updateCount: 1 }];
      const freshRows = [{ id: '5', clockStart: 5, clockEnd: 5, previousClock: 4, timestamp: stamp, authors: person, updateCount: 1 }];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions: before, totalEdits: 5 } })
        .mockResolvedValueOnce({ data: { updates: staleRows } })
        .mockResolvedValueOnce({ data: { document: 'doc', meta: {} } }) // sub-version diff
        .mockResolvedValueOnce({ data: { versions: after, totalEdits: 5 } })
        .mockResolvedValueOnce({ data: { updates: freshRows } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.loadUpdatesForVersion(1, 5, 'v1'); });
      await act(async () => { await result.current.selectUpdate(staleRows[0]); });
      expect(result.current.selection.authors[0].name).toBe('Synced content');

      await act(async () => { await result.current.refresh(); });

      await waitFor(() => expect(result.current.selection.authors[0].name).toBe('Ada Lovelace'));
      expect(result.current.selection.isSubVersion).toBe(true);
    });

    it('an idle poll with unchanged attribution neither refetches rows nor re-adopts the selection', async () => {
      const versions = [{ id: 'v1', name: null, clockStart: 1, clockEnd: 5, timestamp: stamp, isCurrent: true, authors: person }];
      const rows = [{ id: '5', clockStart: 5, clockEnd: 5, timestamp: stamp, authors: person, updateCount: 1 }];

      mockApi.get
        .mockResolvedValueOnce({ data: { versions, totalEdits: 5 } })
        .mockResolvedValueOnce({ data: { updates: rows } })
        .mockResolvedValueOnce({ data: { versions, totalEdits: 5 } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.loadUpdatesForVersion(1, 5, 'v1'); });
      const callsBefore = mockApi.get.mock.calls.length;

      await act(async () => { await result.current.fetchHistory({ background: true }); });

      // One call: the tick. Nothing else moved, so nothing else was requested.
      expect(mockApi.get.mock.calls.length).toBe(callsBefore + 1);
      expect(result.current.versionUpdates['v1:1-5']).toEqual(rows);
    });
  });

  // ── Review 2026-08-03 MED-5: action failures are not load failures ─────────
  // restore/name/rename/delete used to setError, so the panel rendered
  // "Couldn't load version history." with a Retry that refetched the timeline —
  // over a list that had loaded fine — and the next poll cleared it silently.
  describe('review MED-5: the action failure channel', () => {
    const versions = [{ id: 'v1', name: 'Draft', clockStart: 1, clockEnd: 5, timestamp: '2025-01-01T10:00:00Z', isCurrent: true }];

    it('names the action that failed and leaves the timeline channel clean', async () => {
      mockApi.get.mockResolvedValue({ data: { versions, totalEdits: 5 } });
      mockApi.put.mockRejectedValue({ response: { data: { error: 'rename boom' } } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.renameVersion('v1', 'New name'); });

      expect(result.current.actionError).toEqual({ action: 'rename', message: 'rename boom' });
      expect(result.current.error).toBeNull();
      expect(result.current.versions).toHaveLength(1); // timeline untouched
    });

    it('does not let the next poll clear it: the rename still did not happen', async () => {
      mockApi.get.mockResolvedValue({ data: { versions, totalEdits: 5 } });
      mockApi.delete.mockRejectedValue({ response: { data: { error: 'delete boom' } } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.deleteNamedVersion('v1'); });
      expect(result.current.actionError.action).toBe('delete');

      await act(async () => { await result.current.fetchHistory({ background: true }); });
      expect(result.current.actionError.action).toBe('delete');

      // It clears when the user dismisses it, or when the next action starts.
      act(() => { result.current.clearActionError(); });
      expect(result.current.actionError).toBeNull();
    });

    it('a successful action clears a previous action failure', async () => {
      mockApi.get.mockResolvedValue({ data: { versions, totalEdits: 5 } });
      mockApi.post
        .mockRejectedValueOnce({ response: { data: { error: 'name boom' } } })
        .mockResolvedValueOnce({ data: { version: { id: 'nv', name: 'Milestone' } } });

      const { result } = renderHook(() => useVersionHistory('doc-123'));
      await waitFor(() => expect(result.current.versions).toHaveLength(1));

      await act(async () => { await result.current.createNamedVersion('Milestone', 5); });
      expect(result.current.actionError.action).toBe('name');

      await act(async () => { await result.current.createNamedVersion('Milestone', 5); });
      expect(result.current.actionError).toBeNull();
    });
  });
});
