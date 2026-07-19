# Phase 1 Data Model: Version History Mobile/Touch Usability

**No new persisted entities. No schema, migration, or API-shape change (FR-015 / D7).**

The feature operates entirely on existing client-side representations and adds only transient
UI state. This document records the shapes so tasks and analysis have a stable reference.

## Existing representations (UNCHANGED — FR-014)

### Version item (top-level row)
Consumed by `HierarchicalVersionList` / `HistoryItem`. Fields used by this feature:
`id` (String(clockEnd)), `name` (nullable), `clockStart`, `clockEnd`, `timestamp`,
`authors[]`, `isNamed`, `isCurrent`, `onBehalfOf[]`, `onBehalfOfMore`. Role-derived flags
computed in `ItemMenu`: `canRestore = !isCurrent && role!=='viewer'`, `canName = !!role`,
`canRename = isNamed`, `canRemoveName = isNamed && !isSubVersion`. **No shape change.**

### Sub-version item (drill-down edit row)
Produced by `subVersionToItem`: `id`, `clockStart`, `clockEnd`, `timestamp`, `authors[]`,
`isSubVersion: true`, `isCurrent: false`, `subtitle`, `updateCount`. Sub-rows expose
name/rename/restore but NOT remove-name (asymmetry preserved — Assumption). **No shape
change.**

### User role
`userRole ∈ { 'owner' | 'editor' | 'viewer' | null }` — drives action gating identically to
today. **No shape change.**

## New transient UI state (client-only, not persisted)

### Menu open state (existing, extended)
`menuOpen: string | null` in `HierarchicalVersionList` — the version id or `sub-<id>` key of
the open row menu. Extended by the portal-positioning data below.

### Menu portal position (NEW, transient)
Computed on menu open from the trigger button rect; drives the fixed-positioned portaled
dropdown (R2). Shape (illustrative):
`{ top: number, left?: number, right?: number, placement: 'below' | 'above' }`.
Recomputed on open; menu closes on scroll/resize (no persistence).

### Row-action dialog state (NEW, in `HierarchicalVersionList`)
Replaces the `prompt`/`confirm` calls. Illustrative shape:
```
dialog: null | {
  kind: 'name' | 'rename' | 'restore' | 'removeName',
  item,               // the version/sub-version the action targets (captured, stable)
  busy: boolean,      // true while the async action is in flight
  error: string|null, // surfaced on failure (FR-006 scenario 6)
}
```
Captured `item` guards against acting on a stale row identity if history refreshes while the
dialog is open (Edge Case: "Dialog open during data refresh").

### Header-restore dialog state (NEW, in `EditorView`)
For the header "Restore this version" button:
`restoreDialog: null | { busy: boolean, error: string|null }` operating on the current
`selection`.

### Dialog component local state (NEW, in `VersionNameDialog`)
`value: string` (text input); confirm enabled iff `value.trim().length > 0`.
`VersionConfirmDialog` holds no input state.

## State transitions

### Name / Rename
`menu → open name/rename dialog (prefilled for rename) → type → confirm(trimmed)`
→ `busy=true` → `onCreateNamedVersion(name, item.clockEnd)` **or**
`onRenameVersion(item.id, name)` → success: close; failure: `error` set, dialog stays open.
Cancel/Escape/backdrop: close, no side effect.

### Restore (row menu OR header)
`trigger → open confirm dialog (consequence text) → confirm` → `busy=true` →
`onRestoreVersion(item.id)` → success: `onNavigateToDoc(docGuid)` (in-app, no reload — R5);
failure: `error` set, stay in version history (Edge Case: restore failure). Cancel/Escape/
backdrop: close, no side effect.

### Remove name
`menu → open confirm dialog naming the version → confirm` → `busy=true` →
`onDeleteVersion(item.id)` → success: close; failure: `error` set. Cancel/Escape/backdrop:
close, no side effect.

## Navigation state (NEW, in `App.jsx`)
`versionsReachedInApp: boolean` (ref/flag) — true when the versions route was entered via
`navigateToVersions`, false on a direct page load onto `/d/{guid}/versions`. Drives the close
handler's `history.back()` vs `navigateToDoc(guid)` branch (R5). Not persisted.
