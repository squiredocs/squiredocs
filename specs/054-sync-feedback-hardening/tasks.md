---

description: "Task list for 054-sync-feedback-hardening"
---

# Tasks: Sync Feedback Hardening (Repo-Sync Trust Pack)

**Input**: Design documents from `/specs/054-sync-feedback-hardening/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **REQUIRED** — Constitution Principle II makes every behavioral change
test-backed, and mandates that format/serialization changes extend the registry-driven
round-trip suite. Test tasks are therefore not optional here.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US5 from spec.md

## Implement brief — read before starting

1. **`server/markdown-sync.js` contains NUL bytes.** A plain `grep` reports it as binary and
   appears to find nothing. Use `grep -a` or read the file directly. This has misled three
   agents.
2. **Line numbers in these tasks are anchors from 2026-08-11, not contracts.** Re-locate by
   symbol name before editing.
3. **No database changes and no migration.** If you find yourself needing one, **stop and
   report** — that is out of scope for this feature.
4. **Do not touch `computeHunks`, hunk computation, or merge alignment.** That is the parallel
   feature 055 (`specs/055-block-aligned-merge`). 054 reads whatever plan the engine produces.
5. **Do not modify `pushTouchedBlocks`** (`markdown-sync.js:862`). It feeds the shipped
   `overlaps[].pushSide` contract and deliberately labels reconcile blocks `text`
   (research R4).
6. **Byte budgets are tests, not guidelines.** `modify.description` has **218 bytes** of
   headroom. Re-measure after every description edit — there is a ready-made script pattern in
   [contracts/guidance-split.md](./contracts/guidance-split.md).
7. **Backend suites run in parallel** with per-worker DB/Redis isolation (Constitution II).
   Do not add serial assumptions. Use `--forceExit`.
8. **Never edit `design/`, `CLAUDE.md`, or `docs/dev.md`.** `README.md` is edited **only** as
   T072 specifies (its sync and MCP sections).

## Analyze-gate notes (2026-08-11) — MEDIUM findings folded forward

The analyze gate returned **0 CRITICAL, 0 HIGH**. Seven MEDIUM findings are recorded here
because they change how a task should be executed, not whether it should be:

- **M1 — the spec misnames the strict parser's consumer.** US4 acceptance scenario 3 calls the
  strict parser "(sync path)". It is **not** on the sync path: `markdownToPm` defaults to
  `{ strict: false }` and the sync path runs the **tolerant** parser, which already preserves
  `start`. The strict parser's real consumers are `server/diff-service.js:316-323` and
  `server/diff/apply-word-marks.js:35`. FR-013 is still correct and still required — the
  round-trip suite runs both parser modes. Do not "verify" T047 by pushing a sync; verify it
  through the round-trip suite and version-history diffs (research R8).
- **M2 — FR-015 item 6 names a GENERATED directory.** `distribution/kiro-power/steering/` is
  generated. Editing it looks like it works and is reverted by the next
  `node distribution/publish.mjs`. Edit `distribution/publish.mjs` instead (T065/T066), per
  RBD-054-13 and the write-site table in `contracts/guidance-split.md`.
- **M3 — FR-015 surface 9 is an addition, not an edit.** `server/api/chat.js`'s
  `BASE_SYSTEM_PROMPT` contains no channel-rule text at all today. Use the PLAIN variant; the
  prompt's own rule at `chat.js:197` forbids em dashes, which every other variant uses (T069).
- **M4 — FR-006's "nothing applied" has one disclosed exception.** The dry run runs the staged
  image pass, so it may rehost an external image to S3 or copy a cross-doc image (RBD-054-11).
  The four things FR-006 enumerates stay guaranteed absent. **This is the one default flagged
  for a human glance at review** — surface it in T077.
- **M5 — FR-013 edits an explicitly FROZEN module.** `shared/markdown/strict-parser.js:12-16`
  says "Do NOT improve it". Proceed — this is a ratified design amendment — but T048 (header
  comment) and T053 (the pinned test at `markdown-tolerant.test.js:203`) are **not optional
  cleanup**; they are what keeps the freeze meaningful for the next reader.
- **M6 — the diff-cache consequence is absent from the spec.** FR-013 changes the diff
  engine's parser, so cached diffs go stale. T049 + T056 (`CACHE_VERSION` v10 → v11) exist only
  because of RBD-054-12; do not drop them as unrelated.
- **M7 — add an explicit receipt-frontmatter assertion.** RBD-054-7 and SC-008 promise the
  written-back receipt frontmatter is unchanged, but no task asserts it directly. When doing
  **T031**, add an assertion that a sync receipt's `markdown` frontmatter carries exactly
  today's `squire:` fields — cheap, and it pins the promise that every previously written
  baseline still validates.

LOW findings (act only if convenient): the widened excerpt cap also lengthens existing
`overlaps[].excerpt` values (disclosed in the amended RBD-054-6); T004 and T073 map to no FR
and are hygiene — drop them if they get in the way; no test covers the "hundreds of blocks"
receipt-size edge case; and T033's `clock` value needs a `readCurrentClock` call, since the
engine does not read it before the dry-run cut point.

---

## Phase 1: Setup

**Purpose**: Establish the pre-change baseline so regressions are attributable.

- [ ] T001 Capture the pre-change green baseline: run `npx jest --forceExit` from the repo root and record the pass/fail summary in a scratch note (not committed)
- [ ] T002 [P] Record current pinned byte sizes for the three budgeted surfaces (`SERVER_INSTRUCTIONS` 1,225 B, `modify.description` 1,830 B, `import_markdown_file.description` 1,216 B) by running the measurement script pattern from `specs/054-sync-feedback-hardening/contracts/guidance-split.md`

**Checkpoint**: Baseline known; every later failure is caused by this feature.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared parameter parsing and the excerpt helper that US1, US2, and US3 all build
on.

**⚠️ CRITICAL**: US1, US2, and US3 cannot start until this phase is complete. US4 and US5 are
independent of it and may start immediately.

- [ ] T003 Extract a reusable boolean query-param parser in `server/api/docs-import.js` from the existing `parseReceiptOptions` convention (`:242-260`): accept `true`/`1` → true, `false`/`0` → false, anything else → an error carrying the message shape `Unsupported <name> value: <v>. Accepted values: true, false, 1, 0`
- [ ] T004 Refactor `parseReceiptOptions` in `server/api/docs-import.js` to use the T003 helper for `?frontmatter`, confirming no behavior change (message text preserved verbatim)
- [ ] T005 Raise the cap in `blockExcerpt` (`server/markdown-sync.js:838`) from 80 to 120 characters and append an ellipsis marker when truncation occurs, keeping the whitespace-collapse and single-line behavior (RBD-054-6 as amended)
- [ ] T006 [P] Update `server/__tests__/markdown-sync.overlap.test.js` for the widened excerpt: assert the 120-char cap and the ellipsis on a long block, and confirm existing overlap assertions still pass

**Checkpoint**: Boolean params parse consistently; one excerpt shape exists for the whole receipt.

---

## Phase 3: User Story 1 - Staleness is visible on every sync receipt (Priority: P1) 🎯 MVP

**Goal**: Every `mode=sync` response reports how stale the pusher's baseline was, and
`strict=true` refuses to merge over unseen changes.

**Independent Test**: Export a doc, edit it through another session, push with the old
baseline — the receipt reports the gap. Repeat with `strict=true` — 409 with the re-export
remedy, nothing applied.

### Implementation

- [ ] T007 [US1] Stop discarding `currentClock` in `handleSyncPush` (`server/api/docs-import.js:116`): destructure it from the `validateSyncBaseline` result alongside `baselineClock` and `flavor` (the value is already returned at `markdown-sync.js:1042`)
- [ ] T008 [US1] Add a `buildStaleness(baselineClock, currentClock)` helper in `server/api/docs-import.js` returning `{ baselineClock, currentClock, clockGap: Math.max(0, currentClock - baselineClock), docChangedSinceBaseline: currentClock !== baselineClock }` per data-model.md §1
- [ ] T009 [US1] Parse `?strict` in `handleSyncPush` (`server/api/docs-import.js`) using the T003 helper; on a parse error return 400 with the shared message shape
- [ ] T010 [US1] Add the `sync_baseline_stale` entry to `REJECTION_MESSAGES` (`server/api/docs-import.js:86-96`) with the message and guidance text from `contracts/sync-receipt-v2.md`
- [ ] T011 [US1] Implement the strict gate in `handleSyncPush` immediately after baseline validation and **before** the presence session opens (`server/api/docs-import.js:126`): when `strict` and `docChangedSinceBaseline`, return HTTP 409 with `error: 'sync_baseline_stale'`, message, guidance, and the four staleness fields; nothing is applied
- [ ] T012 [US1] Merge the staleness fields into every successful sync response in `handleSyncPush` (`server/api/docs-import.js:177`) so applied, noop, and idempotent-noop receipts all carry them (FR-001 acceptance scenario 5)
- [ ] T013 [US1] Reject `?strict` on non-sync modes and on `POST /api/docs/import` in `server/api/docs-import.js` with a 400 naming the supported combination

### Tests

- [ ] T014 [P] [US1] In `__tests__/integration/sync-push.route.test.js`: unchanged doc → `clockGap: 0`, `docChangedSinceBaseline: false`, push applies (AS-1)
- [ ] T015 [P] [US1] In `__tests__/integration/sync-push.route.test.js`: doc changed after export, no `strict` → applies as today with `clockGap > 0` and `docChangedSinceBaseline: true` (AS-2, FR-003)
- [ ] T016 [P] [US1] In `__tests__/integration/sync-push.route.test.js`: `strict=true` against a changed doc → 409 `sync_baseline_stale` with remedy and staleness fields; assert the doc content, clock, and `yjs_updates` row count are unchanged and no version entry was created (AS-3, FR-004)
- [ ] T017 [P] [US1] In `__tests__/integration/sync-push.route.test.js`: `strict=true` against an unchanged doc → applies normally (AS-4)
- [ ] T018 [P] [US1] In `__tests__/integration/sync-push.route.test.js`: a noop sync still carries all four staleness fields (AS-5)
- [ ] T019 [P] [US1] In `server/__tests__/markdown-sync.rejection.test.js`: `sync_baseline_missing` and `sync_baseline_invalid` take precedence over staleness evaluation, unchanged by `strict` (FR-005)
- [ ] T020 [P] [US1] In `__tests__/integration/sync-push.route.test.js`: `strict=1` is accepted, `strict=yes` returns 400 with the shared message shape (RBD-054-9)
- [ ] T021 [P] [US1] In `__tests__/integration/sync-push.route.test.js`: a baseline ahead of the doc is still rejected as `sync_baseline_invalid`, and `clockGap` never renders negative anywhere (RBD-054-1 edge)

**Checkpoint**: US1 is independently shippable — the trust core works with no other story.

---

## Phase 4: User Story 2 - Per-block change report (Priority: P2)

**Goal**: Receipts carry `blocksChanged` so verification needs no re-export-and-grep.

**Independent Test**: Push a sync editing one paragraph, restructuring one list, and
overlap-reconciling one live-edited block; the receipt names all three with correct index,
type, excerpt, and op kind.

### Implementation

- [ ] T022 [US2] Add `buildChangeReport(plan, sourceMap, baselineMd)` to `server/markdown-sync.js` near `pushTouchedBlocks` (`:862`): map `plan.textBlocks` → `op: 'text'`, `plan.reconcileBlocks` → `op: 'reconcile'`, and call `structuralOps(plan.structural, sourceMap, baselineMd)` (`:703`) for the rest — each `replacements` group emits one entry per baseline index in `first..last` with `op: 'structural'`, each `insertions` entry emits one entry with `op: 'structural'` plus `position: 'after'` (or `'start'` when `afterBlock` is null). **Do not modify `pushTouchedBlocks`** (research R4)
- [ ] T023 [US2] In `buildChangeReport`, populate `blockIndex` from `sourceMap.blocks[i].blockIndex`, `blockType` from `blockNode.nodeName` (falling back to `'text'` for a bare text node, matching `markdown-sync.js:906`), and `excerpt` via `blockExcerpt`; sort by `blockIndex` ascending with insertions following their anchor (data-model.md §2)
- [ ] T024 [US2] Export `buildChangeReport` from `server/markdown-sync.js`'s `module.exports` block (`:1189+`)
- [ ] T025 [US2] Call `buildChangeReport` in `applySyncPush` (`server/markdown-sync.js`) after `planPush` (`:1114`) and attach `blocksChanged` to the applied receipt (`:1180`), keeping `operations` in place (RBD-054-5)
- [ ] T026 [US2] Attach `blocksChanged: []` to both noop receipts in `applySyncPush` (`server/markdown-sync.js:1103-1107` and `:1128-1132`) (FR-010)

### Tests

- [ ] T027 [P] [US2] Unit-test `buildChangeReport` in `server/__tests__/markdown-sync.overlap.test.js`: a two-paragraph text edit yields two entries with `op: 'text'`, correct indices, types, and excerpts (AS-1)
- [ ] T028 [P] [US2] Unit-test `buildChangeReport`: a structural replace, a whole-block delete, and a boundary insertion each yield `op: 'structural'`, with the insertion carrying `position` and its anchor index (AS-2, research R5)
- [ ] T029 [P] [US2] Unit-test `buildChangeReport`: a block reconciled against concurrent live edits yields `op: 'reconcile'` **while** the same block's `overlaps[].pushSide` remains `'text'` — the deliberate asymmetry (AS-3, research R4)
- [ ] T030 [P] [US2] In `__tests__/integration/sync-push.route.test.js`: a noop sync returns `blocksChanged: []` and every changed block (and no unchanged block) appears on a real push (AS-4, SC-004)
- [ ] T031 [P] [US2] In `__tests__/integration/sync-push.route.test.js`: `operations` aggregates are still present alongside `blocksChanged` (FR-011, SC-008)

**Checkpoint**: Verification from the receipt alone.

---

## Phase 5: User Story 3 - Dry run: preview a sync without applying it (Priority: P2)

**Goal**: `dryRun=true` computes the full plan and applies nothing.

**Independent Test**: Push `dryRun=true` for a known change; the response matches the plan, and
a re-export is byte-identical to the pre-dry-run export with no version entry added.

**Depends on**: US2 for the `blocksChanged` payload (its full value); independently testable
against staleness and `operations` alone.

### Implementation

- [ ] T032 [US3] Add a `dryRun` option to `applySyncPush` (`server/markdown-sync.js:1063-1083` opts destructure), defaulting to `false`
- [ ] T033 [US3] Implement the dry-run early return in `applySyncPush` between the overlaps block (`server/markdown-sync.js:1148`) and `persistence.storeUpdate` (`:1160`): return `{ docId, mode: 'sync', dryRun: true, noop: false, clock: <current clock>, overlaps, blocksChanged, operations, images }` with **no** `markdown` key, so `storeUpdate`, `applyLiveUpdate`, and `searchIndexer.markDirty` are never reached (research R2, data-model.md §3)
- [ ] T034 [US3] Add the `dryRun: true` marker to both noop receipts in `applySyncPush` when the option is set, and drop their `markdown` re-export in that case (a dry run is never a baseline, FR-007)
- [ ] T035 [US3] Parse `?dryRun` in `handleSyncPush` (`server/api/docs-import.js`) with the T003 helper and thread it into the `applySyncPush` call (`:130-155`)
- [ ] T036 [US3] Skip the presence session entirely for dry runs: guard `importPresence.observeSyncRange` (`server/api/docs-import.js:127`) and `importPresence.settle` (`:163-176`), and skip opening the session upstream in the sync route so no avatar, selection, or fan-out occurs (RBD-054-3)
- [ ] T037 [US3] Reject `dryRun` on `mode=append`, `mode=replace`, and `POST /api/docs/import` in `server/api/docs-import.js` with a 400 naming the supported combination (FR-008, RBD-054-4)

### Tests

- [ ] T038 [P] [US3] In `__tests__/integration/sync-push.route.test.js`: a dry run returns `dryRun: true`, omits `markdown`, and carries overlaps, `blocksChanged`, staleness fields, and `operations` (AS-1, FR-007)
- [ ] T039 [P] [US3] In `__tests__/integration/sync-push.route.test.js`: the same push without `dryRun` produces changes matching what the dry run reported (AS-2, SC-003)
- [ ] T040 [P] [US3] In `__tests__/integration/sync-push.route.test.js`: after a dry run, the document export is byte-identical, the clock is unchanged, and the `yjs_updates` row count is unchanged (AS-3, SC-003)
- [ ] T041 [P] [US3] In `__tests__/integration/sync-push.route.test.js`: a dry run opens no presence session and emits no live-apply fan-out (assert against the presence/live-apply doubles the suite already uses) (AS-3, RBD-054-3)
- [ ] T042 [P] [US3] In `__tests__/integration/sync-push.route.test.js`: `dryRun=true&strict=true` against a stale baseline returns the same 409 `sync_baseline_stale` a real push would (AS-4, RBD-054-2)
- [ ] T043 [P] [US3] In `__tests__/integration/sync-push.route.test.js`: `dryRun=true` on `mode=append`, `mode=replace`, and the create route each return 400 (AS-5)
- [ ] T044 [P] [US3] In `__tests__/integration/sync-push.route.test.js`: a dry run over a noop push returns `dryRun: true`, `noop: true`, `blocksChanged: []`, and no `markdown` (AS-6)

**Checkpoint**: Agents can look before they touch a live doc.

---

## Phase 6: User Story 4 - Ordered lists keep their numbering (Priority: P2)

**Goal**: `start` survives the full repo round trip; no more spurious renumbering diffs.

**Independent Test**: Create a doc with an ordered list starting at 11; export; the markdown
numbers from 11; push the unchanged file back; the receipt is a noop.

**Independent of US1–US3** — different files entirely; may run in parallel with all of them.

**⚠️ T045 and T046 must land together with T047** — the diff engine serializes then re-parses
with the strict parser, so shipping the serializer fix alone makes every ordered-list item
diff as changed (research R7).

### Implementation

- [ ] T045 [US4] In `server/mcp/yjs/serialization.js` `toMarkdown` (`:255-262`), seed the ordered-list counter from `node.getAttribute('start')` instead of `let num = 1`, coercing with `Number()` and falling back to 1 when absent, non-finite, or `< 1` (RBD-054-8; the attribute may arrive as number **or** string — mirror the adjacent `checked === true || checked === 'true'` handling)
- [ ] T046 [US4] Apply the byte-identical change in `server/mcp/yjs/serialization.js` `toMarkdownWithSourceMap` (`:646-653`); the two copies must stay textually parallel or source maps desync (SC-006)
- [ ] T047 [US4] In `shared/markdown/strict-parser.js:240`, replace `attrs: { start: 1 }` with the first matched item's literal number (extend the `/^(\s*)\d+\. (.*)$/` handling to capture it), clamping values `< 1` to 1
- [ ] T048 [US4] Update the FROZEN-parser header comment in `shared/markdown/strict-parser.js:12-16` to record this one sanctioned exception with its authority (design amendment 2026-08-11, FR-013) — the freeze otherwise stands
- [ ] T049 [US4] Bump `CACHE_VERSION` in `server/diff-service.js:35` from `'v10'` to `'v11'` (RBD-054-12, research R9)
- [ ] T050 [US4] Verify `shared/markdown/tolerant/block-parser.js:442` already emits `attrs: { start: first.start }` and needs **no** change; confirm `< 1` clamping matches the strict parser's new behavior, adding it if absent

### Tests

- [ ] T051 [US4] Add a corpus entry to the sync round-trip invariant in `server/__tests__/format-roundtrip.test.js` (`:1015-1025`) for an ordered list with a non-default start (e.g. `start: 11`), which automatically gains both-flavor coverage (FR-014, Constitution II)
- [ ] T052 [P] [US4] In `server/__tests__/format-roundtrip.test.js`: a doc whose ordered list starts at 11 exports numbered `11.`, `12.`, `13.` in both parser modes (`describe.each([false, true])`, `:41`) (AS-1, AS-3)
- [ ] T053 [US4] Update the pinned assertion at `server/__tests__/markdown-tolerant.test.js:203` — the test named "ordered list honors start number; strict fixes start at 1" now asserts that **both** modes preserve `start`; rename it accordingly. **Update, do not delete** (research R8)
- [ ] T054 [P] [US4] Confirm `server/__tests__/markdown-strict-characterization.test.js` stays green with no fixture regeneration — both ordered-list cases in the 70-case snapshot use `start: 1`, which the new behavior also produces (research R8)
- [ ] T055 [P] [US4] Extend `server/__tests__/serialization.sourcemap.test.js` with an ordered-list-start case asserting `toMarkdownWithSourceMap(nodes).markdown === toMarkdownNodes(nodes)` (SC-006)
- [ ] T056 [P] [US4] Update the `CACHE_VERSION` pins to `'v11'` in `server/__tests__/diff-service.test.js:992-993` and `server/__tests__/markdown-strict-characterization.test.js:77`
- [ ] T057 [P] [US4] In `__tests__/integration/sync-push.route.test.js`: pushing back an unchanged export of a list starting at 11 returns a noop with `blocksChanged: []` (AS-2, SC-005)
- [ ] T058 [P] [US4] Cover `start` = 0, negative, and non-numeric values collapsing to 1 in `server/__tests__/format-roundtrip.test.js` or the tolerant suite (RBD-054-8)

**Checkpoint**: Zero spurious numbering diffs; source maps intact.

---

## Phase 7: User Story 5 - Guidance split: whole-file sync vs targeted edits (Priority: P3)

**Goal**: Every surface teaching the channel rule states the split.

**Independent Test**: Grep every listed surface for the split; the pinned trigger-surface tests
(byte budgets + trigger phrases) stay green.

**Docs-only — no tool behavior changes.** Fully independent of US1–US4.

**Authoritative write-site table and measured sentence variants**:
[contracts/guidance-split.md](./contracts/guidance-split.md). **Three surfaces are generated
from inline text in `distribution/publish.mjs`** — editing the checked-in copies is reverted on
the next regenerate (RBD-054-13).

- [ ] T059 [US5] Add the COMPACT variant to the CHANNEL RULE in `server/mcp/index.js:188-198`, keeping the literal trigger phrase `to sync/import an existing file` and staying ≤ 1,536 UTF-8 bytes (311 B headroom; FR-016)
- [ ] T060 [US5] **Rewrite** (do not append to) the sync-redirect paragraph in `server/mcp/tools/modify.js:77-80` to carry the split, keeping `mode=sync` and the `/or syncing/i` match, and staying ≤ 2,048 bytes — **only 218 B of headroom**, so re-measure before running tests
- [ ] T061 [P] [US5] Add the split to the `import_markdown_file` description's intent list in `server/mcp/tools/import-markdown-file.js:36-50` (832 B headroom), preserving the first-line contract (`sync` + `/existing/`)
- [ ] T062 [P] [US5] Add the FULL variant to both the channel-rule block (`:18-30`) and the two-way-sync section (`:203-254`) of `server/mcp/tools/tool-documentation/export-api.js`, keeping the literal `THE CHANNEL RULE`
- [ ] T063 [P] [US5] Add the FULL variant to the byte-channel section of `distribution/shared/skill.md:22-30`, leaving the `/squire:onboard` clause wording untouched (the Cursor generator's drift tripwire at `publish.mjs:539-547` throws if it moves)
- [ ] T064 [P] [US5] Add the FULL variant to Move 3 in `distribution/shared/onboard.md:57-59`
- [ ] T065 [US5] Add the split to the **inline** Kiro sources in `distribution/publish.mjs`: steering channel-rule body (`:420-422`) and `POWER.md` channel-rule text (`:332`)
- [ ] T066 [US5] Add the split to the **inline** Cursor rule source in `distribution/publish.mjs:499` (the comment at `:502` confirms this text is authored here, not in `shared/skill.md`)
- [ ] T067 [US5] Run `node distribution/publish.mjs` (dry-run by default: regenerates and validates, no network), confirm no drift-guard throw, and stage the regenerated files under `distribution/`
- [ ] T068 [P] [US5] Add the FULL variant to the channel-rule block in `client/public/agents.md:182-186` and to the `## Sync a repo file` loop (`:212-235`)
- [ ] T069 [US5] Add channel-rule guidance including the split to `BASE_SYSTEM_PROMPT` in `server/api/chat.js` near the markdown-attachment workflow (`:173-181`) using the **PLAIN** variant — this prompt has **no** channel-rule text today, so this is an addition, and the prompt's own rule at `:197` forbids em dashes (RBD-054-13)

