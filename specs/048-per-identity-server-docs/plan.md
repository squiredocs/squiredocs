# Implementation Plan: Per-Identity Server Docs

**Branch**: `048-per-identity-server-docs` (parallel-pipeline feature; work happens per pipeline overrides) | **Date**: 2026-08-03 | **Spec**: specs/048-per-identity-server-docs/spec.md

**Input**: Feature specification from `/specs/048-per-identity-server-docs/spec.md`

**Planned against**: `main` @ 8cf10937 — includes the merged 041–047 train (resolver, live-doc trust, `_bindComplete`, bind-failure handling, publish/capture machinery). Design ground truth: `design/collaboration-core.md`, section "Per-identity server docs" (committed 6db8b761); constitution v1.2.0 (Principle VII) @ 8296e488.

## Summary

The shared server `WSSharedDoc` stops authoring content operations. The six
write paths still transacting on it converge on ONE mechanism inside
`documentService.updateDocument`: a fresh ephemeral `Y.Doc` (random one-shot
clientID) seeded from the shared doc's current state, transacted on once,
destroyed after its bytes are captured, merged back into the shared doc with
the same `{ userId, agentName }` origin object. Restore unifies onto the same
shape (ephemeral doc from the best trusted state, store-then-apply,
`applyLiveUpdate` as the single broadcast call), deleting the live-path
capture machinery. After cutover every Yjs clientID in the durable log maps to
exactly one (user, agent) identity by construction, the resolver's answers are
identical on every pod, and the invariant is pinned by Jest guards plus the
retained live-peek tripwire. Five of the six paths already route through
`updateDocument` (research R1), so the code-touch surface is small; the test
surface is where the work is.

### LOUD FLAG 1 — the plan adds a bind-readiness gate the spec's edge-case text said it wouldn't (orchestrator-verified finding, RBD-048-4)

The spec's original "Half-loaded document" edge case ("No new guard is
introduced") restated a design silence that the adversarial review FALSIFIED:
`updateDocument` on a cold doc transacts on a half-loaded shared doc (title
set lost 98/200 trials against the repo's own yjs; an "append" lands before
the whole document), and seeding an ephemeral doc from that empty state
inherits the bug verbatim. The plan therefore gates `updateDocument`'s seed on
bind completion: an awaitable `_bindComplete`-based `waitForDocReady` owned by
`document-service`, consolidating the three divergent half-loaded predicates
(`_bindComplete`, `waitForDocLoaded`'s state-vector poll, and nothing) onto
one owner, plus the missing test class. Recorded as **RBD-048-4
(RATIFIED-BY-DEFAULT)** — a design SILENCE resolved in the only reading
consistent with the design's own correctness claims, not a design
contradiction. The spec's edge case and FR set were amended in the same
change (FR-013). See research R4/R5.

### LOUD FLAG 2 — NO MIGRATION. 048 is code-only.

No schema change, no backfill, no rewriting of pre-cutover rows (spec
"Pre-cutover rows" edge case; the stamp discriminator that WOULD need a
migration is explicitly out of scope, RBD-048-1). The migration slot stays
free. (For the record: had one been needed, the floor is > 1795000000000.)

### LOUD FLAG 3 — this feature is a precondition for scale-out, not the green light (FR-012)

M3 (Redis subscription bound to a dead evicted doc) and M4 (cross-pod
reconnect awareness blackout) remain open scale-out gates; the one-replica
deploy constraint stands after this merges. Nothing in this plan may be
described as enabling multi-replica operation.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS backend); no client changes
(browser/agent-session edit paths are explicitly untouched).

**Primary Dependencies**: `yjs` 13.6.30 (`Y.Doc`, `Y.applyUpdate`,
`Y.encodeStateAsUpdate`, `Y.parseUpdateMeta` — the same empirically verified
surface 045 uses), y-websocket (unmodified), Express. **No new dependency.**

**Storage**: PostgreSQL `yjs_updates` — written through the EXISTING
persistence listener only; **no schema change** (see Loud Flag 2).

**Testing**: Jest, serial, shared DB (`server/__tests__/`,
`__tests__/integration/`). **Do not run backend suites during plan/analyze —
a suite run is in progress on the shared test DB**; implementers use the
standard serial discipline.

**Target Platform**: Linux server (k3s pods).

**Project Type**: Web application backend (server-only feature).

**Performance Goals**: warm-doc writes pay one flag check extra (the gate's
fast path); cold-doc writes pay the load they previously raced. O(doc size)
seed per operation and one state-vector entry per operation are accepted by
the ratified design; no benchmark gate (research R12).

**Constraints**: the design section wins over spec and priors (Principle VI);
seed→transact→merge must stay synchronous with no awaits between them
(FR-001); attribution/persistence/fan-out byte-behavior preserved (FR-005);
sentinel-origin paths (db-load, redis, restore, inverse, sync-push) untouched;
`server/resupply-resolution.js` contains non-UTF8 bytes — edit surgically,
search with `grep -a` (research R10).

