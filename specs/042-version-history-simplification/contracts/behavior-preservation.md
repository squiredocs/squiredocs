# Contract: Behavior Preservation (FR-001)

This feature exposes **no new external interface**. Its contract is the inverse of the
usual one: an enumeration of what MUST NOT change. Everything below was read from
`main` at `603a494b` on 2026-08-02 and is quoted verbatim. Any refactor that alters one
of these is a defect, not a judgement call.

**Re-verify every literal in this file against post-041 `main` before relying on it**
(FR-017). 041 changes some of these deliberately; where it does, 041's post-merge value
becomes the pinned value.

---

## C1 — Undo/redo result shapes (FR-008)

All **nine** honest-empty literals share one structure:

```js
{ success: true, <undone|redone>: false, message: <string>, clock: await currentMaxClock(persistence, docGuid) }
```

`success` is `true` in every honest-empty case — an empty result is not a failure. The
merged builder MUST reproduce this, including the `await currentMaxClock(...)` evaluation
at each site (it is a live read, not a cached value).

**`performUndo` — 5 literals** (`undone: false`), messages verbatim:

| Site | `message` |
|---|---|
| pending recording | `Nothing undone: your latest edit is still being recorded — retry shortly.` |
| no recorded edit | `Nothing to undo: no recorded edit by you in this document.` |
| gapped log | `Nothing undone: the document is still syncing — retry in a moment.` |
| fully superseded | `Nothing left to undo: later edits already superseded everything this edit changed.` |
| claim lost | `This edit was already undone by a concurrent request.` |

**`performRedo` — 4 literals** (`redone: false`), messages verbatim:

| Site | `message` |
|---|---|
| no undone record | `Nothing to redo: no undone edit with a recorded inverse in this document.` |
| gapped log | `Nothing redone: the document is still syncing — retry in a moment.` |
| fully superseded | `Nothing left to redo: later edits already superseded everything the undo reverted.` |
| claim lost | `This edit was already redone by a concurrent request.` |

**Success shapes** (note the deliberate asymmetry — do not "harmonize" them):

```js
// performUndo
{ success: true, undone: true,
  message: 'Edit undone. Later edits by you and other collaborators were preserved.',
  clock, ...(diff ? { diff } : {}) }

// performRedo
{ success: true, redone: true,
  message: 'Edit reapplied.',
  clock, ...(diff ? { diff } : {}) }
```

The `...(diff ? { diff } : {})` spread means the `diff` key is **absent**, not `undefined`,
when there is no diff. Preserve that distinction — it is observable via `Object.keys` and
JSON serialization.

**Also invariant**: the two `console.warn` lines on the gapped-log paths
(`[undo-service] aborting undo for … : update log still gapped after retry budget` and its
redo twin) — these are not the diagnostic logging FR-001 permits removing; they are
operational signals on a data-integrity path.

**Module export surface** stays `{ init, performUndo, performRedo, getUndoStatus }`.
`performInverse` is internal; `performUndo`/`performRedo` remain thin exported wrappers.

---

## C2 — Version-history error strings (FR-009)

The two functions diverge, and the divergence is load-bearing. **Do not unify.**

| Condition | `getVersionContent` | `getContentAtClock` |
|---|---|---|
| no rows | `Document has no version history` as a **bare `Error`** | `Document has no version history` as a **`VersionNotFoundError`** |
| out of range | `` `Version not found: ${versionId} (clock ${clockEnd} out of range ${minClock}-${maxClock})` `` | `` `Version not found: clock ${clock} out of range ${minClock}-${maxClock}` `` (no `versionId` prefix) |

Also in `getVersionContent`: `Version not found` (`VersionNotFoundError`) and
`Invalid version ID format` (`VersionNotFoundError`).

`minClock`/`maxClock` interpolate into these strings, so `getClockRange` MUST return the
same values the old `Math.min`/`Math.max` over the materialized log produced — including
for the empty case, where the "no rows" branch must fire **before** any range formatting.

**Restore**: `Restore aborted: the document is still syncing — retry in a moment.`
(`DocumentSyncingError`).

---

## C3 — Diff cache key (FR-014)

Current key: `` `diff${CACHE_VERSION}:${docGuid}:${previousClock}:${currentClock}` ``
(`server/diff-service.js:58`), TTL `3600` (`:171`), `CACHE_VERSION = 'v10'` (`:35`),
exported at `:322`.

**Pinned by** `server/__tests__/diff-service.test.js:712`:

```js
expect(mockSetex).toHaveBeenCalledWith(`diff${CACHE_VERSION}:test-doc:-1:0`, 3600, expect.any(String));
```

**Contract**: the key **template** and the TTL MUST NOT change, and `CACHE_VERSION` MUST
remain an exported string. The fingerprint is folded **into** `CACHE_VERSION` so the
assertion above continues to hold with no test edit. The human-readable prefix (`v10`)
stays legible in the composite for log/debug purposes (DEC-1, DEC-8).

Determinism: digest file **contents** only — never absolute paths, `__dirname`, mtimes, or
install locations — with a sorted file list and normalized line endings, so every pod of a
build computes the same namespace.