### Tests

- [ ] T070 [US5] Run `npx jest server/mcp/__tests__/tools/ --forceExit` and confirm all byte budgets, trigger phrases, and first-line contracts pass — specifically `trigger-surfaces.test.js:75-77`, `:88-91`, `:93-95`, `tool-modules.test.js:137,165`, `import-markdown-file.test.js:86-88`, and `get-tool-documentation.test.js:70-81`
- [ ] T071 [P] [US5] Add an assertion to `server/mcp/__tests__/tools/trigger-surfaces.test.js` pinning the split's presence in `SERVER_INSTRUCTIONS` and `modify.description` (a stable substring such as `bulk updates`), so a future edit cannot silently drop it (SC-007)

**Checkpoint**: The split is contract at every surface, budgets intact.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T072 Update `README.md`'s Two-Way Sync section (`:513-523`) with the staleness fields, `strict`, `dryRun`, and `blocksChanged`, and add the guidance split there and in the MCP tools section (`:694-745`) — Constitution Principle I requires this in the same commit as the behavior change
- [ ] T073 [P] Update `specs/004-two-way-sync/contracts/sync-push.md` with a pointer to `specs/054-sync-feedback-hardening/contracts/sync-receipt-v2.md` so the base contract does not read as complete on its own
- [ ] T074 [P] Verify no consumer of the sync receipt broke: grep the repo (`grep -ra`) for `operations.textHunks`, `receipt.markdown`, and `overlaps` readers and confirm each still works against the additive shape (SC-008)
- [ ] T075 Run the full backend suite `npx jest --forceExit` and compare against the T001 baseline — zero new failures (SC-008)
- [ ] T076 Walk `specs/054-sync-feedback-hardening/quickstart.md` §2–§5 manually against a live doc in the dev pod, including the browser check that a dry run shows no avatar and no selection (RBD-054-3) and that version-history diffs render `11.` (RBD-054-12)
- [ ] T077 Record any deviation from the plan's decisions, plus the outcome of the RBD-054-11 flag (dry run's staged image pass), in `specs/054-sync-feedback-hardening/clarifications-needed.md`

