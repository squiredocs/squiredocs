import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * Group versions by month for display (January 2025, December 2024, etc.)
 * Uses browser's local timezone for proper grouping
 * @param {Array} versions - Array of version objects with timestamp
 * @returns {Array} Grouped versions by month
 */
function groupVersionsByPeriod(versions) {
  if (!versions || versions.length === 0) return [];

  const monthGroups = new Map();

  for (const version of versions) {
    const versionDate = new Date(version.timestamp);
    const monthKey = `${versionDate.getFullYear()}-${String(versionDate.getMonth() + 1).padStart(2, '0')}`;
    const monthLabel = versionDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    if (!monthGroups.has(monthKey)) {
      monthGroups.set(monthKey, { key: monthKey, label: monthLabel, versions: [] });
    }
    monthGroups.get(monthKey).versions.push(version);
  }

  // Sort versions within each month by timestamp descending (most recent first)
  const sortByRecent = (versions) =>
    versions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Convert to array and sort months descending (most recent first)
  const result = Array.from(monthGroups.values())
    .sort((a, b) => b.key.localeCompare(a.key))
    .map(group => ({
      label: group.label,
      versions: sortByRecent(group.versions),
    }));

  return result;
}

/**
 * Live-refresh cadence for an open history panel (feature 041, FR-008, R5).
 * A poll of an O(rows) endpoint every 10 s is negligible load and keeps the
 * panel honest while a collaborator edits; ticks are skipped while the tab is
 * hidden.
 */
export const HISTORY_POLL_INTERVAL_MS = 10000;

/**
 * Structural fingerprint of a version list. A refresh only invalidates the
 * drill-down cache when this changes, so an idle poll neither wipes cached
 * sub-versions nor makes expanded rows re-fetch every tick (FR-009 + the
 * scroll/expansion-preservation edge case).
 */
function versionsSignature(versions) {
  return (versions || [])
    .map(v => `${v.id}:${v.clockStart}-${v.clockEnd}:${v.name || ''}:${v.isCurrent ? 1 : 0}`)
    .join('|');
}

/**
 * Hook for managing document version history
 * @param {string} docGuid - Document GUID
 * @returns {Object} Version history state and actions
 */
