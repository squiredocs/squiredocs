# Clarifications & Decisions Ledger — 045-resupply-attribution

Decisions made without live maintainer input during parallel spec authoring
(2026-08-02). Per Constitution Principle VI, nothing here was decided silently;
each entry records the question, why it matters, the chosen default, and the
rationale. Sam may overturn any entry; overturning RBD-045-1 reopens the
feature's design contract, and overturning RBD-045-5 reopens the durability
posture.

---

## RBD-045-1 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — The design amendment is the umbrella decision

- **Question**: Is the direction for the publish-before-commit window (fix the
  attribution display; keep the durability posture) settled, or open?
- **Why it matters**: Everything in this feature hangs off that choice; the
  alternative branches (durable-before-broadcast, client ack/journal) are
  entire different features.
- **Decision**: **Settled.** The 2026-08-02 amendment to
  `design/collaboration-core.md` ("the publish-before-commit window is an
  attribution problem first (feature 045)") is the ratified design contract:
  (1) every author-displaying surface becomes via_sync-aware with forensic
  recovery and an honest synced/unknown fallback; (2) the guardrail's
  agent-content detection covers resupply; (3) the durability window stays at
  the 038 FR-018 posture as a documented accepted residual. The amendment was
  itself recorded as ratified-by-default under Sam's attribution-first
  ordering; this entry records it as this feature's umbrella decision.
- **Rationale**: Design docs are ground truth (Constitution VI). Option (e) +
  guardrail fix + documented residual is also the investigation's
  recommendation, with durable-before-broadcast preserved as the named future
  full-closure path.

## RBD-045-2 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Unmappable resupply gets its own "synced contribution" rendering, not "Unknown author"

- **Question**: When a via_sync row's true author cannot be derived, should it
  render as the existing deleted-account "Unknown author" entry (040 FR-008)
  or as a distinct synced-contribution entry?
- **Why it matters**: They state different facts. "Unknown author" means "the
  row's identity was recorded but the account is gone"; the resupply case
  means "the identity on the row is a relay channel and the real author could
  not be determined". Collapsing them would misreport deleted-account edits as
  sync artifacts and vice versa.
- **Decision**: **Distinct rendering.** Unresolvable relayed content displays
  as a dedicated synced/unknown contribution ("synced content", exact copy per
  the writing style guide at implementation time), distinguishable from real
  authors, from the relayer, and from the deleted-account Unknown author. One
  such entry per row regardless of how many origins were unresolvable
  (mirrors the fixed-key collapse pattern of 040 FR-008). Exception: when
  resolution *succeeds* but the resolved user account was deleted, the
  existing Unknown-author rule applies (the identity was determined; the
  account is gone).
- **Rationale**: Honest labels are the whole feature; a label that merges two
  different truths is a smaller lie, not the truth. The fixed-key collapse
  pattern is already established and cheap.

## RBD-045-3 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Ambiguous origin evidence means unmappable, never a guess

- **Question**: If the same embedded Yjs client identifier maps to different
  users across the document's prior directly-attributed rows (identifier
  reuse/collision), should resolution pick the most recent/most frequent
  candidate or refuse?
- **Why it matters**: Yjs client identifiers are random and not globally
  unique across sessions; a heuristic pick would occasionally display a
  confidently wrong author — the exact failure mode this feature exists to
  end.
- **Decision**: **Refuse.** Ambiguity → unresolvable → synced-contribution
  rendering. Evidence is further constrained: same document only, and only
  rows that are not themselves sync-relayed (a via_sync row is never evidence
  for another row, so relay chains cannot launder the relayer into evidence).
- **Rationale**: A displayed author must be derivable, not probable. The
  false-negative cost (an honest "synced" label) is strictly lower than the
  false-positive cost (a fabricated attribution).

## RBD-045-4 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Guardrail treats unresolved fresh via_sync rows conservatively (covered, not ignored)

- **Question**: The guardrail candidate fix must include fresh via_sync rows
  whose resolved origin is an agent. What about fresh via_sync rows whose
  origin cannot be resolved — include (risking benign alerts on human-content
  resupply deletions) or exclude (retaining a blind spot exactly in the
  lost-edit window where evidence is most likely to be missing)?
- **Why it matters**: The blind spot being fixed is precisely "agent content
  that lost its agent_name in transit". Unresolved rows are the population
  where that loss is invisible; excluding them re-creates the hole for the
  hardest cases.
- **Decision**: **Include unresolved fresh via_sync rows in the candidate set**
  (alert annotated as sync-sourced, per the existing 038 annotation). The
  guardrail is alert-only, so the cost of over-inclusion is an occasional
  benign page, bounded by the freshness window's tiny row count; the cost of
  under-inclusion is silent loss of exactly the content the watchdog exists
  to watch. Never-block posture unchanged; the direct `agent_name IS NOT
  NULL` path is preserved exactly.
