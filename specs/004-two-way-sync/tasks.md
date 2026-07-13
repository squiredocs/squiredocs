# Tasks: Two-Way Sync (Offline-Collaborator Push)

**Input**: Design documents from `/specs/004-two-way-sync/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/sync-push.md, quickstart.md

**Tests**: REQUIRED by the spec itself — FR-016 (standing round-trip CI invariant) and FR-017
(API-level protocol coverage incl. the convergence property) are functional requirements, and the
convergence property test + round-trip invariant are first-class tasks per the plan. Backend tests
run serially against the shared test DB (Constitution II) — never launch concurrent runs.

**Organization**: Grouped by user story; ordered for a **single implementer in one worktree**
(sequential execution is the expected mode; [P] marks what could parallelize).

**⚠ MIGRATION FLAG (prominent, per planning guidance)**: This feature carries exactly **one**
additive migration — `yjs_updates.on_behalf_of JSONB NULL` (ledger D8, plan Complexity Tracking,
task T020). Everything else rides existing storage. If review rejects the migration, use D8's
documented fallback (fold a text label into `agent_name`) and adjust T020–T024 accordingly.

## Format: `[ID] [P?] [Story] Description`

## Path Conventions

Single-project web service at repo root: `server/`, `migrations/`, `server/__tests__/`,
`__tests__/integration/` (paths from plan.md Project Structure).

---

## Phase 1: Setup (dependency verification)

**Purpose**: This feature builds on features 001–003, which land before it. Verify their consumed
contracts exist before writing sync code; fail loudly (not adaptively) if they don't.

- [X] T001 Verify consumed contracts from features 001–003 are present and record their actual API surfaces in a short comment block at the top of the (new) `server/markdown-sync.js` stub: 001 generalized parser (`markdownToPm` tolerant mode — location may be `server/markdown-to-pm.js` or `shared/markdown-to-pm.js` after 001's move), 002 import route + module (`server/api/docs-import.js`, `server/markdown-import.js`, `mode=append|replace`, `documents:write` enforcement, PM-JSON→Yjs materializer), 003 exporter options (`flavor=portable`, `frontmatter=true`, `lossy` list, `squire:` frontmatter parse/strip helper, image map). If any are missing or shaped differently than plan.md assumes, STOP and flag in the implementation report before proceeding — do not re-implement their scope here.

---

## Phase 2: Foundational (blocking prerequisites for all stories)

**Purpose**: The serializer source map, the md-offset resolver, canonicalization, and the
fork/synthetic-clientID mechanics — every user story replays through these.

**⚠ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Write failing unit tests for the serializer source map in `server/__tests__/serialization.sourcemap.test.js`: (a) for each registry construct (drive from `INLINE_MARKS` in `server/format-registry.js` so new marks inherit coverage), every emitted plain-text character is covered by exactly one run mapping back to the correct `Y.XmlText` + offset; (b) syntax characters (heading `#`, `**`/`_`/`~~` delimiters, HTML-tag marks, list markers and indentation, fence lines, table pipes and separator rows, blockquote `> ` prefixes, `![alt](src)`, link `[`/`](url)`) are covered by no run; (c) escaped table-cell `\|` splits runs (escape char = structure, `|` = text); (d) `blocks` extents tile the document and include their syntax; (e) assembled output is byte-identical to `toMarkdownNodes(nodes)` for the whole corpus (research.md R1 assertion).
- [X] T003 Implement `toMarkdownWithSourceMap(nodes)` in `server/mcp/yjs/serialization.js` per research.md R1: tagged-segment two-pass emit (runs recorded per delta op in `renderInline`, threaded through `getChildText` for headings/list items/table cells; blockquote splice preserves segment runs; block extents recorded per top-level node; final assembly resolves absolute offsets with the normalize-is-a-no-op-by-construction strategy). `toMarkdown`/`toMarkdownNodes` must remain byte-identical and allocation-free on the non-map path. Make T002 pass.
- [X] T004 Implement the offset resolver in `server/markdown-sync.js`: `resolveMd(sourceMap, offset)` and `classifyRange(sourceMap, start, end)` per research.md R2 (binary search over runs; text-range iff all chars fall in runs of one block; insertion-point boundary rule prefers the left run; syntax resolution via `blocks`). Unit tests in `server/__tests__/markdown-sync.replay.test.js` (same file as T007's replay tests; start it here with the resolver describe-block).
- [X] T005 Implement baseline + fork + canonicalization helpers in `server/markdown-sync.js` per research.md R3/R4: `buildBaseline(persistence, docGuid, clock, {flavor, lossyMarks})` → `{ fork, baselineSV, canonicalMd, sourceMap }` using `persistence.getYDocAtClock` and T003's serializer (baseline serialized in the pushed file's flavor with lossy exclusions so degradation cancels out — FR-010); `canonicalizePushed(markdown, {flavor, lossyMarks})` → canonical md via 001 parser + canonical serializer; `syntheticClientId(docGuid, clock, contentSha256)` → deterministic 31-bit id (research.md R4), pinned on the fork **before any op is created**. Unit-test clientID determinism and pinning in `server/__tests__/markdown-sync.replay.test.js`.

