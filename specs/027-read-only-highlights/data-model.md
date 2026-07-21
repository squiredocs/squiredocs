# Phase 1 Data Model: Read-Only Highlights

This feature introduces **no persisted schema** and **no database migration**
(FR-007). The only "data" it touches are (a) an ephemeral in-flight structure and
(b) the persisted structures it must leave *unchanged*. Documented here for the
acceptance tests.

## Entity 1 — Presence position (ephemeral, MODIFIED shape for text-less targets)

- **What**: a JSON-serialized Yjs `RelativePosition` pointing into a live document,
  used to render an agent cursor/highlight anchor or head.
- **Lifecycle**: constructed by `cursor-operations.js` → broadcast via y-websocket
  awareness (`agent-presence.js`) → resolved on the client viewer
  (`CollaborationCursorWithSelection.js` via y-prosemirror). **Never persisted.**
- **Shape (unchanged for text-bearing targets)**: `{ type: {client, clock}, tname?,
  item?, assoc }` referencing a `Y.XmlText` and an offset within it. FR-005 requires
  this to be **byte-identical** to today for text-bearing content.
- **Shape (CHANGED for text-less targets)**: references the empty **element** type at
  index 0 (`createRelativePositionFromTypeIndex(element, 0)`) instead of a
  freshly-created placeholder `Y.XmlText`. No content is created to produce it.
- **Validation / invariant**: constructing this value MUST write zero bytes to the
  `Y.Doc` on every path (FR-001). It MUST resolve non-null under both
  `Y.createAbsolutePositionFromRelativePosition` (server) and y-prosemirror's
  `relativePositionToAbsolutePosition` (client viewer) for every text-less block shape
  (FR-004/SC-003).

## Entity 2 — Update-log row (persisted, MUST NOT gain rows from reads)

- **What**: the persisted, attributed record of a document change (unit of version
  history and authorship); the `origin`/`agent_name` carried on each persisted Yjs
  update.
- **Invariant under this feature**: a read (whole-document or query-scoped, over any
  document shape including empty/text-less) adds **zero** rows and does **not** advance
  the document clock (FR-002/SC-001). A mutation adds exactly the rows for its intended
  content edits and nothing more — no placeholder-insertion rows (FR-006/SC-005).
- **Test surfaces (existing, no new observability)**: update-log row count + `clock`
  via the read path's `getRecentUpdatesWithUsers`; author set via
  `versionHistory.getCurrentSessionAuthors` / `recentAuthors`.

## Entity 3 — Text-less block/element (classification, not stored)

- **Definition**: any document element with no text runs — empty paragraph, image,
  horizontal rule, empty list item / blockquote / table cell, or a completely empty
  document (zero blocks).
- **Behavioral contract**: gets a boundary-anchored, resolvable, **visible** highlight
  in a read sweep (never skipped — D-2/FR-004); an empty document produces no highlight
  and no write and does not throw (edge case).

## State transitions

None. Position construction is a pure function of `(fragment, target, offset)` after
this change; there is no state machine and no stored state.
