# Implementation Plan: Version History Truth — Attribution Correctness and Failure-Path Honesty

**Branch**: `041-version-history-truth` (parallel-pipeline feature; work happens on `main` per pipeline overrides) | **Date**: 2026-08-02 | **Spec**: specs/041-version-history-truth/spec.md

**Input**: Feature specification from `/specs/041-version-history-truth/spec.md`

**Planned against**: main @ 603a494b. 041 implements and merges FIRST of the 041 → 042 → 044 → 043 train; nothing here depends on the other three.

## Summary

Make the version-history display layer and its failure paths tell the truth the durable log already records. Server side: named versions and split fragments compute authors/on-behalf-of from their own clock range (A1/A7 — reproduced bidirectionally, see ledger note N-041-1); the drill-down applies the timeline's meaningful filter and counts only surviving rows (A2); bindState refuses to serve an empty doc over a load failure (B2); restore builds its delta from the live doc when loaded here (B3), tail-checks its target read (B7), and stops creating/leaking in-memory docs via the creating `getYDoc` (B8); the pending-recording guard ignores `via_sync` rows (B6); the "Reverted" stamp is verified against the record actually undone (A3 narrow); the null/primitive origin fallback degrades loudly (A5); the inverse spanning fallback gets the `viaSync` guard (B9); three stale doc surfaces get post-040-D19 truth (D3–D5). Client side: history/diff failures render error states with retry (B4), the selection is reconciled after every refresh (A4), the open panel live-refreshes by polling, and expanded drill-downs re-fetch instead of showing false emptiness (B5).

No schema changes: every marker/flag this feature reads (`meaningful`, `via_sync`, `on_behalf_of`) already exists, and the FR-017 malformed-origin marker is the in-memory `parseOrigin` classification (parity with the existing classes — RBD-041-9). **No new migration is needed or planned.**

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS backend), React 18 + Vite frontend

**Primary Dependencies**: Express, y-websocket (bin/utils — `docs` map, `getYDoc`), Yjs, TipTap; axios on the client

**Storage**: PostgreSQL (`yjs_updates`, `agent_edits`, `document_versions`) — read/write via `server/postgres-persistence.js`; Redis pub/sub for cross-instance fan-out (optional)

**Testing**: Jest, serial, shared DB (`server/__tests__/`, `server/undo/__tests__/`, `__tests__/integration/`); Vitest for client (`client/src/**/__tests__/`). Implementers use per-worktree databases; the plan assumes NO parallel backend test execution.

**Target Platform**: Linux server (k3s pods), evergreen browsers

**Project Type**: Web application (Express backend + React frontend in one repo)

**Performance Goals**: Timeline stays O(rows) (023 FR-016 invariant — the A1/A2 fixes must not reintroduce per-request replay); history poll adds ≤ 1 cheap request / 10 s / open panel

**Constraints**: Zero schema migrations; no behavior revived from the 040 D19 cut; `design/collaboration-core.md` 2026-08-02 amendment is ground truth; backend tests serial

**Scale/Scope**: 19 FRs across 7 user stories; ~10 server files, ~5 client files, 3 documentation surfaces

## Constitution Check

