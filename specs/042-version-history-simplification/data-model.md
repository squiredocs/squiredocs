# Phase 1 Data Model — 042 Version History Simplification

This feature introduces **no persisted entities and no schema change** (no new
migrations). The "entities" below are the in-process structures the refactors create or
formalize. Two come from the spec's Key Entities; the rest are the internal shapes the
consolidations need in order to be behavior-preserving.

---

## E1 — Diff cache namespace (spec Key Entity; FR-014)

The composite cache-key prefix scoping every cached diff computation.

| Field | Type | Source | Notes |
|---|---|---|---|
| `humanVersion` | string | literal in `server/diff-service.js` | Currently `v10`. Stays hand-maintained and legible for logs/debug. |
| `sourceFingerprint` | string | SHA-256 over diff-pipeline source contents, truncated | Computed once at module load. |
| `CACHE_VERSION` | string | `` `${humanVersion}.${sourceFingerprint}` `` | **The exported constant.** Folding the fingerprint in here (rather than appending at the key-build site) is what keeps `diff-service.test.js:712` passing unmodified — see DEC-8 and contract C3. |

**Fingerprint inputs** (minimum, per FR-014): `server/diff-service.js`,
`server/diff/apply-word-marks.js`, `shared/diff/word-diff.js`.

**Invariants**
- Deterministic across pods of one build: digest file **contents**, sorted file list,
  normalized line endings. Never paths, mtimes, or `__dirname`.
- Changing any input file changes the namespace with no human action (SC-006).
- Identical source ⇒ identical namespace across restarts (US4 scenario 1).
- One-time invalidation on rollout is accepted (1-hour TTL cache).

**Lifecycle**: computed at module load, immutable for the process lifetime.

---

## E2 — Clock range (spec Key Entity; FR-009)

The `(min, max)` clock pair for a document's update log, obtainable without materializing
the log.

| Field | Type | Notes |
|---|---|---|
| `minClock` | number \| null | `null` when the document has no rows |
| `maxClock` | number \| null | `null` when the document has no rows |

**Producer**: a new `getClockRange(docGuid)` on `PostgresPersistence` —
`SELECT MIN(clock), MAX(clock) FROM yjs_updates WHERE doc_guid = $1`.

**Consumers**: a shared range-check helper used by `getContentAtClock` (replaces its read
outright) and by `getVersionContent`'s **named-version branch only** (the clock-number
branch still needs the materialized log for meaningful-filtered grouping — see R8).

**Invariants**
- The empty-log branch must fire before any range formatting, so the "no rows" error wins
  over an out-of-range message (contract C2).
- `minClock`/`maxClock` interpolate verbatim into user-visible error strings, so a `null`
  or string-typed value from the driver must be normalized to the same numbers
  `Math.min`/`Math.max` produced.
- Postgres returns `MIN`/`MAX` over an empty set as SQL `NULL` in a **single row**, not as
  zero rows — the emptiness check must test the value, not `rows.length`.

---

## E3 — Inverse operation mode (FR-008)

The discriminator that collapses `performUndo`/`performRedo` into `performInverse(mode)`.

| Value | Result key | Target resolution | Extra paths |
|---|---|---|---|
| `'undo'` | `undone` | `editRecords.latestEdit` → `undoTarget{Start,End,Clocks}` | pending-recording probe; legacy fallback (`deriveLegacyRange`) when the identity has no 016 records at all |
| `'redo'` | `redone` | `editRecords.nextRedoTarget` → `redoTarget{Start,End}` | none |

**Asymmetries the merged core MUST keep** (they are why this is a `mode` parameter and not
a symmetric function):
- Undo has a pending-recording guard and a legacy-range fallback; redo has neither.
- Undo's `finalizeClaim` passes `targetRange` only when `mode === 'undo'` (not for
  `legacy-undo`); redo always passes it.
- Undo's internal mode can become `'legacy-undo'`; redo's is always `'redo'`.
- Success messages differ in kind, not just wording (contract C1).

---

## E4 — Honest-empty result (FR-008)

One builder replacing nine literals.

```js
{ success: true, [modeKey]: false, message, clock }
```

where `modeKey` is `'undone'` or `'redone'` and `clock` is a **fresh**
`await currentMaxClock(persistence, docGuid)` at each call site. The nine messages are
enumerated verbatim in contract C1 and are inputs to the builder, not derived from the
mode.

The success counterpart adds `...(diff ? { diff } : {})` — the key must be **absent**, not
`undefined`, when there is no diff.

---

## E5 — Diff traversal output (FR-011)

Replaces the twin hand-synchronized walks (`plainTextOf` + `stampSide`) in
`server/diff/apply-word-marks.js` with a single walk emitting both products.