**Checkpoint**: Source map + fork mechanics proven at unit level — user stories can begin.

---

## Phase 3: User Story 1 — Push repo edits into a live document (Priority: P1) 🎯 MVP

**Goal**: A frontmattered repo file with edits pushes back via `mode=sync`; edits replay as native
CRDT ops anchored at the baseline; live doc updates in real time; receipt returns new clock +
canonical re-export; version history attributes the pusher.

**Independent Test**: quickstart.md Scenario 1 — export, edit a sentence, push, verify live
document, receipt (clock > N, re-export), and version-history entry.

- [X] T006 [US1] Write failing hunk-classification and replay unit tests in `server/__tests__/markdown-sync.replay.test.js`: text hunk within one paragraph (character ops; all other blocks' Yjs item identity unchanged — assert same `Y.XmlText` instances / no delete-recreate); text hunk inside a heading, a list item, and a table cell; mark-aware refinement (edit spanning `**bold**` delimiters where block type is unchanged replays as text+format ops, not block replace — FR-007 prefer-text); structural hunks: new heading+paragraph inserted between blocks (surrounding blocks' identity untouched), block deletion, paragraph→list conversion, whole-document emptying; hunk coalescing (<3 common chars within a block merges); determinism (same inputs → byte-identical `pushUpdate` twice, FR-011).
- [X] T007 [US1] Implement diff → anchored hunks → classification in `server/markdown-sync.js` per research.md R3: `diffChars(baselineMd, pushedMd)` (npm `diff`), anchor-walk into `{oldStart, oldEnd, newText}` hunks (adjacency-0 clustering), within-block coalescing constant, classification ordering (whole-block detection → text test → mark-syntax refinement via block-level delta diff → structural), producing the DiffHunk objects of data-model.md.
- [X] T008 [US1] Implement replay in `server/markdown-sync.js`: text hunks as `textNode.delete/insert/format` at source-map offsets; structural hunks as fork-fragment `delete(idx,n)` + `insert(idx, nodes)` over expanded block ranges, nodes built from `markdownToPm` output via 002's PM-JSON→Yjs materializer (do not duplicate it; import from `server/markdown-import.js`). All hunks in one `fork.transact()`, ascending old-offset order (determinism). Produce `pushUpdate = Y.encodeStateAsUpdate(fork, baselineSV)` and the `operations` counts. Make T006 pass.
- [X] T009 [US1] Implement `applySyncPush` orchestration in `server/markdown-sync.js`: store-then-apply per research.md R8 — `persistence.storeUpdate(docGuid, pushUpdate, userId, agentName)` first (yields the receipt clock; whole-or-nothing per FR-008's persistence edge case), then `Y.applyUpdate(getSharedDoc(docGuid), pushUpdate, createOrigin(userId, 'Repo Sync'))` for broadcast (listener's re-store dedupes via ON CONFLICT DO NOTHING, same as `restoreVersion` at `server/version-history.js:670-693`); then re-export post-push shared-doc state in the pushed flavor with refreshed frontmatter (003 serializer) for the receipt — the embedded frontmatter clock MUST equal the clock of the exact state serialized (contract "Consistency rule"; read state + current clock atomically), which may exceed the receipt's top-level `clock` under concurrent edits.
- [X] T010 [US1] Wire `mode=sync` into the PUT route in `server/api/docs-import.js`: accept `mode=sync` beside `append|replace`; parse frontmatter via 003's helper; resolve baseline clock (frontmatter, `baselineClock` param overrides — D3); enforce FR-002 docGuid match and FR-003 auth/ACL re-check (reuse 002's middleware — no privileged path); dispatch to `applySyncPush`; shape the success receipt exactly per `contracts/sync-push.md` (docId, mode, noop, clock, markdown, overlaps, operations).
- [X] T011 [US1] Write API-level integration tests in `__tests__/integration/sync-push.route.test.js` for US1 acceptance scenarios 1–4: single-sentence edit (byte-identical elsewhere, clock > N, canonical re-export in receipt); heading+paragraph insertion between blocks (identity/attribution of untouched blocks unaffected — verify via version timeline and item identity); block deletion recoverable via version history restore; live-editor visibility (second Yjs client connected to the shared doc sees pushed edits via the normal update path). Include auth cases: viewer-role token 403s, `documents:read`-only token 403s.

