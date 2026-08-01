# Implementation Plan: Attribution Integrity

**Branch**: `038-attribution-integrity` | **Date**: 2026-08-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/038-attribution-integrity/spec.md`

**Design basis**: `design/collaboration-core.md`, the two amendments dated 2026-08-01
(commit 13f7561d): (a) edit enforcement covers the WHOLE sync protocol; (b) reconnect
re-supply is sync, not authorship. This plan converges code to those amendments and
closes verified audit findings F1–F5.

## Summary

Five converging fixes to the collaboration sync/attribution pipeline:

1. **F1 / US1 (P1, security)**: Classify `SYNC_STEP2` frames as edits and drop them from
   viewer-role connections, exactly like update frames, with a distinct
   `WS_STEP2_BLOCKED` observability event. The classification function is extracted from
   `server/index.js` into a small importable module so the unit test pins the *real*
   function (the current test at `server/__tests__/permissions.test.js:262-293` pins the
   bug via a hand-mirrored copy) and so a protocol-level integration test can wire the
   real gate.
2. **F2 / US2 (P2)**: Add a nullable `via_sync` boolean to `yjs_updates` (this feature's
   single migration), set exactly for updates produced during the synchronous application
   of a step2 frame (per-connection flag, `finally`-cleared), threaded through
   `storeUpdate` into the row. Log-derived undo treats `via_sync = true` rows as foreign
   (run-breaking, D2); the collab guardrail annotates sync-sourced triggers without
   changing paging (D3). No backfill; `null` ≡ "unknown" ≡ "not sync" (D1/D5).
3. **F3 / US3 (P3)**: `parseOrigin` validates string origins against a strict UUID
   format; a non-UUID string degrades to unattributed-but-persisted with a loud
   alert-worthy signal (never a dropped row); unrecognized object shapes persist with a
   warning. Plus a documentation-only comment on the publish-before-commit window
   (FR-018).
4. **F4 / US4 (P4)**: `document-service.updateDocument` capture becomes origin-scoped and
   synchronously detached (listener matches the transaction's own origin object, removed
   in `finally`; the 50 ms timeout window is deleted), preserving the
   "persistence initiated" contract and 037's emit-time `hadRedisHandler` sampling.
5. **F5 / US5 (P5)**: Delete the homegrown `connectionClientId` capture
   (`parseAwarenessClientIds` + first-frame capture + explicit close-handler awareness
   eviction); presence cleanup relies solely on y-websocket's per-connection
   controlled-id tracking. The Redis pub/sub cleanup in the same close handler is
   preserved unchanged.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS backend); React 18 client untouched by this feature

**Primary Dependencies**: y-websocket (`setupWSConnection`, `bin/utils`), yjs, y-protocols, lib0 (encoding/decoding), Express, `ws`; node-pg-migrate for schema

**Storage**: PostgreSQL — `yjs_updates` gains nullable boolean `via_sync` (single migration, timestamp `1799700000000` > head `1799600000000`, and > the `1795000000000` phantom-row floor from the rolled-back 008 cleanup in `script/migrate.js`)

**Testing**: Jest (backend, serial: `--runInBand` wired); suites touched: `server/__tests__/permissions.test.js`, `server/__tests__/origin.test.js`, `server/undo/__tests__/legacy.test.js`, `server/__tests__/collab-guardrail.test.js`, `server/__tests__/live-fanout.test.js`, `server/__tests__/import-presence.test.js`, new integration test under `__tests__/integration/`

**Target Platform**: Linux server (k3s pods); single- and multi-instance (Redis optional)

**Project Type**: Web service (Express + y-websocket backend; this feature is backend-only)

**Performance Goals**: Zero added per-keystroke cost on the persistence hot path (flag read is O(1); UUID validation is one regex on an already-string origin; no extra queries)

**Constraints**: No behavioral change to persistence semantics (per-doc write ordering, retry, meaningful-classification, shutdown flush); no change to which guardrail events page; no protocol change visible to well-behaved clients

**Scale/Scope**: ~6 server files touched + 1 migration + tests; no client changes

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.1 — PASS (pre-Phase-0
and re-checked post-Phase-1). No Complexity Tracking entries needed.*

- **I. Documentation Reflects Reality**: README/`docs/dev.md` describe collaboration at a
  level above these mechanics; no drift introduced. Per the parallel-agent protocol,
  `CLAUDE.md`/`README.md`/`docs/dev.md` are NOT edited in this worktree — any doc deltas
  are reconciled in the merge queue. In-code contract documentation (FR-015 `via_sync`
  contract, FR-011 synchronicity assumption, FR-018 window comment) ships with the code. PASS.
- **II. Test-Backed Changes**: every behavioral change has named suites (see Testing
  above); FR-008 mandates a protocol-level integration test; the bug-pinning test is
  updated as part of the work (FR-007). Backend tests run serially against a per-agent DB. PASS.
- **III. Trunk-Based Solo Workflow**: no new ceremony; parallel-pipeline worktree rules
  apply (no branches/commits from this agent). PASS.
- **IV. Collaboration-Safe Document Operations**: this feature is an enforcement of
  Principle IV's provenance invariant ("edits MUST remain attributable"). No
  delete-and-recreate paths; no positional targeting; format registry untouched. PASS.
- **V. Secure by Default**: US1 closes a write-permission bypass on an existing ingestion
  surface (the WS sync protocol); trust boundary restated in the contracts. Blocked
  frames fail closed for viewers, stay open for the connection (D4, matches existing
  policy). PASS.
- **VI. Design Docs Are Ground Truth**: the two 13f7561d amendments are the design basis;
  all five open decisions are RATIFIED-BY-DEFAULT in `clarifications-needed.md` (D1–D5).
  `design/` files are not hand-edited. PASS.
- **Technology constraints**: schema change via node-pg-migrate; no new dependencies;
  nothing added to `shared/` (server-only). PASS.

## ⚠ Shared-file boundary with feature 039 (diff-cache-integrity) — DO NOT CROSS

Feature 039 is being built concurrently and owns the **READ path** of
`server/postgres-persistence.js`: `getUpdateRowsUpTo`, `_fetchRowsWithGapRetry`,
`_findFirstGap`. **This feature (038) owns only the WRITE path**: `storeUpdate`,
`_runStoreSlot`, `_storeUpdateCritical` (the INSERT column list), plus the
attribution-metadata read helpers `_queryUpdatesWithUsers` / `_mapUpdateRow`
(adding `via_sync` to the SELECT/mapping only — these are not on 039's owned list and
FR-013 requires the column to surface to undo). Implementers MUST NOT touch
`getUpdateRowsUpTo`, `_fetchRowsWithGapRetry`, or `_findFirstGap`, and MUST NOT edit
anything under `server/diff/`, `server/diff-service.js`, or `specs/039-*`. The diff
subsystem's eventual consumption of `via_sync` is 039/follow-on scope.

**This feature owns the single in-flight migration slot** — no other concurrent feature
may add a migration; ours is `1799700000000_add-via-sync-to-yjs-updates.js`.

## Known implementation hazards (verified against current code)

- **The pinned-bug test**: `server/__tests__/permissions.test.js:262-293` defines a
  *local mirrored copy* of `isEditMessage` and asserts
  `isEditMessage(syncStep2) === false`. Updating this test to the new contract is part of
  the work (FR-007), not collateral damage — do not "preserve" it. The extraction (R1)
  makes the test import the real function so the mirror-drift failure mode dies.
- **Flag scoping relies on synchronous frame application**: message dispatch →
  `readSyncMessage` → `readSyncStep2` → `Y.applyUpdate` → doc `update` listeners is one
  synchronous chain. Set the flag immediately before delegating the frame, clear it in a
  `finally` (a throw must not leave it stuck — FR-011), and document the synchronicity
  assumption at the flag site.
- **connectionClientId deletion**: the close handler at `server/index.js` (~line 2241)
  mixes the awareness eviction (delete) with the Redis pub/sub cleanup (preserve —
  FR-024). `parseAwarenessClientIds` has no callers outside `server/index.js` (verified;
  `attribution-bug.test.js` references it only in comments). The `decoding` import in
  `index.js` is used only by `parseAwarenessClientIds` — remove it with the helper if no
  other use remains at implementation time.
- **Capture-race fix must preserve 037**: `hadRedisHandler` MUST still be sampled at
  emit time inside the listener (see the load-bearing comment in
  `server/document-service.js:71-78`), and the change-producing path must still defer one
  event-loop turn (`setImmediate`) before resolving so "persistence initiated" holds
  (FR-021). Suites `live-fanout.test.js` and `import-presence.test.js` guard this.
- **Migration numbering**: strictly greater than `1799600000000`; the repo's
  `script/migrate.js` auto-cleans phantom `pgmigrations` rows from rolled-back 008 and
  requires new migrations to sort after `1795000000000` — `1799700000000` satisfies both.
- **`parseOrigin` is consumed by every persistence-path caller**: the hardening (R7) must
  keep the sentinel skip-list semantics byte-for-byte (db-load, redis, sync-push brand,
  inverse-apply, restore) and must not change the ws-object path (`{userId, agentName}`
  properties present).

## Project Structure

### Documentation (this feature)

```text
specs/038-attribution-integrity/
├── plan.md              # This file
├── research.md          # Phase 0 output — decisions R1..R11
├── data-model.md        # Phase 1 output — yjs_updates + via_sync
├── quickstart.md        # Phase 1 output — validation guide
├── contracts/           # Phase 1 output
│   ├── sync-protocol-gate.md      # frame classification / role gating / WS_STEP2_BLOCKED
│   ├── via-sync-column.md         # column semantics + consumer rules
│   └── internal-api-changes.md    # changed JS signatures (storeUpdate, parseOrigin, updateDocument, legacy undo)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
migrations/
└── 1799700000000_add-via-sync-to-yjs-updates.js   # NEW — the single owned migration