| Field | Type | Notes |
|---|---|---|
| `text` | string | Exactly what `plainTextOf` produced, including the hard-break word-fusion behavior at `:126` |
| `nodeRefs` | array | The node references `stampSide` walked, in traversal order, with the same offset mapping |

**Invariant**: `text` and `nodeRefs` must be index-consistent by construction — that
consistency is the entire point, since it is currently maintained by hand and defended
only by pin tests. Those pin tests (`diff-service.test.js` word-mark section,
`diff-two-surface-parity.test.js`) MUST pass unmodified.

Both functions are module-internal (`apply-word-marks.js` exports only `applyWordMarks`),
so the merge cannot break an importer.

---

## E6 — Version-history context value (FR-012, DEC-3)

Replaces 14 pure pass-through props between `VersionHistoryPanel` and
`HierarchicalVersionList`.

**Carried in context** (data + callbacks the list consumes and the panel only forwards):
`selection`, `onSelectVersion`, `onSelectUpdate`, `onLoadUpdates`, `versionUpdates`,
`versionUpdatesMeta`, `loadingVersionUpdates`, `onCreateNamedVersion`, `onRenameVersion`,
`onDeleteVersion`, `onRestoreVersion`, `userRole`, `onNavigateToDoc`, `docGuid`.

**Stays a prop or local state**: `isOpen`, `onClose`, `totalEdits`, `showDiffHighlights`,
`onToggleDiffHighlights` (panel-local chrome); `hierarchicalVersions` and `filter` (read by
both, and `filter` is panel-local `useState`); `isLoading` (panel-local — the list's
consumer of it is the unreachable branch being deleted).

**Invariants**
- Rendered output byte-identical, including which wrapper classes render the empty state
  (contract C6).
- `HierarchicalVersionList` must remain renderable in tests — `HierarchicalVersionList.test.jsx`
  (574 lines) mounts it directly with props. Either the context has a default value that
  makes those mounts work unchanged, or the component keeps prop overrides that win over
  context. **The existing test file must not be modified** (FR-001), so this constrains the
  design: props-over-context with a context fallback is the safe shape.

---

## E7 — Restore flow state (FR-013)

One `useRestoreFlow` serving both entry points.

| Field | Type | Notes |
|---|---|---|
| `target` | `{ id }` \| null | **Supplied by the caller.** Header passes live `selection`; row menu passes the item captured at dialog-open time (contract C7). |
| `busy` | boolean | |
| `error` | string \| null | |

Exposed: `open(target)`, `confirm()`, `cancel()`, plus the state above.

**Invariants**: dialog title/message/confirm-label/failure text unchanged (contract C6);
the row menu additionally closes its dropdown on open; post-restore `fetchHistory()` stays
in `useVersionHistory.restoreVersion`, not in this hook.

---

## E8 — Update-fetch data option (FR-015)

`getUpdatesInRange(docGuid, clockStart, clockEnd, { withGap, includeData })`.

| Value | Behavior |
|---|---|
| `includeData: true` | Today's behavior — row mapping attaches `updateData` |
| `includeData: false` | Blob column omitted from the projection; `updateData` absent |

**Default must preserve today's behavior** at every call site not explicitly migrated.
Only `version-history.js:756` and `:849` opt out — both proven not to read `updateData`.
The three sites that do read it (`undo-service.js:101`, `mcp/yjs/edit-range.js:181`,
`mcp/tools/modify.js:327`) are untouched. Client-visible payloads are unchanged because
both opting-out sites already discard the blob before serialization.

---

## E9 — Yjs surgery helpers (FR-010)

Moved from `restoreVersion`'s body into `server/yjs-utils.js` as exported functions.

| Helper | Moved from | Behavior |
|---|---|---|
| `cloneXmlElement(node)` | closure at `version-history.js:625-650` | `Y.XmlText` → new `Y.XmlText` + `applyDelta(source.toDelta())`; `Y.XmlElement` → new element by `nodeName`, attribute copy, recursive children in one `insert(0, children)`; anything else → `null` |
| `buildReplaceDelta(targetFragment, tempFragment)` | inline at `version-history.js:653-681` | delete-all then reinsert cloned children |

**Invariant**: byte-identical behavior. In particular the delete-all+reinsert shape is
**preserved as-is** — see DEC-9. Adding a guard would be a behavior change forbidden by
FR-001, and `yjs-utils.js` does not currently contain the guard FR-010's wording implies.

**Style**: match the module — top-level `function` declarations, `Y` as the only
dependency, synchronous, JSDoc on every export, no persistence awareness.
