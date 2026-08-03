# Specification Analysis Report — 048-per-identity-server-docs

Run: 2026-08-03, plan-stage agent, after /speckit-plan + /speckit-tasks.
Scope: spec.md (amended FR-013) × plan.md × tasks.md × contracts/ ×
design/collaboration-core.md ("Per-identity server docs") × constitution
v1.2.0. Per pipeline overrides: findings reported; only self-introduced drift
auto-fixed (three fixes, listed at the bottom); CRITICAL/HIGH stop the line.

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| I1 | Inconsistency (FIXED) | MEDIUM→resolved | tasks.md T004; contracts/document-service.md; research.md R4 | Plan artifacts said the docs-import loaded-wait was "replace-mode"; the PUT route calls it unconditionally (append AND replace, `server/api/docs-import.js:448`) and the append-mode presence baseline (line 454) reads doc state before `updateDocument` runs | Auto-fixed (self-introduced drift): T004, the contract's consumer note, and R4 now state the unconditional route-level call and why it must stay |
| I2 | Inconsistency (FIXED) | LOW→resolved | checklists/requirements.md | Checklist notes referenced only RBD-048-1..3 after the plan added RBD-048-4 + FR-013 | Auto-fixed: plan-time amendment note added; items re-validated against the amended spec |
| C1 | Coverage | MEDIUM | spec FR-003 paths 4–5; tasks T014 | The empty-import anchor and chat image insert converge via `updateDocument` (mechanism-guarded by G1/G3–G6), but no task names a per-path behavioral test for these two shapes; T014 relies on existing suites, and existing coverage of `server/api/chat-tools.js` insert_image was NOT verified at plan time | Implement brief: during T014, verify existing suites actually exercise the anchor-paragraph and insert_image call sites through the new mechanism; if absent, add one behavioral assertion each (content lands at document END, stamped (user, "Squire Docs Assistant")) |
| C2 | Coverage | MEDIUM | spec FR-010; tasks T014 | "Per-operation docs never announce" has no direct assertion; ephemeral docs have no provider by construction, so the risk is indirect (a future wrapper announcing around them) | Implement brief: cheap guard — in the new suite, assert the ephemeral doc handed to `updateFn` has no awareness/provider fields; do not build presence machinery for it |
| C3 | Coverage | MEDIUM | tasks T016 | The cross-process half of SC-001 ("two processes answer identically") is specified as "two independent resolver processes"; in-repo this must be simulated (fresh resolver state / module isolation), which the 045 scaffolding may or may not already support | Implement brief: if the scaffolding lacks a fresh-process simulation, `jest.isolateModules` (or a second resolver instance with empty memo) is the accepted stand-in; assert identical outcomes for the same rows |
| A1 | Ambiguity | MEDIUM | contracts/document-service.md step 12; spec edge case "Bind failure between seed and merge" | The gate (step 2) and the retained post-merge check (step 12) both throw `BindFailedError`; on the no-change path the post-merge check is the only one that can observe a refusal that landed after the gate. Not contradictory, but the redundancy's INTENT (two windows, one error surface) should be stated in code comments or a future reader will "simplify" one away | Implement brief: T009's comment pass must state why both checks exist (gate = before seed; post-merge = refusal between gate and merge) |
| A2 | Ambiguity | LOW | tasks T024 | "Extend ONLY if not already asserted" leaves a judgment call; acceptable (avoids duplicate pins) but the implementer must record which branch was taken | Note the outcome in the implementation report |
| T1 | Terminology | LOW | spec FR-013 ("bind-readiness gate") vs plan/contracts (`waitForDocReady`) | Same concept, two names; spec deliberately stays mechanism-light | No action — contracts bind the name |
| D1 | Duplication | LOW | plan Phase A text vs tasks Phase 2 preamble | Deliberate restatement of the gate-before-mechanism ordering rationale | None (load-bearing repetition) |

No CRITICAL findings. No HIGH findings. **The line does not stop.**

## Coverage Summary

| Requirement | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-001 mechanism | ✓ | T008 | contract steps 5–13 |
| FR-002 random clientID | ✓ | T008, T010 | G1/G3 |
| FR-003 six paths | ✓ | T001, T008, T017 | paths 1–5 zero call-site change (research R1); see C1 for paths 4–5 behavioral depth |
| FR-004 restore unification | ✓ | T017, T020, T021 | |
| FR-005 attribution/fan-out unchanged | ✓ | T008, T014 | stop-and-report rule if an assertion would weaken |
| FR-006 failure isolation | ✓ | T008, T012 | |
| FR-007 invariant pins | ✓ | T010, T011, T019, T023, T024, T026 | |
| FR-008 resolver retained | ✓ | T025, T027 | code untouched; comments corrected |
| FR-009 undo compatibility | ✓ | T015, T022 | |
| FR-010 presence unchanged | ✓ | T014 | + C2 cheap guard |
| FR-011 corrected record | ✓ | T009, T018, T027, T028 | |
| FR-012 scope boundary | ✓ | T030 | documentation/report-only by design |
| FR-013 bind-readiness gate | ✓ | T002–T007 | RBD-048-4 |
| SC-001/SC-002 | ✓ | T016 | + C3 simulation note |
| SC-003 | ✓ | T014, T015, T020, T022 | |
| SC-004 | ✓ | T026 | review-time, not committed |
| SC-005 | ✓ | T012 | |
| SC-006 | ✓ | T016 | consequence of SC-001 machinery |

Unmapped tasks: none (T001 setup, T007/T029 verification, T030 handoff).

## Constitution Alignment (v1.2.0)

No violations. II: guard suite is a deliverable; serial-only discipline
restated in tasks ground rules. IV: updateFn bodies unchanged; merge-back
cannot conflict. VI: the one design silence is ledger-recorded (RBD-048-4,
RATIFIED-BY-DEFAULT with rationale); spec amended, not silently diverged;
design files untouched. VII: the feature's purpose; live-peek demoted to
tripwire; M3/M4 remain recorded gates (FR-012). I: README handoff to the merge
queue (pipeline override forbids this agent editing it) — restated in T030.

## Metrics

- Total requirements: 13 FR + 6 SC — coverage 19/19 (100%)
- Total tasks: 30 (T001–T030)
- Findings: 0 CRITICAL, 0 HIGH, 4 MEDIUM open (C1, C2, C3, A1) + 2 fixed, 4 LOW
- Duplications: 1 (deliberate); Ambiguities: 2 (1 for implement brief)

## Verdict

**PASS.** Proceed to /speckit-implement. The four open MEDIUMs are folded into
the implement brief (C1, C2, C3, A1 above); none blocks task order or scope.

## Auto-fixes applied during analysis (self-introduced drift only)

1. T004 + contracts/document-service.md + research R4: docs-import loaded-wait
   is unconditional on the PUT route, retained at route level for the
   append-baseline read (was mislabeled "replace-mode").
2. checklists/requirements.md: plan-time amendment note (RBD-048-4/FR-013),
   items re-validated.
3. tasks.md numbering: Phase-2 checkpoint promoted to T007 (no ID gap).
