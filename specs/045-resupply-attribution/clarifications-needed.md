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

---

# Plan-phase additions (2026-08-02)

Entries below were decided while planning (`plan.md`, `research.md`). Same rule:
best default, nothing silent, Sam may overturn any of them.

## RBD-045-8 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Resolution is computed at READ time and memoized; NO migration

- **Question**: FR-009 requires resolution to be computed once and reused, and
  explicitly leaves the mechanism to the plan: persist the result (a schema
  migration), cache it, or memoize it lazily.
- **Why it matters**: it decides whether this feature takes the one in-flight
  migration slot and whether the deploy needs a backfill.
- **Decision**: **Read-time resolution with a bounded per-process memo. No
  migration, no column, no backfill.** The persisted option is rejected because
  (a) it cannot satisfy FR-008 — historical `via_sync` rows must resolve with no
  backfill, so the read path ships anyway, and two mechanisms that must agree is
  the divergence FR-007 forbids; and (b) the costly half of resolution is
  EVIDENCE (the client-identity→user bindings of prior rows), and persisting
  that retroactively means decoding every `yjs_updates` row in every document,
  not just the small `via_sync` population. A Redis cache was rejected too:
  Redis is optional here and 042 just removed a dormant Redis doc cache.
- **Rationale**: the memo buys everything the column would buy (FR-009, SC-005)
  at zero deploy risk, and outcomes are immutable — evidence is strictly prior
  in clock order over an append-only log — so the memo never needs invalidation.

## RBD-045-9 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Single-slot surfaces collapse multi-origin rows to the synced contribution

- **Question**: the per-clock author (and the MCP `lastModifiedBy`) display ONE
  author. What do they show for a `via_sync` row that resolves to several
  origins, or resolves partially?
- **Why it matters**: FR-007 requires one resolution everywhere; these surfaces
  cannot render a list.
- **Decision**: exactly one resolved origin with nothing unresolved ⇒ that
  author; anything else (multiple origins, or any unresolved part) ⇒ the synced
  contribution. The RESOLUTION is identical to the timeline's; only the
  rendering arity differs.
- **Rationale**: showing "the first resolved origin" would present a
  true-but-partial author as the whole story and let the per-clock view and the
  timeline disagree about who is credited.

## RBD-045-10 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02) — FLAGGED FOR SAM** — A no-evidence self-relay renders as "Synced content", softening one 038 promise

- **Question**: a user's genuine offline edits, re-supplied by their own client,
  carry evidence ONLY if that editing session already committed at least one
  direct row in the same document. When it did not (offline from the moment the
  document opened), the row is unresolvable. Show the stamped user anyway, or
  the honest synced label?
- **Why it matters**: 038 promises genuine offline edits stay credited to their
  author; FR-004 forbids ever displaying the stamped identity of a `via_sync`
  row as authorship. In this narrow case the two pull in opposite directions.
- **Decision**: **the honest label wins** — it renders as the synced
  contribution. The server genuinely cannot distinguish "A's own first-session
  offline edit" from "B relaying A's content"; trusting the stamp there is
  exactly the lie this feature exists to end. The SC-002 test matrix stages
  prior attributed rows for the self-relay case, matching US1 scenario 3's
  framing ("A has prior attributed edits").
