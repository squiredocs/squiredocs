import React, { useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import VersionNameDialog from './VersionNameDialog';
import VersionConfirmDialog from './VersionConfirmDialog';
import VersionEmptyState from './VersionEmptyState';
import { useVersionHistoryValues } from '../contexts/VersionHistoryContext';
import { useRestoreFlow } from '../hooks/useRestoreFlow';
import { formatVersionRowTimestamp } from '../utils/datetime';
import './HierarchicalVersionList.css';

/**
 * The clock coordinates a row covers, as shown in its subtitle.
 *
 * The separator is a U+2013 EN DASH, not a hyphen — it reads as a range rather
 * than a compound. Two sites used to spell this out identically (feature 042,
 * FR-015).
 *
 * @param {number} start - first clock in the range
 * @param {number} end - last clock in the range
 * @returns {string} e.g. "Clock 7" or "Clocks 7–12"
 */
function clockRangeLabel(start, end) {
  return start === end ? `Clock ${start}` : `Clocks ${start}\u2013${end}`;
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
 * What the "Synced content" contributor means, for the hover title (feature 045,
 * FR-004). The server sets `isSynced` on that entry; the client only styles it,
 * and never derives authorship of its own.
 */
const SYNCED_CONTRIBUTION_TITLE =
  "This content arrived through a collaborator's reconnect. Its original author could not be determined.";

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
        <div
          key={`${author.id}-${i}`}
          className="hierarchy-author"
          // Feature 045 (FR-004): the synced contribution is not a person, so it
          // says what it is on hover. The flag is a server-set field — never a
          // match on the display name.
          title={author.isSynced ? SYNCED_CONTRIBUTION_TITLE : author.name}
        >
          <span
            className={author.isSynced ? 'hierarchy-author-dot hierarchy-author-dot-synced' : 'hierarchy-author-dot'}
            // Feature 039 FR-018: a colorless author gets the stable neutral,
            // matching the server's own no-identity fallback in
            // server/version-history.js. generateColorFromId salts its hue with
            // the current DATE — deliberate for live presence (collaborators get
            // a fresh palette each day), but wrong for history, where the same
            // archived version would change color overnight.
            //
            // The synced contribution takes NO identity fill: it is an outlined
            // badge (feature 045), and leaving the inline colour off is what lets
            // the stylesheet own that entry's appearance.
            style={author.isSynced ? undefined : { backgroundColor: author.color || '#888888' }}
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
      <div className="hierarchy-version-time">{formatVersionRowTimestamp(timestamp)}</div>
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
  return {
    id: subVersion.id,
    clockStart: subVersion.clockStart,
    clockEnd: subVersion.clockEnd,
    timestamp: subVersion.timestamp,
    authors: subVersion.authors || [],
    isSubVersion: true,
    isCurrent: false,
    subtitle: clockRangeLabel(subVersion.clockStart, subVersion.clockEnd),
    updateCount: subVersion.updateCount,
  };
}

/** Identity of one drill-down request: the version AND the range asked for, so a
 *  re-split (which moves the range under a stable id) is a different request. */
const updatesKey = (version) => `${version.id}:${version.clockStart}-${version.clockEnd}`;

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
function HierarchicalVersionList(props) {
  const {
    hierarchicalVersions = [],
    isLoading,
    filter = 'all', // 'all' or 'named'
  } = props;

  // The rest comes from VersionHistoryContext when a provider is present, and
  // from props otherwise — props always win (042, FR-012, DEC-3). The panel
  // provides them; tests mount this component directly with props.
  const {
    selection, // Unified: version or clock update (with isClock: true)
    onSelectVersion,
    onSelectUpdate,
    onLoadUpdates,
    versionUpdates,
    versionUpdatesMeta,
    loadingVersionUpdates,
    // Per-row drill-down failures (041 review L1): { versionId: message }.
    // Rendered inline on the row that failed — never on the panel's own error
    // channel.
    versionUpdatesError,
    onCreateNamedVersion,
    onRenameVersion,
    onDeleteVersion,
    onRestoreVersion,
    userRole,
    docGuid,
    onNavigateToDoc, // post-restore in-app navigation (024/US4); always wired by App
  } = useVersionHistoryValues(props, {
    versionUpdates: {},
    versionUpdatesMeta: {},
    loadingVersionUpdates: {},
    versionUpdatesError: {},
  });

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

  // ── Feature 041 (FR-009): expanded rows re-fetch after a refresh ──────────
  // A history refresh wipes the hook's drill-down cache, but expansion state
  // lives HERE. An expanded row whose cache entry vanished used to render "No
  // individual updates" — an empty-state claim about a range that demonstrably
  // has edits — until the user manually collapsed and re-expanded it.
  //
  // A failed drill-down load would otherwise retry on every state change, so
  // failures are remembered until the version list itself changes (at most one
  // retry per refresh, never a tight loop).
  const failedLoadsRef = React.useRef(new Set());
  React.useEffect(() => {
    failedLoadsRef.current = new Set();
  }, [hierarchicalVersions]);

  React.useEffect(() => {
    if (!onLoadUpdates) return;

    const present = new Map();
    for (const month of hierarchicalVersions) {
      for (const version of (month.versions || [])) present.set(version.id, version);
    }

    const expandedIds = Object.keys(expandedVersions).filter(id => expandedVersions[id]);

    // A version that no longer exists (re-split, deleted) cannot stay expanded.
    const vanished = expandedIds.filter(id => !present.has(id));
    if (vanished.length > 0) {
      setExpandedVersions(prev => {
        const next = { ...prev };
        for (const id of vanished) delete next[id];
        return next;
      });
    }

    for (const id of expandedIds) {
      const version = present.get(id);
      if (!version) continue;
      if (versionUpdates[id] || loadingVersionUpdates[id]) continue;

      // Always re-request with the FRESH range — a re-split moves it.
      const key = updatesKey(version);
      if (failedLoadsRef.current.has(key)) continue;

      Promise.resolve(onLoadUpdates(version.clockStart, version.clockEnd, id))
        .then((result) => {
          if (result === null || result === undefined) failedLoadsRef.current.add(key);
        })
        .catch(() => { failedLoadsRef.current.add(key); });
    }
  }, [hierarchicalVersions, expandedVersions, versionUpdates, loadingVersionUpdates, onLoadUpdates]);

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

  // Manual retry of a failed drill-down. The auto-refetch suppression above is
  // there to stop a failing row from re-requesting on every state change; an
  // explicit tap is the user asking again, so it clears the suppression first.
  const retryUpdates = (version) => {
    if (!onLoadUpdates) return;
    failedLoadsRef.current.delete(updatesKey(version));
    onLoadUpdates(version.clockStart, version.clockEnd, version.id);
  };

  // In-app dialog state replacing the native prompt/confirm calls (024/US2).
  // `item` is captured at open time so a mid-flight history refresh can't make the
  // action target a stale row (Edge Case: "Dialog open during data refresh").
  // Shape: { kind: 'name'|'rename'|'removeName', item, busy, error } | null.
  // Restore is NOT here: it moved to the shared useRestoreFlow (042, FR-013).
  const [dialog, setDialog] = useState(null);

  const openNameDialog = (item) => {
    setMenuOpen(null);
    setDialog({ kind: item.isNamed ? 'rename' : 'name', item, busy: false, error: null });
  };

  // Restore runs through the shared flow (042, FR-013), so this entry point and
  // the version-history header behave identically. `item` is captured HERE, at
  // open time, and handed to the flow — a background refresh must never be able
  // to retarget a confirm that is already on screen.
  const restoreFlow = useRestoreFlow(onRestoreVersion, {
    onSuccess: () => {
      // In-app navigation to the live doc — never a full page reload (024/FR-012).
      if (onNavigateToDoc && docGuid) {
        onNavigateToDoc(docGuid);
      }
    },
  });

  const openRestoreDialog = (item) => {
    setMenuOpen(null);
    restoreFlow.open(item);
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

  // REACHABLE, despite appearances (042, FR-017 re-verification): the panel
  // mounts this list whenever any version exists, and still forwards
  // `isLoading`, so a FOREGROUND refetch (rename / delete / restore) does swap
  // the rows for this placeholder. Pinned in
  // VersionHistoryPanel.characterization.test.jsx; 042 preserves it rather than
  // deleting it as the pre-041 research assumed.
  if (isLoading) {
    return <div className="hierarchy-loading">Loading versions...</div>;
  }

  if (!filteredVersions || filteredVersions.length === 0) {
    return (
      <VersionEmptyState
        filter={filter}
        className="hierarchy-empty-state"
        hintClassName="hierarchy-empty-hint"
      />
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
                  subtitle: clockRangeLabel(version.clockStart, version.clockEnd),
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
                        {/* FR-009: "No individual updates" describes ONLY a
                            successful, genuinely empty response. An absent
                            cache entry (wiped by a refresh, re-fetch pending)
                            is a loading state, not an empty one. */}
                        {loadingVersionUpdates[version.id] ? (
                          <div className="hierarchy-loading">Loading updates...</div>
                        ) : versionUpdatesError[version.id] ? (
                          /* Review L1: a failed drill-down is a failure of THIS
                             row. It is said here, on the row, and retried here —
                             the panel-level error is for the timeline itself. */
                          <div className="hierarchy-updates-error" role="alert">
                            <button
                              type="button"
                              className="hierarchy-updates-error-btn"
                              onClick={() => retryUpdates(version)}
                            >
                              Couldn't load updates — tap to retry
                            </button>
                          </div>
                        ) : updates === undefined ? (
                          <div className="hierarchy-loading">Loading updates...</div>
                        ) : updates.length > 0 ? (
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
      isOpen={restoreFlow.isOpen}
      title="Restore this version?"
      message="A new version will be created with the restored content."
      confirmLabel="Restore"
      onConfirm={restoreFlow.confirm}
      onCancel={restoreFlow.cancel}
      busy={restoreFlow.busy}
      error={restoreFlow.error}
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
