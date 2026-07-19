# Implementation Plan: Version History Hardening

**Branch**: `023-version-history-hardening` | **Date**: 2026-07-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/023-version-history-hardening/spec.md`

## Summary

Converge the version-history persistence/read architecture to the two ratified
2026-07-19 design amendments (`design/collaboration-core.md`, commit db85ee7):

1. **Clock order is causal order** — a per-document in-process FIFO queue in
   `PostgresPersistence.storeUpdate` (transient retry moved inside the queue slot)
   plus a Postgres advisory transaction lock as the cross-instance clock-acquisition
   backstop; the 016 claim transaction composes via the advisory lock alone
   (research R1).
2. **Every log-rebuild reader is gap-tolerant** — all `yjs_updates` readers funnel
   through one gap-tolerant fetcher sharing the 021 retry budget; artifact-producing
   paths (diff cache, undo claim, backfill) never freeze a gapped result (R2, D-2).
3. **Replay is the sole source of truth, O(rows) timeline** — nullable
   `yjs_updates.meaningful` column written at persist time from the bindState
   before/after context (unknown ⇒ meaningful), idempotent backfill script, timeline
   filters stored flags instead of replaying the log; `document_versions.snapshot_data`
   dropped and named versions become pure clock-range labels (R3-R6, D-3, D-6).
4. **Restore is a first-class undoable edit** — the shared `restoreVersion` core
   records an `agent_edits` row per restore (human identity = `''` agent sentinel),
   broadcasts via a shared live-apply module (loaded doc → apply; else Redis fan-out;
   never a silent skip), and both surfaces converge on identical semantics; ratified
   dead code and the `yjs_state_vectors` table are deleted (R7-R8, D-4, D-5).

Three migrations: 1799000000000 (add meaningful), 1799100000000 (drop
snapshot_data), 1799200000000 (drop yjs_state_vectors) — FR-027/D-7 satisfied.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS) — Express, y-websocket, Yjs server side

**Primary Dependencies**: `yjs`, `pg` (Pool), `node-pg-migrate`, `ioredis`
(cache + pub/sub via `server/redis.js` / `server/redis-pubsub.js`), y-prosemirror
(diff service). No new dependencies.

**Storage**: PostgreSQL (`yjs_updates`, `document_versions`, `agent_edits`;
`yjs_state_vectors` dropped). Redis: diff cache + cross-instance update fan-out.

**Testing**: Jest, backend serial-only against the shared test DB (constitution II;
memory: never run concurrent backend suites). Existing suites extended:
`server/__tests__/postgres-persistence.test.js`, `version-history.test.js`,
`diff-service.test.js`, `server/undo/__tests__/*`, MCP tool tests,
`__tests__/integration/`.

**Target Platform**: Linux containers; prod = 2 replicas, non-sticky routing (the
topology the ordering invariant must survive — D-1).

**Project Type**: web service (existing monolith server + React client; this feature
is server-only except one client file deletion).

**Performance Goals**: SC-003 — timeline O(rows), ≥10x on a 10k-update fixture, zero
full-log replays per request; FR-005 — uncontended single-writer persist latency
within noise of pre-023 (queue bookkeeping + advisory lock ≈ two cheap statements on
the same connection).

**Constraints**: rolling deploy with a mixed-version window (no freeze — D-8);
fire-and-forget persistence semantics preserved (CRITICAL page on terminal failure,
D-9); graceful-shutdown flush must keep covering queued writes (FR-006); 021 retry
knobs shared, no new per-path config (FR-008).

**Scale/Scope**: beta scale — thousands of updates per document; one-pass-per-doc
backfill is feasible (D-3). ~12 source files touched, 3 migrations, 1 new script,
2 new small modules, 1 client file deleted.

## Constitution Check

*GATE: evaluated pre-Phase-0 and re-evaluated post-Phase-1 — PASS (no violations,
Complexity Tracking empty).*

- **I. Documentation Reflects Reality** — behavior changes (serialization, replay-only
  named versions, restore-undo, dropped table) touch README's version-history
  description. Per the parallel-agent overrides this planning agent must not edit
  README.md/docs/dev.md; a dedicated task (in the serial/merge-owned phase of
  tasks.md) carries the doc update so the implement/merge stage lands it in the same
  effort. ✅ (deferred to the owning stage, tracked as a task)
- **II. Test-Backed Changes** — every FR maps to tests in Phase-1 quickstart +
  tasks; backend suites run serially; no format/serialization registry changes (no
  round-trip suite impact). ✅
- **III. Trunk-Based Solo Workflow** — no new ceremony; the only process artifact is
  the ratified-by-default ledger already in place. ✅
- **IV. Collaboration-Safe Document Operations** — the restore core's
  replace-content transaction predates this feature and is unchanged (restore is by
  definition whole-content replacement; its CRDT identity behavior is the existing
  ratified semantics). The inverse/undo path reuses 016 machinery. Attribution
  *improves*: every restore now carries durable performing-identity provenance
  (FR-020). ✅
- **V. Secure by Default** — no new endpoints, tools, or ingestion surfaces; existing
  auth/ACL/rate-limit posture unchanged (versionHistory rate limit already landed in
  the hotfix bundle). The backfill script is operator-run, not exposed. ✅
- **VI. Design Docs Are Ground Truth** — this feature exists to converge code to the
  two 2026-07-19 amendments; open decisions are recorded in
  `clarifications-needed.md` D-1..D-9 as RATIFIED-BY-DEFAULT. No design edits needed
  (the amendments already describe the end state; nothing here falsifies them). ✅
- **Technology constraints** — migrations via node-pg-migrate only; no new markdown /
  serialization dependency; no AI-provider changes. ✅

**Post-Phase-1 re-check**: design artifacts introduce no new projects, patterns, or
dependencies beyond two small extracted modules (`update-classifier`, `live-apply`)
that *reduce* duplication. PASS.

## Project Structure

### Documentation (this feature)

```text
specs/023-version-history-hardening/
├── spec.md
├── clarifications-needed.md   # D-1..D-9 ledger (pre-existing)
├── checklists/requirements.md # pre-existing
├── plan.md                    # this file
├── research.md                # Phase 0 — R1..R9 decisions
├── data-model.md              # Phase 1
├── contracts/
│   ├── persistence-write-read.md   # storeUpdate + gap-fetch contracts
│   └── restore-surfaces.md         # REST/MCP restore convergence contract
├── quickstart.md              # Phase 1 — validation guide
└── tasks.md                   # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
migrations/
├── 1799000000000_add-meaningful-to-yjs-updates.js    # NEW (R9-1)
├── 1799100000000_drop-version-snapshot-data.js       # NEW (R9-2)
└── 1799200000000_drop-yjs-state-vectors.js           # NEW (R9-3)

server/
├── postgres-persistence.js    # MODIFIED — write queue + advisory lock in storeUpdate;
│                              #   _fetchRowsWithGapRetry funnel; getUpdateRowsUpTo (new);
│                              #   meaningful column in _queryUpdatesWithUsers/storeUpdate;
│                              #   createNamedVersion → pure label INSERT;
│                              #   DELETE: getYDocWithHistory, getStateVectorsAtClocks,
│                              #   state-vector writes in storeUpdate/clearDocument/clearAll
├── index.js                   # MODIFIED — bindState: classification context + direct
│                              #   storeUpdate call (retry now internal); REST restore
│                              #   route passes shared-core deps
├── version-history.js         # MODIFIED — timeline reads persisted flags; snapshot
│                              #   branch removed; restoreVersion: recordEdit +
│                              #   live-apply broadcast; DELETE: filterMeaningfulUpdates,
│                              #   enrichVersionsWithMetadata, extractMetadata
├── diff-service.js            # MODIFIED — rows via persistence.getUpdateRowsUpTo;
│                              #   gapped ⇒ skip cache write; DELETE: invalidateCache
├── update-classifier.js       # NEW — shared meaningful-vs-noise predicate (R3)
├── live-apply.js              # NEW — shared apply-or-fanout broadcast (R7, from
│                              #   undo-service's H1-reviewed applyToLiveDoc)
├── undo/undo-service.js       # MODIFIED — uses live-apply module; gapped loadLog
│                              #   aborts observably before any claim
├── onboarding.js              # MODIFIED — drop yjs_state_vectors delete
├── mcp/tools/restore-document-version.js  # MODIFIED — shared-core deps, no
│                              #   session-provider broadcast
└── scripts/
    └── backfill-meaningful-classification.js  # NEW (R5)

client/src/extensions/YChangeExtension.js   # DELETED (US6 — only client change;
                                            #   coordinated with feature 024)

server/__tests__/…, server/undo/__tests__/…, __tests__/integration/…  # extended
```

**Structure Decision**: existing monolith layout; all work lands in `server/`,
`migrations/`, and tests. New logic that two call sites share is extracted into
top-level `server/` modules (matching existing flat convention: `diff-service.js`,
`origin.js`). No `shared/` involvement (nothing is client-shared).

## Phase 0 — Research

See [research.md](research.md). All spec-level unknowns (the two explicitly
plan-phase choices plus seven composition details) are resolved:

- **R1** Serialization = per-doc in-process FIFO queue + advisory xact lock backstop;
  retry moves inside the slot; external-client (016 claim) path uses the lock only —
  deadlock-free by unidirectional lock order.
- **R2** Gap coverage = funnel through one `_fetchRowsWithGapRetry`; consequence-split
  still-gapped behavior (serve / skip-cache / abort-claim / skip-doc).
- **R3** `meaningful` nullable boolean on `yjs_updates`; classified in bindState from
  before/after XML; NULL ⇒ meaningful.
- **R4** Timeline filters stored flags; `filterMeaningfulUpdates` deleted.
- **R5** Idempotent NULL-only backfill script per the search-index backfill pattern.
- **R6** `createNamedVersion` = pure label INSERT; snapshot branch removed; column
  dropped.
- **R7** Restore: recordEdit at the shared core (`''` agent sentinel for humans),
  shared live-apply broadcast, surface convergence, single-persist regression test.
- **R8** Dead-code deletion list re-verified; `yjs_state_vectors` + all four writer
  sites removed.
- **R9** Migrations 1799000000000 / 1799100000000 / 1799200000000.

## Phase 1 — Design & Contracts

- [data-model.md](data-model.md) — entity changes, state transitions, validation
  rules (incl. the `''` agent-identity convention and NULL-classification semantics).
- [contracts/persistence-write-read.md](contracts/persistence-write-read.md) —
  `storeUpdate` ordering/composition contract, gap-fetch funnel contract, observability
  lines.
- [contracts/restore-surfaces.md](contracts/restore-surfaces.md) — the one shared
  restore core: identical attribution, edit-record, broadcast, and error contracts
  for REST + MCP.
- [quickstart.md](quickstart.md) — runnable validation scenarios mapped to SC-001..007.

## Sequencing (feeds /speckit-tasks)

1. **US1 first** (foundation): queue + advisory lock + bindState retry relocation +
   claim-transaction composition tests.
2. **US2** (gap funnel) — independent of US1 code-wise, but its tests assume the
   funnel exists before US3/US4 build on it.
3. **US4 before US3's migration** (classification column + write path + timeline
   rewrite + backfill land before snapshot_data drops — the spec's ordering
   constraint: classification erases the replay-cost rationale for snapshots).
4. **US3** (snapshot drop) after US4.
5. **US5** (restore integration) after US1/US2 (uses ordered writes + gap-safe reads).
6. **US6** (deletions + state-vectors migration) last-ish, independent of US5.
7. Docs task (README version-history section) in the serial/merge-owned phase.

## Complexity Tracking

> No constitution violations — table intentionally empty.