server/
├── ws-edit-gate.js          # NEW (R1): protocol constants + isEditMessage + gate helper,
│                            #   extracted from index.js so tests exercise the real code
├── index.js                 # MODIFIED: use ws-edit-gate; step2 blocking + WS_STEP2_BLOCKED;
│                            #   step2 flag set/clear around originalEmit (FR-011);
│                            #   bindState listener reads flag → viaSync, threads to storeUpdate,
│                            #   passes viaSync to guardrail; FR-018 window comment;
│                            #   DELETE parseAwarenessClientIds + connectionClientId capture +
│                            #   close-handler awareness eviction (keep Redis cleanup)
├── origin.js                # MODIFIED (R7): strict-UUID string validation; malformed-origin
│                            #   degradation signals; sentinel handling unchanged
├── postgres-persistence.js  # MODIFIED (WRITE PATH + metadata read only):
│                            #   storeUpdate/_runStoreSlot/_storeUpdateCritical thread viaSync
│                            #   into the INSERT; _queryUpdatesWithUsers/_mapUpdateRow surface
│                            #   via_sync. DO NOT TOUCH the 039-owned read path.
├── document-service.js      # MODIFIED (R6): origin-scoped capture, finally-detached listener,
│                            #   50ms window removed, 037 contracts preserved
├── collab-guardrail.js      # MODIFIED (R5): viaSync param → syncSourced annotation on the
│                            #   warn line + notifyException extra; paging unchanged (D3)
└── undo/
    ├── legacy.js            # MODIFIED (R4): via_sync=true rows are foreign to identity runs (D2)
    └── undo-service.js      # unchanged behavior; rows now carry viaSync via _mapUpdateRow

