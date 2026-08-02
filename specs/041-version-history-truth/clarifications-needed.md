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

## RBD-041-9 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** — FR-017 "malformed-origin marker" is the in-memory classification, not a DB column (added at plan stage)

- **Question**: FR-017 says a null/primitive origin must "persist unattributed
  WITH a distinct malformed-origin marker". `yjs_updates` has no marker column;
  the existing malformed classes (`'non-uuid-string'`, `'unrecognized-object'`)
  carry their marker on the in-memory `parseOrigin` result only (the row itself
  is a plain unattributed row) plus log/notification. Does FR-017 require a
  persisted column?
- **Why it matters**: A persisted column means a schema migration — the feature
  scope, the pipeline sequencing note, and the spec's own assumptions all
  expect ZERO migrations, and migration slots are globally serialized across
  the 041-044 train.
- **Decision**: **The marker is the in-memory `malformedOrigin` classification
  field (new distinct value `'null-or-primitive'`), at exact parity with how
  the existing malformed classes carry theirs** — plus the error log and
  notifyException page (treated like `'non-uuid-string'`, since a null origin
  is the same caller-bug class). No schema change, no migration.
  `'unrecognized-object'`'s warn-only treatment is unchanged (outside FR-017's
  scope).
- **Rationale**: The spec's operative requirement is "never a marker-less,
  log-less unattributed row" measured against "the same notification treatment
  as the existing malformed-origin classes" — and the existing classes'
  loudness lives in the classification + log + page, not in a column no
  consumer reads. A migration would buy an unread field at real sequencing
  cost. If Sam wants a persisted marker, it is an additive follow-on column,
  not a blocker for this feature.

---

## N-041-1 — Verification note (Sam-relayed, 2026-08-02, mid-planning): A1 reproduced BIDIRECTIONALLY

Relayed from an independent investigation during planning: the A1
named-version author bug was reproduced **in both directions** — when a named
version splits an editing session, Bob's range shows Alice as an author AND
Alice's range shows Bob. The durable log is fully correct; the defect is purely
the presenter copying the parent auto-version's author/onBehalfOf metadata onto
ranges it doesn't describe (`server/version-history.js` — named-version objects
AND both split-fragment spread sites). Sam flags this as the single most direct
violation of the attribution promise, firing the moment anyone names a version.

Consequences bound into plan/tasks:
1. The A1/A7 fix (FR-001..003) is the **top-priority task cluster**.
2. tasks.md pins a **bidirectional regression test**: two users, distinct
   sub-ranges across a named-version split; each fragment credits only its own
   range's authors, and the named range likewise — asserted in BOTH directions.
3. Fix strategy: recompute authors/onBehalfOf from the rows within each range
   (`computeRangeMeta`, research R1) — never inherit from the containing
   auto-version (as FR-002 already requires).

---

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

---

# Implement-stage decisions (2026-08-02)

All RATIFIED-BY-DEFAULT under Sam's pre-authorization for this feature. None
changes a shipped product behavior beyond what the FRs already require; each is
recorded because a reviewer would otherwise have to reverse-engineer the choice.

## IMP-041-1 — Bind refusal lives in its own module (`server/bind-failure.js`)

- **Question**: plan.md's structure note said "no new modules". FR-010's refusal
  logic sits in `server/index.js`'s `bindState` catch, and `server/index.js`
  boots a live HTTP + WebSocket server on `require`, so nothing in it is
  unit-testable.
- **Decision**: extract `refuseBind(...)` into `server/bind-failure.js` (the
  option tasks.md T013 explicitly allows: "extract the load-and-bind step into a
  named function exported for tests"). `server/index.js` calls it from the
  catch; the wiring itself is pinned by source-inspection assertions in
  `server/__tests__/bindstate-failure.test.js`.
- **Rationale**: FR-010 has real behavior (page, evict, close 1013, drop
  persists) that must be provable. A one-function module with injected
  `docs`/`notify` is the smallest thing that makes it so.

## IMP-041-2 — The verified stamp lives in `server/api/chat-revert-stamp.js`

- Same reason as IMP-041-1: FR-015's comparison rule is the whole point of the
  change and could not otherwise be tested. `server/index.js` keeps a
  three-line wrapper binding `chatStore`, so the route reads the same as before.
- The route handler is replicated in `server/__tests__/undo-stamp.test.js`,
  which is this repo's established endpoint-test pattern (cf.
  `undo-status-api.test.js`).

