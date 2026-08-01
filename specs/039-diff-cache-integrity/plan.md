# Implementation Plan: Diff Cache Integrity & Two-Surface Parity

**Branch**: `039-diff-cache-integrity` (parallel-agent mode: work happens on `main` / a pipeline worktree — **no branch is created**)

**Date**: 2026-08-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/039-diff-cache-integrity/spec.md`

## Summary

Eight verified audit findings (F7–F14) in the version-diff stack. The primary requirement is
**cache-write correctness**: a comparison result may be frozen for an hour only when it is
provably *complete* (row set has no internal gap and reaches the requested newest version),
*successful* (no diff-failed flag), and *deterministic* (no load-dependent word-diff timeout).
Secondary requirements unify word emphasis across the two diff surfaces, strip UI-only emphasis
data from every model-bound serialization, halve the log replay per comparison, fix a
regex-based plain-text extractor that corrupts the "Formatting changes only" signal, and pin an
unstable history badge fallback color.

**Technical approach**: four small, independently landable seams, all read-path/serialization —
no schema, no new services, no new UI states.

1. **Read completeness** — add an opt-in `expectedTailClock` to the existing gap-retry choke
   point (`_fetchRowsWithGapRetry`) and surface it through `getUpdateRowsUpTo`. Reuses the one
   shared retry budget; absent the option, behavior is byte-identical (protects the backfill's
   `MAX_CLOCK` sentinel).
2. **Cache-write gate** — replace `if (isRedisEnabled() && !gapped)` in `DiffService.computeDiff`
   with an AND of three conditions (complete ∧ !diffFailed ∧ !timeoutDegraded), bump
   `CACHE_VERSION` v9 → v10 **exactly once**.
3. **Two-surface parity** — introduce `computeLineWordSegments` in `shared/diff/word-diff.js`
   (join rows with `\n`, segment once, re-split the segment stream at newline boundaries) and
   make `server/mcp/diff-postprocess.js` consume it in place of its positional row pairing. The
   version-history side (`applyWordMarks`) already segments per region; it gains only the
   degradation-reason signal.
4. **Model-context hygiene + small fixes** — one shared `stripUiOnlyDiffFields` helper applied at
   three seams; single-replay state reconstruction; structure-walking `extractText`; drop the
   dead `textIdentical` parameter; `'#888888'` badge fallback.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server + `shared/`), React 18 (ESM client)

**Primary Dependencies**: `yjs`, `y-prosemirror`, `diff` (jsdiff: `diffLines`, `diffWordsWithSpace`,
`structuredPatch`), `ioredis`, `pg`, `ai` (AI SDK v5), `prosemirror-model`

**Storage**: PostgreSQL `yjs_updates` (read path only — **no migration in this feature**);
Redis diff cache (namespace `diff<CACHE_VERSION>:<guid>:<prev>:<curr>`, TTL 3600s)

**Testing**: Jest for server + `shared/` (`server/__tests__/`, `server/mcp/__tests__/`,
`shared/diff/__tests__/`, `server/diff/__tests__/`), run `--runInBand`; Vitest for client
(`client/src/components/__tests__/`)

**Target Platform**: Linux server (k3s), evergreen browsers

**Project Type**: Web application (Express/y-websocket backend + React/TipTap frontend + `shared/`)

**Performance Goals**: comparison latency must not regress; F12 halves the log replay for
mid-history pairs (each row applied ≤ 1× per reconstruction). Word-diff time budget stays
**250 ms** (event-loop guard, not a tuning knob — FR-006, CD-3).

**Constraints**: no new env knobs; one shared gap-retry budget
(`COLLAB_READ_GAP_RETRIES`=2, `COLLAB_READ_GAP_RETRY_DELAYS_MS`=100,300); cache TTL unchanged;
client-facing `inlineSegments` contract (segments keyed by stringified output-row index) unchanged;
`CACHE_VERSION` bumped exactly once.

**Scale/Scope**: ~11 production files touched, ~7 test files extended/added. No public API shape
change except the removal of UI-only fields from model-bound copies.

## Collision Contract with Feature 038 (attribution integrity) — BINDING

038 is being implemented concurrently against the same repo. Ownership is disjoint **by function**,
not merely by file:

| Surface | Owner | 039 rule |
|---|---|---|
| `server/index.js` | 038 | **Do not touch.** `computeDiff(docId, previous, current)` call site at ~line 1412 keeps its exact signature. |
| `server/origin.js` | 038 | Do not touch. |
| `server/document-service.js` | 038 | Do not touch. |
| `server/postgres-persistence.js` — **WRITE** path (`storeUpdate` and everything on the update-persistence side) | 038 | Do not touch. |
| `server/postgres-persistence.js` — **READ** path (`getUpdateRowsUpTo`, `_fetchRowsWithGapRetry`, `_findFirstGap`) | **039** | 038 must not touch. Edits confined to these three functions + their JSDoc. |
| node-pg-migrate migration slot | 038 | **039 adds NO migration.** Not one, not a no-op one. |

Practical consequence for the implementer: `_fetchRowsWithGapRetry` is a shared read helper — its
signature gains one optional key inside the existing trailing options object
(`{ descending, expectedTailClock }`), so the other three call sites
(`getYDoc`, `getYDocAtClock`, `_queryUpdatesWithUsers`) are untouched source-wise.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Constitution v1.1.1.*

| Principle | Verdict | Notes |
|---|---|---|
| **I. Documentation Reflects Reality** | ⚠️ **Deferred by pipeline protocol** | This is a behavior change and would normally require `README.md` / `docs/dev.md` updates in the same commit. The parallel-agent protocol forbids editing `CLAUDE.md`, `README.md`, `docs/dev.md` (they are reconciled in the serial merge queue). Recorded in Complexity Tracking; the merge-queue owner MUST perform the doc reconciliation. Assessment of actual doc surface: **no `README.md`/`docs/dev.md` change appears necessary** — neither documents cache-write conditions, word-emphasis internals, or model-bound serialization. Tasks include a verification step rather than an edit. |
| **II. Test-Backed Changes** | ✅ PASS | Every FR maps to at least one test task; backend suites run `--runInBand` against a per-agent DB. No new marks or nodes are introduced, so the registry-driven round-trip suite (`server/__tests__/format-roundtrip.test.js`) is **not** in scope — verified: `diffInsertWord`/`diffDeleteWord` already exist from 022 and their placement is unchanged. |
| **III. Trunk-Based Solo Workflow** | ✅ PASS | No new ceremony. Pipeline worktree + serial merge queue is the already-ratified path for multi-feature work. |
| **IV. Collaboration-Safe Document Operations** | ✅ PASS (N/A by construction) | 039 mutates **no** live document. Every Y.Doc built here is an ephemeral `gc:false` reconstruction destroyed at the end of `computeDiff`. The F12 change seeds `currDoc` via `Y.applyUpdate(currDoc, Y.encodeStateAsUpdate(prevDoc))` — an additive CRDT merge, never a delete-and-recreate. Format knowledge stays in the registry (no serializer change). Provenance untouched (attribution is 038's surface). |
| **V. Secure by Default** | ✅ PASS, net-positive | No new ingestion surface, no new endpoint, no sandbox change. F11 strictly *reduces* what reaches the model. The extraction change (FR-016) removes a regex-strip over untrusted document prose in favor of structural traversal — strictly safer, and it is a *comparison-metadata* extractor, not a sanitizer (the SVG/HTML sanitizers are untouched). |
| **VI. Design Docs Are Ground Truth** | ✅ PASS | `design/document-model-format-pipeline.md` ("Version diffs", 022 amendment) states *"The same shared word-segmentation helper drives the chat tool-output diff"* — the code's positional row pairing **falsifies the parity that sentence asserts**; 039 restores the doc's stated intent, so **no doc amendment is required**. The same amendment's "the diff cache version bumps v7→v8" is a historical statement about 022, not a live invariant — v9→v10 does not contradict it. `design/collaboration-core.md` (023 amendment) states *"A diff … must never be computed from a gapped or misordered row set and then cached/frozen as truth"* — FR-004 extends this to tail-short reads, which is convergence toward the doc, not away. No `design/` file is hand-edited. Open items recorded in `clarifications-needed.md` as RATIFIED-BY-DEFAULT. |

**Gate result: PASS** with one recorded deviation (Principle I, protocol-deferred).

## Project Structure

### Documentation (this feature)

```text
specs/039-diff-cache-integrity/
├── spec.md                    # input
├── clarifications-needed.md   # CD-1..CD-8 (CD-5..CD-8 added at plan time)
├── plan.md                    # this file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
├── contracts/                 # Phase 1 output
│   ├── read-completeness.md
│   ├── cache-write-rules.md
│   ├── word-segmentation.md
│   └── model-bound-serialization.md
├── checklists/
└── tasks.md                   # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
shared/
├── diff/
│   ├── word-diff.js                     # MODIFY: degradation-reason signal (FR-006);
│   │                                    #   NEW computeLineWordSegments (FR-008)
│   └── __tests__/word-diff.test.js      # MODIFY: reason + per-row re-split invariants