server/__tests__/
├── permissions.test.js      # MODIFIED (FR-007): import the REAL isEditMessage from
│                            #   ws-edit-gate; pin the new contract (step2 IS an edit)
├── ws-edit-gate.test.js     # NEW: unit coverage of the gate module incl. short frames
├── origin.test.js           # MODIFIED: UUID validation, malformed string/object cases
├── collab-guardrail.test.js # MODIFIED: syncSourced annotation cases
├── live-fanout.test.js      # must stay green (037 capture semantics)
└── import-presence.test.js  # must stay green (037 emit-time sampling)

server/undo/__tests__/
└── legacy.test.js           # MODIFIED: via_sync exclusion — run-breaking, all-flagged refusal

__tests__/integration/
└── step2-viewer-block.test.js  # NEW (FR-008): protocol-level e2e — viewer step2 dropped
                                #   (no doc change, no row, WS_STEP2_BLOCKED), editor step2
                                #   applied + persisted with via_sync=true
```

**Structure Decision**: Existing single-repo web-service layout; this feature adds one
module (`server/ws-edit-gate.js`), one migration, and one integration test file, and
modifies six existing server files listed above. No client changes.

## Phase 0 → research.md

All spec-level unknowns were resolved as ratified defaults D1–D5 before planning; Phase 0
therefore records the *implementation* decisions (R1–R11) with rationale and rejected
alternatives. See [research.md](research.md).

## Phase 1 → data-model.md, contracts/, quickstart.md

- [data-model.md](data-model.md): `yjs_updates.via_sync` column, states, and consumer
  rules; migration up/down.
- [contracts/sync-protocol-gate.md](contracts/sync-protocol-gate.md): the frame
  classification table, role gating, blocked-frame policy (D4), `WS_STEP2_BLOCKED` event
  shape, and the "new sync message types must be classified before they ship" rule.
- [contracts/via-sync-column.md](contracts/via-sync-column.md): the channel-marker
  contract (set-on-step2, null-means-unknown, proves-transport-not-authorship) and each
  consumer's obligation (undo, guardrail, future readers).
- [contracts/internal-api-changes.md](contracts/internal-api-changes.md): exact JS
  signature changes for `storeUpdate`, `parseOrigin`, `updateDocument`,
  `deriveLegacyRange` inputs, `evaluateUpdate`.
- [quickstart.md](quickstart.md): runnable validation scenarios per user story.

## Post-design Constitution re-check

Re-evaluated after Phase 1: no new violations. The one new module
(`server/ws-edit-gate.js`) exists to kill a test-mirror drift failure mode and enable the
mandated e2e test — not speculative structure. Complexity Tracking remains empty.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.