export function useVersionHistory(docGuid) {
  const { api } = useAuth();
  const [versions, setVersions] = useState([]);
  const [totalEdits, setTotalEdits] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  // Two independent failure channels (feature 041, FR-005/FR-006, research R3):
  //  - `error`      the timeline load and the CRUD actions (name/rename/delete/
  //                 restore). Rendered by the panel with a retry affordance.
  //  - `diffError`  the selected version's preview/diff load. Rendered by the
  //                 preview pane.
  // They are separate because a failed diff must not blank the timeline (and
  // vice versa) and because they have different retry affordances. Before this
  // split both funnelled into one `error` that nothing rendered at all, so a
  // 500 from /history showed the user "No version history yet".
  const [error, setError] = useState(null);
  const [diffError, setDiffError] = useState(null);

  // Unified selection state: { type: 'version', data: version } or { type: 'clock', clock: number, data: update }
  const [selection, setSelection] = useState(null);
  const [versionContent, setVersionContent] = useState(null);
  const [previousVersionContent, setPreviousVersionContent] = useState(null);
  const [diffData, setDiffData] = useState(null); // { fullDoc, currentSnapshot, previousSnapshot }
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  // Hierarchical drill-down state
  const [versionUpdates, setVersionUpdates] = useState({}); // { versionId: [updates] }
  const [versionUpdatesMeta, setVersionUpdatesMeta] = useState({}); // { versionId: { total, hasMore } }
  const [loadingVersionUpdates, setLoadingVersionUpdates] = useState({}); // { versionId: boolean }

  // Monotonic request sequence for diff loads. selectVersion/selectUpdate fire
  // async diff fetches; a slower earlier response must never overwrite a newer
  // selection's preview. Only the response whose seq is still current applies.
  const diffRequestSeqRef = useRef(0);

  // Feature 041 (FR-007): the selection must be reconciled against every
  // refreshed list, so `fetchHistory` needs to read the CURRENT selection
  // without taking it as a dependency (that would rebuild the poll interval on
  // every selection change). A ref is the cheap, correct way to do that.
  const selectionRef = useRef(null);
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  // Last seen structural fingerprint, for the cache-invalidation decision.
  const versionsSignatureRef = useRef('');

  // Group versions client-side using browser's local timezone for proper display
  const groupedVersions = useMemo(() => groupVersionsByPeriod(versions), [versions]);
  // hierarchicalVersions is the same as groupedVersions - kept for API compatibility
  const hierarchicalVersions = groupedVersions;

  /**
   * Fetch version history timeline
   */
  const fetchHistory = useCallback(async ({ background = false } = {}) => {
    if (!docGuid) return;

    // A background tick (the FR-008 live-refresh poll) must be invisible: no
    // loading state — the panel would tear the list down and take the user's
    // scroll position and row expansions with it — and no pre-emptive error
    // clear, so a failing tick leaves the last-good list on screen next to an
    // honest error rather than flickering.
    if (!background) {
      setIsLoading(true);
      setError(null);
    }

    try {
      const response = await api.get(`/api/docs/${docGuid}/history`);
      const fresh = response.data.versions || [];
      setVersions(fresh);
      setTotalEdits(response.data.totalEdits || 0);
      setError(null);

      // Invalidate the drill-down cache only when the version STRUCTURE moved
      // (e.g. naming a clock splits auto versions and shifts clock ranges). An
      // idle poll must not wipe cached sub-versions — that would make every
      // expanded row re-fetch every 10 s and blank its contents in between.
      const signature = versionsSignature(fresh);
      if (signature !== versionsSignatureRef.current) {
        versionsSignatureRef.current = signature;
        setVersionUpdates({});
        setVersionUpdatesMeta({});
      }
    } catch (err) {
      console.error('Error fetching version history:', err);
      setError(err.response?.data?.error || 'Failed to load version history');
    } finally {
      if (!background) setIsLoading(false);
    }
  }, [docGuid, api]);

  /**
   * Load content for a specific version
   */
  const loadVersionContent = useCallback(async (versionId) => {
    if (!docGuid || !versionId) return null;

    setIsLoadingContent(true);
    setError(null);

    try {
      const response = await api.get(`/api/docs/${docGuid}/versions/${versionId}`);
      const content = {
        content: new Uint8Array(response.data.content),
        version: response.data.version,
      };
      setVersionContent(content);
      return content;
    } catch (err) {
      console.error('Error loading version content:', err);
      setError(err.response?.data?.error || 'Failed to load version content');
      return null;
    } finally {
      setIsLoadingContent(false);
    }
  }, [docGuid, api]);

  /**
   * Load content at a specific clock value (for diff comparison)
   * This is a lightweight version that doesn't set the main versionContent state
   */
  const loadPreviousContentAtClock = useCallback(async (clock) => {
    if (!docGuid || clock < 0) return null;

    try {
      const response = await api.get(`/api/docs/${docGuid}/history/clock/${clock}`);
      return {
        content: new Uint8Array(response.data.content),
        clock: response.data.clock,
      };
    } catch (err) {
      console.error('Error loading previous content at clock:', err);
      return null;
    }
  }, [docGuid, api]);

  /**
   * Load diff data for version comparison.
   * Server computes the diff and returns:
   * - document: ProseMirror JSON of the document at currentClock
   * - changes: Array of {type, fromB, toB, deleted} for decorations
   * - meta: {previousClock, currentClock, textIdentical}
   */
  const loadDiffData = useCallback(async (currentClock, previousClock) => {
    if (!docGuid) return null;

    const params = new URLSearchParams({ currentClock: currentClock.toString() });
    if (previousClock >= 0) {
      params.append('previousClock', previousClock.toString());
    }
    // Let failures propagate: selectVersion/selectUpdate surface the error and
    // clear the stale preview rather than silently keeping the previous diff.
    const response = await api.get(`/api/docs/${docGuid}/history/diff?${params}`);
    // Return the server-computed diff data directly
    return response.data;
  }, [docGuid, api]);

  /**
   * Select a version and load its content (including diff data for comparison)
   */
  const selectVersion = useCallback(async (version) => {
    setSelection(version);
    if (!version) {
      setVersionContent(null);
      setPreviousVersionContent(null);
      setDiffData(null);
      setDiffError(null);
      return;
    }

    const seq = ++diffRequestSeqRef.current;
    setIsLoadingContent(true);
    setDiffError(null);
    try {
      // Load diff data - server returns pre-computed document and changes
      const previousClock = version.clockStart > 0 ? version.clockStart - 1 : -1;
      const diffResult = await loadDiffData(version.clockEnd, previousClock);
      if (seq !== diffRequestSeqRef.current) return; // superseded by a newer selection
      setDiffData(diffResult);
      // Legacy compatibility - no longer needed but kept for any remaining consumers
      setVersionContent(null);
      setPreviousVersionContent(null);
    } catch (err) {
      if (seq !== diffRequestSeqRef.current) return; // stale failure, ignore
      console.error('Error loading version diff:', err);
      // Clear the preview rather than showing a wrong (previous) diff, and
      // record the failure so the preview pane renders an error instead of the
      // "Select a version to preview" placeholder (FR-006).
      setDiffData(null);
      setDiffError(err.response?.data?.error || 'Failed to load version content');
    } finally {
      if (seq === diffRequestSeqRef.current) setIsLoadingContent(false);
    }
  }, [loadDiffData]);

  /**
   * Load individual updates for a version (for drill-down)
   */
  const loadUpdatesForVersion = useCallback(async (clockStart, clockEnd, versionId) => {
    if (!docGuid) return null;

    setLoadingVersionUpdates(prev => ({ ...prev, [versionId]: true }));

    try {
      const response = await api.get(`/api/docs/${docGuid}/history/updates`, {
        params: { from: clockStart, to: clockEnd }
      });
      const updates = response.data.updates || [];
      setVersionUpdates(prev => ({ ...prev, [versionId]: updates }));
      // total/hasMore let the UI honestly show "N of M edits" when the server
      // capped the returned subversions (default limit 10). Fall back to the
      // returned length when the server omits them.
      setVersionUpdatesMeta(prev => ({
        ...prev,
        [versionId]: {
          total: typeof response.data.total === 'number' ? response.data.total : updates.length,
          hasMore: response.data.hasMore === true,
        },
      }));
      return updates;
    } catch (err) {
      console.error('Error loading version updates:', err);
      setError(err.response?.data?.error || 'Failed to load version updates');
      return null;
    } finally {
      setLoadingVersionUpdates(prev => ({ ...prev, [versionId]: false }));
    }
  }, [docGuid, api]);

  /**
   * Load content at a specific clock value
   */
  const loadContentAtClock = useCallback(async (clock) => {
    if (!docGuid) return null;

    setIsLoadingContent(true);
    setError(null);

    try {
      const response = await api.get(`/api/docs/${docGuid}/history/clock/${clock}`);
      const content = {
        content: new Uint8Array(response.data.content),
        clock: response.data.clock,
        timestamp: response.data.timestamp,
        formattedTimestamp: response.data.formattedTimestamp,
        author: response.data.author,
      };
      setVersionContent(content);
      return content;
    } catch (err) {
      console.error('Error loading content at clock:', err);
      setError(err.response?.data?.error || 'Failed to load content at clock');
      return null;
    } finally {
      setIsLoadingContent(false);
    }
  }, [docGuid, api]);

  /**
   * Select a sub-version (grouped updates) and load its content
   * Sub-versions have clockStart, clockEnd, previousClock, timestamp, and authors
   * The server provides previousClock to ensure consistent sequential diffing
   */
  const selectUpdate = useCallback(async (subVersion) => {
    // Create a version-like object for the sub-version
    setSelection({
      id: subVersion.id,
      clockStart: subVersion.clockStart,
      clockEnd: subVersion.clockEnd,
      timestamp: subVersion.timestamp,
      authors: subVersion.authors || [],
      isSubVersion: true, // Flag to distinguish from top-level versions
      updateCount: subVersion.updateCount,
    });

    const seq = ++diffRequestSeqRef.current;
    setIsLoadingContent(true);
    setDiffError(null);
    try {
      // Use previousClock from server (provides correct sequential baseline)
      // Falls back to clockStart - 1 for backwards compatibility
      const previousClock = subVersion.previousClock !== undefined
        ? subVersion.previousClock
        : subVersion.clockStart - 1;
      const diffResult = await loadDiffData(subVersion.clockEnd, previousClock);
      if (seq !== diffRequestSeqRef.current) return; // superseded by a newer selection
      setDiffData(diffResult);
      // Legacy compatibility - no longer needed
      setVersionContent(null);
      setPreviousVersionContent(null);
    } catch (err) {
      if (seq !== diffRequestSeqRef.current) return; // stale failure, ignore
      console.error('Error loading update diff:', err);
      setDiffData(null);
      setDiffError(err.response?.data?.error || 'Failed to load version content');
    } finally {
      if (seq === diffRequestSeqRef.current) setIsLoadingContent(false);
    }
  }, [loadDiffData]);

  /**
   * Restore document to a previous version
   */
  const restoreVersion = useCallback(async (versionId) => {
    if (!docGuid || !versionId) return false;

    try {
      const response = await api.post(`/api/docs/${docGuid}/restore`, { versionId });
      if (response.data.success) {
        // Refresh history after restore
        await fetchHistory();
        return true;
      }
      return false;
    } catch (err) {
      console.error('Error restoring version:', err);
      setError(err.response?.data?.error || 'Failed to restore version');
      return false;
    }
  }, [docGuid, api, fetchHistory]);

  /**
   * Create a named version
   */
  const createNamedVersion = useCallback(async (name, clockEnd = null) => {
    if (!docGuid || !name) return null;

    try {
      const body = { name };
      if (clockEnd !== null) {
        body.clockEnd = clockEnd;
      }
      const response = await api.post(`/api/docs/${docGuid}/versions`, body);
      // Refresh history after creating named version
      await fetchHistory();
      return response.data.version;
    } catch (err) {
      console.error('Error creating named version:', err);
      setError(err.response?.data?.error || 'Failed to create named version');
      return null;
    }
  }, [docGuid, api, fetchHistory]);

  /**
   * Rename a version
   */
  const renameVersion = useCallback(async (versionId, name) => {
    if (!docGuid || !versionId) return false;

    try {
      await api.put(`/api/docs/${docGuid}/versions/${versionId}`, { name });
      // Refresh history after rename
      await fetchHistory();
      return true;
    } catch (err) {
      console.error('Error renaming version:', err);
      setError(err.response?.data?.error || 'Failed to rename version');
      return false;
    }
  }, [docGuid, api, fetchHistory]);

  /**
   * Delete a named version
   */
  const deleteNamedVersion = useCallback(async (versionId) => {
    if (!docGuid || !versionId) return false;

    try {
      await api.delete(`/api/docs/${docGuid}/versions/${versionId}`);
      // Refresh history after delete
      await fetchHistory();
      return true;
    } catch (err) {
      console.error('Error deleting version:', err);
      setError(err.response?.data?.error || 'Failed to delete version');
      return false;
    }
  }, [docGuid, api, fetchHistory]);

  /**
   * Clear selection and content
   */
  const clearSelection = useCallback(() => {
    setSelection(null);
    setVersionContent(null);
    setPreviousVersionContent(null);
    setDiffData(null);
    setDiffError(null);
  }, []);

  /**
   * Refresh history data
   */
  const refresh = useCallback(() => {
    return fetchHistory();
  }, [fetchHistory]);

  /**
   * Reconcile the current selection against a freshly fetched version list
   * (feature 041, FR-007 / RBD-041-8).
   *
   * The selection used to be a click-time SNAPSHOT. Everything downstream reads
   * it — the header title, the contributors footer, the current-version badge,
   * the restore gating, and the id the header's "Restore this version" button
   * posts — so after a rename, a mid-range naming (which re-splits the
   * containing auto version into new ids and ranges), a delete, or a live
   * refresh, all of those described a world that no longer existed. The header
   * could post a version id whose range had been split out from under it.
   *
   * Rule: re-resolve to the fresh version whose range CONTAINS the old
   * selection's `clockEnd` — that survives renames and re-splits and keeps the
   * user looking at the same point in history — otherwise fall back to the
   * panel's default selection (the current version). A stale id is never kept.
   * The preview is only re-fetched when the range actually moved, so an idle
   * poll never re-requests an identical diff.
   */
  const reconcileSelection = useCallback((freshVersions) => {
    const current = selectionRef.current;
    if (!current) return;

    if (!freshVersions || freshVersions.length === 0) {
      setSelection(null);
      setVersionContent(null);
      setPreviousVersionContent(null);
      setDiffData(null);
      setDiffError(null);
      return;
    }

    const containing = freshVersions.find(
      v => v.clockStart <= current.clockEnd && v.clockEnd >= current.clockEnd
    );

    // A sub-version selection stays valid as long as a top-level version still
    // covers it; only when its containing version is gone do we fall back.
    if (current.isSubVersion) {
      if (!containing) {
        selectVersion(freshVersions.find(v => v.isCurrent) || freshVersions[0]);
      }
      return;
    }

    const resolved = containing || freshVersions.find(v => v.isCurrent) || freshVersions[0];

    const rangeMoved = resolved.clockStart !== current.clockStart
      || resolved.clockEnd !== current.clockEnd;

    if (rangeMoved) {
      // The preview is genuinely different now — reselect (refetches the diff).
      selectVersion(resolved);
      return;
    }

    // Same range: adopt the FRESH object so every consumer reads post-refresh
    // id/name/isCurrent, but do not re-fetch an identical preview.
    const metadataMoved = resolved.id !== current.id
      || (resolved.name || null) !== (current.name || null)
      || !!resolved.isCurrent !== !!current.isCurrent;
    if (metadataMoved) {
      setSelection(resolved);
    }
  }, [selectVersion]);

  // Reconcile after EVERY refresh — CRUD-driven and poll-driven alike. Keyed on
  // the versions array identity, which only changes when a fetch resolves.
  useEffect(() => {
    reconcileSelection(versions);
  }, [versions, reconcileSelection]);

  // Load history on mount if docGuid is provided
  useEffect(() => {
    if (docGuid) {
      fetchHistory();
    }
  }, [docGuid, fetchHistory]);

  // Live refresh while the panel is open (feature 041, FR-008, R5). The hook is
  // only mounted with a docGuid while version history is open, so the interval's
  // lifetime is the panel's. Hidden tabs skip their ticks — a backgrounded panel
  // has no viewer to be truthful to, and the next visible tick catches up.
  useEffect(() => {
    if (!docGuid) return undefined;

    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchHistory({ background: true });
    }, HISTORY_POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [docGuid, fetchHistory]);

  return {
    // State
    versions,
    groupedVersions,
    hierarchicalVersions,
    totalEdits,
    isLoading,
    error,
    diffError,
    selection, // Unified selection: version or single clock update (with isClock: true)
    versionContent,
    previousVersionContent, // Legacy - no longer used
    diffData, // { document, changes, meta } from server-side diff computation
    isLoadingContent,

    // Hierarchical drill-down state
    versionUpdates,
    versionUpdatesMeta,
    loadingVersionUpdates,

    // Actions
    fetchHistory,
    selectVersion,
    loadVersionContent,
    restoreVersion,
    createNamedVersion,
    renameVersion,
    deleteNamedVersion,
    clearSelection,
    refresh,

    // Hierarchical drill-down actions
    loadUpdatesForVersion,
    loadContentAtClock,
    selectUpdate,
  };
}

export default useVersionHistory;
