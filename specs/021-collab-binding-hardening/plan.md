# Implementation Plan: Collaborative Editor Binding Hardening

**Branch**: `021-collab-binding-hardening` | **Date**: 2026-07-19 | **Spec**: `specs/021-collab-binding-hardening/spec.md`

**Input**: Feature specification from `/specs/021-collab-binding-hardening/spec.md`, the
clarifications ledger (RBD-1..6 + DR-1..3), and design ground truth
`design/collaboration-core.md` — the two 021 amendments (bcf3edc) **and** the
**Addition (Sam, 2026-07-18) — 021 refined by upstream research** (234858d). The Addition
postdates the spec and is folded in as design-ratified (ledger DR-1): skipped-node
protection, createAndFill-before-skip, 3.0.7 baseline bump, enableContentCheck quarantine,
upstream filing as owed follow-up. Two later Sam additions are ledgered as DR-2 (runtime
kill-switch) and DR-3 (skip-event server-side observability).

## Summary

A watching viewer's browser must never destroy remote content. Three parts:

1. **Binding fix (client)** — patch `@tiptap/y-tiptap` (bumped 3.0.1 → 3.0.7 first, then
   patch-package on that baseline) so the Yjs→view render direction is read-only with
   respect to the shared doc: render failures attempt `createAndFill`, then log-and-skip
   with **tracked-skip exclusion** protecting skipped nodes from the PM→Y diff's front
   door; selection restore is exception-guarded with a clamped near-fallback; the PM→Y
   write-back is gated on `tr.docChanged`; detected divergence re-renders FROM Yjs. All
   four behaviors sit behind a single runtime kill-switch (default ON, app_settings
   delivered) and skip events are reported server-side via a minimal authenticated beacon.
   A second, fork-free defense layer (TipTap `enableContentCheck` + disable-collaboration
   quarantine) covers whole-doc schema mismatch. FR-008's drift guard: patch-package
   `--error-on-fail` + a sentinel/version guard test.
2. **Server guardrail (detection, never prevention)** — async, best-effort evaluation after
   persistence: a human-attributed update whose Yjs delete set intersects item ranges
   inserted by agent-attributed rows younger than ~10 s raises a rate-limited
   exception-notifier alert carrying doc, human, agent, and clock range.
3. **Read gap tolerance (persistence)** — `getYDoc` selects clocks, detects
   non-contiguity in the fetched rows, retries ≤2 times (~100/~300 ms, env-tunable), then
   serves as-is with an observable log line.

Technical decisions and their verification (including the 3.0.1→3.0.7 per-function diff)
are in `research.md` R1–R9.

## Technical Context

**Language/Version**: Node.js 22 (CommonJS server), React 18 + vite ESM client

**Primary Dependencies**: `@tiptap/y-tiptap` 3.0.7 (bumped + patched via patch-package),
`@tiptap/extension-collaboration` 3.15 / `@tiptap/core` 3.15 (`enableContentCheck`
verified available), `yjs` 13.6 (server: `Y.decodeUpdate` verified available),
y-websocket, Express, pg

**Storage**: PostgreSQL — read-only use of existing `yjs_updates`
(`doc_guid, clock, update_data, user_id, agent_name, on_behalf_of, created_at`) and one new
key in the existing `app_settings` table. **No migrations** (verified: both tables exist).

**Testing**: client vitest + jsdom (headless binding harness — research R8; existing
`Editor.test.jsx` mocks TipTap and stays untouched); backend jest, serial-only against the
shared test DB (constitution II)

**Target Platform**: existing web app (browser client + Node server), hardened k3s cluster

**Project Type**: web application (client/ + server/)

**Performance Goals**: zero added latency on the update store/broadcast path (guardrail is
post-persist async); gap-free `getYDoc` adds only one integer-compare pass; gapped reads
bounded at ≈500 ms added latency

