# Implementation Plan: Resupply Attribution — Truthful Author Display for Sync-Resupplied Content

**Branch**: `045-resupply-attribution` (parallel-pipeline feature; work happens on `main` per pipeline overrides) | **Date**: 2026-08-02 | **Spec**: specs/045-resupply-attribution/spec.md

**Input**: Feature specification from `/specs/045-resupply-attribution/spec.md`

**Planned against**: `main` @ 62bccbc7 — includes merged **041** (`isMeaningful`, `computeRangeMeta`, `computeFragmentMeta`, `UNKNOWN_AUTHOR`, `getClockRange`) and **042** (the `yjs-utils` extraction, `includeData:false` metadata reads, dead-code removal). All anchors below were re-located by symbol in the working tree; the investigation's pre-041 line numbers are stale and were not used.

**Sequencing**: implements after **044** merges; **MUST merge before 043** (043's US2/FR-003 reconnect assertion is RED until this lands — RBD-045-7).

## Summary

Make every author-displaying surface stop presenting a sync relayer as the author of content
they only carried. One new server module performs **forensic origin resolution**: decode a
`via_sync` row's payload, take the Yjs client identities of its inserted content, and bind them
to users using the document's own PRIOR directly-attributed rows. A bound identity is displayed
exactly as a direct author (so 038's genuine-offline-edit credit survives); anything
unresolvable — no evidence, ambiguous evidence, a deletion-only payload — renders as a new
**"Synced content"** contributor, never the relayer and never a guess. The four surfaces
(timeline incl. named versions and split fragments, drill-down, per-clock author,
recent-authors/MCP) and the collaboration guardrail all consume that ONE outcome; a single
shared author-accumulation helper inside `version-history.js` makes "one resolution, many
renderers" structural rather than aspirational. The guardrail's agent-content candidate query
widens to see resupplied agent content (alert-only posture byte-for-byte preserved), and the
underlying durability window is recorded as a ratifiable accepted residual with the loss path
untouched.

### LOUD FLAG 1 — **NO MIGRATION. 045 does not take the in-flight migration slot.**

The spec's FR-009 explicitly permits a persisted resolution and demands it be an explicit
choice. **It is rejected** (research R1): a persisted result cannot satisfy FR-008 (historical
rows must resolve with no backfill) without ALSO shipping the read-time path, and the
expensive half of resolution is EVIDENCE — persisting evidence retroactively would mean
decoding every `yjs_updates` row in every document, the heaviest possible deploy story, to buy
what a per-process memo buys for free. **This feature is code-only: no `node-pg-migrate` file,
no column, no backfill, no data migration, no deploy-ordering constraint.** The migration slot
stays free for another feature. (For the record, had one been needed the floor is
> 1795000000000 and the highest existing migration is `1799700000000`.)

### LOUD FLAG 2 — a deliberate softening of one 038 promise

A resupplied row whose originating session never committed a direct row in that document has
NO evidence, so it renders as "Synced content" even when its relayer really is its author
(RBD-045-10). This is an honest hedge in a case the server cannot verify, but it is a narrow
regression of 038's "genuine offline edits stay credited". Flagged for Sam; the mitigation
(write-time capture of the connection's own client identity) is deliberately out of scope.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS backend), React 18 + Vite frontend

**Primary Dependencies**: `yjs` 13.6.30 (`parseUpdateMeta` — behavior verified empirically on
2026-08-02, see research R3), Express, y-websocket, TipTap; no new dependency

**Storage**: PostgreSQL — `yjs_updates` (`via_sync`, `update_data`, `user_id`, `agent_name`,
`meaningful`, `clock`) and `users`, all read-only for this feature. **No schema change.**

**Testing**: Jest, serial, shared DB (`server/__tests__/`, `__tests__/integration/`); Vitest
for the client. Implementers use a per-worktree database; never run backend suites in parallel.

**Target Platform**: Linux server (k3s pods), evergreen browsers

**Project Type**: Web application (Express backend + React frontend in one repo)

**Performance Goals**: a document with no `via_sync` rows pays ZERO extra queries and ZERO
decodes (the common path); a document with them pays one evidence pass per process, memoized
permanently; a repeat request performs zero decodes (SC-005). The timeline stays O(rows)
(023 FR-016 invariant preserved).

**Constraints**: no migration; `design/collaboration-core.md`'s 2026-08-02 amendment is ground
truth; resolution is DISPLAY-ONLY (FR-010); the loss path is byte-identical (FR-014); the
guardrail never blocks (FR-012); backend tests serial.

**Scale/Scope**: 14 FRs across 5 user stories; 1 new server module, ~6 server files touched,
2 client files, 1 documentation comment, plus the ledger entry.

## Constitution Check

*GATE: evaluated against constitution v1.1.1 before Phase 0; re-checked after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| I. Documentation Reflects Reality | Behavior-changing work updates README/docs in the same effort | **PASS with handoff**: pipeline overrides forbid this agent editing `README.md`. A new displayed contributor type is README-visible: the merge queue MUST update the version-history section (README ~L446-475) and the `via_sync` description (~L1128) to state that relayed content is credited to its recovered author or shown as "Synced content", never the relayer. Restated under "Merge-queue notes". |
| II. Test-Backed Changes | Every behavioral change ships tests; backend serial | **PASS**: every FR maps to named tests (quickstart matrix). No format/serialization change, so no round-trip registry work. |
| III. Trunk-Based Solo Workflow | No process for its own sake | **PASS**: one new module, no new infrastructure. The rejected alternatives (migration, Redis cache) were rejected partly on this ground. |
| IV. Collaboration-Safe Document Operations | Targeted Yjs ops; provenance is a product invariant | **PASS, and this is the principle the feature serves**: nothing mutates a document; the durable stamp is never rewritten (FR-010). Provenance moves from a known-false display to a derived-or-honestly-unknown one. |
| V. Secure by Default | Untrusted content stays inert; auth/ACL enforced | **PASS**: no new endpoint, no new ingestion surface. Resolution reads only server-side durable rows; the synthetic contributor is a fixed server-side constant, never content-derived, so nothing new reaches the client as markup. Existing route auth/ACL unchanged. |
| VI. Design Docs Are Ground Truth | design/ wins; gaps go to the ledger | **PASS**: implements the 2026-08-02 `design/collaboration-core.md` amendment verbatim (display truth + guardrail coverage + documented residual). Five new decisions recorded as RBD-045-8..12 plus note N-045-1 in `clarifications-needed.md`; nothing decided silently. |

**Post-Phase-1 re-check**: **PASS** — the design artifacts add no migration, no dependency, no
new endpoint, no registry bypass, and no README edit by this agent. Complexity Tracking is
empty (no violations).

## Project Structure

### Documentation (this feature)

```text
specs/045-resupply-attribution/
├── spec.md                        # committed (cc15b18f)
├── clarifications-needed.md       # RBD-045-1..7 (+8..12 and note N-045-1 added by this plan)
├── plan.md                        # This file
├── research.md                    # Phase 0: mechanism decisions R1–R16
├── data-model.md                  # Phase 1: derived entities (no schema)
├── quickstart.md                  # Phase 1: validation guide + FR/SC → test matrix
├── checklists/requirements.md     # from /speckit-specify
├── contracts/
│   ├── resupply-resolution.md     # the resolver's surface, guarantees, algorithm, config
│   ├── author-surfaces.md         # the one accumulation helper + how 4(+1) surfaces consume it
│   ├── guardrail-candidates.md    # widened candidate set, preserved posture
│   └── persistence-readers.md     # the two (plus one) narrow read-only queries
└── tasks.md                       # Phase 2 (/speckit-tasks — not created by plan)
```

### Source Code (repository root)

```text
server/
├── resupply-resolution.js     # NEW — origin extraction, evidence fold, memo, _stats seam
├── version-history.js         # SYNCED_CONTRIBUTION + collectAuthorsForUpdate; thread ctx through
│                              #   groupUpdatesIntoVersions / computeRangeMeta / computeFragmentMeta /
│                              #   mergeNamedVersions / getVersionTimeline / getUpdatesForVersion
│                              #   (projection must stop dropping viaSync) / getCurrentSessionAuthors /
│                              #   getContentAtClock
├── postgres-persistence.js    # getUpdatePayloads, getDirectAttributedRows, getUserDisplayFields
├── collab-guardrail.js        # widened fresh-row query + candidate classification + init(pool, persistence)
├── index.js                   # guardrail init wiring; 038 FR-018 window comment cross-reference (FR-013)
└── mcp/tools/read-document.js # resolve once; recentAuthors + lastModifiedBy consume it

client/src/components/
├── HierarchicalVersionList.jsx  # distinct rendering for author.isSynced (dot + title)
└── HierarchicalVersionList.css  # outlined-dot style, light + dark

server/__tests__/
├── resupply-resolution.test.js  # NEW — resolution matrix, caching/decode counters, import guard
├── resupply-attribution.test.js # NEW — cross-surface agreement incl. the MCP consumer (FR-007/SC-004)
├── version-history.test.js      # surface-level author assertions (the existing single home)
└── collab-guardrail.test.js     # widened candidates, posture preserved
client/src/components/__tests__/HierarchicalVersionList.test.jsx
```

**Structure Decision**: existing web-app layout; the only new file is one server module plus
its test. Resolution deliberately does NOT live inside `version-history.js` — the guardrail
consumes it too, and a separate module is what makes the FR-010 import guard testable.

## Implementation phases

1. **Resolver core** (US1/US2 substrate): `server/resupply-resolution.js` + the three
   persistence readers + unit tests over fabricated rows. Independently verifiable.
2. **Display surfaces** (US1/US2/US3): `SYNCED_CONTRIBUTION`, the shared accumulation helper,
   context threading through all four surfaces, the `getUpdatesForVersion` projection fix, MCP
   wiring, client rendering.
3. **Guardrail** (US4): widened query + classification + wiring, alert-shape tests.
4. **Residual record** (US5): the RBD-045-5 ledger entry is already drafted in the spec's
   ledger; the plan task is the cross-reference from the 038 FR-018 persistence-listener
   comment plus a FR-014 no-change diff review.

## Key risks and how the design answers them

| Risk | Answer |
|---|---|
| First-render evidence scan on a large document | Only when the document actually has `via_sync` rows; batched; hard cap `RESUPPLY_EVIDENCE_MAX_ROWS` (default 20000) degrades to an honest "Synced content" rather than burning CPU (R5) |
| Cache staleness of names/avatars | Memo holds identifiers only; display fields are materialized per request (R6) |
| Resolution leaking into replay/undo/permissions | FR-010 enforced by an import-guard test (R14) |
| Guardrail cost or posture drift | Widening is recency-bounded and sits behind the existing cheap-first guards; all failures still swallowed; direct path byte-identical (contracts/guardrail-candidates.md) |
| Server-shared-doc client identity maps to many users | Correctly reported as ambiguous ⇒ "Synced content"; never guessed (R12) |
| Pre-038 unmarked resupplies polluting evidence | Documented limit N-045-1; strictly better than today's unconditional lie |

## Merge-queue notes

1. **Order**: 044 → **045** → 043. 043's US2/FR-003 assertion goes GREEN only once 045 is on
   `main`; 043's spec sequencing line still says "after 041 and 042" and must be extended to
   include 045 (RBD-045-7 — orchestrator-owned, not edited by this agent).
2. **README (Constitution I)**: this agent may not edit `README.md`. At merge, update the
   version-history section (~L446-475) and the `via_sync` paragraph (~L1128) to describe
   recovered authorship and the "Synced content" contributor.
3. **No migration, no backfill, no deploy ordering.** Deploy is a plain image roll; rollback is
   a revert.
4. **Do not duplicate 043's harness.** 045 stages resupplies as fabricated rows only; the real
   reconnect end-to-end test is 043's (R15).
5. **Sam owes**: ratification of RBD-045-5 (accepted residual, confirm/overturn), a look at
   RBD-045-10 (the softened 038 promise), and the manual UI walk in quickstart.md.

## Complexity Tracking

No Constitution Check violations. Table intentionally empty.
