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
 *
 * Authors are deliberately NOT part of this signature: an attribution change
 * must not blank every expanded row. It is carried by the separate authors
 * fingerprint below, which drives a background refresh instead of a wipe.
 */
function versionsSignature(versions) {
  return (versions || [])
    .map(v => `${v.id}:${v.clockStart}-${v.clockEnd}:${v.name || ''}:${v.isCurrent ? 1 : 0}`)
    .join('|');
}

/**
 * Fingerprint of one version's contributor list. Attribution is the thing this
 * panel exists to state, and it MOVES without the structure moving: a "Synced
 * content" entry resolving to a real person once the relay's origin is known, a
 * deleted account collapsing to "Unknown author". Both must reach the preview
 * footer and the expanded drill-down rows.
 */
function authorsFingerprint(authors) {
  return (authors || [])
    .map(a => `${a.id ?? ''}~${a.name ?? ''}~${a.isSynced ? 1 : 0}~${a.isAgent ? 1 : 0}`)
    .join(',');
}

function versionsAuthorsSignature(versions) {
  return (versions || []).map(v => `${v.id}:${authorsFingerprint(v.authors)}`).join('|');
}

/**
 * Identity of one drill-down request: the version AND the clock range it
 * answers.
 *
 * Auto-version ids are `String(clockEnd)`, so naming a version at a clock
 * INSIDE an existing range re-splits it while an id survives — an id-only cache
 * key let an in-flight response for the OLD range land as the sub-rows, and the
 * AUTHORS, of the new one (the row could not re-request in the meantime because
 * its own loading flag was still up). Range-qualifying every drill-down key
 * makes that write unreachable rather than unlikely: a response for a range the
 * version no longer has is simply not the data the list reads, and the row
 * re-fetches its current range.
 */
export function updatesCacheKey(versionId, clockStart, clockEnd) {
  return `${versionId}:${clockStart}-${clockEnd}`;
}

/**
 * Whether two diff payloads are the same document. The preview feeds `content`
 * to useEditor as a dependency, so a new-but-identical object tears TipTap down
 * and resets the reader's scroll position — and the live-refresh reconcile
 * re-fetches on every collaborator keystroke.
 */