**Constraints**: NO file overlap with in-flight 018 (server/search/**, search.js,
search-indexer.js, api/chat-models.js, mcp/yjs/serialization.js) or 019 (server/mcp/**,
client/public/agents.md) — verified against their tasks.md file lists; this feature's server
touches (`server/index.js` wiring, `server/postgres-persistence.js`, new
`server/collab-guardrail.js`, `server/api/admin.js`, `server/api/app-settings.js`) and all
client editor files are disjoint from both. No schema migrations. Kill-switch and quarantine
must be independent; guardrail active regardless of kill-switch state.

**Scale/Scope**: one patched dependency (4 sites + 2 support mechanisms), 2 small new
endpoints, 1 new server module, 1 modified persistence method; ~11 new test files.

## Constitution Check

*GATE: evaluated against constitution v1.1.1 before Phase 0; re-evaluated after Phase 1.*

- **I — Documentation Reflects Reality**: PASS with obligation — README (collaboration
  section) must gain the binding-patch/kill-switch/guardrail behavior notes in the same
  effort; task included (Polish phase).
- **II — Test-Backed Changes**: PASS — tests-first tasks for every behavior; backend suites
  serial; no format/serialization change, so the round-trip registry suite is unaffected
  (SC-006 task runs the existing collab suites unmodified).
- **III — Trunk-Based Solo Workflow**: PASS — pipeline worktree + serial merge queue per
  `/the-pipeline`; no new ceremony beyond the constituted pipeline.
- **IV — Collaboration-Safe Document Operations**: PASS — this feature *enforces* the
  principle (render paths become read-only w.r.t. the CRDT; provenance stops lying). The
  patch's tracked-skip design explicitly avoids delete-and-recreate of shared content.
  Placeholder alternative rejected partly on IV's single-registry rule (research R2).
- **V — Secure by Default**: PASS with obligations — two new endpoints state their trust
  boundary: `GET /api/client-config` (requireAuth, static shape) and
  `POST /api/collab/render-skip-report` (requireAuth, ≤8 KB body, shape-validated,
  content-free fields only, rate-limited). Skip-report payloads carry node type names and
  error class names, never document content. Contract:
  `contracts/runtime-config-and-skip-report.md`.
- **VI — Design Docs Are Ground Truth**: PASS — the Addition (234858d) is folded in as
  design-ratified; deltas beyond the amendments are ledgered (DR-1 Addition fold-in, DR-2
  kill-switch, DR-3 skip observability) in `clarifications-needed.md`; nothing resolved
  silently. Upstream filing recorded as owed follow-up (Promotion Notes below), matching
  the Addition's refinement (5).

**Post-Phase-1 re-check**: no violations introduced; no Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/021-collab-binding-hardening/
├── spec.md
├── clarifications-needed.md     # RBD-1..6 + DR-1..3 (ledger)
├── plan.md                      # this file
├── research.md                  # R1–R9 (incl. 3.0.1→3.0.7 diff verification)
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── binding-patch.md
│   ├── guardrail-alert.md
│   ├── gap-read.md
│   └── runtime-config-and-skip-report.md
└── tasks.md                     # /speckit-tasks output
```

### Source Code (repository root)

```text
client/
├── package.json                         # + @tiptap/y-tiptap 3.0.7 exact pin, patch-package,
│                                        #   "postinstall": "patch-package --error-on-fail"
├── patches/
│   └── @tiptap+y-tiptap+3.0.7.patch     # the four-site patch (committed)
├── src/
│   ├── components/Editor.jsx            # enableContentCheck/onContentError quarantine wiring
│   ├── components/EditorView.jsx        # quarantine refresh banner
│   ├── hooks/useClientConfig.js         # NEW: fetch /api/client-config → kill-switch global
│   ├── utils/skipReporter.js            # NEW: debounced batched skip-event beacon
│   ├── test/bindingHarness.js           # NEW: headless two-doc binding harness (R8)
│   └── __tests__/
│       ├── binding-patch-guard.test.js          # NEW: FR-008 drift guard
│       ├── binding-render-failure.test.js       # NEW: US1 repros (catch paths, front door)
│       ├── binding-selection-writeback.test.js  # NEW: US1 repros (selection, docChanged gate)
│       ├── binding-killswitch.test.js           # NEW: flag-off stock-behavior repro
│       ├── skip-reporter.test.js                # NEW: exactly-one-report test
│       └── editor-quarantine.test.jsx           # NEW: contentError → quarantine
server/
├── index.js                     # guardrail hook in bindState listener; 2 new routes
├── collab-guardrail.js          # NEW: delete-set × fresh-agent-content evaluation
├── postgres-persistence.js      # getYDoc gap detect + bounded retry
├── api/admin.js                 # GET/PUT settings/collab-binding-hardening
├── api/app-settings.js          # collab_binding_hardening key accessors
└── __tests__/
    ├── collab-guardrail.test.js         # NEW: US2 signature/silence/suppression
    └── postgres-gap-read.test.js        # NEW: US3 gap retry/serve-as-is
```

**Structure Decision**: existing two-package web layout (`client/` + `server/`); no new
packages. The binding patch lives as a committed patch file, not a source fork (research R3).

## Architecture Decisions (summary — details in research.md and contracts/)

| # | Decision | Where |
|---|----------|-------|
| A1 | Baseline bump to y-tiptap **3.0.7** first; patched functions verified byte-identical 3.0.1→3.0.7 except `_typeChanged`/`restoreRelativeSelection` (upstream-hardened; guard rebased onto 3.0.7 bodies) | R1 |
| A2 | Skipped-node protection = **tracked-skip exclusion** in `updateYFragment` (placeholder rejected: mapping-clear turns placeholders into Y-content corruption via the diff's replace branch; schema-registry drift) | R2, contracts/binding-patch.md |
| A3 | `createAndFill` attempted before skipping; successful stand-ins are still diff-excluded pairs | R2 |
| A4 | Patch mechanism = **patch-package** (`--error-on-fail` postinstall) + sentinel/version guard test; survives `npm ci` in CI/worktrees | R3 |
| A5 | Kill-switch = `app_settings.collab_binding_hardening` → `GET /api/client-config` → live-read global, default ON, atomic all-four revert; guardrail & quarantine independent | R4, DR-2 |
| A6 | Quarantine = `enableContentCheck` + `disableCollaboration()` + `setEditable(false)` + refresh banner | R5 |
| A7 | Guardrail = post-persist async `Y.decodeUpdate` delete-set × fresh agent-row insert-range intersection; (doc,user)-keyed 5-min suppression; never touches the write path | R6, contracts/guardrail-alert.md |
| A8 | Gap read = clock-contiguity single pass + ≤2 full re-fetches (100/300 ms) + serve-as-is + log | R7, contracts/gap-read.md |
| A9 | Client repros = headless binding harness (real ySyncPlugin + EditorView in jsdom, app schema); selection-throw injected via a deliberate patch seam | R8 |
| A10 | Skip observability = minimal authed beacon → structured log + OTel counter on the 014 spine (no client o11y channel exists — verified) | R9, DR-3 |

## Phases

- **Phase 0 (research)** — complete: `research.md`.
- **Phase 1 (design & contracts)** — complete: `data-model.md`, `contracts/*`,
  `quickstart.md`.
- **Phase 2 (tasks)** — `/speckit-tasks` → `tasks.md` (tests-first; incident repros as
  named tests).

## Dependencies & Sequencing

- US1 (client) is independent of US2/US3 (server); US2 and US3 touch different server files
  and are mutually independent. Setup (baseline bump + patch scaffolding) blocks US1 only;
  the kill-switch server endpoint is part of US1's slice (client consumes it).
- Parallel-safe with 018/019 (file-disjoint — verified; see Technical Context).
- Feature 016 (log-derived undo) is the recovery path; not built here.

## Promotion Notes (owed follow-ups — record on merge/deploy)

- **Upstream filing (design Addition refinement 5)**: file the incident repro upstream — a
  y-tiptap issue plus comments on y-prosemirror #39/#258 — and track the upstream v2
  rewrite as the eventual exit ramp from the patch. Owed after merge; not a task in this
  feature's implementation phases.
- Kill-switch flip drill: after deploy, verify `PUT /api/admin/settings/collab-binding-hardening`
  → refresh → stock behavior, then flip back ON (quickstart §4).