**Checkpoint**: US1 fully functional — the MVP round trip works end to end.

---

## Phase 4: User Story 2 — Concurrent edits converge without conflicts (Priority: P1)

**Goal**: Pushes merge with concurrent live edits per CRDT semantics — no conflict error, no
retry, no lock; both-sides-changed blocks come back as advisory overlap flags.

**Independent Test**: quickstart.md Scenario 2 — disjoint-block edits (no overlap flagged),
same-block edits (both survive, flagged).

- [X] T012 [US2] Write failing overlap-detection tests in `server/__tests__/markdown-sync.overlap.test.js` per US2 scenarios and SC-006: doc-edits-block-A + push-edits-block-B → no overlaps; both-edit-different-spans-of-block-A → both edits present, A flagged; same-span rewrite → interleaved characters, flagged; structural push replace vs. concurrent intra-block live edit → replacement wins, doc-side edit dropped, flagged (`pushSide: "structural"`); block delete vs. edit-inside → deletion wins, flagged (`pushSide: "deleted"`); doc-side-deleted block that push edits → flagged (`docSide: "deleted"`); clock-equal push (nobody edited) → fast-path, zero overlaps; flags never alter application (assert final doc state identical with flag computation forcibly disabled).
- [X] T013 [US2] Implement overlap detection in `server/markdown-sync.js` per research.md R5: state-vector fast path via `persistence.getStateVectorsAtClocks(docGuid, [baselineClock])` vs. current SV (equal → skip); block-level canonical-md LCS between baseline fork (pre-replay) and current live snapshot to find doc-side changed/deleted blocks; intersect with push-touched block set recorded during replay (T008); emit OverlapFlag payloads per data-model.md (blockIndex, blockType, ≤80-char excerpt, docSide, pushSide). Computed after application, strictly advisory (FR-012). Make T012 pass.
- [X] T014 [US2] Write order-independence tests in `server/__tests__/markdown-sync.order-independence.test.js` per US2 scenario 5 / SC-004: generate concurrent live updates; apply `pushUpdate` before / after / interleaved with them onto replicas of the live doc; assert identical final canonical markdown + `extractXml` across all orders; cover the duplicate/retried push (D5/FR-011 edge case): push the identical file twice through the route against the same baseline and assert no duplicated content, no doubled blocks, and no second content-changing version entry (CRDT dedup of the deterministic update); assert no code path in `server/markdown-sync.js` or the route performs compare-and-set, conflict-based rejection, or retry (grep-level assertion on receipt/API surface: no 409-on-conflict, no retry loop — the only 409 is the pre-processing `sync_doc_mismatch` identity check).
- [X] T015 [US2] Write the convergence property test (FIRST-CLASS, SC-002/FR-017) in `server/__tests__/markdown-sync.convergence.test.js` per research.md R9: a generated corpus of (document × edit-script × concurrent-edit-script) cases where each edit script is expressed as Yjs operations so it can be applied two ways — (a) directly on a real offline client forked at the baseline (`encodeStateAsUpdate(clientDoc, baselineSV)`), and (b) serialized to markdown and pushed through `markdown-sync`; assert both worlds produce identical final document state (canonical markdown + `extractXml`), including cases with concurrent live edits and the clock-equal degenerate case. Seed-fixed randomized generation (deterministic CI), ≥ the acceptance-scenario shapes of US1/US2 plus task lists, marks, tables, nested lists from the registry.
- [X] T016 [US2] Extend `__tests__/integration/sync-push.route.test.js` with the API-level concurrent flow: baseline pull → live edit via a second Yjs websocket client → push → receipt lists expected overlaps; both edit streams visible in a follow-up export.

