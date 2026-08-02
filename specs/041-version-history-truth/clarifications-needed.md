# Clarifications & Decisions Ledger — 041-version-history-truth

Decisions made without live maintainer input during parallel spec authoring
(2026-08-02). Per Constitution Principle VI, nothing here was decided silently;
each entry records the question, why it matters, the chosen default, and the
rationale. Sam may overturn any entry; overturning RBD-041-1..3 requires
re-opening the corresponding FR.

---

## RBD-041-1 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Bind behavior on document load failure (FR-010, report B2)

- **Question**: When the collaboration bind's document load fails with a real
  error (DB outage), should the server (a) refuse/fail the bind so clients
  retry, or (b) bind a read-only/degraded doc, or (c) keep current behavior
  (bind empty doc as "NEW DOC")?
- **Why it matters**: Current behavior serves a blank document over an outage;
  a client holding local state then re-supplies the whole document as new
  clocks under its own attribution — both an attribution lie and apparent data
  loss. This is the single most dangerous failure-path dishonesty in the report.
- **Decision**: **Fail closed — refuse the bind so clients retry. Never bind an
  empty doc over a load failure.** Report to the exception notifier; the
  legitimate no-rows new-document path is unchanged.
- **Rationale**: A refused bind is a transient, visible, retryable failure; a
  blank-doc bind is a silent corruption vector. Matches the fail-closed posture
  restore and undo already adopted (023 D-2). Pre-made in the feature scope
  directive.

## RBD-041-2 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Restore vs. concurrent live edits (FR-011, report B3)

- **Question**: Restore currently builds its delta from a Postgres read, so
  edits landing between that read and the store/broadcast interleave invisibly
  with the "restore" row. Options: (a) build the delta from the live doc state
  inside a transaction when the doc is loaded here, (b) full cross-pod
  serialization of restore against all writes, (c) accept as-is.
- **Why it matters**: The stored restore row is labeled "restore to version X"
  but can encode a different transition; merged-not-lost, yet the record lies.
- **Decision**: **When the doc is loaded in memory, build the restore delta
  from the live doc state inside a transaction (plus RBD-implied B7/FR-012
  tail-completeness on the target read). Full cross-pod serialization is OUT of
  scope; record it as a residual limitation where the guarantee is documented.**
- **Rationale**: The in-memory transaction closes the common single-instance
  window at low cost; cross-pod serialization needs a distributed doc-level
  lock design that belongs in its own feature if ever justified. Pre-made in
  the feature scope directive.

## RBD-041-3 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Truthful "Reverted" stamp (FR-015, report A3, NARROW)

- **Question**: The chat "Reverted" stamp trusts the client-supplied card
  reference (toolCallId); cross-chat undo (shared chat-assistant identity) or a
  direct POST can stamp a card whose edit was not the one undone. Options:
  (a) verify the card's recorded edit range matches the undone record and skip
  the stamp on mismatch, (b) scope undo per chat, (c) revive 040's offer-guard
  machinery, (d) accept as-is.
- **Why it matters**: A card saying "Reverted" about a different edit is a
  user-facing attribution lie; document data is unaffected.
- **Decision**: **Verify the card's recorded editRange matches the undone
  record; skip the stamp (and log) on mismatch — including cards with no
  recorded range.** Explicitly OUT of scope: anything cut by 040 D19 (no
  restore-undo, no offer guards) per design/collaboration-core.md's 2026-08-02
  amendment; per-chat undo scoping is a product-behavior change not taken here.
- **Rationale**: Cheapest change that makes the stamp truthful without
  altering undo semantics or reviving cut machinery. Pre-made in the feature
  scope directive.

---

## RBD-041-4 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — A7 folded into A1's fix (FR-003)

- **Question**: Report A7 (a named version whose `clock_end` row was
  noise-classified matches no auto version → authorless, fallback timestamp)
  was left to the spec author: include or defer?
- **Why it matters**: Same user-visible symptom class as A1 (wrong/empty
  authors on a named version).
- **Decision**: **Include, folded into FR-001/FR-003.** Computing named-version
  authors and timestamp from the named range's own rows (the A1 fix) removes
  the dependence on finding a matching auto version entirely, so A7 is cured by
  the same change; specifying it separately would invite a second, divergent
  lookup path.
- **Rationale**: Near-zero marginal cost; deferring it would leave a known
  empty-authors case inside code this feature is already rewriting.

## RBD-041-5 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — FR-016 allows guard OR load-bearing comment (report B9)

- **Question**: Add the `viaSync` channel guard to computeInverse's
  spanning-range fallback, or document the invariant?
- **Why it matters**: The fallback is currently unreachable with sync rows only
  by timing; silence invites a regression.
- **Decision**: **Either is acceptable; prefer the guard** (it is cheap and
  makes the invariant enforced rather than asserted). The comment alternative
  is retained so the implementer can choose it if the guard provably changes
  behavior for legacy rows.
- **Rationale**: The spec's goal is that the invariant stops being held
  together by unstated timing; both forms achieve that, the guard more
  robustly.

## RBD-041-6 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — A6 (created_at monotonicity) DEFERRED

- **Question**: Version grouping trusts `created_at` wall-clock monotonicity
  across pods; clock skew can shift version boundaries. Include or defer?
- **Why it matters**: Boundaries can be wrong under skew — but never authors,
  once FR-001..003 scope authors by clock range.
- **Decision**: **Defer.** After this feature, the worst outcome of skew is a
  boundary/timestamp oddity, not an attribution error. A real fix (group by
  clock order, timestamps display-only) changes version-boundary behavior for
  every existing document and deserves its own design pass; bolting it onto a
  truth-fix feature risks silent regrouping of shipped histories.
- **Rationale**: Severity LOW in the report; the attribution half of the risk
  is eliminated by this feature's own FRs.

## RBD-041-7 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — FR-008 live-refresh mechanism left to plan

- **Question**: Should the open panel's live refresh (report B5) be a poll or a
  subscription over the still-connected collaboration provider?
- **Why it matters**: UX freshness vs. server load vs. implementation risk.
- **Decision**: **Spec constrains the outcome only** (new versions appear
  without reopening; scroll and expansions preserved; expanded rows re-fetch).
  Mechanism is a plan-phase choice.
- **Rationale**: Both mechanisms satisfy every acceptance scenario; choosing at
  spec level would be implementation detail (speckit guidance) with no product
  consequence.

## RBD-041-8 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — Stale-selection resolution rule (FR-007)

- **Question**: When a refresh removes the selected version (delete,
  resplit), what should the panel select?
- **Why it matters**: FR-007 forbids silently retaining a stale selection;
  something must happen.
- **Decision**: **Re-resolve to the version in the refreshed list that now
  contains the old selection's `clockEnd` when one exists; otherwise fall back
  to the panel's existing default-selection rule (current version).** Never
  keep a stale id.
- **Rationale**: Containing-version reselection preserves the user's context
  through renames/resplits (the common case); the default rule is the existing,
  already-shipped behavior for "nothing selected".