- **Rationale**: false credit is worse than an honest hedge. Flagged because it
  is a visible (if narrow) softening of a shipped promise; the mitigation
  (capturing the connection's own Yjs client identity at write time) is a
  separate feature, not a side effect of this one.

## RBD-045-11 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Deleted-account resupply: Unknown author while resolvable, synced contribution once evidence is erased

- **Question**: the spec's edge case says a resupply whose original author's
  account was deleted follows the deleted-account "Unknown author" rule. But
  `yjs_updates.user_id` is `ON DELETE SET NULL`, so account deletion also erases
  the evidence rows that made the mapping possible.
- **Why it matters**: after deletion the mapping cannot be re-derived, so the
  spec's edge case is not reachable as a steady state.
- **Decision**: a resolved origin whose `users` row is gone renders
  `UNKNOWN_AUTHOR` (spec edge case honored wherever it is reachable — e.g. a
  memoized outcome, or an account deleted between the evidence write and the
  read). Once evidence is erased, later resolutions honestly yield the synced
  contribution. Both statements are true; neither invents a person.
- **Rationale**: matching the FK policy's reality beats pretending the mapping
  survived it. Recorded so the difference is not later read as a bug.

## RBD-045-12 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — `lastModifiedBy` joins FR-001's covered surfaces

- **Question**: FR-001 enumerates its covered surfaces as exhaustive, but MCP
  `read_document` also returns `lastModifiedBy`, built with the same
  `createAuthor(lastUpdate)` call on a row that may be `via_sync`.
- **Why it matters**: leaving it out would keep an agent-facing field naming the
  relayer as the last editor, which is the exact lie the feature closes, in the
  exact place (agent input) US3 argues is most dangerous.
- **Decision**: **include it.** It consumes the same resolution context as
  `recentAuthors` in the same call, under the single-slot rule (RBD-045-9). No
  new mechanism, no schema change, one extra line.
- **Rationale**: the surface list was written to bound scope, not to protect a
  fifth lying field; the cost of covering it is a line, the cost of leaving it
  is a lying feed for agents.

---

# Implementation-phase additions (2026-08-02)

Decided while implementing, under the same rule: best default, nothing silent.

## RBD-045-13 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Cache eviction is plain insertion-order (FIFO), not LRU

- **Question**: the plan specified bounded per-process caches
  (`RESUPPLY_CACHE_MAX_DOCS`, `RESUPPLY_CACHE_MAX_OUTCOMES`) but not the
  eviction policy.
- **Why it matters**: an LRU needs per-read bookkeeping on the hottest path of
  a display request; the wrong choice adds cost to the common case.
- **Decision**: **FIFO** — when a cap is exceeded, the oldest INSERTED entries
  are dropped, with no recency tracking. Documented in the module header of
  `server/resupply-resolution.js`.
- **Rationale**: an evicted outcome costs a recompute, never correctness (it is
  re-derivable from the durable log, and evidence is prior-only so it cannot
  change). Recency bookkeeping would buy a marginally better hit rate for a
  real per-read cost on every author-displaying request.

## RBD-045-14 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — MCP `lastModifiedBy` gains the 040 unknown-author fallback

- **Question**: `contracts/author-surfaces.md` defines the single-slot rule's
  non-`via_sync` branch as `createAuthor(row) || UNKNOWN_AUTHOR`. MCP
  `read_document` previously returned `null` for a row whose user was deleted
  (bare `createAuthor`), while `getContentAtClock` already returned
  `UNKNOWN_AUTHOR` there (040 FR-008).
- **Why it matters**: adopting the shared helper changes that one field's value
  for deleted-account rows from `null` to the synthetic unknown contributor.
- **Decision**: **take the contract's rule.** `lastModifiedBy` now reports
  `Unknown author` where it used to report nothing, which is what the per-clock
  view already did. The field's type is unchanged (an author object or null),
  and `null` now means only "there is no row at all".
- **Rationale**: FR-007 is about one resolution everywhere; two surfaces
  disagreeing on the deleted-account case is the same class of inconsistency,
  and 040 already settled which answer is honest.

## RBD-045-15 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Guardrail `agentUserId` is scoped to DIRECT matched rows

- **Question**: `agentUserId` is "the first non-null `user_id` among matched
  rows". With the candidate set widened, a matched sync candidate's `user_id`
  is the RELAYER's, not an agent's.
- **Why it matters**: leaving the field's derivation untouched would silently
  present a relayer as the agent's user on the new alert type — a smaller
  version of the exact lie the feature closes.
- **Decision**: `agentUserId` is computed from matched rows that carry an
  `agent_name` (so every alert that fires today is byte-identical), and a
  matched sync candidate's stamped user is reported as the additive
  `relayedByUserId`. When only sync candidates matched, `agentUserId` is null
  and `relayedByUserId` carries the relayer.
- **Rationale**: FR-012 requires the existing payload to be preserved exactly
  and permits additive fields; naming the relayer as such is the honest option.

## N-045-1 — NOTE (no decision required) — Pre-038 unmarked resupplies are evidence-eligible

Rows written before the `via_sync` marker existed carry `NULL`, and the 038
contract forbids treating `NULL` as suspicious, so a pre-038 resupply row can
bind a client identity to the RELAYER. Where that is the only binding for the
identity, a later resupply can resolve to the wrong user. It is bounded (it
requires the true author to have no correctly attributed row for that session in
the same document) and strictly better than today's unconditional relayer
credit. No fix in this feature; recorded so nobody re-derives it as a surprise.


## N-045-2 — NOTE (no decision required) — The shared server doc never binds an identity

Added by the 045 post-merge adversarial review (HIGH-1), 2026-08-03.

**The claim that was wrong.** Research R12 concluded that content created on the
server's shared `WSSharedDoc` "typically maps to several users and is AMBIGUOUS",
so it would refuse itself with no code. It only refuses once a SECOND identity has
committed a direct row for that client identity BEFORE the relayed row. Until
then the shared identity has exactly one binding and resolution credits it with
full confidence: doc loaded, user X's assistant edit commits and binds the shared
identity, user Y's assistant edit is broadcast and lost in a crash, any browser
resupplies it — and every surface names X as the author of Y's words. Systematic,
not a birthday accident, and the exact failure this feature exists to prevent.

**The rule now implemented.** A client identity KNOWN to be a shared server doc's
is poisoned: it never binds an author, never resolves, and always renders the
honest "Synced content" entry. Three read-side sources, deliberately all read-side
so no write path imports a display-only module:

1. the live shared doc, when this instance has the document loaded
   (`resupplyResolution.init({ peekSharedDoc })`, wired in `server/index.js`);
2. any evidence row stamped with an identity that ONLY ever writes through the
   shared doc — today the chat assistant (`CHAT_AGENT_NAME`), which has no Y.Doc
   of its own. This is the RETROACTIVE source: the stamp is durable, so rows
   written long before this rule existed are covered by their own recorded
   identity, with no migration and no backfill;
3. the pre-existing 2+ identity ambiguity, unchanged.

**Residual.** A server-side write under a PLAIN user identity (title set, document
seed, restore, REST/MCP import) made by a pod that has since died leaves a
single-identity binding that the durable log cannot distinguish from the
legitimate case: a genuine offline edit whose author's own prior rows bind their
own client identity has a byte-identical shape. Over-refusing everything of that
shape would delete the feature. The real fix is to give server-side write paths
per-identity docs the way MCP agent sessions already have them (research R12) —
a feature of its own, not a review fix. Recorded so nobody re-derives it as a
surprise.