## IMP-041-3 — Per-document paging throttle on refused binds

- **Question** (analyze MEDIUM finding U2): does the exception notifier already
  dedupe or rate-limit?
- **Finding**: yes — `server/exception-notifier.js` rate-limits GLOBALLY to 10
  emails per 5 minutes.
- **Decision**: keep a cheap per-document throttle (one page per doc per 5 min)
  inside the refusal path anyway.
- **Rationale**: the notifier's budget is shared with every other alert source.
  A sustained DB outage across many documents would burn the whole budget on one
  repeated fact and crowd out unrelated pages. The throttle is a `Map` of
  `docGuid -> lastPagedAt`, pruned opportunistically, and only ever populated by
  documents that actually failed to load. Honors the spec edge case ("no
  unbounded notification spam") without weakening the signal.

## IMP-041-4 — `mergeNamedVersions` receives the UNFILTERED rows

- **Question**: research R1 says to pass `getVersionTimeline`'s
  meaningful-filtered array; research R16 requires distinguishing "range has no
  rows" (FR-003 ⇒ empty authors) from "range is all noise" (⇒ credit its real
  in-range editors). Those are indistinguishable in a pre-filtered array.
- **Decision**: pass the unfiltered rows; `computeRangeMeta` applies the
  meaningful rule itself, per range.
- **Rationale**: satisfies both FR-003 and R16 with no extra query and no
  replay — it is the same array `getVersionTimeline` already holds, so the
  O(rows) invariant (023 FR-016) is untouched. Auto-version grouping still
  consumes the filtered set, unchanged.

## IMP-041-5 — Split fragments scope authors/provenance, NOT timestamps

- FR-002 scopes "the authors and on-behalf-of provenance" of a fragment; FR-003
  scopes a NAMED version's timestamp. Fragments therefore keep their parent auto
  version's timestamp.
- **Rationale**: a fragment is a slice of one activity burst (all its rows are
  within the grouping threshold of one another), so the displayed time is off by
  at most that threshold, and rewriting fragment timestamps would change the
  rendered history of every existing document for no attribution gain. Recorded
  as a deliberate residual, not an oversight.

## IMP-041-6 — The drill-down cache is invalidated by STRUCTURE, not by every refresh

- **Question**: FR-008's 10 s poll flows through the same refresh path that
  wipes `versionUpdates`. Wiping on every tick would make every expanded row
  re-fetch every 10 s and blank its contents in between — the opposite of the
  scroll/expansion-preservation edge case (analyze MEDIUM finding C1).
- **Decision**: compute a structural fingerprint (`id:clockStart-clockEnd:name:isCurrent`
  per version) and invalidate only when it changes.
- **Rationale**: a drill-down's contents depend only on the rows in its range,
  and any change to those rows moves the fingerprint (a new edit extends the
  current version's `clockEnd`; noise rows are excluded from both surfaces by
  FR-004). Structure-unchanged therefore implies drill-down-unchanged. Two
  existing hook tests asserted the wipe using `versions: []` on both fetches —
  an artificial payload where the structure genuinely never changes — and were
  updated to realistic before/after lists.

## IMP-041-7 — The panel keeps its list mounted across refreshes

- **Question** (analyze MEDIUM finding C1): scroll preservation on live refresh
  is manual-check-only, so the implementation must avoid remount patterns.
- **Decision**: (a) background poll ticks never set `isLoading`; (b) the panel's
  loading placeholder only stands in for an EMPTY list, so
  `HierarchicalVersionList` stays mounted through every refresh; (c) rows keep
  their existing `key={version.id}` / `key={month.label}` identity.
- **Rationale**: with the old gating (`!isLoading && versions.length > 0`) every
  refresh unmounted the list, discarding scroll position, month expansion and
  row expansion — and would have made FR-009's re-fetch effect meaningless.
  Actual pixel behavior still needs Sam's two-browser manual check (quickstart
  manual check #2).

## IMP-041-8 — A fourth documentation surface corrected in the SC-011 sweep

- `server/api/chat.js:92` also carried the pre-cut claim ("the identity a web-UI
  restore is RECORDED under"). FR-018 names two surfaces and FR-019 a third, but
  SC-011's sweep is "zero pre-cut claims", so it was corrected too and is
  covered by the grep-level guard in
  `server/__tests__/restore-doc-truth.test.js`.
