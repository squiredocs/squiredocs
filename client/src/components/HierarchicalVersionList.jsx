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
        <div key={`${author.id}-${i}`} className="hierarchy-author" title={author.name}>
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
 * Item menu dropdown component - shared between versions and sub-versions
 */
function ItemMenu({ item, menuOpen, menuRef, onMenuOpen, onNameVersion, onRestoreVersion, onDeleteVersion, userRole }) {
  const canRestore = !item.isCurrent && userRole !== 'viewer';
  const canName = userRole !== 'viewer';
  const canRename = item.isNamed;
  const canRemoveName = item.isNamed && !item.isSubVersion;

  return (
    <div className="hierarchy-version-menu" ref={menuOpen ? menuRef : null}>
      <button
        className="hierarchy-menu-btn"
        onMouseDown={(e) => e.stopPropagation()}
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
          {canName && (
            <button onClick={onNameVersion}>
              {canRename ? 'Rename' : 'Name this version'}
            </button>
          )}
          {canRestore && (
            <button onClick={onRestoreVersion}>
              Restore this version
            </button>
          )}
          {canRemoveName && (
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
 * Convert a sub-version to a unified item format
 */
function subVersionToItem(subVersion) {
  const isSingleUpdate = subVersion.clockStart === subVersion.clockEnd;
  return {
    id: subVersion.id,
    clockStart: subVersion.clockStart,
    clockEnd: subVersion.clockEnd,
    timestamp: subVersion.timestamp,
    authors: subVersion.authors || [],
    isSubVersion: true,
    isCurrent: false,
    subtitle: isSingleUpdate
      ? `Clock ${subVersion.clockStart}`
      : `Clocks ${subVersion.clockStart}–${subVersion.clockEnd}`,
    updateCount: subVersion.updateCount,
  };
}

/**
 * Combined sub-versions item - represents multiple older sub-versions collapsed into one
 */
function CombinedSubVersionsItem({ subVersions, isSelected, onClick }) {
  // Collect unique authors from all combined sub-versions
  const authorsMap = new Map();
  for (const sv of subVersions) {
    for (const author of (sv.authors || [])) {
      const key = `${author.id}-${author.isAgent ? 'agent' : 'user'}`;
      if (!authorsMap.has(key)) {
        authorsMap.set(key, author);
      }
    }
  }
  const authors = Array.from(authorsMap.values());

  const oldestSv = subVersions[subVersions.length - 1];
  const newestSv = subVersions[0];

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
          {subVersions.length} earlier edits
        </div>
        <div className="hierarchy-item-subtitle">
          Clocks {oldestSv.clockStart}–{newestSv.clockEnd}
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
  const isVersion = !item.isSubVersion;
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

  const handleNameItem = async (item) => {
    const name = prompt(item.name ? 'Rename version:' : 'Name this version:', item.name || '');
    if (name && name.trim()) {
      if (item.isNamed) {
        await onRenameVersion(item.id, name.trim());
      } else {
        // Use clockEnd for both versions and sub-versions
        await onCreateNamedVersion(name.trim(), item.clockEnd);
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
                // Add clock range subtitle to versions
                const versionWithSubtitle = {
                  ...version,
                  subtitle: version.clockStart === version.clockEnd
                    ? `Clock ${version.clockStart}`
                    : `Clocks ${version.clockStart}–${version.clockEnd}`,
                };

                return (
                  <HistoryItem
                    key={version.id}
                    item={versionWithSubtitle}
                    isSelected={selection?.id === version.id && !selection?.isClock}
                    onClick={() => onSelectVersion(version)}
                    isExpandable={true}
                    isExpanded={isExpanded}
                    onToggle={() => toggleVersion(version)}
                    menuOpen={menuOpen === version.id}
                    menuRef={menuRef}
                    onMenuOpen={() => setMenuOpen(prev => prev === version.id ? null : version.id)}
                    onNameVersion={() => handleNameItem(version)}
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
                            {updates.slice(0, MAX_VISIBLE_UPDATES).map((subVersion) => {
                              const subVersionItem = subVersionToItem(subVersion);
                              const menuKey = `sub-${subVersion.id}`;
                              return (
                                <HistoryItem
                                  key={subVersion.id}
                                  item={subVersionItem}
                                  isSelected={selection?.isSubVersion && selection?.id === subVersion.id}
                                  onClick={() => onSelectUpdate(subVersion)}
                                  menuOpen={menuOpen === menuKey}
                                  menuRef={menuRef}
                                  onMenuOpen={() => setMenuOpen(prev => prev === menuKey ? null : menuKey)}
                                  onNameVersion={() => handleNameItem(subVersionItem)}
                                  onRestoreVersion={() => handleRestoreItem(subVersionItem)}
                                  userRole={userRole}
                                />
                              );
                            })}
                            {updates.length > MAX_VISIBLE_UPDATES && (
                              <CombinedSubVersionsItem
                                subVersions={updates.slice(MAX_VISIBLE_UPDATES)}
                                isSelected={selection?.isSubVersion && updates.slice(MAX_VISIBLE_UPDATES).some(sv => sv.id === selection?.id)}
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