- **Rationale**: For an observability net, false alarm beats blind spot. If
  page noise materializes in practice, narrowing is a one-line revisit with
  data in hand.

## RBD-045-5 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02) — FLAGGED FOR SAM'S RATIFICATION** — The publish-before-commit durability window is an ACCEPTED RESIDUAL

This is the accepted-residuals ledger entry required by FR-013. It records a
product risk posture, so it is explicitly flagged for Sam's confirmation even
though work proceeds under the pre-authorized default.

- **What remains open**: an edit broadcast to peers but not yet durably
  committed is lost from durable history if the serving instance dies
  SIGKILL-class in the window — SIGKILL/OOM/native crash (segfault core dumps
  have occurred in this deployment), drain-deadline overrun with the store
  down, or a retries-exhausted persistence drop. Healthy window width is
  milliseconds to tens of milliseconds (≈1s under store retry).
- **What already covers deploys**: the SIGTERM drain (pending-writes flush,
  20s deadline) makes rolling deploys ≈ zero-loss; terminal persistence
  failure pages the exception notifier.
- **Frequency**: order of a few events per year per busy deployment.
- **What 045 changes**: given a loss with ≥2 connected clients, mis-stamping
  the resupply was previously the majority outcome and displayed forever;
  after 045 the display is truthful (recovered author or honest synced label)
  and the guardrail is not blinded. A residual occurrence is therefore a
  bounded durability incident — content survives in clients and returns via
  resupply at a displaced clock (temporal displacement: it joins history at
  the resupply clock, and earlier-clock reconstructions lack it) — no longer
  a permanent attribution lie.
- **Posture kept**: 038 FR-018 (documentation-only closure at the persistence
  listener) stands, under the pragmatic-B2B calibration. 043 US3 pins the
  loss path as a characterization test so the residual can never silently
  widen or narrow.
- **Revisit path**: durable-before-broadcast (commit before publish) is the
  named full closure — high complexity (wrapping/forking the sync library's
  update handling), +5-20ms p50 on remote echo, and store outages would stall
  live collaboration. Revisit if hot-path latency budget or durability
  requirements change.
- **Out of scope forever-until-revisited**: changing the write/broadcast
  ordering, retry policy, or drain behavior (FR-014).
- **Sam ratifies**: [ ] confirmed / [ ] overturned (overturning promotes
  durable-before-broadcast or an alternative into its own feature).

## RBD-045-6 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Home of record for accepted residuals

- **Question**: The feature directive requires the residual "recorded in the
  accepted-residuals ledger" — but no repo-wide accepted-residuals ledger
  artifact exists (verified by search on 2026-08-02; prior residuals live in
  per-feature ledgers, e.g. 002's link-render residual, 016's RBD-9 window).
  Where does the record live?
- **Why it matters**: A record nobody can find is not a record; inventing a
  new repo-wide artifact is new ceremony (Constitution III) that shouldn't be
  created as a side effect of a spec.
- **Decision**: **This feature's ledger entry (RBD-045-5) is the record**,
  cross-referenced from the two durable anchors readers actually hit: the
  design amendment in `design/collaboration-core.md` (already states the
  posture) and the 038 FR-018 persistence-listener comment (updated by
  FR-013 to point here). If Sam wants a consolidated repo-wide residuals
  ledger, migrating existing entries is a small follow-on task, not a blocker.
- **Rationale**: Matches the established Constitution-VI convention;
  discoverability is served by the cross-references from the places the
  window is documented.

## RBD-045-7 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — 043 sequencing must be extended to include 045

- **Question**: 043's spec says it "merges last, after 041 (truth fixes) and
  042 (refactors)" — it predates 045 and does not name it, yet its US2/FR-003
  end-to-end test asserts exactly the timeline behavior 045 delivers ("the
  version timeline does not credit the relaying client"). Who fixes the
  ordering statement?
- **Why it matters**: If 043 merges before 045, its US2 suite is RED against
  main through no fault of its own, or worse, gets "fixed" by weakening the
  assertion 045 exists to satisfy.
- **Decision**: **045 merges before 043; the orchestrator extends 043's
  sequencing note to "after 041, 042, and 045".** This spec's Sequencing &
  Interlocks section makes the interlock explicit from the 045 side; 043's
  spec.md is not edited by this (parallel-safe) spec agent. Additionally:
  043 US2's tests, once merged, become the standing end-to-end regression
  guard for 045 US1/US2 — 045's own suite covers the finer resolution matrix
  (forensic mapping, ambiguity, deletion-only, guardrail).
- **Rationale**: 043 explicitly targets "settled code"; 045 changes the very
  behavior 043 asserts, so 045 is part of the settlement. The division of
  test labor avoids duplicate E2E harness work.
