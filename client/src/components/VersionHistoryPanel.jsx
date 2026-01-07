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
  // Diff props
  showDiff,
  onToggleDiff,
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
