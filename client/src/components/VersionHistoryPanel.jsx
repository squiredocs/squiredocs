import React, { useState } from 'react';
import './VersionHistoryPanel.css';

/**
 * Generate a deterministic color from a user ID
 */
function generateColorFromId(id) {
  if (!id) return '#888888';
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

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
  totalEdits = 0,
  isLoading = false,
}) {

  const [expandedGroups, setExpandedGroups] = useState({});

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

  if (!isOpen) return null;

  return (
    <div className="version-history-panel">
      <div className="version-history-header">
        <h2>Version history</h2>
        <button className="version-history-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="version-history-filter">
        <select defaultValue="all">
          <option value="all">All versions</option>
          <option value="named">Named versions only</option>
        </select>
      </div>

      {isLoading && (
        <div className="version-history-loading">Loading versions...</div>
      )}


      {!isLoading && groupedVersions.length === 0 && (
        <div className="version-history-empty">
          <p>No version history yet.</p>
          <p className="version-history-empty-hint">Edit the document to start tracking versions.</p>
        </div>
      )}

      <div className="version-history-list">
        {groupedVersions.map((group) => (
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
                    onClick={() => handleVersionClick(version)}
                  >
                    <div className="version-item-content">
                      <div className="version-item-time">
                        {version.name || formatTimestamp(version.timestamp)}
                      </div>
                      {version.isCurrent && (
                        <div className="version-item-badge">Current version</div>
                      )}
                      {version.isNamed && !version.isCurrent && (
                        <div className="version-item-badge named">Named version</div>
                      )}
                      <div className="version-item-authors">
                        {version.authors?.slice(0, 3).map((author, i) => (
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
                        {version.authors?.length > 3 && (
                          <div className="version-author-more">
                            +{version.authors.length - 3} more
                          </div>
                        )}
                      </div>
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

      {totalEdits > 0 && (
        <div className="version-history-footer">
          Total: {totalEdits} edit{totalEdits !== 1 ? 's' : ''}
        </div>
      )}

    </div>
  );
}

export default VersionHistoryPanel;
