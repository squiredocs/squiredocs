import React, { useState } from 'react';
import { generateColorFromId } from '../utils/colorUtils';
import './HierarchicalVersionList.css';

// Maximum number of individual clock updates to show before combining
const MAX_VISIBLE_UPDATES = 20;

/**
 * Format date and time for version/update display
 * @param {string|Date} timestamp - ISO timestamp string or Date
 * @returns {string} Formatted date/time (e.g., "Jan 5, 4:30 PM")
 */
function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Chevron icon component
 */
function ChevronIcon({ expanded }) {
  return (
    <svg
      className={`hierarchy-chevron ${expanded ? 'expanded' : ''}`}
      viewBox="0 0 24 24"
      fill="currentColor"
      width="16"
      height="16"
    >
      <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
    </svg>
  );
}

/**
 * Author list component - shared between versions and updates
 */
function AuthorList({ authors, maxDisplay = null }) {
  if (!authors || authors.length === 0) return null;

  const displayAuthors = maxDisplay ? authors.slice(0, maxDisplay) : authors;
  const remaining = maxDisplay ? authors.length - maxDisplay : 0;

  return (
    <div className="hierarchy-version-authors">
      {displayAuthors.map((author, i) => (
        <div key={author.id || i} className="hierarchy-author" title={author.name}>
          <span
            className="hierarchy-author-dot"
            style={{ backgroundColor: author.color || generateColorFromId(author.id) }}
          />
          <span className="hierarchy-author-name">{author.name || 'Unknown'}</span>
        </div>
      ))}
      {remaining > 0 && (
        <span className="hierarchy-author-more">+{remaining} more</span>
      )}
    </div>
  );
}

/**
 * Shared content display for both versions and updates
 */
function ItemContent({ name, timestamp, subtitle, badge, authors, maxAuthors }) {
  return (
    <>
      {name && <div className="hierarchy-version-name">{name}</div>}
      <div className="hierarchy-version-time">{formatDateTime(timestamp)}</div>
      {subtitle && <div className="hierarchy-item-subtitle">{subtitle}</div>}
      {badge && <div className="hierarchy-version-badge">{badge}</div>}
      <AuthorList authors={authors} maxDisplay={maxAuthors} />
    </>
  );
}

/**
 * Version menu dropdown component
 */