server/
├── postgres-persistence.js              # MODIFY (READ PATH ONLY — 039 territory):
│                                        #   _findFirstGap / _fetchRowsWithGapRetry /
│                                        #   getUpdateRowsUpTo gain expectedTailClock (FR-001..003)
├── diff-service.js                      # MODIFY: cache-write gate (FR-005), CACHE_VERSION v10
│                                        #   (FR-007), single-replay reconstruction (FR-015),
│                                        #   drop dead textIdentical param (FR-017)
├── yjs-utils.js                         # MODIFY: extractText walks structure (FR-016)
├── diff/apply-word-marks.js             # MODIFY: thread degradation report (FR-006)
├── mcp/
│   ├── diff-postprocess.js              # MODIFY: per-region segmentation (FR-008..010)
│   ├── diff-utils.js                    # stripHardBreakMarkers stays VERBATIM (FR-011 / 028);
│   │                                    #   ADD stripUiOnlyDiffFields export (FR-012)
│   └── index.js                         # MODIFY: strip at MCP tool-result serialization (FR-012a)
├── api/
│   ├── chat-tools.js                    # MODIFY: toModelOutput on MCP-bridged tools (FR-012b)
│   ├── chat-models.js                   # MODIFY: NEW stripUiOnlyDiffParts pass (FR-012c/FR-014)
│   └── chat.js                          # MODIFY: one call to the new strip pass beside
│                                        #   stripReasoningParts (~line 964). MUST NOT pass
│                                        #   { tools } to convertToModelMessages (~line 976).
└── __tests__/                           # MODIFY/ADD: diff-service, postgres-gap-read, yjs-utils

