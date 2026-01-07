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
 * Item menu dropdown component - shared between versions and clock updates
 */
function ItemMenu({ item, menuOpen, menuRef, onMenuOpen, onNameVersion, onRestoreVersion, onDeleteVersion, userRole }) {
  const isVersion = !item.isClock;
  const canRestore = !item.isCurrent && userRole !== 'viewer';

  return (
    <div className="hierarchy-version-menu" ref={menuOpen ? menuRef : null}>
      <button
        className="hierarchy-menu-btn"
        onClick={(e) => {
          e.stopPropagation();
          onMenuOpen();
        }}
        title="Options"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <circle cx="12" cy="5" r="2"/>
          <circle cx="12" cy="12" r="2"/>
          <circle cx="12" cy="19" r="2"/>
        </svg>
      </button>
      {menuOpen && (
        <div className="hierarchy-menu-dropdown">
          {isVersion && (
            <button onClick={onNameVersion}>
              {item.isNamed ? 'Rename' : 'Name this version'}
            </button>
          )}
          {canRestore && (
            <button onClick={onRestoreVersion}>
              Restore this version
            </button>
          )}
          {isVersion && item.isNamed && (
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
 * Convert a clock update to a unified item format
 */
function clockToItem(update) {
  return {
    id: `clock-${update.clock}`,
    clock: update.clock,
    timestamp: update.timestamp,
    authors: update.author ? [update.author] : [],
    isClock: true,
    isCurrent: false,
    subtitle: `Clock ${update.clock}`,
  };
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
 * Unified history item component - renders both versions and clock updates
 */
function HistoryItem({
  item,
  isSelected,
  onClick,
  // Expandable props (versions only)
  isExpandable = false,
  isExpanded = false,
  onToggle,
  children,
  // Menu props
  menuOpen,
  menuRef,
  onMenuOpen,
  onNameVersion,
  onRestoreVersion,
  onDeleteVersion,
  userRole,
}) {
  const isVersion = !item.isClock;
  const itemClass = isVersion ? 'hierarchy-version' : 'hierarchy-update';

  return (
    <div className={`hierarchy-item ${itemClass} ${isSelected ? 'selected' : ''}`}>
      <div className={isVersion ? 'hierarchy-version-header' : 'hierarchy-update-header'} onClick={onClick}>
        {isExpandable && (
          <button
            className="hierarchy-expand-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.();
            }}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            <ChevronIcon expanded={isExpanded} />
          </button>
        )}
        <div className="hierarchy-item-content">
          <ItemContent
            name={item.name}
            timestamp={item.timestamp}
            subtitle={item.subtitle}
            badge={item.isCurrent ? 'Current' : null}
            authors={item.authors}
            maxAuthors={3}
          />
        </div>
        <ItemMenu
          item={item}
          menuOpen={menuOpen}
          menuRef={menuRef}
          onMenuOpen={onMenuOpen}
          onNameVersion={onNameVersion}
          onRestoreVersion={onRestoreVersion}
          onDeleteVersion={onDeleteVersion}
          userRole={userRole}
        />
      </div>
      {children}
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

  const handleRestoreItem = async (item) => {
    if (window.confirm('Restore this version? A new version will be created with the restored content.')) {
      const success = await onRestoreVersion(item.id);
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
              {month.versions.map((version) => {
                const updates = versionUpdates[version.id];
                const isExpanded = expandedVersions[version.id];

                return (
                  <HistoryItem
                    key={version.id}
                    item={version}
                    isSelected={selection?.id === version.id && !selection?.isClock}
                    onClick={() => onSelectVersion(version)}
                    isExpandable={true}
                    isExpanded={isExpanded}
                    onToggle={() => toggleVersion(version)}
                    menuOpen={menuOpen === version.id}
                    menuRef={menuRef}
                    onMenuOpen={() => setMenuOpen(version.id)}
                    onNameVersion={() => handleNameVersion(version)}
                    onRestoreVersion={() => handleRestoreItem(version)}
                    onDeleteVersion={() => handleDeleteVersion(version)}
                    userRole={userRole}
                  >
                    {isExpanded && (
                      <div className="hierarchy-updates-list">
                        {loadingVersionUpdates[version.id] ? (
                          <div className="hierarchy-loading">Loading updates...</div>
                        ) : updates && updates.length > 0 ? (
                          <>
                            {updates.slice(0, MAX_VISIBLE_UPDATES).map((update) => {
                              const clockItem = clockToItem(update);
                              const menuKey = `clock-${update.clock}`;
                              return (
                                <HistoryItem
                                  key={update.clock}
                                  item={clockItem}
                                  isSelected={selection?.isClock && selection?.clock === update.clock}
                                  onClick={() => onSelectUpdate(update)}
                                  menuOpen={menuOpen === menuKey}
                                  menuRef={menuRef}
                                  onMenuOpen={() => setMenuOpen(menuKey)}
                                  onRestoreVersion={() => handleRestoreItem(clockItem)}
                                  userRole={userRole}
                                />
                              );
                            })}
                            {updates.length > MAX_VISIBLE_UPDATES && (
                              <CombinedUpdatesItem
                                updates={updates.slice(MAX_VISIBLE_UPDATES)}
                                isSelected={selection?.isClock && updates.slice(MAX_VISIBLE_UPDATES).some(u => u.clock === selection?.clock)}
                                onClick={() => onSelectUpdate(updates[MAX_VISIBLE_UPDATES])}
                              />
                            )}
                          </>
                        ) : (
                          <div className="hierarchy-empty">No individual updates</div>
                        )}
                      </div>
                    )}
                  </HistoryItem>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default HierarchicalVersionList;