**Checkpoint**: The offline-collaborator claim is proven by property test; overlaps advisory-only.

---

## Phase 5: User Story 3 — Formatting-only and unchanged pushes are true no-ops (Priority: P2)

**Goal**: Byte-identical, reformatted, or lossy-degradation-only pushes generate zero ops, store
nothing, create no version entry, and still return current clock + re-export (D7).

**Independent Test**: quickstart.md Scenario 3 — reformat delimiters, push, verify clock unchanged
and no version entry.

- [ ] T017 [US3] Write failing no-op tests in `server/__tests__/markdown-sync.replay.test.js` (no-op describe block) and `__tests__/integration/sync-push.route.test.js`: byte-identical re-push; `**bold**`→`__bold__` delimiter style and whitespace reflow that canonicalizes away; portable-flavor file with `lossy: [underline]` and no content edits pushed at a doc whose live state has underline marks → no-op AND doc-side underline marks intact (US3 scenario 3 + FR-010); each case asserts zero ops, no stored update (update count unchanged), no version entry, `noop:true` receipt with current clock + current-state re-export.
- [ ] T018 [US3] Implement no-op short-circuit in `server/markdown-sync.js` per research.md R7: canonical string-equality pre-check after `canonicalizePushed` vs. baseline canonical md → skip fork/replay/store, return no-op receipt (re-export of **current** doc state, D7). Verify the lossy-exclusion path from T005 makes degradation-only pushes hit this branch. Make T017 pass.
- [ ] T019 [US3] Extend the registry-driven round-trip suite (FIRST-CLASS, FR-016/SC-001/SC-009) in `server/__tests__/format-roundtrip.test.js`: for every registry-driven corpus document, (a) `push(export(doc))` through `markdown-sync` is a no-op — empty canonical diff, zero ops, no version entry; (b) `export → import → export` is byte-stable in squire flavor; (c) a repeated pull→push cycle (≥3 iterations, rewriting the file from each receipt) stays a no-op every time (SC-009, phantom-edit guard). Registry-driven so new marks/nodes inherit sync coverage by construction (Constitution II).

**Checkpoint**: Round-trip honesty enforced as a standing CI property.

---

## Phase 6: User Story 4 — Pushes are attributed, with on-behalf-of provenance (Priority: P2)

**Goal**: Version entries authored by the token identity (agent-style, "Repo Sync"); optional
on-behalf-of metadata recorded and surfaced as plain text.

**Independent Test**: quickstart.md Scenario 4 — push with on-behalf-of headers; inspect version
history for token attribution + visible metadata.