function sameDiffPayload(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
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
  // Third channel: the CRUD actions (restore/name/rename/delete). They used to
  // share `error` with the timeline load, so a failed rename rendered
  // "Couldn't load version history." with a Retry that refetched the timeline
  // instead of retrying the action — over a list that had loaded perfectly —
  // and the next 10 s poll silently cleared the banner. An action failure is
  // about the ACTION: it names it, offers no load retry, and stays until the
  // user dismisses it or the next action succeeds.
  // Shape: { action: 'name'|'rename'|'delete', message } | null. Restore is
  // deliberately NOT on this channel: it is always confirmed through a modal,
  // which owns its own failure reporting (see restoreVersion).
  const [actionError, setActionError] = useState(null);

  // Unified selection state: { type: 'version', data: version } or { type: 'clock', clock: number, data: update }
  const [selection, setSelection] = useState(null);
  // The server-computed diff payload:
  //   { document, currentDocument, meta: { previousClock, currentClock,
  //     textIdentical, formattingOnly, diffFailed } }
  // `document` carries diffInsert/diffDelete marks baked in; `currentDocument`
  // is the unmarked version the preview swaps to when highlights are off.
  const [diffData, setDiffData] = useState(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  // Hierarchical drill-down state. Every map here is keyed by updatesCacheKey()
  // — version id AND range — never by version id alone.
  const [versionUpdates, setVersionUpdates] = useState({}); // { key: [updates] }
  const [versionUpdatesMeta, setVersionUpdatesMeta] = useState({}); // { key: { total, hasMore } }
  const [loadingVersionUpdates, setLoadingVersionUpdates] = useState({}); // { key: boolean }
  // Per-row drill-down failures (review L1): { versionId: message }. A failed
  // drill-down is a failure OF ONE ROW, so it belongs to that row and never to
  // the panel-level `error` channel — putting it there made a 500 from
  // /history/updates render "Couldn't load version history." + Retry over a
  // perfectly healthy list, while the expanded row sat on "Loading updates..."
  // forever. The list renders this inline, with its own retry.
  const [versionUpdatesError, setVersionUpdatesError] = useState({});

  // The same monotonic guard as the timeline and the diff, per drill-down key:
  // only the newest request for a given range may write its result (a retry tap
  // while the first request is still out).
  const updatesRequestSeqRef = useRef(new Map());
  // Which ranges currently hold cached drill-down data, so an attribution-only
  // refresh knows exactly what to re-request. Written next to the cache itself.
  const cachedRangesRef = useRef(new Map());

  // Monotonic request sequence for diff loads. selectVersion/selectUpdate fire
  // async diff fetches; a slower earlier response must never overwrite a newer
  // selection's preview. Only the response whose seq is still current applies.
  const diffRequestSeqRef = useRef(0);

  // The same guard for the timeline itself (review M3). `fetchHistory` runs from
  // three places at once — mount, the 10 s background poll, and every CRUD action
  // that refreshes afterwards — so a slow poll response could land AFTER a
  // fresher refresh and overwrite the newer list with a pre-rename/pre-restore
  // one, wiping the drill-down cache a second time and reconciling the selection
  // against a world that no longer exists. Only the response whose seq is still
  // current applies.
  const historyRequestSeqRef = useRef(0);

  // Feature 041 (FR-007): the selection must be reconciled against every
  // refreshed list, so `fetchHistory` needs to read the CURRENT selection
  // without taking it as a dependency (that would rebuild the poll interval on
  // every selection change). A ref is the cheap, correct way to do that.
  const selectionRef = useRef(null);
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  // Last seen structural fingerprint, for the cache-invalidation decision, and
  // the attribution fingerprint that drives the refresh-without-wipe path.
  const versionsSignatureRef = useRef('');
  const authorsSignatureRef = useRef('');

  // `fetchHistory` re-requests cached drill-down ranges when attribution moves,
  // and is declared before `loadUpdatesForVersion`; the ref bridges the
  // declaration order without making either callback depend on the other.
  const loadUpdatesRef = useRef(null);

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

    const seq = ++historyRequestSeqRef.current;
    try {
      const response = await api.get(`/api/docs/${docGuid}/history`);
      if (seq !== historyRequestSeqRef.current) return; // superseded by a newer fetch
      const fresh = response.data.versions || [];
      setVersions(fresh);
      setTotalEdits(response.data.totalEdits || 0);
      setError(null);

      // Invalidate the drill-down cache only when the version STRUCTURE moved
      // (e.g. naming a clock splits auto versions and shifts clock ranges). An
      // idle poll must not wipe cached sub-versions — that would make every
      // expanded row re-fetch every 10 s and blank its contents in between.
      const signature = versionsSignature(fresh);
      const authorsSignature = versionsAuthorsSignature(fresh);
      if (signature !== versionsSignatureRef.current) {
        versionsSignatureRef.current = signature;
        authorsSignatureRef.current = authorsSignature;
        cachedRangesRef.current.clear();
        setVersionUpdates({});
        setVersionUpdatesMeta({});
      } else if (authorsSignature !== authorsSignatureRef.current) {
        // Attribution moved while the structure stood still. Cached sub-rows
        // carry authors too, so they are REFRESHED, not wiped: a correction to
        // who wrote something must not blank what it says while it lands.
        authorsSignatureRef.current = authorsSignature;
        for (const range of Array.from(cachedRangesRef.current.values())) {
          loadUpdatesRef.current?.(range.clockStart, range.clockEnd, range.versionId, { background: true });
        }
      }
    } catch (err) {
      if (seq !== historyRequestSeqRef.current) return; // stale failure, ignore
      console.error('Error fetching version history:', err);
      setError(err.response?.data?.error || 'Failed to load version history');
    } finally {
      // Not seq-guarded: only a foreground fetch ever raises this flag, so the
      // foreground fetch that raised it must always be able to lower it — a
      // background tick superseding it must not strand the panel in "Loading".
      if (!background) setIsLoading(false);
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
   *
   * `background: true` is the live-refresh path (the reconcile below). It keeps
   * the last-good preview on screen while the new diff is in flight instead of
   * raising the "Loading version…" placeholder, which — with the current version
   * auto-selected — fired on EVERY 10 s poll during live collaboration, tearing
   * TipTap down and resetting the reader's scroll position.
   */
  const selectVersion = useCallback(async (version, { background = false } = {}) => {
    setSelection(version);
    if (!version) {
      setDiffData(null);
      setDiffError(null);
      return;
    }

    const seq = ++diffRequestSeqRef.current;
    if (!background) {
      setIsLoadingContent(true);
      setDiffError(null);
    }
    try {
      // Load diff data - server returns pre-computed document and changes
      const previousClock = version.clockStart > 0 ? version.clockStart - 1 : -1;
      const diffResult = await loadDiffData(version.clockEnd, previousClock);
      if (seq !== diffRequestSeqRef.current) return; // superseded by a newer selection
      // Keep the previous payload's identity when the document is unchanged, so
      // a poll that moved the range without changing the content does not
      // rebuild the editor.
      setDiffData(prev => (background && sameDiffPayload(prev, diffResult) ? prev : diffResult));
      setDiffError(null);
    } catch (err) {
      if (seq !== diffRequestSeqRef.current) return; // stale failure, ignore
      console.error('Error loading version diff:', err);
      // A BACKGROUND refetch is the reconcile, not the reader: it must never
      // destroy the preview they are reading. A 429 while a collaborator types
      // used to replace the loaded preview with "Couldn't load this version's
      // preview. Select the version again to retry." — over a version that was
      // still selected, after the user did nothing. Keep the last-good diff;
      // the next tick re-requests it.
      if (background) return;
      // Foreground: clear the preview rather than showing a wrong (previous)
      // diff, and record the failure so the preview pane renders an error
      // instead of the "Select a version to preview" placeholder (FR-006).
      setDiffData(null);
      setDiffError(err.response?.data?.error || 'Failed to load version content');
    } finally {
      if (seq === diffRequestSeqRef.current) setIsLoadingContent(false);
    }
  }, [loadDiffData]);

  /**
   * Load individual updates for a version (for drill-down).
   *
   * Every result is stored under updatesCacheKey(versionId, clockStart,
   * clockEnd): the answer belongs to the RANGE it was asked about, not to the
   * id, which can outlive the range it described.
   *
   * `background: true` is the attribution-refresh path: no spinner over rows
   * that are still correct, and a failure keeps the last-good rows rather than
   * replacing them with a row error.
   *
   * Returns the updates on success, `null` on failure, and `undefined` when the
   * response was superseded (the caller must not read that as a failure).
   */
  const loadUpdatesForVersion = useCallback(async (clockStart, clockEnd, versionId, { background = false } = {}) => {
    if (!docGuid) return null;

    const key = updatesCacheKey(versionId, clockStart, clockEnd);
    const seq = (updatesRequestSeqRef.current.get(key) || 0) + 1;
    updatesRequestSeqRef.current.set(key, seq);

    if (!background) {
      setLoadingVersionUpdates(prev => ({ ...prev, [key]: true }));
      setVersionUpdatesError(prev => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }

    try {
      const response = await api.get(`/api/docs/${docGuid}/history/updates`, {
        params: { from: clockStart, to: clockEnd }
      });
      if (seq !== updatesRequestSeqRef.current.get(key)) return undefined; // superseded
      const updates = response.data.updates || [];
      setVersionUpdates(prev => ({ ...prev, [key]: updates }));
      cachedRangesRef.current.set(key, { versionId, clockStart, clockEnd });
      // total/hasMore let the UI honestly show "N of M edits" when the server
      // capped the returned subversions (default limit 10). Fall back to the
      // returned length when the server omits them.
      setVersionUpdatesMeta(prev => ({
        ...prev,
        [key]: {
          total: typeof response.data.total === 'number' ? response.data.total : updates.length,
          hasMore: response.data.hasMore === true,
        },
      }));
      setVersionUpdatesError(prev => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });

      // A selected SUB-VERSION carries the authors of the row it was clicked
      // from — the timeline reconcile never sees it, so a corrected row has to
      // correct the preview footer here.
      const current = selectionRef.current;
      if (current?.isSubVersion) {
        const match = updates.find(
          u => u.clockStart === current.clockStart && u.clockEnd === current.clockEnd
        );
        if (match && authorsFingerprint(match.authors) !== authorsFingerprint(current.authors)) {
          setSelection({ ...current, authors: match.authors || [] });
        }
      }
      return updates;
    } catch (err) {
      if (seq !== updatesRequestSeqRef.current.get(key)) return undefined; // stale failure
      console.error('Error loading version updates:', err);
      // Row-level, never panel-level (review L1) — and never at all for a
      // background refresh, where the row error would blank rows that are
      // still true.
      if (!background) {
        setVersionUpdatesError(prev => ({
          ...prev,
          [key]: err.response?.data?.error || 'Failed to load version updates',
        }));
      }
      return null;
    } finally {
      // Not seq-guarded, for the same reason as fetchHistory: only a foreground
      // request raises this flag, so it must always be able to lower it.
      if (!background) setLoadingVersionUpdates(prev => ({ ...prev, [key]: false }));
    }
  }, [docGuid, api]);

  useEffect(() => { loadUpdatesRef.current = loadUpdatesForVersion; }, [loadUpdatesForVersion]);

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
   * Restore document to a previous version.
   *
   * A restore failure is reported by the CONFIRM DIALOG, and only there. Both
   * entry points — the row menu and the version-history header — run this
   * through useRestoreFlow, which already keeps its dialog open carrying the
   * failure; also raising `actionError` reported the same failure twice, and the
   * banner outlived the modal the user cancelled, so it then needed a separate
   * Dismiss. The dialog is the surface holding the user's attention, so it is
   * the owner: a failure THROWS, carrying the server's message for the dialog to
   * render.
   */
  const restoreVersion = useCallback(async (versionId) => {
    if (!docGuid || !versionId) return false;

    setActionError(null);
    let response;
    try {
      response = await api.post(`/api/docs/${docGuid}/restore`, { versionId });
    } catch (err) {
      console.error('Error restoring version:', err);
      throw new Error(err.response?.data?.error || 'Failed to restore version');
    }

    // A 200 whose body does not say `success` is a restore that did not happen.
    // It used to return a bare `false` reported nowhere — a silent failure
    // inside the very channel added to end silent failures. Unreachable against
    // today's server, and stated anyway.
    if (!response?.data?.success) {
      throw new Error(response?.data?.error || 'The server did not confirm the restore.');
    }

    // Refresh history after restore
    await fetchHistory();
    return true;
  }, [docGuid, api, fetchHistory]);

  /**
   * Create a named version
   */
  const createNamedVersion = useCallback(async (name, clockEnd = null) => {
    if (!docGuid || !name) return null;

    setActionError(null);
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
      setActionError({
        action: 'name',
        message: err.response?.data?.error || 'Failed to create named version',
      });
      return null;
    }
  }, [docGuid, api, fetchHistory]);

  /**
   * Rename a version
   */
  const renameVersion = useCallback(async (versionId, name) => {
    if (!docGuid || !versionId) return false;

    setActionError(null);
    try {
      await api.put(`/api/docs/${docGuid}/versions/${versionId}`, { name });
      // Refresh history after rename
      await fetchHistory();
      return true;
    } catch (err) {
      console.error('Error renaming version:', err);
      setActionError({
        action: 'rename',
        message: err.response?.data?.error || 'Failed to rename version',
      });
      return false;
    }
  }, [docGuid, api, fetchHistory]);

  /**
   * Delete a named version
   */
  const deleteNamedVersion = useCallback(async (versionId) => {
    if (!docGuid || !versionId) return false;

    setActionError(null);
    try {
      await api.delete(`/api/docs/${docGuid}/versions/${versionId}`);
      // Refresh history after delete
      await fetchHistory();
      return true;
    } catch (err) {
      console.error('Error deleting version:', err);
      setActionError({
        action: 'delete',
        message: err.response?.data?.error || 'Failed to remove the version name',
      });
      return false;
    }
  }, [docGuid, api, fetchHistory]);

  /**
   * Refresh history data
   */
  const refresh = useCallback(() => {
    return fetchHistory();
  }, [fetchHistory]);

  /**
   * Dismiss an action failure. It does NOT clear itself on the next poll: the
   * user's rename still did not happen, and a banner that vanishes on a timer
   * teaches them the action might have worked after all.
   */
  const clearActionError = useCallback(() => setActionError(null), []);

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
      // The preview is genuinely different now — reselect (refetches the diff)
      // in the BACKGROUND. With the current version auto-selected this path runs
      // on every poll a collaborator types through, and a foreground reselect
      // replaced the preview with "Loading version…" each time.
      selectVersion(resolved, { background: true });
      return;
    }

    // Same range: adopt the FRESH object so every consumer reads post-refresh
    // id/name/isCurrent/authors, but do not re-fetch an identical preview.
    // Attribution counts: a "Synced content" entry that has since resolved to a
    // person, or a deletion that collapsed one to "Unknown author", changes what
    // the contributors footer must say about the very same range.
    const metadataMoved = resolved.id !== current.id
      || (resolved.name || null) !== (current.name || null)
      || !!resolved.isCurrent !== !!current.isCurrent
      || authorsFingerprint(resolved.authors) !== authorsFingerprint(current.authors);
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

    // In-flight dedupe: a /history that takes longer than the interval must not
    // stack a queue of identical requests behind it. The seq guard already keeps
    // the RESULT honest; this keeps a slow server from being hammered.
    let inFlight = false;
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      Promise.resolve(fetchHistory({ background: true })).finally(() => { inFlight = false; });
    };

    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      poll();
    }, HISTORY_POLL_INTERVAL_MS);

    // A hidden tab skips its ticks, so a returning tab can be a full interval
    // out of date. Refresh on the way back in rather than showing a stale
    // timeline until the next tick.
    const onVisibilityChange = () => {
      if (!document.hidden) poll();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
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
    actionError, // { action, message } — the CRUD channel, never the load channel
    selection, // Unified selection: version or single clock update (with isClock: true)
    diffData, // { document, changes, meta } from server-side diff computation
    isLoadingContent,

    // Hierarchical drill-down state
    versionUpdates,
    versionUpdatesMeta,
    loadingVersionUpdates,
    versionUpdatesError,

    // Actions
    fetchHistory,
    selectVersion,
    restoreVersion,
    createNamedVersion,
    renameVersion,
    deleteNamedVersion,
    refresh,
    clearActionError,

    // Hierarchical drill-down actions
    loadUpdatesForVersion,
    selectUpdate,
  };
}

export default useVersionHistory;
