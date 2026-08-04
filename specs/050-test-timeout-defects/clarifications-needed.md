# Clarifications & Decisions Ledger — 050-test-timeout-defects

Decisions made without live maintainer input during parallel spec authoring
(2026-08-04). Per Constitution Principle VI nothing here was decided silently:
each entry records the question, why it matters, the chosen default, and the
rationale. Sam may overturn any entry.

The umbrella decisions **D1-D4** in `design/test-suite-architecture.md` were
ratified at their stated defaults by Sam on 2026-08-04 (doc header) and are
**not** re-opened here. In particular D2 (perf guards stay in the default run)
bounds this train's scope.

This file also carries two **design-doc gaps** (section B), mirrored from the
spec's Flagged Gaps section.

---

## A. Ratified-by-default decisions

### RBD-050-1 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)** — Client timing fix uses fake timers, not an injectable establish window

- **Question**: Design §1.2 permits either "switch the file to fake timers, or
  make the establish window injectable so tests can shrink it." Which one?
- **Why it matters**: The injectable option requires modifying
  `client/src/contexts/AiChatContext.jsx` (the window is a module-level
  `const RECONNECT_ESTABLISH_MS = 5_000`, line 26 — verified not injectable
  today). Train A's ratified success bar is that this feature changes test
  wiring, never product code. The choice decides whether that bar holds.
- **Decision**: **Fake timers** (Vitest `vi.useFakeTimers` family), controlling
  both the establish window and the tests' own scheduled deliveries/sleeps.
  Fallback: only if implementation proves fake timers infeasible for this
  file's mix of timers, promises, and scripted streams may the injectable
  option be considered — and doing so re-opens gap G-050-1 and FR-007 rather
  than being decided silently in the implement phase.
- **Rationale**: Fake timers satisfy both halves of the design at once (the
  speedup and the no-product-code invariant) with a zero-byte product diff.
  An injection seam added for tests alone is exactly the kind of
  product-surface change this train was scoped to avoid.

### RBD-050-2 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)** — "Assertions semantically unchanged" permits additive strengthening, forbids everything else

- **Question**: The design says test semantics/assertions do not change. Does
  that forbid *adding* an assertion (e.g. that modify results carry a real
  edit range instead of `editRangePending`), which would let the suite itself
  enforce SC-002 forever?
- **Why it matters**: Read strictly, "unchanged" would leave SC-002 verified
  only by a one-off observation at merge time; read loosely, it could excuse
  rewriting what tests prove. The reviewable line needs to be explicit.
- **Decision**: Existing assertions MUST keep identical meaning, order, and
  trigger conditions — none weakened, removed, or reordered. **New assertions
  that strictly verify more** (such as asserting the absence of
  `editRangePending` in a modify result) are permitted and encouraged where
  cheap. Recorded in FR-006.
- **Rationale**: The design's intent (Verification: "the banner-persistence
  assertions unchanged", "no editRangePending in the suite") is that the tests
  keep proving what they prove while the defect stays fixed. Additive
  strengthening serves that intent; a strict no-touch reading would leave the
  headline outcome unguarded against regression.

### RBD-050-3 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)** — Sweep scope and deliverable

- **Question**: §1.1 mandates a sweep for "the other pre-016 suites … any
  suite that calls modify through the tool registry but registers only
  bindState/writeState" without defining the enumeration method or what to do
  when the sweep finds nothing.