client/src/
├── components/HierarchicalVersionList.jsx   # MODIFY: '#888888' fallback (FR-018)
├── utils/colorUtils.js                      # UNCHANGED (presence rotation is deliberate — FR-018)
└── components/__tests__/HierarchicalVersionList.test.jsx  # MODIFY

server/scripts/backfill-meaningful-classification.js  # UNCHANGED — protected by opt-in (FR-002)
```

**Structure Decision**: existing web-app layout. Shared segmentation logic lives in `shared/diff/`
(consumed by both server surfaces, per the constitution's `shared/` rule); server-only diff
assembly stays under `server/diff/` and `server/mcp/`.

## Design Decisions (rationale in research.md)

- **D1 — Opt-in tail check via an options key.** `getUpdateRowsUpTo(docGuid, clock, { expectedTailClock })`;
  the value is **never** derived from `clock`, because the backfill passes `MAX_CLOCK = 2147483647`
  as `clock`. Callers that omit it get today's code path exactly. (CD-5)
- **D2 — Empty-with-expectation is incomplete.** When `expectedTailClock >= 0` is supplied and the
  fetch returns zero rows, that is an incomplete read (retry), not an empty document. Without the
  option, zero rows stays a legitimate empty document.
- **D3 — Degradation reason as an out-of-band report sink.** `computeWordSegments` keeps its
  `null`-on-degradation return (no call-site churn, no accidental-truthiness bug) and accepts an
  optional `report` object it stamps with `report.reason = 'size' | 'timeout'`. The same object is
  threaded `computeDiff → computeMarkdownDiff → applyWordMarks → computeWordSegments`. Matches
  FR-006's literal "out-of-band degradation signal". (CD-6)
- **D4 — Live-turn strip via `toModelOutput`, history strip via a dedicated pass.** These are two
  different seams and must stay two different mechanisms. `toModelOutput` on the MCP-bridged chat
  tools handles the current turn (the AI SDK's sanctioned hook; the stored/browser-bound output
  keeps the segments). History replay is a `stripUiOnlyDiffParts(messages)` pass over **UI
  messages**, called beside `stripReasoningParts` *before* `convertToModelMessages`.
  **`convertToModelMessages` is still called with no `{ tools }` argument** (FR-014 — passing tools
  would run the image tools' `toModelOutput` over history and re-inline image bytes
  `chat-tools.js` deliberately keeps out of storage). (CD-7)
- **D5 — Structural `extractText` preserves today's line shape.** One line per top-level fragment
  node, descendants concatenated with no separator, `.trim()` at the end — the same shape the
  regex version produced for tag-free prose, minus the corruption of literal `<div>` text.
  `extractText`'s only consumer is `diff-service.js` (verified by grep), so blast radius is
  `textIdentical` + `formattingOnly` only. `extractXml` is untouched. (CD-8)
- **D6 — Single-replay reconstruction.** Build `prevDoc` from rows `clock <= previousClock`; when
  `previousClock >= 0`, seed `currDoc` with `Y.applyUpdate(currDoc, Y.encodeStateAsUpdate(prevDoc))`;
  then apply only rows in `(previousClock, currentClock]`. `gc:false` on both docs is preserved, so
  the seed carries deleted structs and the result converges byte-identically.
- **D7 — Per-region guardrails on the chat surface.** `computeLineWordSegments` joins each side's
  rows with `\n` and calls `computeWordSegments` once. On `null` (size or timeout), the **whole
  region** gets no `inlineSegments` — the row-tint-only fallback that already exists. Approved
  visible change (spec Assumptions / FR-010).
- **D8 — One `CACHE_VERSION` bump.** `v9 → 'v10'` in `server/diff-service.js`. Every output-shape
  change in this feature rides that single bump. Do **not** bump again for the F10 or F13 changes.

## Known Implementation Hazards (carry into tasks)

1. **Tail check must be opt-in.** `server/scripts/backfill-meaningful-classification.js:100` calls
   `getUpdateRowsUpTo(docGuid, MAX_CLOCK)` with `MAX_CLOCK = 2147483647`. An unconditional tail
   expectation would burn the full retry budget (2 × up to 300 ms) on **every** document.
2. **Never pass `{ tools }` to `convertToModelMessages`** (`server/api/chat.js:976`). The image
   tools (`view_image`, `view_svg_blocks`) define `toModelOutput` precisely to keep image bytes
   out of stored history; handing tools to the history conversion would re-inline them every turn.
3. **Per-row rejoin must be byte-identical.** `computeLineWordSegments`'s re-split leans on the
   segmenter's faithfulness invariant (`segments.map(s => s.text).join('') === input`). Test the
   rejoin as bytes, not as visual plausibility.
4. **`plainTextOf` and `stampSide.isTextBlock` are two implementations of one traversal.** They
   must stay in agreement. Any change near them needs a test covering a block with **no direct
   text child** (e.g. an empty paragraph, a list wrapper).
5. **One cache bump only.** `CACHE_VERSION` is `'v9'` at `server/diff-service.js:26`.
6. **Hard-break strip is chat-only and frozen.** `stripHardBreakMarkers` in
   `server/mcp/diff-utils.js` is ratified 028 behavior — do not touch it while editing its
   neighbours.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Principle I: `README.md` / `docs/dev.md` not updated in this feature's commits | The parallel-agent protocol forbids editing them (concurrent 038 agent; they are reconciled in the serial merge queue) | Editing them here would guarantee a merge conflict with 038 and defeat the queue's reconciliation step. Mitigation: a task verifies whether either doc actually describes any changed behavior (assessment: neither does) and the finding is reported to the merge-queue owner. |
| Two distinct mechanisms for the same logical strip (`toModelOutput` + a history pass) | FR-014 / hazard: unifying them by passing `{ tools }` into `convertToModelMessages` would re-inline image bytes the image tools deliberately keep out of stored history | A single unified mechanism is exactly the bug the spec forbids. The duplication is two ~10-line call sites around **one** shared `stripUiOnlyDiffFields` implementation, so the *logic* is not duplicated. |
| `computeWordSegments` keeps a `null` return **and** gains a report sink (rather than a discriminated result object) | FR-006 specifies an out-of-band signal; the `null` contract has existing call sites and tests, and a truthy `{ degraded: … }` return would silently pass `if (!segs)` guards at any missed call site | A discriminated return is arguably cleaner but converts a missed call site into a *silent wrong-output* bug instead of an obvious one. Rejected on blast-radius grounds. |

## Post-Design Constitution Re-Check

Re-evaluated after Phase 1 artifacts. **No new violations.** Specifically:

- No migration was introduced (Technology Constraints: node-pg-migrate) — 038 keeps the slot.
- No third-party markdown/serialization dependency added (`diff` and `yjs` are incumbent).
- Shared client/server logic (`computeLineWordSegments`) was placed in `shared/`, as required.
- No AI-provider behavior moved out of `server/api/ai-providers.js` (the chat changes are
  message-shaping in `chat-models.js` / `chat-tools.js`, not provider dispatch).
- Test output stays LLM-friendly (no reporter changes).