- [ ] T020 [P] [US4] **⚠ THE ONE MIGRATION (D8)** — create `migrations/<timestamp>_add-on-behalf-of-to-updates.js` via node-pg-migrate: add nullable `on_behalf_of JSONB` to `yjs_updates`, no default, no backfill, no index; down-migration drops it. Keep it this small.
- [ ] T021 [US4] Extend the write path: optional `onBehalfOf` argument on `storeUpdate` in `server/postgres-persistence.js` (persisted to the new column; `null` for every non-sync caller — no other call sites change); `applySyncPush` in `server/markdown-sync.js` passes it through; length-cap (256/field) and field whitelist (`name,email,commit,url`) enforced in `server/markdown-sync.js` before storage (D6).
- [ ] T022 [US4] Extend the read path: include `on_behalf_of` in `_queryUpdatesWithUsers`/`_mapUpdateRow` in `server/postgres-persistence.js`; surface it through version grouping in `server/version-history.js` (attach to the version/subversion entries containing the push's clock, alongside `createAuthor`'s output) so the timeline API exposes it; render strictly as text (no markup/link interpretation — D6). US4 scenario 2 requires the metadata to be **visible** in version history, so if the client version-history panel does not already render generic text metadata, add the minimal display (plain-text line beneath the author) in the version panel component — visibility is part of this story's acceptance, not optional polish.
- [ ] T023 [US4] Parse `X-Squire-On-Behalf-Of-{Name,Email,Commit,Url}` headers (and equivalent query params) in `server/api/docs-import.js` for `mode=sync` only, per contracts/sync-push.md.
- [ ] T024 [US4] Write attribution tests in `__tests__/integration/sync-push.route.test.js` per US4 scenarios and SC-005: content-changing push → version entry authored by token identity with agent-style attribution ("Repo Sync (<user>)" via existing `createAuthor` mechanics, indistinguishable in mechanism from other agent edits); with on-behalf-of headers → metadata visible on the entry as plain text (assert a hostile value like `<img src=x onerror=…>` round-trips as inert text and over-length values are capped); without headers → token identity alone.

**Checkpoint**: Provenance invariant (Constitution IV) satisfied for CI-originated pushes.

---

## Phase 7: User Story 5 — Stale or invalid baselines are rejected with re-pull guidance (Priority: P3)

**Goal**: Malformed/out-of-range/unreconstructible baselines and docGuid mismatches are rejected
machine-readably, leaving zero trace; no whole-document-replacement fallback exists.

**Independent Test**: quickstart.md Scenario 5 — push with clock > current, with no baseline, with
mismatched docGuid; verify errors, guidance, and zero mutation.

- [ ] T025 [US5] Write failing rejection tests in `server/__tests__/markdown-sync.rejection.test.js` and `__tests__/integration/sync-push.route.test.js` per US5 scenarios and SC-008: baseline > current clock → 400 `sync_baseline_invalid` with `currentClock` + re-pull guidance; negative/non-numeric → 400 `sync_baseline_invalid`; missing frontmatter clock AND missing param → 400 `sync_baseline_missing`; frontmatter docGuid ≠ target → 409 `sync_doc_mismatch` rejected before any processing; forced-unavailable baseline (test hook) → 410 `sync_baseline_unavailable`; every rejection asserts zero document mutation, unchanged clock, no version entry, and that no code path performs whole-document replacement as a fallback.
- [ ] T026 [US5] Implement the rejection taxonomy in `server/markdown-sync.js` + `server/api/docs-import.js` per research.md R6 and contracts/sync-push.md: validation ordering (auth/ACL → docGuid match → baseline presence → baseline validity vs. `_getCurrentUpdateClock` → reconstructibility hook `canReconstruct(docGuid, clock)` returning true today (D1 forward guard, injectable for tests)); all before fork construction. Make T025 pass.

