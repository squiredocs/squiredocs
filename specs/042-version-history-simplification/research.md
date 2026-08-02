# Phase 0 Research — 042 Version History Simplification

All findings below were verified against `main` at `603a494b` on 2026-08-02 by direct
code reading and repo-wide greps (stale copies under `.claude/worktrees/` excluded — they
are not the repo, and jest ignores them via `testPathIgnorePatterns`).

**Every line number here is pre-041.** FR-017 requires all of it to be re-verified against
post-041 `main` before anything is touched; the *content anchors* (function names, string
literals, class-name families) are what the implementer should search for, not the numbers.

---

## R1 — FR-002: `redis-persistence.js` is deletable, but not design-neutral

**Decision**: Delete `server/redis-persistence.js` (142 lines) and
`server/__tests__/redis-persistence.test.js` (328 lines) — **gated on DEC-7**.

**Rationale**: exhaustive grep over `server/`, `client/`, `shared/`, `script/`,
`migrations/`, `__tests__/`, all `package.json`, Dockerfiles and k8s manifests found the
module's only `require` site is its own test (`redis-persistence.test.js:58`). No dynamic
or computed require exists anywhere: the only Redis requires in production code are
`./redis` and `./redis-pubsub`. `bindState` loads exclusively from Postgres. The test is a
pure unit test against a mocked `../redis` (no DB, no live Redis), so deleting it removes
no coverage of any surviving code.

**Blocking discovery**: two `design/` exports describe the module as live —

- `design/authentication-and-sharing.md:19` — *"Redis plays no role in auth — it caches Yjs docs and fans out updates/awareness across instances (`server/redis-persistence.js`, `server/redis-pubsub.js`)"*. Names the file by path.
- `design/collaboration-core.md:23` — *"Named-version snapshots and a 24-hour Redis doc cache are the only materialized states"*. That cache (`DOC_TTL_SECONDS = 24*60*60`, key prefix `yjs:doc:`) exists only inside the module being deleted; grep found no other implementation.

Both claims are **already false today** — nothing wires the module up. Constitution
Principle I ("when analysis reveals docs are already out of date, they MUST be corrected as
part of the work that discovered the drift") and Principle VI (amend the Squire source, then
`node design/sync.mjs`; never hand-edit exports) therefore both apply. See DEC-7.

**Alternatives considered**: (a) hand-edit the two `design/` files — forbidden by Principle
VI; (b) delete the module and leave the docs — forbidden ("never resolved ad hoc"); (c) keep
the module — preserves a false design claim and 470 dead lines, retained only as the DEC-7
fallback.

---

## R2 — FR-003: what must survive the ROOT CAUSE block

**Decision**: Reduce `server/index.js:2168-2204` to the `Y.applyUpdate` call plus its
existing `try`/`catch`.

**Rationale**: the block runs on **every cross-instance update**. Instrumentation to remove:
`Y.encodeStateVector`, `Y.diffUpdate`, `Y.decodeStateVector`, two `xmlFragment.toArray().length`
walks, and 8 `console.log('[RedisPubSub:ROOT_CAUSE] …')` lines. Load-bearing lines that MUST
survive verbatim: `Y.applyUpdate(doc, updateData, ORIGIN_REDIS)` and the catch's
`console.error('[RedisPubSub] Error applying doc update for …', err.message)`. The sibling
`onAwareness` handler immediately above (2157-2167) is already in exactly the target shape and
is the pattern to match.

---

## R3 — FR-004: the frontend legacy path is deader than specified

**Decision**: Remove all listed symbols; the spec's inventory is correct and in two places
conservative.

Verified in `client/src/hooks/useVersionHistory.js` (446 lines):

| Symbol | Lines | Consumers |
|---|---|---|
| `loadVersionContent` | 103-124 | returned; **zero** consumers |
| `loadContentAtClock` | 238-262 | returned; **zero** consumers |
| `loadPreviousContentAtClock` | 130-143 | **not even returned**, never called internally — fully unreachable |
| `versionContent` state | 55 | read only at `EditorView.jsx:162` → passed at `:405` to `VersionPreview`, which declares props at 13-18 and **does not declare it** |
| `previousVersionContent` state | 56 | **never set to a non-null value anywhere**; destructured at `EditorView.jsx:163` and never used |
| `refresh` alias | 398-400 | only consumer is `useVersionHistory.test.js:481` |
| `clearSelection` | 388-393 | destructured at `EditorView.jsx:173`, **never invoked** |

