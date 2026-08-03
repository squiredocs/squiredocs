# Analysis Report — 049 Constant-Time Server-Side Write Path

**Date**: 2026-08-03 · **Stage**: post-tasks, pre-implement
**Artifacts**: `spec.md` (committed 0660bc5c), `plan.md`, `tasks.md`, plus
`research.md`, `data-model.md`, `contracts/`, `quickstart.md`,
`clarifications-needed.md`
**Constitution**: `.specify/memory/constitution.md` v1.2.0
**Design ground truth**: `design/collaboration-core.md` → "Per-identity server
docs" + the 049 amendment + the two 2026-08-03 corrections

**Verdict: PROCEED.** No CRITICAL findings. One HIGH-adjacent factual correction
to the spec's *evidence* (F1) that does **not** stop the line — it strengthens
work already scheduled behind FR-008's own stop-the-line gate — plus seven
MEDIUMs folded into the implement brief and two LOWs.

---

## Findings

| ID | Category | Severity | Location | Summary | Recommendation |
| --- | --- | --- | --- | --- | --- |
| **F1** | Inconsistency / evidence | **MEDIUM (was assessed as HIGH; see note)** | `clarifications-needed.md` §B vs `server/resupply-resolution.js:339` | The spec's preliminary sweep asserts "no `.clientID` read on a document anywhere in `server/` outside `server/mcp/sandbox/isolate-bundle.js`". **That is false.** `learnLiveServerClient` reads `doc.clientID` off the live shared document. It was missed because `resupply-resolution.js` is NUL-bearing and a plain `grep` silently skips it — the **fourth** instance of this repo hazard. | Carried into the audit as **T005a**. Traced during analysis: every call path (`computeOutcomes` → `resolveForRows` from version-history/export, and the guardrail's strictly **post-persist** `.then()`) is unreachable inside the fully-synchronous borrow window, so the mechanism is not at risk today. The audit must record that reasoning explicitly, because if resupply resolution ever becomes reachable synchronously from the update event it would poison a **borrowed** id as a shared-doc client id and make the resolver refuse *legitimately attributed* rows. |
| **F2** | Coverage gap | MEDIUM | `spec.md` FR-003 vs `tasks.md` | FR-003 requires the *signature* to carry the mutate-phase prohibitions; no task required the JSDoc to enumerate them (subdocuments and awareness construction are contract-text only, unenforceable). | Added **T018a**. |
| **F3** | Coverage gap | MEDIUM | `spec.md` Edge Cases ("a write whose mutate phase makes no change") vs `tasks.md` | 049 introduces a **second** no-change path (a nullish compute return) that G6 did not cover. | Added **T018b**. |
| **F4** | Inconsistency (behavioral) | MEDIUM | `server/document-service.js` | Under 048 the shared document's transaction came from `Y.applyUpdate`, which yjs runs as **non-local**; under 049 it is `doc.transact`, i.e. **local**. Verified with `grep -a` that nothing in `server/` branches on `transaction.local`. It is also exactly why yjs's own client-id self-heal can never fire for our writes — which is the mechanical reason FR-007's manual re-check is required. | Added **T030a(a)**. Record in the audit. |
| **F5** | Inconsistency (behavioral) | MEDIUM | `server/import-presence.js:404` | The origin-filtered `observeDeep` now receives events produced by a **local mutation** rather than by an **applied update**. Expected to be equivalent, but FR-010 pins presence behavior as unchanged, so it must be demonstrated. | Added **T030a(b)**: run `server/__tests__/import-presence.test.js` and confirm. |
| **F6** | Ambiguity / honesty | MEDIUM | `spec.md` SC-001 / FR-013 | The persistence listener still runs `classifyByXml` (`server/update-classifier.js`), documented as O(document size) per applied update and skipped only above a 500 KB ceiling. 049 makes **`updateDocument`** constant time; the end-to-end write is not constant time for documents under that ceiling. Unchanged by this feature, but an unqualified "sub-millisecond server-side write" would oversell it. | Added **T044**: state it in `performance.md` rather than round up. |
| **F7** | Coverage gap | MEDIUM | `spec.md` FR-015 vs `tasks.md` | FR-015 is a "MUST NOT be represented as" requirement with no natural implementation task, so it had zero coverage. | Added **T045**: carry the non-claim into the merge/promotion note. |
| **F8** | Spec-internal tension | MEDIUM | `spec.md` FR-006 bullet 3 vs bullet 5 / US3 AS3 | "A cached id resumes at the correct clock after an unload/reload" cannot both hold with "cache entries MUST NOT outlive the document's presence in the process" — in y-websocket an unload destroys the `Y.Doc`. | Already reported as **PD-049-2**; the plan honors the anti-leak MUST and keeps the safety property AS3 protects. Sam may overturn. |
| **F9** | Underspecification (ratified default) | MEDIUM | `clarifications-needed.md` RBD-049-2 | The ratified state-vector detector does not detect a **delete-only** compute-phase mutation (measured against `yjs@13.6.30`). | Already reported as **PD-049-3**; the ratified detector is kept and an update-event tripwire added. Pinned by **T030 / N7**. |
| **F10** | Coverage / scope | MEDIUM | `spec.md` FR-005 vs the codebase | FR-005's inventory is the production inventory; **eight test files** also call `updateDocument` directly and break with the signature. | Already reported as **N-049-2**; covered by T020–T023. |
| **F11** | Ambiguity | LOW | `tasks.md` T039 (pre-fix) | The SC-008 result had no definite home ("sibling notes or the implementation summary"). | Fixed in place: a named heading in `performance.md`. |
| **F12** | Accuracy | LOW | `research.md` / `plan.md` / `tasks.md` (pre-fix) | Referenced `server/agent-presence.js`, which does not exist; the module is `server/mcp/agent-presence.js` (plus `server/mcp/presence-claim.js`). | Fixed in place in all three artifacts. |

