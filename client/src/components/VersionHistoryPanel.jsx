import React, { useState, useEffect, useRef } from 'react';
import { shouldUseBrowserLinkBehavior } from '../utils/linkBehavior';
import HierarchicalVersionList from './HierarchicalVersionList';
import './VersionHistoryPanel.css';

function VersionHistoryPanel({
  docGuid,
  isOpen,
  onClose,
  onSelectVersion,
  selection, // Unified: version or clock update (with isClock: true)
  hierarchicalVersions = [],
  totalEdits = 0,
  isLoading = false,
  onCreateNamedVersion,
  onRenameVersion,
  onDeleteVersion,
  onRestoreVersion,
  userRole,
  // Hierarchical drill-down props
  onSelectUpdate,
  onLoadUpdates,
  versionUpdates = {},
  loadingVersionUpdates = {},
  // Diff highlighting toggle
  showDiffHighlights = true,
  onToggleDiffHighlights,
}) {
  const [filter, setFilter] = useState('all');

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
        <label className="version-history-highlight-toggle">
          <input
            type="checkbox"
            checked={showDiffHighlights}
            onChange={(e) => onToggleDiffHighlights?.(e.target.checked)}
          />
          Highlight changes
        </label>
      </div>

      {isLoading && (
        <div className="version-history-loading">Loading versions...</div>
      )}

      {!isLoading && hierarchicalVersions.length === 0 && (
        <div className="version-history-empty">
          <p>{filter === 'named' ? 'No named versions yet.' : 'No version history yet.'}</p>
          <p className="version-history-empty-hint">
            {filter === 'named' ? 'Name a version using the menu on any version.' : 'Edit the document to start tracking versions.'}
          </p>
        </div>
      )}

      {!isLoading && hierarchicalVersions.length > 0 && (
        <HierarchicalVersionList
          hierarchicalVersions={hierarchicalVersions}
          selection={selection}
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
          filter={filter}
        />
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