**Tests to update in the same change** (removing a test whose sole subject is deleted code
is not weakening the suite, per the spec's Edge Cases):
`useVersionHistory.test.js` L40, L205, L253-285 (whole `clearSelection` describe), L456-486
(the `refresh` test); mock entries in `EditorView.banners.test.jsx:104-117` and
`EditorView.toolsmenu.test.jsx:102-115`.

**Incidental finding (not in scope, recorded only)**: both EditorView test mocks also supply
`selectedVersion: null`, a key the hook has never returned.

---

## R4 — FR-005: dead CSS, verified selector-by-selector

**Decision**: ~234 dead lines in `VersionHistoryPanel.css`, ~43 in `HierarchicalVersionList.css`.
Each class name below returned **zero** hits when greped against every `.jsx`/`.js` under
`client/src`.

`VersionHistoryPanel.css` (514 lines) — dead ranges **126-157** (`.version-history-view-toggle`,
`.view-toggle-btn` family) and **177-378** (`.version-history-list`, `.version-group*`,
`.version-item*`, `.version-author*`, `.version-item-menu`/`.version-menu-*`,
`.version-expand-btn`).

**Live blocks interleaved with the dead ones — must be preserved**: `.version-history-panel`
(1-14), `-header` (15-29), `-close` (30-57), `-controls` (58-68), `-filter` (69-89),
`-highlight-toggle` (90-110), the `@media (hover: none)` touch block (108-125), the
loading/error/empty group (**159-176**), `.version-history-footer` (379-389), the entire
`.version-dialog*` block (391-495), and both trailing media queries (496-514).

`.version-history-error` (line 160 in the shared selector list, own rule 167-169) has **zero**
JSX references today but MUST be kept — 041 wires it up (spec FR-005).

`HierarchicalVersionList.css` (384 lines) — dead: **271-285** (`.hierarchy-combined*`),
**321-352** (`.hierarchy-breadcrumb*`), plus two the spec did not enumerate:
**119-122** (`.hierarchy-version-date`) and **124-127** (`.hierarchy-version-edits`).
Note `.hierarchy-loading` is **live** (reused at `HierarchicalVersionList.jsx:574` for
"Loading updates...") even though the branch at :503-505 that also uses it is unreachable —
delete the branch, keep the class.

---

## R5 — FR-006: dead exports and the `baselineClock` branch

**Decision**: Unexport the six named symbols; delete the `baselineClock` branch and its tests.

Verified: no external import site exists for `claimUndo`, `claimRedo`, `insertLegacyUndone`
(`edit-records.js`), `EDIT_ORIGIN`, `HISTORY_ORIGIN` (`inverse.js`), or `LEGACY_GAP_MS`
(`legacy.js`). The functions stay where they are used internally; only the export entry goes.

`baselineClock` branch: `server/undo/legacy.js:97` (JSDoc `@param`), `:108` (destructure,
default `null`), `:118-119` (the branch itself). **No production caller passes it** —
confirmed, and already recorded as owed cleanup in `specs/016-log-derived-undo/promotion-notes.md:49-50`
("RBD-10's baselineClock-anchored legacy mode is dead code"). Tests to delete:
`server/undo/__tests__/legacy.test.js` lines 36, 46, 51, 64, 148, 159, 172, 240, 246.

**Name-collision hazard confirmed and quarantined**: `baselineClock` also names an unrelated
feature-004 two-way-sync field (the `?baselineClock=` query param / `squire: clock` frontmatter).
Those hits live in `server/api/docs-import.js`, `server/mcp/yjs/edit-range.js`,
`server/mcp/tools/tool-documentation/export-api.js`, `markdown-sync.rejection.test.js`,
`live-fanout.test.js`, `__tests__/integration/sync-push.route.test.js`, plus `README.md:509`
and the 004/019 specs. **None of them may be touched.** No code path connects the two.

**Do not unexport** `LEGACY_FRESHNESS_MS` or `_isIdentityRow` from `legacy.js` — both have
live test importers.

---

## R6 — FR-007: `getDiff` and the mark-don't-move trio

**Decision**: Delete `getDiff` (`postgres-persistence.js:497-500`). Mark the other three.

`getDiff`: **zero callers** repo-wide, confirmed. Only textual reference is a doc comment at
`:449` which must be corrected in the same change.

Consumers to name in the DEC-2 comment (all verified):

| Method | Lines | Consumers |
|---|---|---|
| `getAllDocuments` | 546-565 | internal (`getAllDocumentsWithMeta:608`) + `__tests__/integration/collaboration.test.js:88` |
| `getDocumentMeta` | 572-581 | `migrations/1766103664104_add-title-to-documents.js:80`, `script/backfill-document-titles.js:61`, `server/__tests__/document-titles.test.js`, integration harness |
| `getAllDocumentsWithMeta` | 607-623 | **no production caller** — integration test harness only |

The migration dependency is load-bearing beyond the migration itself:
`server/__tests__/globalSetup.js` runs `npm run migrate` before **every** backend test run,
so breaking `PostgresPersistence`'s export shape or `getDocumentMeta` breaks the entire
backend suite, not just a replay-from-scratch. DEC-2's "mark, don't move" is correct.

---

## R7 — FR-008: the honest-empty count is nine, not five

**Decision**: Merge `performUndo`/`performRedo` into `performInverse(mode)`; replace **all
nine** hand-built empty-result literals with one builder.

**Spec drift**: FR-008 says "the five hand-built empty-result copies". The actual count is
**nine** — five in `performUndo`, four in `performRedo`. The spec's Edge Cases note that they
"differ only incidentally today" and that the merged builder "must reproduce the exact current
response shapes, not an idealized one" — that instruction is what governs; the count is a
correction, recorded as a MEDIUM analyze finding.

The builder must be shape-faithful per mode, since the undo and redo copies are not identical
to each other. `contracts/behavior-preservation.md` carries the enumerated shapes.

---

## R8 — FR-009: the two log reads are genuinely different

**Decision**: Add `getClockRange(docGuid)` (a `SELECT MIN(clock), MAX(clock)`) plus a shared
range-check helper. Replace the full-log read in `getContentAtClock` outright; replace it in
`getVersionContent` **only on the named-version branch**.

**Verified asymmetry** (this is the spec's "falsified nuance", confirmed):

- `getVersionContent` (473-560) does exactly one full user-joined read, at `:511`
  (`persistence.getUpdatesWithUsers(docGuid)`). It feeds range validation at 513-524 **and**,
  on the `!versionMeta` branch only (clock-number version ids, 536-552), a
  `filter(u => u.meaningful !== false)` + `groupUpdatesIntoVersions` grouping. For a **named
  (UUID) version**, `versionMeta` is already resolved by `getVersionById` at 484-495, so the
  whole read is *purely* range validation and can be replaced.
- `getContentAtClock` (829-880) reads at `:834` **purely** for range validation — nothing else
  consumes `allUpdates`. Replaceable outright.

**Error-string divergence between the two functions is real and must be preserved exactly**
(see the contract file). In particular `'Document has no version history'` is thrown as a
bare `Error` in `getVersionContent:514` but as a `VersionNotFoundError` in
`getContentAtClock:836`, and the out-of-range message includes the `${versionId}` prefix in
one and not the other. A "tidy-up" here would be a behavior change.

**Bonus saving found (in scope under FR-015's `includeData` clause)**: `getContentAtClock:849`
re-fetches a single row via `getUpdatesInRange(docGuid, clock, clock)` — with its
`update_data` blob — that was already present in the `allUpdates` array it just discarded.

---

## R9 — FR-010: extract the restore surgery, do not fix it

**Decision**: Move `cloneXmlElement` (a closure at `version-history.js:625-650`) and the
replace-delta build (653-681) into `server/yjs-utils.js` as exported, tested helpers.
**Change nothing about their behavior.**

**Spec wording correction**: FR-010 says the extraction lands "where the viewer-deletion bug
class is guarded". `server/yjs-utils.js` (79 lines, exports `extractXml` and `extractText`
only) contains **no such guard** — no file in `server/`, `shared/`, or `client/src` contains
one. The nearest prior art is a comment at `server/markdown-import.js:328-331` asserting
"never recreate the fragment or doc", but the code beneath it is itself a delete-all+reinsert
against the same fragment. So `yjs-utils.js` is the right *home* for generic Yjs surgery, but
the premise that it already guards this bug class is false. Recorded as **DEC-9**; adding a
guard would be a behavior change forbidden by FR-001.

**Style to match in `yjs-utils.js`**: module-level `function` declarations, `const Y = require('yjs')`
as the only dependency, `Y.Doc`/raw Yjs node as first positional arg, no persistence or DB
awareness, synchronous, JSDoc `@param`/`@returns` on every export, inline rationale comments
citing feature numbers.

**Also in `restoreVersion` and worth removing under FR-003's spirit**: nine
`console.log('[Restore] …')` lines at 588, 590, 597, 599, 657, 671, 679, 683, 690. These are
*not* named by any FR — flagged, not scoped. Do not remove without a decision.

---

## R10 — FR-011: the twin traversals and their safety net

**Decision**: Merge `plainTextOf` + `stampSide` in `server/diff/apply-word-marks.js` into one
walk emitting `{ text, nodeRefs }`.

**Safety net**: `server/__tests__/diff-service.test.js` (1276 lines, word-level marks section)
and `server/__tests__/diff-two-surface-parity.test.js` (238 lines, SC-003 agreement between
the chat and version-history surfaces). Both MUST pass unmodified. `apply-word-marks.js`
exports only `applyWordMarks`, so neither traversal is externally reachable — the merge is
module-internal and cannot break an importer.

**Known pre-existing behaviors that must be preserved, not "fixed"** (deep-dive section F):
hard breaks fuse adjacent words into one diff token (`apply-word-marks.js:126`); `loggedOnce`
means the first refinement failure logs once per process lifetime and all later failures are
silent (`:36`, `:176-179`).

---

## R11 — FR-012: the prop drill, measured

**Decision**: `VersionHistoryContext` (DEC-3 default). The merge alternative is not
demonstrably simpler and would change component boundaries during the highest-041-overlap
story.

**Measured** (`VersionHistoryPanel.jsx`, 123 lines): **21 declared props**, of which **14 are
pure pass-through** to `HierarchicalVersionList`, 3 are both used locally and forwarded
(`docGuid`, `hierarchicalVersions`, `isLoading`), and 4 are local-only (`isOpen`, `onClose`,
`showDiffHighlights`, `onToggleDiffHighlights`). **Nothing is transformed.** The only locally
created value is `filter` (`useState('all')`), used locally *and* forwarded.
`HierarchicalVersionList.jsx` declares 17 props (335-353).

The deep dive's "15 of 20" and the spec's "~21" are both approximately right; the exact
disposition table is in `data-model.md`.

**Duplicated empty state** — `VersionHistoryPanel.jsx:82-89` and
`HierarchicalVersionList.jsx:507-516` render byte-identical copy ("No named versions yet." /
"No version history yet." / "Name a version using the menu on any version." / "Edit the
document to start tracking versions."), differing only in wrapper class names
(`version-history-empty*` vs `hierarchy-empty*`). **Both are live** and reachable under
different conditions, so consolidation must preserve which classes render when — this is a
rendered-output invariant, not free deduplication.

**Unreachable loading branch**: `HierarchicalVersionList.jsx:503-505` — the panel renders the
list under `{!isLoading && …}` (`:91`) while passing `isLoading={isLoading}` (`:106`), so
`isLoading` is always `false` inside the list. Safe to delete; keep the `.hierarchy-loading`
class (live at `:574`).

---

## R12 — FR-013: how the two restore flows actually differ

**Decision**: Extract `useRestoreFlow`; preserve all seven observable differences below or
prove each is unobservable.

- **Header** (`EditorView.jsx`): state `restoreDialog` (`:85`), trigger `:389-397`, handler
  `handleConfirmHeaderRestore` `:214-229`, dialog `:440-449`. Restores `selection.id`.
- **Row menu** (`HierarchicalVersionList.jsx`): multiplexed `dialog` state (`:418`, shape
  `{kind, item, busy, error}`), opener `:425-428`, shared `runDialogAction` `:437-445`,
  handler `handleConfirmRestore` `:483-501`, dialog `:626-635`. Restores `dialog.item.id`,
  captured at open time — a **deliberate** choice (comment at 415-416) so a mid-flight
  refresh cannot retarget the restore.

Differences: (1) target source — live `selection` vs open-time captured `item`, and the row
menu can target a sub-version built by `subVersionToItem` (244-259); (2) state shape —
dedicated vs `kind`-discriminated; (3) throw-path error text computed in different places
(same effective string); (4) navigation guard — `onNavigateToDoc?.(docGuid)` vs
`if (onNavigateToDoc && docGuid)`; (5) close-then-navigate ordering; (6) the row menu also
closes its dropdown; (7) post-restore `fetchHistory()` is common to both and already lives in
the hook (`useVersionHistory.js:309-325`).

Difference (1) is **semantic and must be preserved** — the shared hook must accept the target
as a parameter, not resolve it internally. Dialog title, message, and confirm label are
already byte-identical between the two.

**041 collision warning**: 041's FR-007 (selection reconciliation) and its US3 acceptance
scenario 2 ("the header restore acts on a post-split version id") rewrite exactly this
targeting logic. FR-013 must be re-derived from post-041 code, not from this table.

---

## R13 — FR-014: fold the fingerprint into `CACHE_VERSION`

**Decision**: Compute a SHA-256 over the sorted, normalized contents of the diff-pipeline
source files at module load, truncate to a short hex prefix, and make the **exported**
`CACHE_VERSION` the composite (e.g. `v10.a1b2c3d4`). Do **not** append the fingerprint at the
key-build site.

**Rationale**: `server/diff-service.js:35` defines `CACHE_VERSION = 'v10'`, `:58` builds
`` `diff${CACHE_VERSION}:${docGuid}:${previousClock}:${currentClock}` ``, and `:322` exports it.
`server/__tests__/diff-service.test.js:712` asserts the key as
`` `diff${CACHE_VERSION}:test-doc:-1:0` `` using that same exported constant. Folding the
fingerprint into the constant keeps that assertion true **without modifying the test**,
satisfying FR-001 and SC-001. Appending it separately at `:58` would break the pin test and
force a test edit that FR-001 does not permit.

**Determinism requirements** (spec Edge Cases): digest file *contents*, never paths,
timestamps, or `__dirname`; read with an explicit encoding; sort the file list; normalize line
endings. Pods of the same build then agree. Files at minimum: `server/diff-service.js`,
`server/diff/apply-word-marks.js`, `shared/diff/word-diff.js`.

**Self-reference caveat**: the digest set includes `diff-service.js` itself, which is fine —
it reads the file from disk, not its own module text, so there is no fixpoint problem.

**Alternative rejected**: the CI-guard variant (DEC-1) — it still ends in a human step.

---

## R14 — FR-015: the long tail, item by item

**`retryWithBackoff`** — **no shared helper exists** anywhere in `server/` or `shared/`. Three
independent implementations: `server/index.js:363-379` (a closure defined *inside* the
per-update `bindState` listener, so re-allocated on every Yjs update; exactly one use at
`:427`); `postgres-persistence.js:211-234` `_runStoreSlot` (`MAX_ATTEMPTS=3`, `baseDelay=100`);
`postgres-persistence.js:390-434` `_fetchRowsWithGapRetry` (env-configured fixed-delay table —
**a different mechanism, out of scope**). The first two share a byte-identical delay formula
(`baseDelay * 2^(attempt-1) + Math.random()*50`) and are the consolidation targets. Leave
`_storeUpdateCritical`'s `MAX_CONFLICT_RETRIES = 5` no-delay conflict loop (`:244`) alone.

**`isMeaningful`** — only **two** true JS predicate sites exist, both
`u.meaningful !== false`: `version-history.js:419` (timeline) and `:540` (getVersionContent).
The third site the spec counts, `postgres-persistence.js:644` (`meaningful: row.meaningful ?? null`),
is a row-mapping normalization, not a predicate. **041 owns adding the third** (its FR-004
applies the filter to the drill-down). Per DEC-5, 042 consolidates only if 041 did not already
introduce a helper — verify at rebase.

**`isSentinelOrigin`** — the authoritative list is `origin.js:145-153` (five members:
`ORIGIN_DB_LOAD`, `ORIGIN_REDIS`, `isSyncPushOrigin(...)`, `ORIGIN_INVERSE_APPLY`,
`ORIGIN_RESTORE`). The other "lists" are **deliberately different subsets, not drift**:
`index.js:2242` skips only `{redis, db-load}` for publish (comment 2235-2241 explains why),
and `index.js:2209` skips only `{redis}` for awareness. **Consolidating these into one
predicate would be a behavior change.** What is genuinely drifting is *prose*:
`origin.js:8` lists only 2 of the 5 sentinels and is stale; `index.js:292`, `:314`, `:336-337`
and `origin.js:117-118` restate the list in comments. Scope FR-015's sentinel clause to
exporting a single `isSentinelOrigin()` for the authoritative 5-member check and correcting
the stale prose — **not** to unifying the two deliberate subsets.

**`includeData`** — `getUpdatesInRange` (`postgres-persistence.js:744-747`) hardcodes
`includeData: true`. Of five call sites, **two never touch the blob**:
`version-history.js:756` (`getUpdatesForVersion` — maps to a metadata-only shape at 763-771)
and `version-history.js:849` (`getContentAtClock` — reads only `createdAt` and
`createAuthor(update)`). The other three genuinely need it
(`undo-service.js:101`, `mcp/yjs/edit-range.js:181`, `mcp/tools/modify.js:327`). Client-visible
payloads are unchanged because the blob is discarded before serialization today.

**Env consolidation** — five reads in `postgres-persistence.js`: `DB_POOL_MAX` (`:45`),
`DB_POOL_ACQUIRE_TIMEOUT_MS` (`:46`), `DB_STATEMENT_TIMEOUT_MS` (`:49`),
`COLLAB_READ_GAP_RETRIES` (`:391`), `COLLAB_READ_GAP_RETRY_DELAYS_MS` (`:393`). Note the two
groups differ in *when* they read: 45/46/49 at construction with no NaN guard; 391/393 on
every fetch call with full validation. **Consolidating the read timing would be a behavior
change** (env vars mutated between calls are currently picked up by the second group). Scope
this to co-locating the parsing, preserving per-call evaluation where it exists today.

**`formatDateTime` collision** — the three implementations produce **three different strings**
and are **not substitutable**:

| Site | Output | Notes |
|---|---|---|
| `client/src/utils/datetime.js:15-18` (shared) | `"Jun 20, 2026 at 8:16 AM"` | year + literal `" at "`; no explicit `hour12` (locale-dependent) |
| `HierarchicalVersionList.jsx:12-21` | `"Jan 5, 4:30 PM"` | **no year**, Intl's `", "` join, explicit `hour12: true` |
| `AdminPage.jsx:188-193` | `"Jun 20, 2026, 8:16 AM"` | null-guard returning `'Never'`; `toLocaleString` default separator |

FR-015 requires consolidation "without changing any rendered string", so this is a
**name-collision resolution, not a merge**: move each variant into `client/src/utils/datetime.js`
under a distinct, descriptive name and re-point the call sites. Recorded as **DEC-10**.

**`clockRangeLabel`** — exactly two sites, both in `HierarchicalVersionList.jsx` (254-256 and
542-547), both producing `` `Clock ${start}` `` / `` `Clocks ${start}–${end}` `` with a
**U+2013 EN DASH**, not a hyphen. Preserve the character exactly.

**`useYUndoState`** — currently inline in `client/src/components/MobileActionBar.jsx:12-13`
(state) and `:19-57` (a combined `useEffect` that *also* drives indent/outdent/list-context
state). The extraction must split that effect without changing subscription behavior
(`editor.on('selectionUpdate'|'transaction')` with matching `off`, dep array `[editor]`).
Only consumer today is `MobileActionBar` itself (`:95`, `:106`); no UI change now.
Note `AiChatMessages.jsx:606-657` also has `canUndo`/`canRedo` — that is server-fetched agent
undo status, **unrelated**, do not touch.

**Diff identical-markdown re-conversion** — the redundant `yDocToProseMirror` call in
`diff-service.js`'s identical-markdown early-return branch.

---

## R15 — FR-016: the four stale comments, verified false

- `client/src/components/VersionPreview.jsx:7-12` — *"Diff visibility is toggled purely via CSS."* **False.** Lines 24-34 swap which ProseMirror document is fed to `useEditor`, with `content` in the dependency array, so toggling tears down and re-creates the TipTap editor. `VersionPreview.css` has no class or attribute keyed on diff visibility (its only diff rules are unconditional element selectors). Worse: when `showDiff === false` and the server supplied no `currentDocument`, `:27` falls back to the diff-annotated `diffData.document` with diff CSS fully applied. **Correct the comment only** — the fallback behavior is out of scope under FR-001.
- `server/diff-service.js` `computeDiff` JSDoc — documents a result shape that does not exist.
- `client/src/hooks/useVersionHistory.js:57` (`// { fullDoc, currentSnapshot, previousSnapshot }`) and `:145-151` (JSDoc) describe **two different** shapes, neither complete: `meta` also carries `formattingOnly` and `diffFailed` (read at `VersionPreview.jsx:38-39`), and `diffData.currentDocument` (read at `VersionPreview.jsx:27`) appears in neither. The same stale comment is echoed at `EditorView.jsx:164` — correct it too.
- `shared/diff/word-diff.js:8-11` — "client bundler can consume it". **False**: no file under `client/` imports it.

---

## R16 — 041 overlap map (the FR-017 checklist)

| File | 041 changes | 042 changes | Collision |
|---|---|---|---|
| `server/version-history.js` | FR-001..004 author scoping, meaningful filter, drill-down counts; FR-011 live-doc restore delta | FR-009 range check, FR-010 extraction, FR-015 `includeData` | **HIGH** — 041 rewrites `restoreVersion`'s delta source (the exact code FR-010 extracts) and the drill-down (`getUpdatesForVersion`, which FR-015 also edits) |
| `server/postgres-persistence.js` | FR-012 tail-completeness on `getYDocAtClock` | FR-007 `getDiff` delete + marks, FR-009 `getClockRange`, FR-015 retry/env | **MEDIUM** — adjacent methods, different lines |
| `server/undo/edit-records.js` | FR-014 `via_sync` predicate, FR-018 docstring | FR-006 unexport three symbols | **LOW** |
| `client/src/hooks/useVersionHistory.js` | FR-005/006/007/008 error state, selection reconcile, live refresh | FR-004 delete legacy path, FR-016 comments | **HIGH** — 041 may add consumers of state 042 plans to delete |
| `client/src/components/EditorView.jsx` | FR-005/006/007 error rendering, reconciliation | FR-004 destructure + `:405` prop, FR-013 restore flow | **HIGH** |
| `client/src/components/VersionHistoryPanel.css` | FR-005 wires `.version-history-error` | FR-005 deletes dead blocks | **MEDIUM** — the known case; keep the error rule |
| `client/src/components/HierarchicalVersionList.jsx` | FR-009 expanded-row re-fetch | FR-012, FR-013, FR-015 | **HIGH** |
| `server/undo/inverse.js` | FR-016 guard-or-comment on the spanning fallback | FR-006 unexport two constants | **LOW** |

**Rule for T001**: re-run the reference grep for **every** symbol, class name, and line anchor
in R1-R15 against post-041 `main` before touching it, and update
`clarifications-needed.md` if any claim changed (FR-017).

---

## R17 — Test-net gaps that shape task ordering

- `client/src/components/VersionHistoryPanel.jsx` and `client/src/components/VersionPreview.jsx` have **no dedicated test files anywhere** under `client/src`. US3 (FR-012/FR-013) therefore refactors an untested surface. The spec's Assumption that "the existing test suites are an adequate behavioral safety net" is **false for US3**. Mitigation: add characterization tests before refactoring (new tests over existing behavior — permitted, and required by Constitution Principle II's spirit).
- Strong nets that must pass unmodified: `undo-service.test.js` (607), `inverse.test.js` (591), `legacy.test.js` (388, minus the `baselineClock` blocks), `edit-records.test.js` (426), `diff-service.test.js` (1276), `diff-two-surface-parity.test.js` (238), `version-history.test.js` (2036), `HierarchicalVersionList.test.jsx` (574), `useVersionHistory.test.js` (487, minus the deleted-symbol blocks).
- `HierarchicalVersionList.test.jsx` has **zero** references to any FR-004 symbol, so FR-004 cannot disturb it.