*GATE: evaluated against constitution v1.1.1 before Phase 0; re-checked after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| I. Documentation Reflects Reality | Behavior-changing work updates README/docs in the same effort | **PASS with handoff**: FR-018/FR-019 fix the in-code/tool docs this feature owns. Pipeline overrides forbid this agent editing README.md; the merge queue MUST check README's version-history section (error states, live refresh, restore semantics) and update it at merge time. Flagged again in "Merge-queue notes" below. |
| II. Test-Backed Changes | Every behavioral change ships tests; backend serial | **PASS**: every FR maps to named test additions (see quickstart.md matrix); no format/serialization change, so no round-trip registry work. |
| III. Trunk-Based Solo Workflow | No process for its own sake | **PASS**: pipeline feature; no new ceremony. |
| IV. Collaboration-Safe Document Operations | Targeted Yjs ops, no wholesale delete-recreate, provenance preserved | **PASS**: restore's delete-and-reclone of the fragment is the *shipped, designed* restore semantic (design/collaboration-core.md "Restore is non-destructive"), unchanged in shape here — FR-011 only moves where the delta is computed. All new writes carry standard origins. FR-013 *removes* a path that mutated server memory as a side effect of a read. |
| V. Secure by Default | Untrusted content stays inert; auth/ACL on endpoints | **PASS**: no new endpoints, no new ingestion surface. Error states render fixed strings, never server-echoed content as markup. FR-015 *narrows* what a client-supplied `toolCallId` can do. |
| VI. Design Docs Are Ground Truth | design/ wins; gaps go to the ledger | **PASS**: 2026-08-02 amendment (web-UI restore not an undo target) is enforced by FR-015's explicit no-revival clause and restore's existing `agentName`-gated recording (untouched). FR-011's cross-pod residual is recorded where the guarantee is documented (restoreVersion header + contracts/restore-live-delta.md). New decisions recorded as RBD-041-9 and N-041-1 in clarifications-needed.md. |

**Post-Phase-1 re-check**: PASS — design artifacts introduce no migration, no new dependency, no registry bypass, no README edit by this agent.

## Project Structure

### Documentation (this feature)

```text
specs/041-version-history-truth/
├── spec.md              # committed (603a494b)
├── clarifications-needed.md  # RBD-041-1..8 (+9 and note N-041-1 added by plan)
├── plan.md              # This file
├── research.md          # Phase 0: per-FR mechanism decisions R1–R16
├── data-model.md        # Phase 1: entities & derived-field rules
├── quickstart.md        # Phase 1: validation guide + FR→test matrix
├── contracts/
│   ├── range-scoped-version-meta.md   # A1/A2/A7 computation contract
│   ├── undo-result-and-stamp.md       # additive undo/redo result fields + stamp verification
│   ├── bind-failure.md                # bindState refusal semantics + close code
│   └── restore-live-delta.md          # FR-011/012/013 restore read/write contract
└── tasks.md             # Phase 2 (/speckit-tasks — not created by plan)
```

### Source Code (repository root)

```text
server/
├── version-history.js        # FR-001..004: range-scoped meta (both fragment sites :335-341 AND :348-357,
│                             #   named-version objects :285-304, drill-down :754-792); FR-011/012 restoreVersion
├── postgres-persistence.js   # FR-012: getYDocAtClock gains expectedTailClock (currently absent — only
│                             #   getUpdateRowsUpTo has it; :783-798)
├── index.js                  # FR-010 bindState catch (:469-474); FR-015 stamp verification (:1582-1589);
│                             #   FR-017 notification wiring (:328); restore-route deps (:1531)
├── live-apply.js             # FR-013: deps take the honest peek
├── document-service.js       # FR-013: new peekSharedDoc (docs.get, never creates)
├── origin.js                 # FR-017: :186 fallback gains malformedOrigin marker + error log
├── agent-identity.js         # FR-018: docstring truth (:20-30)
├── undo/
│   ├── edit-records.js       # FR-014: via_sync exclusion (:189-211); FR-018 sentinel comment (:24-46)
│   ├── inverse.js            # FR-016: viaSync guard on spanning fallback (:105-113)
│   └── undo-service.js       # FR-015: additive undoneRecordRange/redoneRecordRange; FR-013 peek dep
└── mcp/tools/
    └── restore-document-version.js  # FR-019: description truth (:28-49)

client/src/
├── hooks/useVersionHistory.js       # FR-005/006 error split; FR-007 reconcile; FR-008 poll; FR-009 cache↔expand
├── components/
│   ├── VersionHistoryPanel.jsx      # FR-005: error state + retry (empty state gated on success)
│   ├── HierarchicalVersionList.jsx  # FR-005/009: error prop; expanded rows re-fetch after refresh
│   ├── VersionPreview.jsx           # FR-006: diff error state (placeholder only when nothing selected)
│   ├── EditorView.jsx               # FR-005/006/007: wire error/retry/reconciled selection through
│   └── VersionHistoryPanel.css      # FR-005: .version-history-error (:160-171) becomes live

server/__tests__/, server/undo/__tests__/, __tests__/integration/, client/src/**/__tests__/
                                      # per-FR coverage; see quickstart.md matrix
```