---

## C4 — Rendered date strings (FR-015, DEC-10)

Three implementations, three outputs, **none substitutable**:

| Source | Output | Distinguishing detail |
|---|---|---|
| `client/src/utils/datetime.js` `formatDateTime` | `Jun 20, 2026 at 8:16 AM` | literal `" at "` join; no explicit `hour12` |
| `HierarchicalVersionList.jsx` local | `Jan 5, 4:30 PM` | **no year**; Intl `", "` join; explicit `hour12: true` |
| `AdminPage.jsx` local | `Jun 20, 2026, 8:16 AM` | returns `'Never'` for falsy input; `toLocaleString` |

Consolidation moves each into `client/src/utils/datetime.js` under a **distinct name**.
The `'Never'` null-guard is behavior and travels with its function.
`formatVersionTimestamp` (`June 20 at 8:16 AM`, used at `EditorView.jsx:385`) is a fourth,
already-shared variant — leave it alone.

---

## C5 — Clock range label (FR-015)

```js
isSingle ? `Clock ${start}` : `Clocks ${start}–${end}`
```

The separator is **U+2013 EN DASH** (`–`), not a hyphen. Two sites, both in
`HierarchicalVersionList.jsx`. The helper MUST emit the same character.

---

## C6 — Empty-state and dialog copy (FR-012, FR-013)

Rendered strings, both surfaces:

- `No named versions yet.` / `No version history yet.`
- `Name a version using the menu on any version.` / `Edit the document to start tracking versions.`
- Restore dialog: title `Restore this version?`, message
  `A new version will be created with the restored content.`, confirm label `Restore`,
  failure `Failed to restore this version.`

**Wrapper class names are part of the contract**: the panel copy renders inside
`.version-history-empty` / `.version-history-empty-hint`; the list copy inside
`.hierarchy-empty-state` / `.hierarchy-empty-hint`. Both branches are live under different
conditions. Deduplicating the *copy* must not collapse the *classes*.

---

## C7 — Restore targeting semantics (FR-013)

- Header restores the **live** `selection.id`.
- Row menu restores `dialog.item.id`, **captured when the dialog opens** — deliberate, so a
  mid-flight history refresh cannot retarget the restore.

`useRestoreFlow` MUST take the target as a parameter. Resolving it internally would
silently change one of the two call sites.

Navigation guards also differ (`onNavigateToDoc?.(docGuid)` vs
`if (onNavigateToDoc && docGuid)`); preserve each call site's effective behavior or prove
equivalence.

---

## C8 — Persistence module ABI (FR-007, DEC-2)

`module.exports = { PostgresPersistence }` and the instance method `getDocumentMeta` are
imported by `migrations/1766103664104_add-title-to-documents.js:1,80`, which
`server/__tests__/globalSetup.js` executes (via `npm run migrate`) before **every** backend
test run. Changing either breaks the whole backend suite, not just migration replay.

`getUpdatesInRange`'s existing signature
`(docGuid, clockStart, clockEnd, { withGap = false } = {})` gains `includeData` as an
**opt-in with a default preserving today's behavior at every un-migrated call site**.
Only the two call sites proven not to read the blob (`version-history.js:756`, `:849`) opt
out.

---

## C9 — Sentinel-origin subsets (FR-015)

The authoritative check is `origin.js:145-153` (five members). These are **deliberately
different, not drift**, and MUST stay different:

- `index.js:2242` — publish skip-list, `{ redis, db-load }` only (comment at 2235-2241 explains why sync-push/inverse/restore must still publish)
- `index.js:2209` — awareness skip-list, `{ redis }` only

`isSentinelOrigin()` consolidates only the authoritative five-member check.

---

## C10 — Preserved quirks (do not "fix" while nearby)

- `apply-word-marks.js:126` — hard breaks fuse adjacent words into one diff token.
- `apply-word-marks.js:36,176-179` — `loggedOnce`: first refinement failure logs once per process; later failures are silent.
- `VersionPreview.jsx:27` — when `showDiff === false` and the server sent no `currentDocument`, the diff-annotated document renders with diff CSS applied. FR-016 corrects the *comment* only.
- `postgres-persistence.js` env reads: pool knobs (`:45,46,49`) are read once at construction; gap-retry knobs (`:391,393`) are read on **every call**. Co-locate the parsing; preserve the timing.
- `getAllDocuments` SQL keeps its redundant `DISTINCT` + `GROUP BY`.

---

## C11 — SC-002 measurement basis

Net line reduction is measured as `git diff --shortstat` between the merge-base and the
merge commit, across **all tracked files including tests**, and excluding
`specs/**`. Deleted test files count toward the total (they are code the repo no longer
carries).

**Dependency**: `server/__tests__/redis-persistence.test.js` (328) +
`server/redis-persistence.js` (142) = 470 of roughly 865 available deletion lines. If DEC-7
resolves against deleting the module, **SC-002's ≥600-line target becomes unreachable** and
must be renegotiated rather than met by padding other deletions.