function VersionMenu({ version, menuOpen, menuRef, onMenuOpen, onNameVersion, onRestoreVersion, onDeleteVersion, userRole }) {
  return (
    <div className="hierarchy-version-menu" ref={menuOpen ? menuRef : null}>
      <button
        className="hierarchy-menu-btn"
        onClick={(e) => {
          e.stopPropagation();
          onMenuOpen();
        }}
        title="Version options"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <circle cx="12" cy="5" r="2"/>
          <circle cx="12" cy="12" r="2"/>
          <circle cx="12" cy="19" r="2"/>
        </svg>
      </button>
      {menuOpen && (
        <div className="hierarchy-menu-dropdown">
          <button onClick={onNameVersion}>
            {version.isNamed ? 'Rename' : 'Name this version'}
          </button>
          {!version.isCurrent && userRole !== 'viewer' && (
            <button onClick={onRestoreVersion}>
              Restore this version
            </button>
          )}
          {version.isNamed && (
            <button onClick={onDeleteVersion}>
              Remove name
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Update item component (Level 2 - individual clock ticks)
 */
function UpdateItem({ update, isSelected, onClick }) {
  const authors = update.author ? [update.author] : [];

  return (
    <div
      className={`hierarchy-item hierarchy-update ${isSelected ? 'selected' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <div className="hierarchy-item-content">
        <ItemContent
          timestamp={update.timestamp}
          subtitle={`Clock ${update.clock}`}
          authors={authors}
        />
      </div>
    </div>
  );
}

/**
 * Combined updates item - represents multiple older updates collapsed into one
 */
function CombinedUpdatesItem({ updates, isSelected, onClick }) {
  // Collect unique authors from all combined updates
  const authorsMap = new Map();
  for (const update of updates) {
    if (update.author) {
      const key = `${update.author.id}-${update.author.isAgent ? 'agent' : 'user'}`;
      if (!authorsMap.has(key)) {
        authorsMap.set(key, update.author);
      }
    }
  }
  const authors = Array.from(authorsMap.values());

  const oldestUpdate = updates[updates.length - 1];
  const newestUpdate = updates[0];

  return (
    <div
      className={`hierarchy-item hierarchy-update hierarchy-combined ${isSelected ? 'selected' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <div className="hierarchy-item-content">
        <div className="hierarchy-version-time">
          {updates.length} earlier updates
        </div>
        <div className="hierarchy-item-subtitle">
          Clock {oldestUpdate.clock}–{newestUpdate.clock}
        </div>
        <AuthorList authors={authors} maxDisplay={3} />
      </div>
    </div>
  );
}

/**
 * Version item component (Level 1 - 5-minute groupings)
 */
function VersionItem({
  version,
  isSelected,
  isExpanded,
  updates,
  isLoadingUpdates,
  onToggle,
  onClick,
  onUpdateClick,
  selection,
  onMenuOpen,
  menuOpen,
  onNameVersion,
  onRestoreVersion,
  onDeleteVersion,
  userRole,
  menuRef,
}) {
  return (
    <div className={`hierarchy-item hierarchy-version ${isSelected ? 'selected' : ''}`}>
      <div className="hierarchy-version-header" onClick={onClick}>
        <button
          className="hierarchy-expand-btn"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
        >
          <ChevronIcon expanded={isExpanded} />
        </button>
        <div className="hierarchy-item-content">
          <ItemContent
            name={version.name}
            timestamp={version.timestamp}
            badge={version.isCurrent ? 'Current' : null}
            authors={version.authors}
            maxAuthors={3}
          />
        </div>
        <VersionMenu
          version={version}
          menuOpen={menuOpen}
          menuRef={menuRef}
          onMenuOpen={onMenuOpen}
          onNameVersion={onNameVersion}
          onRestoreVersion={onRestoreVersion}
          onDeleteVersion={onDeleteVersion}
          userRole={userRole}
        />
      </div>

      {isExpanded && (
        <div className="hierarchy-updates-list">
          {isLoadingUpdates ? (
            <div className="hierarchy-loading">Loading updates...</div>
          ) : updates && updates.length > 0 ? (
            <>
              {/* Show most recent updates individually */}
              {updates.slice(0, MAX_VISIBLE_UPDATES).map((update) => (
                <UpdateItem
                  key={update.clock}
                  update={update}
                  isSelected={selection?.isClock && selection?.clock === update.clock}
                  onClick={() => onUpdateClick(update)}
                />
              ))}
              {/* Combine older updates into a single item */}
              {updates.length > MAX_VISIBLE_UPDATES && (
                <CombinedUpdatesItem
                  updates={updates.slice(MAX_VISIBLE_UPDATES)}
                  isSelected={selection?.isClock && updates.slice(MAX_VISIBLE_UPDATES).some(u => u.clock === selection?.clock)}
                  onClick={() => onUpdateClick(updates[MAX_VISIBLE_UPDATES])}
                />
              )}
            </>
          ) : (
            <div className="hierarchy-empty">No individual updates</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * HierarchicalVersionList component
 * Displays version history in a hierarchical drill-down format:
 * Month (January 2025) > Version (Jan 5, 4:30 PM) > Updates (clock ticks)
 */
function HierarchicalVersionList({
  hierarchicalVersions = [],
  selection, // Unified: version or clock update (with isClock: true)
  onSelectVersion,
  onSelectUpdate,
  onLoadUpdates,
  versionUpdates = {},
  loadingVersionUpdates = {},
  onCreateNamedVersion,
  onRenameVersion,
  onDeleteVersion,
  onRestoreVersion,
  userRole,
  isLoading,
  filter = 'all', // 'all' or 'named'
}) {
  // Filter versions based on filter prop
  const filteredVersions = filter === 'named'
    ? hierarchicalVersions.map(month => ({
        ...month,
        versions: month.versions.filter(v => v.isNamed)
      })).filter(month => month.versions.length > 0)
    : hierarchicalVersions;

  // Auto-expand first month
  const firstMonthLabel = filteredVersions[0]?.label;
  const [expandedMonths, setExpandedMonths] = useState(() => {
    return firstMonthLabel ? { [firstMonthLabel]: true } : {};
  });
  const [expandedVersions, setExpandedVersions] = useState({});
  const [menuOpen, setMenuOpen] = useState(null);
  const menuRef = React.useRef(null);

  // Close menu when clicking outside
  React.useEffect(() => {
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

  const toggleMonth = (label) => {
    setExpandedMonths(prev => ({ ...prev, [label]: !prev[label] }));
  };

  const toggleVersion = (version) => {
    const versionId = version.id;
    const willExpand = !expandedVersions[versionId];
    setExpandedVersions(prev => ({ ...prev, [versionId]: willExpand }));

    // Load updates when expanding if not already loaded
    if (willExpand && !versionUpdates[versionId] && onLoadUpdates) {
      onLoadUpdates(version.clockStart, version.clockEnd, versionId);
    }
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

  if (isLoading) {
    return <div className="hierarchy-loading">Loading versions...</div>;
  }

  if (!filteredVersions || filteredVersions.length === 0) {
    return (
      <div className="hierarchy-empty-state">
        <p>{filter === 'named' ? 'No named versions yet.' : 'No version history yet.'}</p>
        <p className="hierarchy-empty-hint">
          {filter === 'named' ? 'Name a version using the menu on any version.' : 'Edit the document to start tracking versions.'}
        </p>
      </div>
    );
  }

  return (
    <div className="hierarchy-list">
      {filteredVersions.map((month) => (
        <div key={month.label} className="hierarchy-month">
          <div
            className="hierarchy-month-header"
            onClick={() => toggleMonth(month.label)}
          >
            <ChevronIcon expanded={expandedMonths[month.label]} />
            <span className="hierarchy-month-label">{month.label}</span>
          </div>

          {expandedMonths[month.label] && (
            <div className="hierarchy-versions-list">
              {month.versions.map((version) => (
                <VersionItem
                  key={version.id}
                  version={version}
                  isSelected={selection?.id === version.id && !selection?.isClock}
                  isExpanded={expandedVersions[version.id]}
                  updates={versionUpdates[version.id]}
                  isLoadingUpdates={loadingVersionUpdates[version.id]}
                  onToggle={() => toggleVersion(version)}
                  onClick={() => onSelectVersion(version)}
                  onUpdateClick={onSelectUpdate}
                  selection={selection}
                  menuOpen={menuOpen === version.id}
                  onMenuOpen={() => setMenuOpen(version.id)}
                  onNameVersion={() => handleNameVersion(version)}
                  onRestoreVersion={() => handleRestoreVersion(version)}
                  onDeleteVersion={() => handleDeleteVersion(version)}
                  userRole={userRole}
                  menuRef={menuRef}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default HierarchicalVersionList;
