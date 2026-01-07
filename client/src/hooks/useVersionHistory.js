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
 * Hook for managing document version history
 * @param {string} docGuid - Document GUID
 * @returns {Object} Version history state and actions
 */
export function useVersionHistory(docGuid) {
  const { api } = useAuth();
  const [versions, setVersions] = useState([]);
  const [hierarchicalVersions, setHierarchicalVersions] = useState([]);
  const [totalEdits, setTotalEdits] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Unified selection state: { type: 'version', data: version } or { type: 'clock', clock: number, data: update }
  const [selection, setSelection] = useState(null);
  const [versionContent, setVersionContent] = useState(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  // Hierarchical drill-down state
  const [versionUpdates, setVersionUpdates] = useState({}); // { versionId: [updates] }
  const [loadingVersionUpdates, setLoadingVersionUpdates] = useState({}); // { versionId: boolean }

  // Group versions client-side using browser's local timezone
  const groupedVersions = useMemo(() => groupVersionsByPeriod(versions), [versions]);

  /**
   * Fetch version history timeline
   */
  const fetchHistory = useCallback(async () => {
    if (!docGuid) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await api.get(`/api/docs/${docGuid}/history`);
      setVersions(response.data.versions || []);
      setHierarchicalVersions(response.data.hierarchicalVersions || []);
      // groupedVersions is computed client-side via useMemo for proper local timezone handling
      setTotalEdits(response.data.totalEdits || 0);
    } catch (err) {
      console.error('Error fetching version history:', err);
      setError(err.response?.data?.error || 'Failed to load version history');
    } finally {
      setIsLoading(false);
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
   * Select a version and load its content
   */
  const selectVersion = useCallback(async (version) => {
    setSelection(version);
    if (version) {
      await loadVersionContent(version.id);
    } else {
      setVersionContent(null);
    }
  }, [loadVersionContent]);

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
   * Select a specific update (clock tick) and load its content
   * Treats the clock as a single-update "version" for unified selection
   */
  const selectUpdate = useCallback(async (update) => {
    // Create a version-like object for the single clock update
    setSelection({
      id: `clock-${update.clock}`,
      clock: update.clock,
      clockStart: update.clock,
      clockEnd: update.clock,
      timestamp: update.timestamp,
      authors: update.author ? [update.author] : [],
      isClock: true, // Flag to distinguish from grouped versions
    });
    await loadContentAtClock(update.clock);
  }, [loadContentAtClock]);

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
  }, []);

  /**
   * Refresh history data
   */
  const refresh = useCallback(() => {
    return fetchHistory();
  }, [fetchHistory]);

  // Load history on mount if docGuid is provided
  useEffect(() => {
    if (docGuid) {
      fetchHistory();
    }
  }, [docGuid, fetchHistory]);

  return {
    // State
    versions,
    groupedVersions,
    hierarchicalVersions,
    totalEdits,
    isLoading,
    error,
    selection, // Unified selection: version or single clock update (with isClock: true)
    versionContent,
    isLoadingContent,

    // Hierarchical drill-down state
    versionUpdates,
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