- **Why it matters**: An undefined sweep is either skippable ("we looked, it's
  fine") or unbounded. The defect class only stays closed if the sweep is
  reproducible and its result is recorded.
- **Decision**: The sweep enumerates (a) every backend test file registering
  `setPersistence` and (b) every backend test file that executes tools through
  the registry without registering persistence, classifying each as
  per-update-attributed, snapshot-only, or not-applicable (mocked registry /
  never executes a live modify). The classification is recorded in the feature
  artifacts **even when empty**, and the sweep is re-executed at implement
  time (the spec-time result may go stale). Spec-time result, 2026-08-04:
  21 `setPersistence` suites; document-editing-workflow is the **only**
  snapshot-only one; all six other live-modify suites already attribute
  identity; all non-`setPersistence` `modify` references are mocks or
  name-strings.
- **Rationale**: This is the design's own instruction made testable (SC-007);
  recording an empty result distinguishes "verified closed" from "not looked".

### RBD-050-4 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04)** — Which numbers are gates and which are expectations

- **Question**: The design's Verification section mixes hard observations
  ("no editRangePending", "well under 1s per test", "Vitest wall under 10s")
  with machine-dependent totals ("backend 264s → roughly 175s"). Which are
  pass/fail?
- **Why it matters**: Treating the 175s total as a gate makes the feature's
  acceptance depend on machine load and on files this feature never touches
  (the other 253 suites); treating everything as an estimate makes the
  verification section toothless.
- **Decision**: Hard gates: SC-001 (per-test well under 1s; file ~13s or
  less), SC-002 (zero `editRangePending`), SC-004 (Vitest wall under 10s on
  the reference machine), SC-005 (all green), SC-006 (assertion semantics),
  SC-007 (sweep recorded). Expectation, recorded but not gating: SC-003
  (backend total ≈175s), measured on the app-dev pod for the design's trend
  table.
- **Rationale**: The gates are the quantities this feature's own changes
  control deterministically (poll cadence and removed sleeps); the suite
  total is an arithmetic consequence measured on one reference machine and
  belongs to the design doc's outcome table, not to this feature's
  acceptance.

---

## B. Design-doc gaps (flagged, not resolved ad hoc)

### G-050-1 — Tension between §1.2's injectable-window option and Train A's test-wiring-only bar

Design §1.2 offers "fake timers **or** make the establish window injectable";
the Train A success criteria say this feature never changes product code. The
injectable option cannot satisfy both (verified: `RECONNECT_ESTABLISH_MS` is a
non-injectable module const in `client/src/contexts/AiChatContext.jsx:26`).
Resolved for this train by RBD-050-1 (fake timers). If fake timers prove
infeasible, this gap must be re-opened — ideally by amending the design doc to
say which half yields — rather than silently shipping a product-code seam.

### G-050-2 — The design does not say whether "roughly 175s" is a gate

The Verification section's backend-total figure names no machine and no
tolerance. Resolved for this train by RBD-050-4 (expectation, not gate).
Suggested doc amendment when convenient: mark the totals in the Expected
Outcomes table as reference-machine expectations.

### Minor factual note (no action needed)

§1.2 describes the client sleeps as "5600ms, 6500ms plus 3200ms, 5500ms". In
the file as of 2026-08-04 the real sleeps are 5600ms, 5500ms and 3200ms
(total 14.3s, matching the 14.8s file time); the 6500ms figure is a scheduled
stream-delivery timer inside the late-reply test's patched transport, not a
sleep. Substantively the design's claim holds; recorded here only so the next
reader is not confused by the mismatch.

---

## C. Implementer decisions (RATIFIED BY DEFAULT)

Taken at implement time on branch `050-test-timeout-defects`, 2026-08-04. Each is
recorded so a reviewer can overturn it rather than discover it. None changes what
any existing assertion proves.

### RBD-050-5 — SC-002 is verified by the in-suite assertions, not by the log grep

- **Decision**: treat the 20 added `expect(<result>.editRangePending).toBeUndefined()`
  assertions as the SC-002 evidence, and disregard `grep -c editRangePending` on the
  Jest log.
- **Why forced**: the grep gate proposed in quickstart.md and T012 expects `> 0`
  before and `0` after, but it reads **`0` in both** — `editRangePending` is a field
  on the returned result object and is never printed to stdout, so the grep never
  had anything to match. It does not discriminate.
- **What was done instead**: the in-suite assertions were proven non-vacuous by
  temporarily neutralizing the per-update listener (simulating pre-016 wiring) and
  confirming `modify: append text to existing paragraph` then FAILS at the
  `editRangePending` assertion and takes 5084 ms again. The temporary edit was
  reverted immediately and appears in no commit.
- **Reviewer's remedy if overturned**: none available — the grep cannot be made to
  work without printing the flag, which would be a change to product logging.
  quickstart.md's grep line is worth correcting in a later train.

### RBD-050-6 — Guards added to the deliberately-failing modifies too

- **Decision**: attach the additive `editRangePending` guard to the `badResult`
  modifies in the Mermaid and SVG error tests, not only to the succeeding ones.
- **Why**: T013 says "for every `modify` result the suite captures". These two guards
  are vacuous (a script-error modify never enters the durability wait) but strictly
  additive and true.
- **Reviewer's remedy if overturned**: delete those two lines; nothing else depends
  on them.

### RBD-050-7 — The two unbound setup modifies are bound as `setupResult`

- **Decision**: the setup modifies in `undo should succeed` and `redo should succeed`
  were `await executeScript.handler(...)` with no assignment; they are now
  `const setupResult = await executeScript.handler(...)` so the guard can be attached.
- **Why**: T013 explicitly directs binding the result rather than restructuring the
  surrounding assertions. `setupResult` avoids colliding with the `result` each test
  already uses for its undo/redo call.
- **Reviewer's remedy if overturned**: revert to the bare `await` and drop the two
  guards.

### RBD-050-8 — `vi.useRealTimers()` in `afterEach` is unconditional

- **Decision**: `afterEach` calls `vi.useRealTimers()` on every test, not only the two
  that install a fake clock.
- **Why**: plan B2. A test that fails mid-way under a fake clock would otherwise leak
  it into the next test, turning one failure into a cascade. Unconditional restore is
  a no-op when timers are already real.
- **Reviewer's remedy if overturned**: none needed; it has no observable effect on the
  eight real-timer tests.

### RBD-050-9 — Per-test timeout annotations dropped in the client file only

- **Decision**: the obsolete `10000` and `20000` per-test timeouts on the two client
  recovery tests were dropped (plan B3/B4 permit it). The backend file's `10000` /
  `30000` annotations were LEFT ALONE (plan A6 prefers the smaller diff).
- **Why**: the client annotations existed solely to accommodate the real sleeps being
  removed and are actively misleading now; the backend annotations are merely generous.
- **Reviewer's remedy if overturned**: restore the two client annotations — they are
  harmless either way.