**Structure Decision**: Existing web-application layout; no new directories, no new modules except nothing — `peekSharedDoc` lands inside the existing `document-service.js`. All changes are edits to the files above.

## Approach per user story (summary — full mechanisms in research.md)

- **US1 (P1, top-priority cluster — Sam-relayed bidirectional repro N-041-1)**: one new pure helper `computeRangeMeta(updates, clockStart, clockEnd)` derives `{authors, onBehalfOf, onBehalfOfMore, timestamp}` from the rows inside a clock range using the exact author/dedupe logic `groupUpdatesIntoVersions` uses. `mergeNamedVersions` gains the (already meaningful-filtered) `updates` array and uses the helper for named-version objects AND both fragment-spread sites; `getUpdatesForVersion` filters `meaningful !== false` before grouping and counts surviving rows. Regression test asserts range-scoped authors in BOTH directions across a named-version split (R1, R2, R16 noise-only fallback).
- **US2 (P1)**: hook error states get rendered — list error + retry in the panel (empty state only on successful zero-version response), diff error in the preview (placeholder only when nothing selected) (R3). bindState's catch is provably a real-failure path (the no-rows case returns an empty doc without throwing): it now pages the notifier, evicts the doc from the y-websocket map, and closes that doc's connections with close code 1013 so clients retry (R7, RBD-041-1).
- **US3 (P2)**: post-refresh selection reconciliation inside the hook per RBD-041-8 (containing-`clockEnd` version, else default rule); every action reads the reconciled selection (R4). Live refresh = 10 s poll while the panel is open, paused when the tab is hidden (R5, plan-level choice under RBD-041-7). Expanded rows re-fetch when a refresh wipes the drill-down cache (R6).
- **US4 (P2)**: restore builds its delta in a transaction ON the live doc when (honestly) loaded here, captured origin-scoped under `ORIGIN_RESTORE`, then stored; durable-log path unchanged otherwise; cross-pod serialization documented as residual (R8, RBD-041-2). `getYDocAtClock` gains `expectedTailClock`; restore's target read passes its (range-validated, hence committed) `clockEnd` (R9). `peekSharedDoc` (backed by y-websocket's exported `docs` map) replaces the creating lookup in live-apply/undo/restore deps; no doc is ever created, so nothing leaks (R10).
- **US5 (P2)**: `AND via_sync IS NOT TRUE` in the pending-recording newest-row probe (R11). Undo/redo results additively carry the claimed record's edit range; the chat route stamps only when the card's stored `output.editRange` matches, skip+log otherwise — including cards with no stored range (R12, RBD-041-3).
- **US6 (P3)**: `parseOrigin`'s final fallback returns `malformedOrigin: 'null-or-primitive'` + error log; bindState listener pages it like `'non-uuid-string'` (R14, RBD-041-9 — marker is the in-memory classification, no schema change). `computeInverse`'s spanning fallback excludes `viaSync === true` rows (guard, not comment — R13, RBD-041-5 preference).
- **US7 (P3)**: rewrite the three stale surfaces to post-040-D19 truth (R15).

## Merge-queue notes (obligations this agent cannot discharge)

1. **README.md**: check the version-history/undo sections against the shipped behavior after merge (error states, live refresh, verified Reverted stamp, restore live-delta) and update in the merge commit if drifted (Constitution I; pipeline override forbids this agent editing it).
2. **No migration in this feature** — the migration-slot serialization concern does not apply to 041.
3. 042/043/044 assumptions: 041 does NOT delete dead code (C-section), does NOT add the E-section standalone suites beyond its own FR coverage, and leaves `VersionHistoryPanel.css` dead blocks in place except `.version-history-error` which becomes live — 042's dead-CSS deletion must not remove it.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
