---

description: "Task list for 045-resupply-attribution"
---

# Tasks: Resupply Attribution — Truthful Author Display for Sync-Resupplied Content

**Input**: Design documents from `/specs/045-resupply-attribution/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R16), data-model.md, contracts/ (4), quickstart.md

**Tests**: REQUIRED. Constitution Principle II — every behavioral change ships tests, and the
spec's Assumptions bind each FR to the affected suites. Backend suites run **serially** against
one shared DB.

**Baseline**: `main` @ 62bccbc7 (041 + 042 merged). Implements after 044 merges; **merges before
043**. No branches, no commits outside the implement flow's own convention.

**NO MIGRATION** (RBD-045-8). If any task appears to need a schema change, stop and re-read
`plan.md` LOUD FLAG 1 — it does not.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 from spec.md

---

## Phase 1: Setup

**Purpose**: confirm the substrate the plan assumes is actually present.

- [x] T001 Verify baseline symbols exist before touching anything: `isMeaningful`, `computeRangeMeta`, `computeFragmentMeta`, `UNKNOWN_AUTHOR`/`UNKNOWN_AUTHOR_KEY`, `getCurrentSessionAuthors`, `getContentAtClock` in `server/version-history.js`; `_mapUpdateRow`'s `viaSync` and `getUpdatesInRange({includeData})` in `server/postgres-persistence.js`; the `agent_name IS NOT NULL` fresh-row query in `server/collab-guardrail.js`. Record any drift from `plan.md` in `specs/045-resupply-attribution/clarifications-needed.md` before proceeding (merged code wins over the spec, per the spec's Sequencing section).
- [x] T002 Confirm the backend test DB is reachable and the affected suites are green BEFORE any edit (`npx jest server/__tests__/version-history.test.js server/__tests__/collab-guardrail.test.js --runInBand`), so later failures are attributable to this work.

---

## Phase 2: Foundational (blocking prerequisites for US1–US4)

**Purpose**: the resolver and its readers. Nothing user-visible changes in this phase.

- [x] T003 Add `getUpdatePayloads(docGuid, clocks)` to `server/postgres-persistence.js` per `contracts/persistence-readers.md` (PK-scoped `clock = ANY($2)`, returns `{clock, updateData}`, empty input ⇒ no query, deliberately NOT routed through `_queryUpdatesWithUsers`/gap-retry — document why in the JSDoc).
- [x] T004 Add `getDirectAttributedRows(docGuid, {afterClock, beforeClock, limit})` to `server/postgres-persistence.js` per `contracts/persistence-readers.md`, with `via_sync IS NOT TRUE AND user_id IS NOT NULL`, ascending order, and a JSDoc restating the 038 read rule (only `true` means sync; `NULL`/`false` are identical and never suspicious).
- [x] T005 Add `getUserDisplayFields(ids)` to `server/postgres-persistence.js` returning `Map<userId, {userName, userEmail, userPicture}>`; a missing id is the deleted-account signal (RBD-045-11).
- [x] T006 Create `server/resupply-resolution.js` with origin extraction: `originClientIds(updateData)` = `[...Y.parseUpdateMeta(bytes).to.keys()]`, empty ⇒ deletion-only ⇒ unresolvable. Include the header comment recording the verified `parseUpdateMeta` behavior (struct clients only, delete-set clients structurally excluded — research R3) and why `decodeUpdate().structs` was not used.
- [x] T007 Implement the evidence fold in `server/resupply-resolution.js` per `data-model.md` §3: ascending batched scan, `Map<clientID, {userId, agentName} | AMBIGUOUS>`, sticky ambiguity on a differing `(userId, agentName)` pair, `scannedThroughClock` high-water mark, `RESUPPLY_EVIDENCE_MAX_ROWS` honest-refusal cap (research R5).
- [x] T008 Implement `resolveForRows(reader, docGuid, rows)` and `EMPTY_RESOLUTION` in `server/resupply-resolution.js` per `contracts/resupply-resolution.md`: zero queries and zero decodes when no row has `viaSync === true`; single ascending pass snapshotting each target at its own clock (evidence strictly prior — R2); permanent `(docGuid, clock)` memo with the documented eviction caps; per-request `directory` built from the caller's rows plus one batched `getUserDisplayFields` lookup (R6); all internal failures caught and degraded to `unresolved: true`.
- [x] T009 Add the `_stats()` / `_resetForTest()` seams to `server/resupply-resolution.js` (`evidenceRowsDecoded`, `targetRowsDecoded`, `evidenceQueries`) for FR-009/SC-005.
- [x] T010 Create `server/__tests__/resupply-resolution.test.js` covering the resolution matrix with fabricated rows per `quickstart.md`: resolvable single origin; agent origin; ambiguous identity (same client id, two users); no evidence; deletion-only payload; multi-origin partial; self-relay; `via_sync` row offered as evidence for another `via_sync` row (never resolves); evidence never crossing documents; `via_sync` NULL/false rows untouched (FR-002, FR-005, FR-006, FR-008).

**Checkpoint**: the resolver is independently verifiable; no display surface has changed yet.

---

## Phase 3: User Story 1 — Resupplied content credits its true author (P1)

**Goal**: the timeline and drill-down credit the recovered author of a mis-stamped `via_sync`
row and never the relayer.

**Independent test**: stage a `via_sync` row stamped to B carrying A's content (A has prior
attributed rows); the timeline and drill-down both show A and never B.

**Note**: US1 and US2 form one P1 increment — the unresolvable rendering (Phase 4) must land
with this phase, because the rule "never display the relayer" has no safe fallback without it.

- [x] T011 [US1] Add `SYNCED_CONTRIBUTION` and `SYNCED_CONTRIBUTION_KEY` to `server/version-history.js` beside `UNKNOWN_AUTHOR` per `data-model.md` §6 (frozen object, neutral color, additive `isSynced: true`), with a comment stating what it asserts and how it differs from `UNKNOWN_AUTHOR` (RBD-045-2).
- [x] T012 [US1] Add the private `collectAuthorsForUpdate(update, authors, ctx)` helper to `server/version-history.js` per `contracts/author-surfaces.md`, and REPLACE the duplicated author-accumulation blocks in `groupUpdatesIntoVersions` and `computeRangeMeta` with calls to it. With no context the behavior must be byte-identical to today (041's UNKNOWN_AUTHOR collapse, `getAuthorKey` keying, `createAuthor` shape, `onBehalfOf` still row-sourced).
- [x] T013 [US1] Add `authorFromOrigin(origin, directory)` to `server/version-history.js`: builds the `createAuthor` shape from a resolved `(userId, agentName)` plus directory display fields; a resolved id absent from the directory ⇒ `UNKNOWN_AUTHOR` (RBD-045-11).
- [x] T014 [US1] Thread the additive `{ resolution }` options argument through `groupUpdatesIntoVersions`, `computeRangeMeta`, `computeFragmentMeta` and `mergeNamedVersions` in `server/version-history.js` (omitting it always yields today's behavior — every existing direct-call test must stay valid).
- [x] T015 [US1] Wire `getVersionTimeline` in `server/version-history.js` to `resolveForRows` ONCE over the full row set and pass the context into grouping and merging; keep the read O(rows) (no payload fetch on the timeline query itself — the resolver issues its own targeted queries).
- [x] T016 [US1] Fix the row projection in `getUpdatesForVersion` (`server/version-history.js`) to carry `viaSync` and `clock` through to `groupUpdatesIntoVersions`, and resolve over the range rows. The projection currently drops `viaSync`, which would silently disable resolution on the drill-down.
- [x] T017 [US1] Extend `server/__tests__/version-history.test.js`: timeline and drill-down credit the resolved author (human and agent origins) and never the relayer; a resolved origin renders identically to a direct author; self-relay with prior evidence shows no hedging (FR-001, FR-003, SC-001, SC-002).
- [x] T018 [US1] Extend `server/__tests__/version-history.test.js` for range-scoped surfaces: a NAMED version and both SPLIT FRAGMENT shapes over a `via_sync` row credit the resolved author (041's `computeRangeMeta`/`computeFragmentMeta` paths, FR-001).
- [x] T019 [US1] Create `server/__tests__/resupply-attribution.test.js` (the cross-surface home — there is no `version-history-api.test.js` in this repo; `server/__tests__/version-history.test.js` is the single existing home for these functions): stage a mis-stamped `via_sync` row against a real DB via `server/__tests__/helpers/db`, assert the timeline output credits the resolved author, and assert rows with `via_sync` NULL/false produce byte-identical output to pre-045 (FR-008 regression guard). Follow the `doc_guid`-cleanup convention used by `collab-guardrail.test.js`.

**Checkpoint**: US1 is demonstrable end to end on the two highest-traffic surfaces.

---

## Phase 4: User Story 2 — Unmappable synced content is honestly labeled (P1)

**Goal**: unresolvable relayed content renders as a distinct "Synced content" contributor,
never the relayer, never a guess.

**Independent test**: stage a `via_sync` row with no prior evidence; the timeline and drill-down
show the synced contribution, the relayer is absent, and no real user is fabricated.

- [x] T020 [US2] Confirm/complete the unresolved branch of `collectAuthorsForUpdate` in `server/version-history.js`: exactly ONE `SYNCED_CONTRIBUTION` entry per version regardless of how many rows or origins were unresolvable, coexisting with real authors and with `UNKNOWN_AUTHOR` (FR-004, FR-005).
- [x] T021 [US2] Export `SYNCED_CONTRIBUTION`/`SYNCED_CONTRIBUTION_KEY` from `server/version-history.js`'s module exports with the same comment convention 040 used for `UNKNOWN_AUTHOR`.
- [x] T022 [P] [US2] Render the synced contribution distinctly in `client/src/components/HierarchicalVersionList.jsx` (`AuthorList`): when `author.isSynced`, use the outlined-dot variant and set an explanatory `title`; do not string-match the display name.
- [x] T023 [P] [US2] Add the outlined-dot style (light and dark) to `client/src/components/HierarchicalVersionList.css`.
- [x] T024 [US2] Extend `server/__tests__/version-history.test.js`: no-evidence, ambiguous-evidence, and deletion-only rows all render the synced contribution; a version made entirely of unresolvable rows renders it as its contributor rather than an empty list; the synced contribution and `UNKNOWN_AUTHOR` coexist distinguishably in one version; the relayer never appears (FR-004, FR-005, FR-006, SC-003).
- [x] T025 [P] [US2] Extend `client/src/components/__tests__/HierarchicalVersionList.test.jsx`: an `isSynced` author renders with the distinct dot and tooltip and is visually distinguishable from an `Unknown author` entry in the same version.

**Checkpoint**: the P1 pair is complete — no surface can display a relayer, and the fallback is honest.

---

## Phase 5: User Story 3 — Every author-displaying surface tells the same truth (P2)

**Goal**: the per-clock author and the agent-facing recent-authors feed obey the same
resolution as the timeline.

**Independent test**: for one staged row, the timeline, drill-down, per-clock view and MCP read
report the identical resolution outcome.

- [x] T026 [US3] Wire `getContentAtClock` in `server/version-history.js` to resolve its single row and apply the single-slot rule (RBD-045-9): one resolved origin and nothing unresolved ⇒ that author; multi-origin or any unresolved ⇒ `SYNCED_CONTRIBUTION`; non-`via_sync` rows unchanged.
- [x] T027 [US3] Add the optional `{ resolution }` argument to `getCurrentSessionAuthors` in `server/version-history.js`, keeping the function synchronous (the caller resolves).
- [x] T028 [US3] Wire `server/mcp/tools/read-document.js`: resolve once over `recentUpdates`, pass the context into `getCurrentSessionAuthors`, and apply the single-slot rule to `lastModifiedBy` (RBD-045-12). The response shape is unchanged apart from the additive `isSynced` marker.
- [x] T029 [US3] Extend `server/__tests__/resupply-attribution.test.js` with the cross-surface agreement case: ONE staged `via_sync` row asserted through timeline, drill-down, per-clock and recent-authors — identical outcome, zero disagreements (FR-007, SC-004).
- [x] T030 [US3] Extend `server/__tests__/resupply-attribution.test.js` for the MCP consumer path: `getCurrentSessionAuthors` with a resolution context, and the `lastModifiedBy` single-slot rule as `server/mcp/tools/read-document.js` applies it (FR-001, RBD-045-12). There is no dedicated `read-document` suite today; test the consumer wiring here rather than creating a thin new file.
- [x] T031 [US3] Extend `server/__tests__/resupply-attribution.test.js` for `getContentAtClock` (the surface behind `/api/docs/:docId/history/clock/:clock`): resolved author, and the synced contribution for an unresolvable row (US3 scenarios 1–2).

---

## Phase 6: User Story 4 — The guardrail sees deletions of resupplied agent content (P2)

**Goal**: the collaboration guardrail stops going blind when agent content arrives through a
human connection; posture unchanged.

**Independent test**: stage fresh `via_sync` agent content with no agent name, have a human
delete it inside the freshness window — the alert fires, annotated, and nothing is blocked.

- [x] T032 [US4] Widen the fresh-row query in `server/collab-guardrail.js` to `(agent_name IS NOT NULL OR via_sync IS TRUE)` and select `via_sync`, per `contracts/guardrail-candidates.md`; keep the recency predicate and cheap-first ordering exactly as they are.
- [x] T033 [US4] Add candidate classification in `server/collab-guardrail.js`: `agent_name` rows unchanged; `via_sync` rows resolved through `resolveForRows` — agent origin ⇒ candidate, unresolved ⇒ candidate (RBD-045-4), all-human origins ⇒ not a candidate. Resolution failures degrade to "unresolved", i.e. still a candidate, so degradation never re-opens the blind spot.
- [x] T034 [US4] Add the additive alert fields in `server/collab-guardrail.js`: `syncSourcedCandidates: true` when a matched row was a sync candidate, the `unknown (sync-relayed)` agent-name placeholder, and `relayedByUserId` instead of presenting a relayer's id as `agentUserId`. The existing trigger-level `syncSourced` annotation and every field an existing alert carries stay byte-identical.
- [x] T035 [US4] Wire `collabGuardrail.init(pool, persistence)` in `server/index.js` (and update the module's `init` signature) so the guardrail can reach the resolver's reader interface; keep the raw pool for its own query.
- [x] T036 [US4] Extend `server/__tests__/collab-guardrail.test.js`: resolved-agent `via_sync` candidate alerts; unresolved `via_sync` candidate alerts (conservative); all-human-origin `via_sync` candidate does NOT alert; the existing direct `agent_name` cases are unchanged; nothing is ever blocked; a resolution failure still yields the conservative alert (FR-011, FR-012, SC-006).

---

## Phase 7: User Story 5 — The durability window becomes a documented accepted residual (P3)

**Goal**: the residual is ratifiable and cross-referenced; the loss path is untouched.

**Independent test**: read the ledger entry — all six elements plus the ratification flag — and
diff the loss path to show zero behavioral change.

- [x] T037 [US5] Verify RBD-045-5 in `specs/045-resupply-attribution/clarifications-needed.md` contains all six required elements (scope, deploy mitigation, frequency, consequence change, revisit path, ratification flag) and correct it if the plan-phase work changed any fact (FR-013, SC-007).
- [x] T038 [US5] Update the 038 FR-018 publish-before-commit window comment at the persistence listener in `server/index.js` to cross-reference feature 045 and RBD-045-5: the display-side lie is closed, the durability residual stands, and the ledger entry is where the acceptance is recorded. **Comment only — no code change** (FR-013, FR-014).
- [x] T039 [US5] Review `git diff` for the persistence write/broadcast path (`server/index.js` bindState listener, `server/postgres-persistence.js` `storeUpdate`/`_runStoreSlot`, `server/retry.js`, `server/shutdown.js`) and confirm zero behavioral change, so 043's US3 characterization observes pre-045 behavior (FR-014, SC-007). Record the confirmation in the implementation summary.

---

## Phase 8: Polish & cross-cutting

- [x] T040 Add the FR-010 scope-guard test to `server/__tests__/resupply-resolution.test.js`: `server/undo/**`, `server/diff-service.js` and the restore path do not import `server/resupply-resolution.js`, and undo's `viaSync` run-breaking guard in `server/undo/legacy.js` is unchanged.
- [x] T041 Add the FR-009/SC-005 performance assertions to `server/__tests__/resupply-resolution.test.js`: a document with no `via_sync` rows performs zero queries and zero decodes; a repeated timeline request over already-resolved history performs zero additional decodes (`_stats()`); first-render cost is bounded by the rows displayed.
- [x] T042 [P] Document the config knobs (`RESUPPLY_EVIDENCE_MAX_ROWS`, `RESUPPLY_EVIDENCE_BATCH`, `RESUPPLY_CACHE_MAX_DOCS`, `RESUPPLY_CACHE_MAX_OUTCOMES`) in the module header of `server/resupply-resolution.js` with their defaults and the honest-refusal semantics of the cap.
- [x] T043 [P] State the via_sync display contract where it is READ, in the `_mapUpdateRow` comment block of `server/postgres-persistence.js`: consumers now include display resolution (045), which never rewrites the row and never trusts the stamp for authorship.
- [x] T044 Run the full affected suites serially per `quickstart.md` (backend, integration, client) and confirm green; investigate any pre-existing flake against the T002 baseline rather than adjusting assertions.
- [x] T045 Write the implementation summary into `specs/045-resupply-attribution/` (not a new top-level doc): decisions honored, deviations found, and the two Sam-facing flags (RBD-045-5 ratification, RBD-045-10 softened 038 promise).
- [x] T046 Restate the merge-queue handoff in the summary: README update owed at merge (version-history section ~L446-475 and the `via_sync` paragraph ~L1128 — this agent may not edit README.md), 043's sequencing line must be extended to "after 041, 042, and 045", no migration and no backfill in the deploy story.

---

## Dependencies

```
Phase 1 (T001-T002)
   └─> Phase 2 Foundational (T003-T010)          # blocks every story
          ├─> Phase 3 US1 (T011-T019)  ─┐
          │                              ├─ one P1 increment; ship together
          ├─> Phase 4 US2 (T020-T025)  ─┘        # depends on T011-T014
          ├─> Phase 5 US3 (T026-T031)            # depends on T011-T014
          ├─> Phase 6 US4 (T032-T036)            # depends only on Phase 2
          └─> Phase 7 US5 (T037-T039)            # fully independent (docs only)
                 └─> Phase 8 Polish (T040-T046)
```

- **T012 is the pivot**: T014–T031 all consume the shared helper. Do not parallelize across it.
- **US4** touches only `collab-guardrail.js` / `index.js` and can proceed alongside US1–US3
  once Phase 2 lands.
- **US5** touches only the ledger and one comment; it can be done at any time.

## Parallel opportunities

- Phase 2: T003, T004, T005 are three independent methods in one file — same file, so do them in
  one pass, then T006–T009 sequentially, with T010 written alongside.
- Phase 4: T022, T023, T025 (client) run in parallel with the server-side T020/T021/T024.
- Phase 8: T042 and T043 are independent comment-only tasks.

## Implementation strategy

- **MVP = Phase 2 + Phase 3 + Phase 4** (US1 + US2). That is the ratified core: no surface
  displays a relayer, recovered authors are credited, and the fallback is honest. It is
  shippable on its own.
- **Increment 2 = Phase 5** (US3): the remaining surfaces, including the agent-facing feed.
- **Increment 3 = Phase 6** (US4): the guardrail's blind spot.
- **Increment 4 = Phase 7** (US5): the residual record, doable any time.
- Stop-the-line rule: if any task appears to require a schema migration, a change to the
  write/broadcast ordering, or resolution feeding undo/diff/permissions, STOP — those are
  RBD-045-8, FR-014 and FR-010 respectively, and each is a decision, not an implementation
  detail.

## Task count

46 tasks: Setup 2, Foundational 8, US1 9, US2 6, US3 6, US4 5, US5 3, Polish 7.
