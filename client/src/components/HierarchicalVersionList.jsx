import React, { useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { generateColorFromId } from '../utils/colorUtils';
import VersionNameDialog from './VersionNameDialog';
import VersionConfirmDialog from './VersionConfirmDialog';
import './HierarchicalVersionList.css';

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
 * On-behalf-of provenance for sync (Repo Sync) pushes — feature 004, D8.
 * The server dedupes pushes by identity (name+email) and caps the list at 10
 * distinct identities with a `moreIdentities` overflow count (review note #5),
 * so each entry is { name?, email?, commitCount, latestCommit?, latestUrl? }.
 *
 * Rendered STRICTLY as plain text (never as markup or a live link): every value
 * comes from untrusted push metadata and is displayed inertly. React escapes it
 * by default, so a hostile string renders as literal characters.
 */
function OnBehalfOfList({ onBehalfOf, moreIdentities = 0 }) {
  const identities = onBehalfOf || [];
  if (identities.length === 0 && moreIdentities <= 0) return null;
  return (
    <div className="hierarchy-onbehalfof">
      {identities.map((p, i) => {
        const idParts = [];
        if (p.name) idParts.push(p.name);
        if (p.email) idParts.push(p.email);
        const identity = idParts.join(' · ') || 'unknown';

        const detailParts = [];
        if (typeof p.commitCount === 'number' && p.commitCount > 0) {
          detailParts.push(`${p.commitCount} ${p.commitCount === 1 ? 'push' : 'pushes'}`);
        }
        if (p.latestCommit) detailParts.push(`latest ${p.latestCommit}`);
        if (p.latestUrl) detailParts.push(p.latestUrl); // shown as text, not a link (D6)
        const detail = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';

        return (
          <div key={i} className="hierarchy-onbehalfof-line" title="On behalf of">
            on behalf of {identity}{detail}
          </div>
        );
      })}
      {moreIdentities > 0 && (
        <div className="hierarchy-onbehalfof-line hierarchy-onbehalfof-more">
          +{moreIdentities} more
        </div>
      )}
    </div>
  );
}

/**
 * Shared content display for both versions and updates
 */
function ItemContent({ name, timestamp, subtitle, badge, authors, maxAuthors, onBehalfOf, onBehalfOfMore }) {
  return (
    <>
      {name && <div className="hierarchy-version-name">{name}</div>}
      <div className="hierarchy-version-time">{formatDateTime(timestamp)}</div>
      {subtitle && <div className="hierarchy-item-subtitle">{subtitle}</div>}
      {badge && <div className="hierarchy-version-badge">{badge}</div>}
      <AuthorList authors={authors} maxDisplay={maxAuthors} />
      <OnBehalfOfList onBehalfOf={onBehalfOf} moreIdentities={onBehalfOfMore} />
    </>
  );
}

/**
 * Compute a fixed-position anchor for the portaled menu dropdown from the trigger
 * button's viewport rect (024/R2). Right-aligns to the button, clamps into the
 * viewport, and flips above the button when there is not enough room below.
 */
function computeMenuPosition(rect, itemCount) {
  const GAP = 4;
  const MENU_WIDTH = 200; // min-width 180 + inner padding
  const MENU_HEIGHT = Math.max(itemCount, 1) * 44 + 8; // per-item ~44px + padding
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;

  const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, vw - MENU_WIDTH - 8));
  const spaceBelow = vh - rect.bottom;
  const openAbove = spaceBelow < MENU_HEIGHT && rect.top > spaceBelow;

  return openAbove
    ? { left, bottom: Math.max(8, vh - rect.top + GAP), placement: 'above' }
    : { left, top: rect.bottom + GAP, placement: 'below' };
}

/**
 * Item menu dropdown component - shared between versions and sub-versions.
 *
 * The dropdown is portaled to document.body with fixed positioning so it is never
 * clipped by the version list's `overflow-y:auto` scroll container (024/FR-003/R2).
 * `dropdownRef` is attached to the portaled node so the parent's outside-tap
 * dismissal counts the (out-of-tree) dropdown as "inside".
 */