**Scale/Scope**: 13 FRs across 3 user stories; ~4 server files materially
changed (`document-service.js`, `version-history.js`, `api/docs-import.js`,
comment-only `resupply-resolution.js`), 1 new guard-suite file, ~6 existing
test files touched, ledger + spec amendments already landed with this plan.

## Constitution Check

*GATE: evaluated against constitution v1.2.0 before Phase 0; re-checked after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| I. Documentation Reflects Reality | Behavior-changing work updates README/docs in the same effort | **PASS with handoff**: pipeline overrides forbid this agent editing `README.md`/`docs/dev.md`/`design/`. Restore's ordering flip (store-then-apply) and the per-operation authorship mechanism are README-relevant wherever it describes server-side writes or restore; the merge queue MUST sweep those sections (see "Merge-queue notes"). In-code documentation (FR-011) is IN scope and planned (research R10). |
| II. Test-Backed Changes | Every behavioral change ships tests; backend serial | **PASS**: the guard suite is itself a deliverable (FR-007), the orchestrator-mandated half-loaded test class is planned (research R5), restore/undo/presence regressions map to named suites (quickstart matrix). No format/serialization change → no round-trip registry work. Serial-only discipline restated. |
| III. Trunk-Based Solo Workflow | No process for its own sake | **PASS**: no new infrastructure; one new test file; the mechanism REPLACES machinery (restore live-path capture deleted). |
| IV. Collaboration-Safe Document Operations | Targeted Yjs ops; registry; provenance invariant | **PASS, and this is the principle the feature serves**: `updateFn` bodies are unchanged (same targeted ops, now on a seeded ephemeral doc); the merge-back is a plain CRDT apply that cannot conflict (fresh clientID); restore keeps its shipped `replaceFragmentContents` semantic (DEC-9 recorded in 042). No format-registry surface is touched. Provenance moves from "one clientID, many identities" to "every clientID binds one identity by construction". |
| V. Secure by Default | Untrusted content inert; auth/ACL enforced | **PASS**: no new endpoint, no new ingestion surface, no sandbox change. The gate can only REFUSE writes that previously raced; error surfaces keep their existing status mapping. |
| VI. Design Docs Are Ground Truth | design/ wins; gaps go to the ledger; falsified records amended | **PASS**: the plan implements the ratified section verbatim; its one silence (load completion before seeding) is resolved as RBD-048-4 RATIFIED-BY-DEFAULT with the rationale recorded — the loaded-state reading is the only one consistent with the design's own correctness claims. FR-011's falsified in-code claims are corrected in the same effort (research R10). Design files are NOT hand-edited; the design amendment itself (if Sam wants the silence closed in the doc) is flagged for the Squire-side flow in the ledger entry. |
| VII. Horizontally Scalable App Pods | Correctness independent of replica count; process-local memory is cache only | **PASS — the feature's raison d'être**: post-cutover rows resolve identically on every pod with zero shared in-memory state (SC-001); the retained live-peek knowledge is demoted to defense-in-depth tripwire (fail-honest, RBD-048-3), which is exactly the "cache whose loss degrades honestly" posture Principle VII permits. FR-012 keeps the one-replica constraint honest: M3/M4 remain recorded deploy-gating items, not accepted residuals. |

**Post-Phase-1 re-check**: **PASS** — the design artifacts add no migration,
no dependency, no new endpoint, no registry bypass; Complexity Tracking is
empty (no violations to justify).

## Project Structure

### Documentation (this feature)

```text
specs/048-per-identity-server-docs/
├── spec.md                        # input (amended: FR-013 + half-loaded edge case, per RBD-048-4)
├── clarifications-needed.md       # RBD-048-1..3 (input) + RBD-048-4 (added by this plan)
├── plan.md                        # This file
├── research.md                    # Phase 0: mechanism decisions R1–R12
├── data-model.md                  # Phase 1: entities & doc-lifecycle states (no schema)
├── quickstart.md                  # Phase 1: validation guide + FR/SC → test matrix
├── checklists/requirements.md     # from /speckit-specify
├── contracts/
│   ├── document-service.md        # updateDocument's new internal contract + waitForDocReady
│   ├── restore-unification.md     # restoreVersion's unified path, ordering, broadcast
│   └── invariant-guards.md        # what the guard suite pins, and how
└── tasks.md                       # Phase 2 (/speckit-tasks — not created by plan)
```

### Source Code (repository root)

