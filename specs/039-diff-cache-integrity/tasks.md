---

description: "Task list for 039-diff-cache-integrity"
---

# Tasks: Diff Cache Integrity & Two-Surface Parity

**Input**: Design documents from `/specs/039-diff-cache-integrity/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: REQUIRED. Constitution Principle II ("Test-Backed Changes") makes tests mandatory for
every behavioral change, and every user story in spec.md declares an Independent Test. Test tasks
are written **before** their implementation task and must FAIL first.

**Organization**: Tasks are grouped by user story (US1–US8) so each can be implemented, tested, and
landed independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US8)
- Exact file paths are included in every task

## Path Conventions

Web app at repository root: `server/` (Express/y-websocket, CommonJS), `client/src/` (React, ESM),
`shared/` (isomorphic CommonJS). Backend tests: Jest. Client tests: Vitest.

---

## ⛔ PARALLEL-AGENT GUARDRAILS (read before T001)

Another agent is concurrently implementing **038-attribution-integrity**. These are hard rules,
not preferences:

- **Stay on the current branch.** Do NOT create or switch branches. Do NOT commit unless the
  pipeline instructs it.
- **Do NOT run `create-new-feature.sh`. Do NOT write `.specify/feature.json`** (shared and racy —
  it currently points at 038).
- Prefix EVERY `.specify` script invocation with
  `SPECIFY_FEATURE=039-diff-cache-integrity SPECIFY_FEATURE_DIRECTORY=/local-dev/specs/039-diff-cache-integrity`.
- **Do NOT edit `CLAUDE.md`, `README.md`, or `docs/dev.md`** — reconciled in the merge queue.
- **038 territory — do not touch**: `server/index.js`, `server/origin.js`,
  `server/document-service.js`, the WRITE path of `server/postgres-persistence.js` (`storeUpdate`
  and the update-persistence side), and the migration slot.
- **039 territory in `server/postgres-persistence.js`**: ONLY `getUpdateRowsUpTo`,
  `_fetchRowsWithGapRetry`, `_findFirstGap` and their JSDoc.
- **This feature adds NO database migration.** Not one, not a no-op one.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Worktree environment. Worktrees do not inherit `node_modules`, and backend tests are
serial-only within one database — a parallel agent MUST NOT share the test DB.

- [X] T001 Install dependencies in the worktree root: `npm ci && (cd client && npm ci)`
- [X] T002 Copy the environment file from the main tree if present: `cp /local-dev/.env .env` (ignore failure if absent). Redis is shared across agents and is fine — the `CACHE_VERSION` bump namespaces 039's entries.
- [X] T003 Create a per-agent test database and export its URL: `createdb collab_test_db_039`, then `export TEST_DATABASE_URL='postgres://<user>:<pass>@<host>:5432/collab_test_db_039'`. EVERY backend test command in this file must be run as `DATABASE_URL="$TEST_DATABASE_URL" npx jest <paths> --runInBand`. `server/__tests__/helpers/db.js` respects `DATABASE_URL`. `--runInBand` is already wired — do not defeat it. NEVER point at the shared `collab_test_db`.
- [X] T004 Capture the pre-change baseline: run `DATABASE_URL="$TEST_DATABASE_URL" npx jest server shared --runInBand` and `(cd client && npx vitest run)`, and record the passing set so any later failure is attributable to this feature rather than to inherited drift.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The single cache-namespace bump and a shared cache-assertion harness that US1, US2,
and US3 all build on.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T005 Bump the diff cache namespace exactly once in `server/diff-service.js`: `CACHE_VERSION` `'v9'` → `'v10'` (line ~26), and replace the v8→v9 rationale comment with a 039 rationale (entries may be tail-gap-poisoned or shaped by the pre-parity algorithms). **This is the ONLY bump in this feature** — no later task may bump it again (FR-007, plan hazard #5).
- [X] T006 In `server/diff-service.js`, refactor the cache-write site (currently `if (isRedisEnabled() && !gapped)`, line ~115) into a single named predicate composed of three explicitly named terms — `rowsIncomplete`, `diffFailedFlag`, `timeoutDegraded` — where `rowsIncomplete = gapped`, and the other two are wired to their present-day values so the refactor is **behavior-preserving**. Document that the terms are AND-ed as a veto and are never traded off. US1/US2/US3 each redefine exactly one term, which prevents three stories from rewriting the same `if`.
- [X] T007 [P] Add a shared cache-assertion helper to `server/__tests__/diff-service.test.js` (or a sibling helper under `server/__tests__/helpers/`) that asserts "result served AND `redis.setex` NOT called" vs. "result served AND `setex` called with a `diffv10:` key and TTL 3600". Used by T009, T016, T020.

**Checkpoint**: Foundation ready — user stories can begin.

---

## Phase 3: User Story 1 — A diff never freezes the wrong document state (Priority: P1) 🎯 MVP

**Goal**: A comparison computed from a row set that is gapped OR short of the requested newest
version is served but never cached, and the read is retried within the existing shared budget
first.

**Independent Test**: Simulate a diff request for version N while N's row has not committed;
verify retry within the existing budget, no cache write when still missing, and a correct cached
diff on the next request after N commits.

### Tests for User Story 1 ⚠️ (write first, must FAIL)

- [X] T008 [P] [US1] Add read-completeness tests RC-1…RC-8 (contracts/read-completeness.md) to `server/__tests__/postgres-gap-read.test.js`: tail-short triggers retry; budget exhausted ⇒ `gapped: true` with a warn line naming the tail reason; row appearing on retry N ⇒ `gapped: false`; zero rows WITH `expectedTailClock >= 0` ⇒ incomplete; zero rows WITHOUT the option ⇒ complete/no retry; omitting the option reproduces today's retry count and `gapped` value on gapped/gap-free/empty inputs; `descending: true` evaluates the tail on the ascending view.
- [X] T009 [P] [US1] Add CW-T1 to `server/__tests__/diff-service.test.js`: with `getUpdateRowsUpTo` mocked to report an incomplete (tail-short) read, the diff is returned to the caller and `setex` is NOT called; with the log healed, the diff includes version N and IS cached under a `diffv10:` key.
- [X] T010 [P] [US1] Add the backfill regression guard (RC-7) to `server/__tests__/postgres-gap-read.test.js`: `getUpdateRowsUpTo(guid, 2147483647)` with no `expectedTailClock` issues exactly ONE query and zero retry delays. This is the FR-002 / hazard #1 guard — the backfill must never burn the retry budget.

### Implementation for User Story 1

- [X] T011 [US1] In `server/postgres-persistence.js` (READ PATH ONLY), extend `_fetchRowsWithGapRetry`'s trailing options object with an optional `expectedTailClock`. Compute `tailShort` on the ascending view per contracts/read-completeness.md (empty rows count as short only when `expectedTailClock >= 0`), OR it with the existing `_findFirstGap` result into an `incomplete` condition, drive the existing retry loop from `incomplete`, and return `gapped: incomplete`. Reuse the SAME budget (`COLLAB_READ_GAP_RETRIES`, `COLLAB_READ_GAP_RETRY_DELAYS_MS`) — no new env var, no per-path budget (023 FR-008). Extend the existing structured `console.warn` line to name the reason (gap vs. short tail).
- [X] T012 [US1] In `server/postgres-persistence.js`, add an options parameter to `getUpdateRowsUpTo(docGuid, clock, { expectedTailClock } = {})` that forwards to `_fetchRowsWithGapRetry`. Return shape unchanged. Add a JSDoc warning that `expectedTailClock` MUST NEVER be derived from `clock` (CD-5), citing `server/scripts/backfill-meaningful-classification.js:100`'s `MAX_CLOCK` sentinel.
- [X] T013 [US1] In `server/diff-service.js` `computeDiff`, pass `{ expectedTailClock: currentClock }` to `getUpdateRowsUpTo` (FR-003) and feed the returned `gapped` into the `rowsIncomplete` term of the T006 predicate (FR-004 / FR-005a). Update the surrounding comment to state that "incomplete" now covers tail-short reads as well as internal gaps, extending 023 FR-009 / D-2.
- [X] T014 [US1] Verify `server/scripts/backfill-meaningful-classification.js` is byte-unmodified and that its `getUpdateRowsUpTo(docGuid, MAX_CLOCK)` call still takes the no-expectation path (FR-002).

**Checkpoint**: US1 independently testable — `DATABASE_URL="$TEST_DATABASE_URL" npx jest server/__tests__/postgres-gap-read.test.js server/__tests__/diff-service.test.js --runInBand`

---

## Phase 4: User Story 2 — Transient diff failures recover on the next request (Priority: P1)

**Goal**: A comparison whose computation threw is served as the plain-document fallback but never
cached, so the next request recovers.

**Independent Test**: Force the diff computation to throw once, observe the fallback plus failure
flag and no cache write; request again without the failure and get a cached, fully highlighted diff.

### Tests for User Story 2 ⚠️ (write first, must FAIL)

- [X] T015 [P] [US2] Add CW-T2 to `server/__tests__/diff-service.test.js`: with `computeMarkdownDiff` forced to throw once, the response carries `meta.diffFailed === true` and the plain `currentDocument`, and `setex` is NOT called; with the failure removed, the same version pair returns the highlighted diff AND is cached. Assert the served presentation is unchanged from today (no new UI state — CD-2).

### Implementation for User Story 2

- [X] T016 [US2] In `server/diff-service.js`, wire the `diffFailedFlag` term of the T006 predicate to `result.meta.diffFailed` (FR-005b), replacing its behavior-preserving placeholder. Add a comment recording the F8 rationale: caching a failure froze the "Diff highlighting unavailable" notice for a full hour with no retry path.
- [X] T017 [US2] Confirm the `catch` around `computeMarkdownDiff` in `server/diff-service.js` (lines ~87-93) is otherwise unchanged — it still logs, still falls back to `currentDocument`, still sets `diffFailed`. The only change is that the result is no longer cacheable.

**Checkpoint**: US1 + US2 both independently functional.

---

## Phase 5: User Story 3 — Word-level emphasis is deterministic per version pair (Priority: P2)

**Goal**: Distinguish the deterministic size cap from the load-dependent time budget; cache the
former, never the latter.

**Independent Test**: A size-capped region yields a cacheable line-level result every time; a
timeout-degraded computation is served but not cached; a later request under normal load returns
and caches the word-level result.

### Tests for User Story 3 ⚠️ (write first, must FAIL)

- [X] T018 [P] [US3] Add WD-1…WD-4 to `shared/diff/__tests__/word-diff.test.js`: an oversized side stamps `report.reason === 'size'` and returns `null`; a forced jsdiff timeout stamps `report.reason === 'timeout'` and returns `null`; calling with NO `report` argument behaves exactly as today; `DIFF_TIMEOUT_MS === 250` and `MAX_SIDE_CHARS === 20000` are pinned as constants.
- [X] T019 [P] [US3] Add a report-threading test to `server/diff/__tests__/apply-word-marks.test.js` (create the file if absent): `applyWordMarks(removedMd, addedMd, report)` propagates the segmenter's reason into `report` for both degradation kinds, and its fail-open `catch` path still returns line-level blocks without throwing.
- [X] T020 [P] [US3] Add CW-T3 and CW-T4 to `server/__tests__/diff-service.test.js`: a `'size'`-degraded comparison IS cached; a `'timeout'`-degraded comparison is served but NOT cached; recomputing without the timeout returns the word-level result AND caches it. Add CW-T5: simultaneous incomplete + failed + timeout still yields exactly one served response and no cache write.

### Implementation for User Story 3

- [X] T021 [US3] In `shared/diff/word-diff.js`, add an optional third `report` parameter to `computeWordSegments`. On the size-cap early return set `report.reason = 'size'`; on the jsdiff-timeout return set `report.reason = 'timeout'`. **Keep the `null` return** (CD-6) and do NOT change `MAX_SIDE_CHARS` or `DIFF_TIMEOUT_MS`. Document why the reasons differ in cacheability: `size` is a pure function of the inputs, `timeout` is wall-clock and load-dependent.
- [X] T022 [US3] In `server/diff/apply-word-marks.js`, add a `report` parameter to `applyWordMarks` and forward it to `wordDiff.computeWordSegments`. No algorithmic change — this file is already the per-region reference behavior. Preserve the fail-open `catch` and the `loggedOnce` throttle exactly (VH-1).
- [X] T023 [US3] In `server/diff-service.js`, create a per-request report sink in `computeDiff`, thread it through `computeMarkdownDiff` into each `applyWordMarks` call, OR every `reason === 'timeout'` sighting into a `timeoutDegraded` flag (whole-result granularity — CD-4), and wire that flag into the T006 predicate's `timeoutDegraded` term (FR-005c). The sink MUST be per-request, never module-level state (re-entrancy).

**Checkpoint**: The full FR-005 cache gate (a ∧ b ∧ c) is now live and independently tested.

---

## Phase 6: User Story 4 — Chat and version history agree about which words changed (Priority: P2)

**Goal**: Both surfaces derive word emphasis from one shared per-region segmentation, restoring the
ratified 022 SC-003 parity.

**Independent Test**: Feed the same before/after pair through both pipelines and assert the
changed-character ranges match row-for-row.

### Tests for User Story 4 ⚠️ (write first, must FAIL)

- [X] T024 [P] [US4] Add LS-T1 and LS-T2 to `shared/diff/__tests__/word-diff.test.js` for the new `computeLineWordSegments`: row counts preserved on both sides (including unequal counts, empty rows, and a trailing empty row); and the **byte-identical per-row rejoin** assertion `result.before[k].map(s => s.text).join('') === beforeLines[k]` over a corpus including multi-byte UTF-8, leading/trailing whitespace, and an empty row. Assert bytes, not visual plausibility (plan hazard #3).
- [X] T025 [P] [US4] Add LS-T3, LS-T4, LS-T5 to `shared/diff/__tests__/word-diff.test.js`: a line inserted at the top of an otherwise-unchanged multi-line block leaves the unchanged rows with no `changed` segments; unequal row counts give EVERY row segments (no `Math.min` anywhere); an oversized region returns `null`.
- [X] T026 [P] [US4] Add PAR-1 and PAR-2 (SC-003) as a new parity test file `server/__tests__/diff-two-surface-parity.test.js`: drive `postProcessDiffLines` (chat) and `applyWordMarks` (version history) from the same before/after pair, derive each surface's ordered per-side (row-relative start, end) changed-range lists, and assert equality row for row; plus, when the guardrails trip, both surfaces fall back for the WHOLE region. Compare derived range lists, not the surfaces' native output shapes.
- [X] T027 [P] [US4] Add VH-T1 to `server/diff/__tests__/apply-word-marks.test.js`: a block with NO direct text child (empty paragraph, list wrapper) is traversed identically by `plainTextOf` and by `stampSide`'s `isTextBlock` — the two separate implementations of one traversal must stay in agreement (plan hazard #4).
- [X] T028 [P] [US4] Add CS-T1 to `server/mcp/__tests__/diff-postprocess.test.js`: `inlineSegments` keys remain stringified OUTPUT row indices with `Segment[]` values, and the truncation filter in `server/mcp/diff-utils.js` still drops keys past `MAX_DIFF_LINES` (CS-1, CS-3).

### Implementation for User Story 4

- [X] T029 [US4] In `shared/diff/word-diff.js`, implement and export `computeLineWordSegments(beforeLines, afterLines, report)`: join each side with `'\n'`, call `computeWordSegments` once, return `null` if it returns `null`, otherwise re-split each side's coalesced segment stream at every `'\n'` (dropping the newline itself as a row separator) into per-row `Segment[]` arrays, one per input row, in order. Document that the re-split's exactness is a derived consequence of the segmenter's faithfulness invariant.
- [X] T030 [US4] In `server/mcp/diff-postprocess.js`, replace the positional pairing block (`pairCount = Math.min(delOutIdx.length, addOutIdx.length)`, lines ~183-191) with a single `computeLineWordSegments` call over the region's `stripSpanTags(line.slice(1))` row texts, assigning `inlineSegments` for ALL rows on both sides (FR-009). On `null`, emit no `inlineSegments` for the whole region — row tint only (FR-010). Segment the SAME stripped strings the rows render, so per-row rejoin is an invariant about displayed text (CS-2).
- [X] T031 [US4] Verify the format-only branch in `server/mcp/diff-postprocess.js` (the `delLines.length === addLines.length` + identical-plain-text path, lines ~139-162) is unmodified — it runs before word segmentation and is out of scope (CS-4).
- [X] T032 [US4] Verify `stripHardBreakMarkers` in `server/mcp/diff-utils.js` is byte-identical to `main` (ratified 028 / FR-011, plan hazard #6), and run the 028 regression cases in `server/mcp/__tests__/diff-postprocess.test.js` unmodified (CS-T2).

**Checkpoint**: The two surfaces agree; the four approved visible changes are the only ones.

---

## Phase 7: User Story 5 — The model stops paying for UI-only diff data (Priority: P2)

**Goal**: `diff.inlineSegments` is absent from every model-bound serialization, while storage and
the browser keep it.

**Independent Test**: Request a comparison via each of the three model-bound paths and assert the
emphasis field is absent while hunk positions and format annotations are retained; assert the
stored/browser-bound output still carries the segments.

### Tests for User Story 5 ⚠️ (write first, must FAIL)

- [X] T033 [P] [US5] Add MS-1 and MS-2 to `server/mcp/__tests__/diff-postprocess.test.js` (or a new `server/mcp/__tests__/strip-ui-only.test.js`): `stripUiOnlyDiffFields` removes `diff.inlineSegments`, retains `lines`/`hunkStarts`/`formatAnnotations`/`truncatedByServer`, never mutates its input, and returns unrelated results by identity.
- [X] T034 [P] [US5] Add MS-3 to `server/mcp/__tests__/`: the MCP tool-result serialization of a `modify` result contains no `inlineSegments`, and the pretty-print indentation is unchanged (explicit spec non-goal).
- [X] T035 [P] [US5] Add MS-4 to the chat-tools test suite under `server/api/__tests__/`: the bridged tool's `toModelOutput` strips the segments while the value returned by `execute` still carries them (FR-013).
- [X] T036 [P] [US5] Add MS-5, MS-6, MS-7 to the chat-models/chat test suites under `server/api/__tests__/`: `stripUiOnlyDiffParts` strips replayed tool outputs without mutating the input array or its parts; an image tool part in history survives the pass WITHOUT image bytes being re-inlined; and `convertToModelMessages` is invoked with EXACTLY ONE argument (the FR-014 regression guard).

### Implementation for User Story 5

- [X] T037 [US5] In `server/mcp/diff-utils.js`, implement and export `stripUiOnlyDiffFields(result)`: pure and non-mutating; identity return when the input is not an object, has no `diff`, or has no `diff.inlineSegments`; otherwise a shallow clone with `diff` shallow-cloned minus `inlineSegments`. Targeted at `result.diff` only — not a deep key walk (ST-5). Do NOT touch `stripHardBreakMarkers` in the same file.
- [X] T038 [US5] In `server/mcp/index.js` (line ~69), wrap the tool result: `JSON.stringify(stripUiOnlyDiffFields(result), null, 2)`. Indentation unchanged (MA-1).
- [X] T039 [US5] In `server/api/chat-tools.js` `buildTools`, add `toModelOutput: ({ output }) => ({ type: 'json', value: stripUiOnlyDiffFields(output) })` to the MCP-bridged `tool({ ... })` definition (~line 467). Do NOT modify the image tools' own `toModelOutput` definitions (~lines 321, 386) and do NOT change `MAX_RESULT_CHARS`'s full-result measurement (~line 501).
- [X] T040 [US5] In `server/api/chat-models.js`, add `stripUiOnlyDiffParts(messages)` modeled on `stripReasoningParts` (~line 312) — non-mutating, never drops a part or a message, rewrites only tool parts whose `output.diff.inlineSegments` exists, via `stripUiOnlyDiffFields`; export it. Then in `server/api/chat.js`, call it unconditionally on `modelInputMessages` beside `stripReasoningParts` (~line 964), BEFORE `convertToModelMessages` (~line 976). **Add a comment at the `convertToModelMessages` call recording that `{ tools }` MUST NEVER be passed** — the image tools' `toModelOutput` exists to ADD image bytes that stored history deliberately omits, so passing tools would re-inline every image on every turn (FR-014, plan hazard #2).

**Checkpoint**: All three model-bound seams clean; storage and browser rendering unchanged.

---

## Phase 8: User Story 6 — Diff computation stops replaying the log twice (Priority: P3)

**Goal**: Each log row is applied at most once per reconstruction, with byte-identical output.

**Independent Test**: Diff output for representative version pairs is deep-equal before/after, and
an application counter shows each row applied at most once.

### Tests for User Story 6 ⚠️ (write first, must FAIL)

- [X] T041 [P] [US6] Add CW-T9 to `server/__tests__/diff-service.test.js`: deep-equal `computeDiff` output before/after the reconstruction change for at least three representative version pairs, including `previousClock = -1` (the empty-state case, where seeding is skipped).
- [X] T042 [P] [US6] Add CW-T10 to `server/__tests__/diff-service.test.js`: an application counter (e.g. spying on `Y.applyUpdate` or counting per-row invocations) proves no log row is applied more than once per reconstruction (SC-006).

### Implementation for User Story 6

- [X] T043 [US6] In `server/diff-service.js` `buildDocsAtClocks` (lines ~134-158), keep the signature and return shape, and replace the double-apply loop: apply rows with `clock <= previousClock` to `prevDoc`; when `previousClock >= 0`, seed `currDoc` with `Y.applyUpdate(currDoc, Y.encodeStateAsUpdate(prevDoc))`; then apply only rows in `(previousClock, currentClock]` to `currDoc`. When `previousClock < 0`, skip seeding and apply all rows `clock <= currentClock` as today (FR-015 / US6 scenario 2).
- [X] T044 [US6] Verify `gc: false` is preserved on BOTH `Y.Doc` constructions in `server/diff-service.js` — it is what makes the seed carry deleted structs, and is load-bearing for byte-identical output (SR-2). Add a comment saying so.

**Checkpoint**: Half the replay work, identical output.

---

## Phase 9: User Story 7 — The "Formatting changes only" banner tells the truth (Priority: P3)

**Goal**: Plain-text extraction preserves literal angle-bracket prose, so a text change is never
reported as formatting-only.

**Independent Test**: Two versions differing only inside literal angle-bracket prose extract to
different plain text and report a text change.

### Tests for User Story 7 ⚠️ (write first, must FAIL)

- [X] T045 [P] [US7] Add extraction tests to `server/__tests__/diff-service.test.js` (the existing `extractText (shared yjs-utils)` describe block, ~line 62): a document containing `use <div> tags for layout` extracts that prose verbatim; and today's line shape is preserved — one line per TOP-LEVEL fragment node, descendants concatenated with no separator, trailing `.trim()` (CD-8).
- [X] T046 [P] [US7] Add CW-T11 and CW-T12 to `server/__tests__/diff-service.test.js`: two versions differing only inside literal angle-bracket prose yield `meta.textIdentical === false` and `meta.formattingOnly === false`; and the same holds when the literal `<` sits inside a **bold** run (the `Y.XmlText` `toDelta` subtlety — the walk must read string inserts, not `toString()`).

### Implementation for User Story 7

- [X] T047 [US7] In `server/yjs-utils.js`, rewrite `extractText` (lines ~28-37) to walk the Yjs tree: recurse into `Y.XmlElement`/`Y.XmlFragment` children and concatenate `Y.XmlText` **string inserts** (via `toDelta()`, NOT `toString()`, which would re-emit inline formatting as tags and simply move the bug down a level). Join top-level node texts with `'\n'`, concatenate descendants with NO separator, `.trim()` the result — preserving today's shape exactly (CD-8, FR-016).
- [X] T048 [US7] Leave `extractXml` in `server/yjs-utils.js` unchanged — `formattingOnly` needs the markup-bearing form and `server/update-classifier.js` depends on it. Confirm `extractText`'s only consumer remains `server/diff-service.js` (repo-wide grep).
- [X] T049 [US7] In `server/diff-service.js`, remove the declared-but-never-read `textIdentical` parameter from `computeMarkdownDiff` (line ~187) and drop the argument at its call site (line ~88). No behavior change — the function already re-derives the answer from `prevMd === currMd` (FR-017).
- [X] T050 [US7] Run the existing `server/__tests__/diff-service.test.js` and `server/__tests__/update-classifier.test.js` suites and confirm no `textIdentical` / `formattingOnly` expectation flipped except the intended angle-bracket cases — any other flip is a real regression, not a shape change.

**Checkpoint**: The banner tells the truth.

---

## Phase 10: User Story 8 — History author badges keep a stable fallback color (Priority: P3)

**Goal**: A colorless history author badge uses the stable neutral `#888888`, not a date-salted
presence color.