function ItemMenu({ item, menuOpen, menuRef, dropdownRef, onMenuOpen, onNameVersion, onRestoreVersion, onDeleteVersion, userRole }) {
  const canRestore = !item.isCurrent && userRole !== 'viewer';
  // Naming a version is permitted for viewer+ (Sam-ratified 2026-07-19, F9):
  // matches the REST/MCP server behavior, which allows any role with access.
  // Restore stays edit-only (it mutates the live doc); naming is non-destructive.
  const canName = !!userRole;
  const canRename = item.isNamed;
  const canRemoveName = item.isNamed && !item.isSubVersion;

  const btnRef = useRef(null);
  const [pos, setPos] = useState(null);
  const itemCount = (canName ? 1 : 0) + (canRestore ? 1 : 0) + (canRemoveName ? 1 : 0);

  useLayoutEffect(() => {
    if (menuOpen && btnRef.current) {
      setPos(computeMenuPosition(btnRef.current.getBoundingClientRect(), itemCount));
    } else {
      setPos(null);
    }
    // itemCount is stable for a given item/role; recompute only on open toggle.
  }, [menuOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const dropdownStyle = pos
    ? {
        position: 'fixed',
        left: `${pos.left}px`,
        ...(pos.placement === 'above'
          ? { bottom: `${pos.bottom}px` }
          : { top: `${pos.top}px` }),
      }
    : { position: 'fixed', visibility: 'hidden' };

  return (
    <div className="hierarchy-version-menu" ref={menuOpen ? menuRef : null}>
      <button
        ref={btnRef}
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
      {menuOpen && createPortal(
        <div
          className="hierarchy-menu-dropdown hierarchy-menu-dropdown--fixed"
          ref={dropdownRef}
          style={dropdownStyle}
          onMouseDown={(e) => e.stopPropagation()}
        >
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
        </div>,
        document.body
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
  dropdownRef,
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
            onBehalfOf={item.onBehalfOf}
            onBehalfOfMore={item.onBehalfOfMore}
          />
        </div>
        <ItemMenu
          item={item}
          menuOpen={menuOpen}
          menuRef={menuRef}
          dropdownRef={dropdownRef}
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
  versionUpdatesMeta = {},
  loadingVersionUpdates = {},
  onCreateNamedVersion,
  onRenameVersion,
  onDeleteVersion,
  onRestoreVersion,
  userRole,
  isLoading,
  filter = 'all', // 'all' or 'named'
  docGuid,
  onNavigateToDoc, // post-restore in-app navigation (024/US4); always wired by App
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
  // The dropdown is portaled out of the row's DOM subtree, so the outside-tap test
  // must treat the portaled node as "inside" too (024/R3).
  const dropdownRef = React.useRef(null);

  // Close menu when tapping/clicking outside, or when the viewport scrolls/resizes
  // (a fixed-positioned portal would otherwise linger at a stale anchor — 024/R2/R3).
  React.useEffect(() => {
    if (!menuOpen) return;

    const handlePointerOutside = (event) => {
      const inButton = menuRef.current && menuRef.current.contains(event.target);
      const inDropdown = dropdownRef.current && dropdownRef.current.contains(event.target);
      if (!inButton && !inDropdown) {
        setMenuOpen(null);
      }
    };
    const closeMenu = () => setMenuOpen(null);

    // pointerdown covers mouse + touch + pen in one path (fixes touch dismissal).
    document.addEventListener('pointerdown', handlePointerOutside);
    document.addEventListener('scroll', closeMenu, true); // capture: catches inner scrollers
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('pointerdown', handlePointerOutside);
      document.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('resize', closeMenu);
    };
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

  // In-app dialog state replacing the native prompt/confirm calls (024/US2).
  // `item` is captured at open time so a mid-flight history refresh can't make the
  // action target a stale row (Edge Case: "Dialog open during data refresh").
  // Shape: { kind: 'name'|'rename'|'restore'|'removeName', item, busy, error } | null.
  const [dialog, setDialog] = useState(null);

  const openNameDialog = (item) => {
    setMenuOpen(null);
    setDialog({ kind: item.isNamed ? 'rename' : 'name', item, busy: false, error: null });
  };

  const openRestoreDialog = (item) => {
    setMenuOpen(null);
    setDialog({ kind: 'restore', item, busy: false, error: null });
  };

  const openRemoveNameDialog = (item) => {
    setMenuOpen(null);
    setDialog({ kind: 'removeName', item, busy: false, error: null });
  };

  const closeDialog = () => setDialog(null);

  const runDialogAction = async (fn, failureMessage) => {
    setDialog(prev => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      return await fn();
    } catch (err) {
      setDialog(prev => (prev ? { ...prev, busy: false, error: err?.message || failureMessage } : prev));
      return undefined;
    }
  };

  const handleConfirmName = async (trimmedName) => {
    const item = dialog?.item;
    if (!item) return;
    // Rename by id; name by clockEnd — semantics preserved exactly (024/C5, FR-005).
    const result = await runDialogAction(
      () => (item.isNamed
        ? onRenameVersion(item.id, trimmedName)
        : onCreateNamedVersion(trimmedName, item.clockEnd)),
      'Failed to save the version name.'
    );
    if (result === undefined) return; // threw — error already surfaced, stay open
    // The hook signals failure without throwing: createNamedVersion → null,
    // renameVersion → false. Keep the dialog open with the error (FR-006).
    if (result === false || result === null) {
      setDialog(prev => (prev ? { ...prev, busy: false, error: 'Failed to save the version name.' } : prev));
      return;
    }
    closeDialog();
  };

  const handleConfirmRemoveName = async () => {
    const item = dialog?.item;
    if (!item) return;
    const result = await runDialogAction(
      () => onDeleteVersion(item.id),
      'Failed to remove the version name.'
    );
    if (result === undefined) return; // threw — error already surfaced, stay open
    // deleteNamedVersion signals failure as false, not a throw (FR-006).
    if (result === false || result === null) {
      setDialog(prev => (prev ? { ...prev, busy: false, error: 'Failed to remove the version name.' } : prev));
      return;
    }
    closeDialog();
  };

  const handleConfirmRestore = async () => {
    const item = dialog?.item;
    if (!item) return;
    const success = await runDialogAction(
      () => onRestoreVersion(item.id),
      'Failed to restore this version.'
    );
    if (success === undefined) return; // threw — error already surfaced, stay open
    if (success) {
      closeDialog();
      // In-app navigation to the live doc — never a full page reload (024/FR-012).
      if (onNavigateToDoc && docGuid) {
        onNavigateToDoc(docGuid);
      }
    } else {
      // Server rejected the restore — keep the dialog open with an error.
      setDialog(prev => (prev ? { ...prev, busy: false, error: 'Failed to restore this version.' } : prev));
    }
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

  const dialogItem = dialog?.item;
  const removeNameMessage = dialogItem?.name
    ? `Remove the name "${dialogItem.name}" from this version?`
    : 'Remove the name from this version?';

  return (
    <>
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
                    // A sub-version shares its parent's id (both String(clockEnd)),
                    // so guard on isSubVersion — the flag selectUpdate actually
                    // sets — to keep selecting a sub-version from ALSO highlighting
                    // its parent. (isClock was never set anywhere.)
                    isSelected={selection?.id === version.id && !selection?.isSubVersion}
                    onClick={() => onSelectVersion(version)}
                    isExpandable={true}
                    isExpanded={isExpanded}
                    onToggle={() => toggleVersion(version)}
                    menuOpen={menuOpen === version.id}
                    menuRef={menuRef}
                    dropdownRef={dropdownRef}
                    onMenuOpen={() => setMenuOpen(prev => prev === version.id ? null : version.id)}
                    onNameVersion={() => openNameDialog(version)}
                    onRestoreVersion={() => openRestoreDialog(version)}
                    onDeleteVersion={() => openRemoveNameDialog(version)}
                    userRole={userRole}
                  >
                    {isExpanded && (
                      <div className="hierarchy-updates-list">
                        {loadingVersionUpdates[version.id] ? (
                          <div className="hierarchy-loading">Loading updates...</div>
                        ) : updates && updates.length > 0 ? (
                          <>
                            {updates.map((subVersion) => {
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
                                  dropdownRef={dropdownRef}
                                  onMenuOpen={() => setMenuOpen(prev => prev === menuKey ? null : menuKey)}
                                  onNameVersion={() => openNameDialog(subVersionItem)}
                                  onRestoreVersion={() => openRestoreDialog(subVersionItem)}
                                  userRole={userRole}
                                />
                              );
                            })}
                            {versionUpdatesMeta[version.id]?.hasMore && (
                              <div className="hierarchy-updates-more">
                                Showing {updates.length} of {versionUpdatesMeta[version.id].total} edits
                              </div>
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

    <VersionNameDialog
      isOpen={dialog?.kind === 'name' || dialog?.kind === 'rename'}
      mode={dialog?.kind === 'rename' ? 'rename' : 'name'}
      initialValue={dialog?.kind === 'rename' ? (dialogItem?.name || '') : ''}
      onConfirm={handleConfirmName}
      onCancel={closeDialog}
      busy={!!dialog?.busy}
      error={dialog?.error || null}
    />

    <VersionConfirmDialog
      isOpen={dialog?.kind === 'restore'}
      title="Restore this version?"
      message="A new version will be created with the restored content."
      confirmLabel="Restore"
      onConfirm={handleConfirmRestore}
      onCancel={closeDialog}
      busy={!!dialog?.busy}
      error={dialog?.error || null}
    />

    <VersionConfirmDialog
      isOpen={dialog?.kind === 'removeName'}
      title="Remove name"
      message={removeNameMessage}
      confirmLabel="Remove name"
      onConfirm={handleConfirmRemoveName}
      onCancel={closeDialog}
      busy={!!dialog?.busy}
      error={dialog?.error || null}
    />
    </>
  );
}

export default HierarchicalVersionList;
