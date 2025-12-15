import { useState, useCallback, useEffect, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * Group versions by time period for display (Today, Yesterday, This week, etc.)
 * Uses browser's local timezone for proper grouping
 * @param {Array} versions - Array of version objects with timestamp
 * @returns {Array} Grouped versions by period
 */
function groupVersionsByPeriod(versions) {
  if (!versions || versions.length === 0) return [];

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const thisWeekStart = new Date(today.getTime() - today.getDay() * 24 * 60 * 60 * 1000);
  const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const groups = {
    today: [],
    yesterday: [],
    thisWeek: [],
    lastWeek: [],
    thisMonth: [],
    older: [],
  };

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (const version of versions) {
    const versionDate = new Date(version.timestamp);
    const versionDay = new Date(versionDate.getFullYear(), versionDate.getMonth(), versionDate.getDate());

    if (versionDay.getTime() === today.getTime()) {
      groups.today.push(version);
    } else if (versionDay.getTime() === yesterday.getTime()) {
      groups.yesterday.push(version);
    } else if (versionDay >= thisWeekStart) {
      // Group by day name for this week
      const dayName = dayNames[versionDate.getDay()];
      if (!groups[dayName]) {
        groups[dayName] = [];
      }
      groups[dayName].push(version);
    } else if (versionDay >= lastWeekStart) {
      groups.lastWeek.push(version);
    } else if (versionDay >= thisMonthStart) {
      groups.thisMonth.push(version);
    } else {
      groups.older.push(version);
    }
  }

  // Sort versions within each group by timestamp descending (most recent first)
  const sortByRecent = (versions) =>
    versions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Build ordered result with display labels
  const result = [];

  if (groups.today.length > 0) {
    result.push({ label: 'Today', versions: sortByRecent(groups.today) });
  }
  if (groups.yesterday.length > 0) {
    result.push({ label: 'Yesterday', versions: sortByRecent(groups.yesterday) });
  }

  // Add this week's days in reverse order (most recent day first)
  for (let i = 6; i >= 0; i--) {
    const dayName = dayNames[i];
    if (groups[dayName] && groups[dayName].length > 0) {
      result.push({ label: dayName, versions: sortByRecent(groups[dayName]) });
    }
  }

  if (groups.lastWeek.length > 0) {
    result.push({ label: 'Last week', versions: sortByRecent(groups.lastWeek) });
  }
  if (groups.thisMonth.length > 0) {
    result.push({ label: 'This month', versions: sortByRecent(groups.thisMonth) });
  }
  if (groups.older.length > 0) {
    result.push({ label: 'Older', versions: sortByRecent(groups.older) });
  }

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
  const [totalEdits, setTotalEdits] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [versionContent, setVersionContent] = useState(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

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
    setSelectedVersion(version);
    if (version) {
      await loadVersionContent(version.id);
    } else {
      setVersionContent(null);
    }
  }, [loadVersionContent]);

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
   * Clear selected version and content
   */
  const clearSelection = useCallback(() => {
    setSelectedVersion(null);
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
    totalEdits,
    isLoading,
    error,
    selectedVersion,
    versionContent,
    isLoadingContent,

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
    setSelectedVersion,
  };
}

export default useVersionHistory;
