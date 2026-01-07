import React, { useState, useEffect, useRef } from 'react';
import { shouldUseBrowserLinkBehavior } from '../utils/linkBehavior';
import { generateColorFromId } from '../utils/colorUtils';
import HierarchicalVersionList from './HierarchicalVersionList';
import './VersionHistoryPanel.css';

/**
 * Format timestamp in browser's local timezone
 * @param {string|Date} timestamp - ISO timestamp string or Date
 * @returns {string} Formatted timestamp (e.g., "December 10, 4:44 PM")
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const options = {
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  return date.toLocaleString(undefined, options);
}

function VersionHistoryPanel({
  docGuid,
  isOpen,
  onClose,
  onSelectVersion,
  selectedVersion,
  groupedVersions = [],
  hierarchicalVersions = [],
  totalEdits = 0,
  isLoading = false,
  onCreateNamedVersion,
  onRenameVersion,
  onDeleteVersion,
  onRestoreVersion,
  userRole,
  // Hierarchical drill-down props
  selectedUpdateClock,
  onSelectUpdate,
  onLoadUpdates,
  versionUpdates = {},
  loadingVersionUpdates = {},
  // Diff props
  showDiff,
  onToggleDiff,
}) {

  const [expandedGroups, setExpandedGroups] = useState({});
  const [filter, setFilter] = useState('all');
  const [viewMode, setViewMode] = useState('hierarchical'); // 'flat' or 'hierarchical'
  const [menuOpen, setMenuOpen] = useState(null);
  const menuRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(null);
      }
    };

    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [menuOpen]);

  const handleVersionClick = (version) => {
    if (onSelectVersion) {
      onSelectVersion(version);
    }
  };

  const toggleGroup = (label) => {
    setExpandedGroups(prev => ({
      ...prev,
      [label]: !prev[label],
    }));
  };

  const handleNameVersion = async (version) => {
    const name = prompt(version.name ? 'Rename version:' : 'Name this version:', version.name || '');
    if (name && name.trim()) {
      if (version.isNamed) {
        await onRenameVersion(version.id, name.trim());
      } else {
        await onCreateNamedVersion(name.trim(), version.clockEnd);
      }
    }
    setMenuOpen(null);
  };

  const handleDeleteVersion = async (version) => {
    if (window.confirm(`Remove name "${version.name}" from this version?`)) {
      await onDeleteVersion(version.id);
    }
    setMenuOpen(null);
  };

  const handleRestoreVersion = async (version) => {
    if (window.confirm('Restore this version? A new version will be created with the restored content.')) {
      const success = await onRestoreVersion(version.id);
      if (success) {
        window.location.reload();
      }
    }
    setMenuOpen(null);
  };

  // Filter versions based on selected filter
  const filteredGroupedVersions = filter === 'named'
    ? groupedVersions.map(group => ({
        ...group,
        versions: group.versions.filter(v => v.isNamed)
      })).filter(group => group.versions.length > 0)
    : groupedVersions;

  if (!isOpen) return null;

  return (
    <div className="version-history-panel">
      <div className="version-history-header">
        <h2>Version history</h2>
        <a
          href={`/d/${docGuid}`}
          className="version-history-close"
          onClick={(e) => {
            // Allow standard browser behaviors (Cmd+Click, Ctrl+Click, middle-click, etc.)
            if (shouldUseBrowserLinkBehavior(e)) {
              return; // Let the browser handle it
            }

            // For normal clicks, use the onClose handler
            e.preventDefault();
            onClose();
          }}
          aria-label="Close"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </a>
      </div>

      <div className="version-history-controls">
        <div className="version-history-filter">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All versions</option>
            <option value="named">Named versions only</option>
          </select>
        </div>
        <div className="version-history-view-toggle">
          <button
            className={`view-toggle-btn ${viewMode === 'hierarchical' ? 'active' : ''}`}
            onClick={() => setViewMode('hierarchical')}
            title="Hierarchical view"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/>
            </svg>
          </button>
          <button
            className={`view-toggle-btn ${viewMode === 'flat' ? 'active' : ''}`}
            onClick={() => setViewMode('flat')}
            title="Flat list view"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z"/>
            </svg>
          </button>
        </div>
        {onToggleDiff && (
          <button
            className={`diff-toggle-btn ${showDiff ? 'active' : ''}`}
            onClick={onToggleDiff}
            title={showDiff ? 'Hide diff highlighting' : 'Show diff highlighting'}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
            </svg>
            <span>Diff</span>
          </button>
        )}
      </div>

      {isLoading && (
        <div className="version-history-loading">Loading versions...</div>
      )}


      {!isLoading && filteredGroupedVersions.length === 0 && (
        <div className="version-history-empty">
          <p>{filter === 'named' ? 'No named versions yet.' : 'No version history yet.'}</p>
          <p className="version-history-empty-hint">
            {filter === 'named' ? 'Name a version using the menu on any version.' : 'Edit the document to start tracking versions.'}
          </p>
        </div>
      )}

      {/* Hierarchical view */}
      {viewMode === 'hierarchical' && !isLoading && hierarchicalVersions.length > 0 && (
        <HierarchicalVersionList
          hierarchicalVersions={hierarchicalVersions}
          selectedVersion={selectedVersion}
          selectedUpdateClock={selectedUpdateClock}
          onSelectVersion={onSelectVersion}
          onSelectUpdate={onSelectUpdate}
          onLoadUpdates={onLoadUpdates}
          versionUpdates={versionUpdates}
          loadingVersionUpdates={loadingVersionUpdates}
          onCreateNamedVersion={onCreateNamedVersion}
          onRenameVersion={onRenameVersion}
          onDeleteVersion={onDeleteVersion}
          onRestoreVersion={onRestoreVersion}
          userRole={userRole}
          isLoading={isLoading}
        />
      )}

      {/* Flat list view */}
      {viewMode === 'flat' && (
      <div className="version-history-list">
        {filteredGroupedVersions.map((group) => (
          <div key={group.label} className="version-group">
            <div className="version-group-header">
              <span className="version-group-label">{group.label}</span>
            </div>

            <div className="version-group-items">
              {group.versions.map((version, index) => {
                // Show first 10 versions, others only if expanded
                const INITIAL_SHOW_COUNT = 10;
                if (index >= INITIAL_SHOW_COUNT && !expandedGroups[group.label]) return null;

                const isSelected = selectedVersion?.id === version.id;

                return (
                  <div
                    key={version.id}
                    className={`version-item ${isSelected ? 'selected' : ''} ${version.isCurrent ? 'current' : ''}`}
                  >
                    <div className="version-item-content" onClick={() => handleVersionClick(version)}>
                      {version.name && (
                        <div className="version-item-name">{version.name}</div>
                      )}
                      <div className="version-item-time">
                        {formatTimestamp(version.timestamp)}
                      </div>
                      {version.isCurrent && (
                        <div className="version-item-badge">Current version</div>
                      )}
                      <div className="version-item-authors">
                        {version.authors?.map((author, i) => (
                          <div
                            key={author.id || i}
                            className="version-author"
                            title={author.name}
                          >
                            <span
                              className="version-author-dot"
                              style={{ backgroundColor: author.color || generateColorFromId(author.id) }}
                            />
                            <span className="version-author-name">
                              {author.name || 'Unknown'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="version-item-menu" ref={menuOpen === version.id ? menuRef : null}>
                      <button
                        className="version-menu-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpen(menuOpen === version.id ? null : version.id);
                        }}
                        title="Version options"
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                          <circle cx="12" cy="5" r="2"/>
                          <circle cx="12" cy="12" r="2"/>
                          <circle cx="12" cy="19" r="2"/>
                        </svg>
                      </button>

                      {menuOpen === version.id && (
                        <div className="version-menu-dropdown">
                          <button onClick={() => handleNameVersion(version)}>
                            {version.isNamed ? 'Rename' : 'Name this version'}
                          </button>
                          {!version.isCurrent && userRole !== 'viewer' && (
                            <button onClick={() => handleRestoreVersion(version)}>
                              Restore this version
                            </button>
                          )}
                          {version.isNamed && (
                            <button onClick={() => handleDeleteVersion(version)}>
                              Remove name
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {group.versions.length > 10 && !expandedGroups[group.label] && (
                <button
                  className="version-expand-btn"
                  onClick={() => toggleGroup(group.label)}
                >
                  Show more
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      )}

      {totalEdits > 0 && (
        <div className="version-history-footer">
          Total: {totalEdits} edit{totalEdits !== 1 ? 's' : ''}
        </div>
      )}

    </div>
  );
}

export default VersionHistoryPanel;