**Note on F1's severity.** Assessed against the stop-the-line rule and
deliberately *not* escalated to HIGH: it corrects an evidence note that the spec
itself labels "evidence, **not** discharge", inside a requirement (FR-008) whose
own gate already halts implementation on a live reader. It changes no
requirement, no decision and no task ordering — it makes an already-scheduled
task more specific. Escalating it would halt the pipeline to tell the implementer
something the very next task already makes them do. It is nonetheless reported
prominently, because a false "we looked and found nothing" is worse than not
having looked.

## Coverage summary

| Requirement | Task(s) | Notes |
| --- | --- | --- |
| FR-001 borrow, do not copy | T008, T010 | |
| FR-002 collision check, also at reuse | T008, T009, T033 | |
| FR-003 two-phase signature | T010, T012–T017, **T018a** | T018a added by this analysis |
| FR-004 compute mutation detected | T026, T029, T030 | |
| FR-005 caller migration | T001, T012–T017 (+T020–T023 tests) | |
| FR-006 identity cache | T032, T034, T035, T036 | |
| FR-007 cached-id collision detection | T033, T034 | |
| FR-008 BLOCKING verification | T002–T007, **T005a** | gate |
| FR-009 deletions | T010 | |
| FR-010 must-not-change list | T042, T043, **T030a** | |
| FR-011 invariant pins | T018, **T018b**, T019, T028–T030, T034–T036, T038 | |
| FR-012 library caveat + loud guard | T037, T038, T040 | |
| FR-013 performance recorded | T024, T025, **T044** | |
| FR-014 correct falsified record | T011, T041 | |
| FR-015 scope boundary | **T045** | was uncovered |
| SC-001 | T024, T025, T044 | |
| SC-002 | T018 (G1), T035 (G3 one-to-one) | |
| SC-003 | T018, T019 | |
| SC-004 | T028 | |
| SC-005 | T036 | |
| SC-006 | T031, T043 | |
| SC-007 | T006 | |
| SC-008 | T038, T039 | |
| SC-009 | T034 | |

**Edge cases**: mint collision → T009; later collision → T033/T034; no-change
mutate → G6 + T018b; refused bind mid-write → H3 (unchanged, T042); teardown
mid-gate → H6 (unchanged, T042); restore → T041/T042; sync push → T042;
reentrancy → T009; subdocuments → T018a (contract text; nothing creates them
today, verified).

**Unmapped tasks**: none. Every task traces to an FR, an SC, an edge case, or a
constitution obligation.

## Constitution alignment

No violations. All seven principles PASS as recorded in `plan.md`'s Constitution
Check; the post-Phase-1 re-evaluation is unchanged. Notable: Principle VII is
satisfied *structurally* — the identity cache is process-local and its loss costs
one client id in a state vector, never a correctness answer; Principle II's
serial-DB rule is respected (the mechanism guards are hermetic, and the suite runs
`--runInBand`); Principle VI is honored by flagging D-049-A, D-049-B, E-049-A and
PD-049-1..4 rather than resolving any of them against `design/`.

## Metrics

- Requirements: 15 FR + 9 SC = **24**
- Tasks: **50** (T001–T046 with T005a, T018a, T018b, T030a)
- Requirement coverage: **100%** (was 93% before this analysis added T018a,
  T018b, T030a, T044, T045; FR-015 had zero tasks)
- CRITICAL: **0** · HIGH: **0** · MEDIUM: **10** · LOW: **2**
- Ambiguities: 2 (both fixed) · Duplications: 0

## Next actions

1. **Start at Phase 2 and honor the gate.** T003–T007 plus T005a produce
   `clientid-reader-audit.md`. A `live` reader that can execute inside the borrow
   window halts implementation.
2. Fold the MEDIUMs into the implement brief (F1, F4, F5, F6 are now tasks;
   F8, F9, F10 are recorded ledger decisions to carry forward, not to re-litigate).
3. Owed to Sam and **not** actionable by any agent: the D-049-A amendment to the
   Squire design doc (borrowing's residual equals yjs's *at draw time* and
   requires an explicit re-check at reuse time), and the manual walk in
   `quickstart.md` §7.