---

## Dependencies & Execution Order

```
Phase 1 (Setup: T001-T002)
  └─> Phase 2 (Foundational: T003-T006)  ── blocks US1, US2, US3 only
        ├─> Phase 3  US1 staleness   (T007-T021)   🎯 MVP
        ├─> Phase 4  US2 report      (T022-T031)
        └─> Phase 5  US3 dry run     (T032-T044)   ← full value needs US2 (T022-T026)

Phase 6  US4 ordered lists (T045-T058)   ── independent; may start at T001
Phase 7  US5 guidance split (T059-T071)  ── independent; may start at T001

  └─> Phase 8 (Polish: T072-T077) ── needs everything
```

**Story independence**

| Story | Blocked by | Can ship alone |
|---|---|---|
| US1 | Phase 2 | **Yes** — the MVP |
| US2 | Phase 2 | Yes |
| US3 | Phase 2; full value needs US2 | Yes (against staleness + `operations`) |
| US4 | Nothing | Yes |
| US5 | Nothing | Yes |

**Hard couplings** (must not be split across commits)

- **T045 + T046 + T047** — serializer copies and the strict parser land together, or every
  ordered-list item diffs as changed (research R7).
- **T049 + T056** — the cache bump and its pins.
- **T065/T066 + T067** — inline source edits and the regeneration that publishes them.

## Parallel Execution Opportunities

- **Immediately after T002**: three tracks in parallel — Phase 2→US1/US2/US3, Phase 6 (US4),
  and Phase 7 (US5). They share no files.
- **Within US1**: T014–T021 are all `[P]` (independent test cases, same file — coordinate
  writes or append sequentially).
- **Within US4**: T052, T054–T058 are `[P]` across different suites.
- **Within US5**: T061–T064, T068 are `[P]` across different files; T059/T060 touch budgeted
  descriptions and should be measured one at a time; T065–T067 are serial (`publish.mjs` then
  regenerate).

## Implementation Strategy

**MVP** = Phase 1 + Phase 2 + Phase 3 (US1). That alone closes the silent-stale-merge hole,
which is the trust core and the only item that can lose a collaborator's work.

**Recommended increments**

1. **US1** — staleness + strict (MVP; independently deployable)
2. **US4** — ordered lists (independent, self-contained, fixes an active defect)
3. **US2** — change report
4. **US3** — dry run (lands on top of US2 for full value)
5. **US5** — guidance split (docs-only; can land any time)

**Task count**: 77 tasks across 8 phases — US1: 15, US2: 10, US3: 13, US4: 14, US5: 13,
Setup/Foundational: 6, Polish: 6.