**Checkpoint**: All five user stories independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T027 Performance guard per research.md R11 (SC-007): pass `maxEditLength` to `diffChars`; on `undefined` (cap exceeded) fall back to `diffLines`-then-`diffChars`-within-changed-clusters coarse hunking in `server/markdown-sync.js`; add a ~1 MB-markdown timing test (< 10 s) to `server/__tests__/markdown-sync.replay.test.js` (skip-in-CI-if-slow-runner pattern only if the suite's runtime budget demands it — prefer keeping it on).
- [ ] T028 [P] Hostile-input pass (Constitution V, spec edge cases) in `__tests__/integration/sync-push.route.test.js`: unparseable/hostile markdown degrades per never-lose-content and proceeds as a structural edit; whitelisted-only HTML inertness in pushed content; pushed file that empties the document replays as delete-all (recoverable via restore); non-Squire frontmatter preserved as content; `./assets/` image refs resolve via frontmatter map with unchanged refs producing zero ops.
- [ ] T029 Run the full serial backend verification (quickstart.md "Automated validation" list plus the existing suites touched: serialization, version-history, diff-service, import) and fix fallout; confirm `toMarkdown` output is byte-identical pre/post source-map change across the round-trip corpus.
- [ ] T030 [P] Documentation (Constitution I): update `ReadMe.md` (two-way sync capability, `mode=sync`, receipt, overlap flags, on-behalf-of) and the export/import API docs surface (`server/mcp/tools/tool-documentation/export_api.js` if 002/003 put route docs there — verify actual location) in the same commit as the implementation. If implementation falsified any design-doc mechanism, amend the source Squire doc per Constitution VI (flag to maintainer — exports are not hand-edited).
- [ ] T031 Execute quickstart.md scenarios 1–5 manually against the dev pod as the final end-to-end validation; record results in the implementation report.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)** → everything (T001 gates all).
- **Phase 2 (Foundational)**: T002 → T003 → (T004, T005). Blocks all user stories.
- **Phase 3 (US1)**: T006 → T007 → T008 → T009 → T010 → T011. Needs Phase 2.
- **Phase 4 (US2)**: T012 → T013; T014, T015 after T008/T009; T016 after T010. Needs US1's engine
  (T007–T009) — US2 tests the same pipeline under concurrency, so it follows US1.
- **Phase 5 (US3)**: T017 → T018 → T019. Needs T005 (canonicalization) + T010 (route); independent
  of US2.
- **Phase 6 (US4)**: T020 [P] anytime after Setup; T021 → T022 → T023 → T024. T021 needs T009.
- **Phase 7 (US5)**: T025 → T026. Needs T010 (route); independent of US2/US3/US4.
- **Phase 8 (Polish)**: after all desired stories.

### Critical path (single implementer)

T001 → T002 → T003 → T004/T005 → T006 → T007 → T008 → T009 → T010 → T011 (MVP) → T012–T016
(convergence proof) → T017–T019 (round-trip invariant) → T020–T024 → T025–T026 → T027–T031.

### Parallel Opportunities

Limited by design (one worktree, one implementer), but: T004 ∥ T005; T020 (migration) ∥ anything
after T001; T028 ∥ T030; US3/US4/US5 phases are mutually independent after US1 and could be
reordered if a review needs one earlier.

---

## Implementation Strategy

**MVP first**: Phases 1–3 deliver User Story 1 — the full push round trip on a quiet document.
Stop and validate with quickstart Scenario 1 before proceeding.

**Incremental delivery**: US2 (convergence + overlaps) is what makes the feature safe to use on a
*live* document — treat US1+US2 as the real shippable increment. US3 (no-op honesty) is what makes
it safe to run in a *loop* (CI). US4 and US5 complete provenance and the protocol's error
contract. Each checkpoint leaves the suite green and the feature independently testable.

**Notes**
- Never run backend suites concurrently (shared test DB, Constitution II).
- No conflict-resolution UI, no retry paths, no compare-and-set anywhere — if you find yourself
  adding one, re-read FR-008.
- The live document is never consulted or mutated during diff/replay (FR-004) — only in the final
  store-then-apply step (T009) and advisory overlap read (T013).