**Independent Test**: Render the history author list with a colorless author on two different
mocked dates and assert the same neutral color both times.

### Tests for User Story 8 ⚠️ (write first, must FAIL)

- [X] T051 [P] [US8] Add a fallback-stability test to `client/src/components/__tests__/HierarchicalVersionList.test.jsx`: an author entry with no `color` renders `#888888` on two different mocked system dates.

### Implementation for User Story 8

- [X] T052 [US8] In `client/src/components/HierarchicalVersionList.jsx` (line ~56), change the badge fallback from `author.color || generateColorFromId(author.id)` to `author.color || '#888888'`, matching the server's no-identity fallback in `server/version-history.js` (line ~60). Remove the now-unused `generateColorFromId` import if nothing else in the file uses it.
- [X] T053 [US8] Verify `client/src/utils/colorUtils.js` is unchanged — the daily presence rotation in `generateColorFromId` is deliberate product behavior and explicitly out of scope (FR-018).

**Checkpoint**: All eight user stories independently functional.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [X] T054 Run the full backend suite: `DATABASE_URL="$TEST_DATABASE_URL" npx jest server shared --runInBand`. Compare against the T004 baseline — the only intended changes are the four approved visible ones (surplus-row emphasis, less false emphasis on shifted rewrites, slightly more frequent chat row-tint fallback on very large regions, stable badge color) (SC-008).
- [X] T055 [P] Run the client suite `(cd client && npx vitest run)` and `npm run build`.
- [X] T056 [P] Run every scenario in `specs/039-diff-cache-integrity/quickstart.md` §3 (V1–V8) and record the outcome.
- [X] T057 Documentation check (do NOT edit): confirm whether `README.md` or `docs/dev.md` describe cache-write conditions, word-emphasis internals, or model-bound serialization. Expected finding: neither does, so no update is owed. **Report the finding to the merge-queue owner rather than editing** — Principle I is deferred to the merge queue by the parallel-agent protocol (see plan.md Complexity Tracking).
- [X] T058 Design-doc check (do NOT hand-edit `design/`): confirm that restoring two-surface parity converges toward `design/document-model-format-pipeline.md`'s existing claim ("The same shared word-segmentation helper drives the chat tool-output diff") rather than contradicting it, so no Squire-doc amendment is owed. Report if this assessment turns out wrong.
- [X] T059 Run the pre-handoff checklist in `specs/039-diff-cache-integrity/quickstart.md` §5: no migration anywhere; `git diff --stat` touches none of `server/index.js`, `server/origin.js`, `server/document-service.js`, `CLAUDE.md`, `README.md`, `docs/dev.md`, `.specify/feature.json`; `server/postgres-persistence.js` changes confined to the three read-path functions; `CACHE_VERSION === 'v10'` bumped exactly once; `stripHardBreakMarkers` byte-identical to `main`; `convertToModelMessages` takes exactly one argument; the backfill script unmodified; `DIFF_TIMEOUT_MS === 250`, `MAX_SIDE_CHARS === 20000`, cache TTL `3600`.
- [X] T060 Remove any behavior-preserving placeholder left by T006 (every one of the three predicate terms must now be wired to a real value) and confirm the cache-write predicate has exactly the three conditions from FR-005 — no more, no fewer (CW-4).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup. **Blocks all user stories.**
- **User Stories (Phases 3–10)**: all depend on Foundational.
- **Polish (Phase 11)**: depends on all desired stories.