```text
server/
├── document-service.js            # THE implementation point: waitForDocReady gate (NEW export)
│                                  # + ephemeral per-operation mechanism inside updateDocument;
│                                  # createSeededDocument/call sites UNCHANGED
├── version-history.js             # restoreVersion unified (ephemeral seed, store-then-apply,
│                                  # single applyLiveUpdate); live-path capture machinery DELETED;
│                                  # residuals comment corrected (FR-011)
├── api/docs-import.js             # waitForDocLoaded DELETED → documentService.waitForDocReady
├── resupply-resolution.js         # COMMENTS ONLY: corrected shared-doc account (FR-011);
│                                  # code untouched (FR-008 — nothing deleted at cutover)
├── collab-bind-state.js           # UNTOUCHED (the gate consumes _bindComplete; no binder change)
├── live-doc-trust.js              # UNTOUCHED (read-to-store trust stays a distinct predicate)
├── undo/inverse.js                # UNTOUCHED (pinning test only)
├── markdown-sync.js               # UNTOUCHED (pinned-clientID exception; pinning test only)
└── __tests__/
    ├── per-operation-doc.test.js  # NEW — invariant guards + gate + half-loaded test class
    ├── document-service-capture.test.js   # fakes marked _bindComplete; contract preserved
    ├── document-titles.test.js            # ditto
    ├── live-fanout.test.js                # ditto
    ├── import-presence.test.js            # ditto
    └── resupply-resolution.test.js        # + three-sources-still-wired assertion

__tests__/integration/             # restore ordering/one-row assertions; undoability of
                                   # import + title set through the new mechanism (FR-009)
```

**Structure Decision**: existing web-app layout; server-only feature. No new
modules except the one new test file — the mechanism lives inside the file
that already owns the seam.

## Implementation phases

Dependency-ordered; each phase leaves the suite green.

- **Phase A — the gate (FR-013, research R4/R5)**: add `waitForDocReady` to
  `document-service.js`; await it in `updateDocument` before any doc read;
  replace `docs-import.js`'s `waitForDocLoaded`; mark test fakes
  `_bindComplete`; land the half-loaded test class RED→GREEN. This phase is
  independently valuable (it fixes the reproduced title-loss bug even before
  the ephemeral mechanism lands) and MUST precede Phase B, because seeding
  from an ungated doc reproduces the bug the review found.
- **Phase B — the per-operation mechanism (FR-001/002/003/005/006)**: rewrite
  `updateDocument`'s core to seed→transact→merge on an ephemeral doc
  (research R2/R3); paths 1–5 converge with zero call-site changes; extend the
  guard suite (insert-set clientID, distinct consecutive clientIDs,
  updateFn-doc-is-not-shared-doc, throwing-updateFn isolation, no-change
  zero-value, capture/return contract preserved).
- **Phase C — restore unification (FR-004, research R6)**: rewrite
  `restoreVersion` to the one ephemeral path with store-then-apply and the
  single `applyLiveUpdate` broadcast; delete the live-path capture machinery;
  update the restore suites' ordering expectations; add the
  restore-emits-fresh-clientID guard.
- **Phase D — pins and the record (FR-007/008/009/011, research R7–R11)**:
  undo-inverse and sync-push pinning tests; resolver three-sources wiring
  assertion; undoability regression (import + title set); FR-011 comment
  corrections in `resupply-resolution.js`, `version-history.js`,
  `document-service.js`.

## Key risks and how the design answers them

- **A caller depends on `updateFn` receiving the SHARED doc** (e.g. asserts
  object identity or stashes the doc). Answer: the guard suite makes the
  ephemeral-doc argument an explicit contract; the implement phase sweeps all
  `updateDocument` callers (research R1's inventory is the complete list) and
  all suites that drive it. Callers only ever mutate the passed doc — the
  inventory shows no identity-dependent caller.
- **The gate deadlocks a test that never binds.** Answer: bounded 5 s timeout
  with the established error shape; fakes set `_bindComplete = true`
  explicitly (research R4, harness note).
- **Restore's ordering flip surprises a consumer.** Answer: RBD-048-2 records
  both accepted consequences; the only observable differences are the crash
  window's half (safer) and merge-during-store-await (already the durable
  path's semantics). The suites assert one attributed row whose stored bytes
  equal the broadcast bytes in both loaded and not-loaded cases.
- **The merged bytes differ in encoding from the ephemeral capture.** Answer:
  nothing compares encodings; persistence/Redis/return-value all consume the
  shared doc's own emission, exactly as today (research R3).
- **`resupply-resolution.js` is encoding-fragile.** Answer: comment-only
  surgical edits; `grep -a` for searches; no re-encode (research R10).

## Merge-queue notes

- **README sweep (Principle I handoff)**: wherever README describes
  server-side write attribution, the shared server doc, or restore's
  broadcast/store ordering, update to the per-operation-doc + store-then-apply
  account. This agent is forbidden to edit README.
- **Design-doc note**: RBD-048-4 resolves a design SILENCE; if Sam wants the
  bind-completion gate stated in the design section, that is a Squire-doc
  amendment + `node design/sync.mjs` (never a hand-edit) — recorded in the
  ledger entry, not performed here.
- **Deploy posture**: one-replica constraint unchanged (FR-012); no migration,
  so no deploy-ordering constraint.
- Backend suites are serial-only on the shared DB; a suite run was in progress
  during planning — implementers must re-verify green before merge.

## Complexity Tracking

No constitution violations to justify; table intentionally empty.