### User Story Dependencies

- **US1 (P1)**, **US2 (P1)**, **US3 (P2)** are each independently testable but all edit the cache
  predicate in `server/diff-service.js`. They **serialize on that file** — implement in order
  US1 → US2 → US3 (each redefines exactly one term of the T006 predicate). Their *test* tasks are
  parallelizable.
- **US4 (P2)** depends on US3's `report` parameter existing in `shared/diff/word-diff.js`
  (T021) before T029 lands, since `computeLineWordSegments` forwards it. Otherwise independent.
- **US5 (P2)**, **US6 (P3)**, **US7 (P3)**, **US8 (P3)** are fully independent of each other and of
  US1–US4, with one file-level caveat: US6 and US7 both edit `server/diff-service.js`
  (different functions — `buildDocsAtClocks` vs. `computeMarkdownDiff`'s signature).

### Within Each User Story

Tests are written first and must FAIL → shared/ helpers → server modules → call sites →
verification tasks.

### Parallel Opportunities

- T007 is `[P]` within Foundational.
- All test tasks within a story are `[P]` (different files or different describe blocks).
- Once Foundational completes, three independent tracks can run concurrently:
  **Track A** US1 → US2 → US3 → US4 (diff-service + segmentation),
  **Track B** US5 (MCP/chat serialization),
  **Track C** US6 → US7 (diff-service internals) and US8 (client) — with US6/US7 sequenced against
  Track A's `server/diff-service.js` edits.
- US8 touches only client files and can run at any time after Setup.

---

## Parallel Example: User Story 4

```bash
# Launch all US4 tests together (different files / describe blocks):
Task: "LS-T1/LS-T2 per-row rejoin tests in shared/diff/__tests__/word-diff.test.js"
Task: "PAR-1/PAR-2 parity tests in server/__tests__/diff-two-surface-parity.test.js"
Task: "VH-T1 traversal-agreement test in server/diff/__tests__/apply-word-marks.test.js"
Task: "CS-T1 client-contract test in server/mcp/__tests__/diff-postprocess.test.js"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → 4. **STOP and VALIDATE**: the
   highest-severity audit finding (F7) is closed and independently testable — a torn or tail-short
   read can no longer freeze an hour of confidently wrong diffs for every viewer.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 (F7) → validate → MVP.
3. US2 (F8) → validate. **The two P1 stories together close the entire "wrong answer frozen for an
   hour" class.**
4. US3 (F9) → validate. The FR-005 gate is now complete (a ∧ b ∧ c).
5. US4 (F10) → validate the ratified 022 SC-003 parity is restored.
6. US5 (F11) → validate token savings with rendering unchanged.
7. US6, US7, US8 (F12–F14) → validate. Each adds value without breaking the previous ones.

### Notes

- `[P]` = different files, no dependencies on incomplete tasks.
- Verify each test FAILS before implementing it.
- Backend tests: `DATABASE_URL="$TEST_DATABASE_URL" npx jest <paths> --runInBand`, always against
  `collab_test_db_039`, never the shared DB.
- Do not bump `CACHE_VERSION` more than once (T005 owns it).
- Do not touch 038 territory, and add no migration.
