# Clarifications Ledger — 016-log-derived-undo

Decisions the design amendment (`design/collaboration-core.md`, "Version history" —
**Amendment (Sam, 2026-07-18) — agent-edit undo is derived from the update log, not from
a live session**; cross-referenced in `design/agent-surface-mcp.md`) did not answer were
taken with the best default and recorded here as **RATIFIED-BY-DEFAULT (Sam
pre-authorized, 2026-07-18)** per Constitution Principle VI.

Decisions the amendment already made are Sam-ratified 2026-07-18 and are cited in the
spec, not re-decided: clock-range input (persisted on the chat modify tool part and
returned by every modify); insertions and delete-sets extracted from the logged updates;
the inverse applied as a normal forward update (history never rewritten);
popStackItem-equivalent semantics (later edits preserved, superseded content skipped,
honest "nothing left to undo" when fully superseded); redo = invert the inverse via the
inverse's own recorded clock range, chaining indefinitely; retirement of the session
`Y.UndoManager`; one mechanism for both surfaces; standard origin attribution on the
inverse; undo works from any instance and survives session expiry and restarts.

---

## RBD-1: The edit identifier's shape, and the fate of the existing `clock` field

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment says the edit's clock range is "persisted on the chat
  modify tool part and returned by every modify" — but today's modify result carries a
  single `clock` that is the **pre-edit** baseline, captured at handler start before the
  script even runs (`server/mcp/tools/modify.js:294-300, 535`), and edit persistence is
  asynchronous, so the post-edit clock is not knowable at that capture point. What
  exactly gets recorded, and what happens to the existing field?
- **Decision**: The existing `clock` field keeps its exact current meaning (pre-edit
  baseline) — the chat staleness/conflict machinery reads it
  (`server/api/chat-staleness.js`) and repurposing it would silently corrupt the
  conflict guard. The edit identifier is **new, explicit range data** (both endpoints of
  the edit's own rows), recorded only once all of the edit's rows are durably persisted
  (spec FR-001/FR-002/FR-004), returned in the modify result and persisted on the chat
  tool part. Row selection within the range is qualified by the acting identity's
  attribution, so foreign rows interleaved into the range are never part of the edit.
- **Why this default**: Additive is the only safe option: every consumer of the current
  field keeps working, and the new field can carry exactly the contract the inverse
  needs (all rows of the edit, only rows of the edit, only durable rows) instead of
  overloading a field with established different semantics. Recording after durability
  is forced by the async write path — a speculative range could let an undo derive a
  partial inverse, violating the surgical guarantee.

## RBD-2: Legacy history — pre-016 chat parts and pre-016 undos

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: Existing chat messages persist only the pre-edit `clock` on modify
  parts; edits undone by the retired session mechanism have a `reverted` flag but no
  recorded inverse range. What can these do under the new mechanism?
- **Decision**: Best-effort with honest refusal (spec FR-021, SC-011). Where the edit's
  rows are unambiguously identifiable from the persisted pre-edit clock plus
  attribution — the contiguous run of the acting identity's own rows immediately
  following it — legacy undo works. Where identification is ambiguous (e.g. interleaved
  same-identity activity), undo-status reports unavailable and the surfaces return the
  honest empty result. Redo of a pre-016 undo (no recorded inverse range exists) is
  honestly unavailable. No migration or backfill of old chat messages.
- **Why this default**: The failure hierarchy is clear: a guessed inverse can destroy
  content (Constitution IV), while honest unavailability is exactly what those users
  already experience today once the session dies (the button disappears). Best-effort
  derivation still strictly improves on the status quo — most legacy edits sit at the
  end of a quiet range and derive cleanly — and a backfill of every stored chat is
  disproportionate ceremony for a solo-beta product (Constitution III).

## RBD-3: Where the inverse record lives (bare `redo(docGuid)` must find it)

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment says redo derives from "the inverse's own recorded clock
  range" but not where that record lives. The MCP `redo` tool receives only `docGuid`,
  and the mechanism must be stateless across instances and restarts — so the record
  cannot live in memory, and the chat message store alone cannot serve MCP agents
  (whose operations have no chat message).
- **Decision**: The inverse record — inverse range ↔ inverted edit, per (document,
  acting identity) — is persisted **durably server-side in the database**, the same
  durability class as the update log itself, keyed so any instance can resolve "this
  identity's undo/redo chain in this document" from the document id alone (spec FR-014,
  FR-016, FR-017). The chat surface additionally persists the association on the chat
  tool part (beside `reverted`) so the per-message UI state survives reloads
  independently. The exact storage vehicle (new table vs. annotation of existing
  stores) is a plan-stage choice; the requirement is durability, instance-independence,
  and identity scoping.
- **Why this default**: Every alternative fails a ratified property: in-memory state
  recreates the exact pathology being retired; client-supplied state (making the agent
  pass the range back) breaks the existing tool contract, breaks the chat button, and
  trusts the caller with integrity the server owns; Redis-only storage would let a
  cache flush sever the redo chain, contradicting "survives restarts". The database is
  where the sibling mechanisms (log, named versions) already keep durable truth.

## RBD-4: MCP multi-step undo depth

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment defines undoing "an agent edit" (singular) and the
  undo↔redo chain on it, but the current MCP tools are documented and behave as a
  stack: repeated `undo` calls walk back through the agent's successive edits. Does the
  log-derived mechanism preserve multi-step depth, or flatten undo to latest-edit-only?
- **Decision**: Full parity: repeated MCP `undo` steps back through the calling
  identity's own prior edits in reverse chronological order (skipping already-undone
  edits), and `redo` reapplies most-recently-undone first — LIFO, exactly as the
  `Y.UndoManager` stack behaved, but now bounded by the durable log instead of the
  session lifetime (spec FR-017). The chat button remains latest-edit-only, unchanged.
- **Why this default**: The tools' published descriptions promise "go back through edit
  history"; silently shrinking that to one step would be a behavioral regression hidden
  behind an infrastructure change, and agents already build on the multi-step contract
  ("try different approaches"). The log-derived core makes depth *cheaper* to honor
  (every prior edit's rows are durable), so restricting it would be ceremony without a
  prevented failure.

## RBD-5: MCP tool result shape after the session's retirement

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: Today's undo/redo results include a `cursor` restored from the presence
  session (`server/mcp/tools/undo-redo-handler.js`), and the descriptions promise
  cursor restoration. With no session in the path, what do the tools return?
- **Decision**: Cursor restoration is retired from behavior and descriptions (spec
  FR-022/FR-023). The result keeps `success` and `undone`/`redone` plus an honest
  `message`, and gains the post-operation document `clock` (the same field modify
  returns) so the agent's observed-clock tracking and the conflict guard stay coherent
  after an undo without a forced re-read. The `cursor` field is dropped rather than
  returned as `null` forever; the description documents the change.
- **Why this default**: The cursor was an artifact of the session the amendment
  retires — synthesizing one would require creating the very session undo must no
  longer create (FR-008). The clock is what agents actually need after a state-changing
  operation (it is how every other mutating surface reports "where the document is
  now"), and returning it closes the loop with the staleness machinery that already
  warns agents about reverted documents.

## RBD-6: undo-status availability — how much does the poll compute?

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment pins an honest "nothing left to undo" for fully
  superseded edits, and the button poll (`GET /api/docs/:docId/undo-status`, every 30 s
  per open chat) must become log-derived. Does the poll compute the full inverse to
  guarantee `canUndo` implies a non-empty undo, or report cheap availability?
- **Decision**: The poll reports **cheap availability**: `canUndo` means the latest
  agent edit exists with a usable recorded identifier and is not currently undone;
  `canRedo` means an inverse record exists to reapply. Full supersession is discovered
  at action time, where the honest nothing-left-to-undo result (FR-011) is surfaced to
  the user by the existing error/result display, and the UI refreshes status afterward
  (the client already re-fetches status after every action). Deriving the full inverse
  on every poll is explicitly not required (spec FR-019, SC-007).
- **Why this default**: The poll multiplies across open chats and runs forever now that
  visibility is no longer session-bound; rebuilding document states every 30 s per
  client to pre-compute emptiness would buy only the suppression of a rare, honest,
  well-explained click outcome. The fully-superseded case is the edge; the amendment's
  honesty requirement attaches to the undo operation's answer, which this preserves
  exactly.

## RBD-7: Race posture — duplicate undo and undo-before-persist

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment is silent on two timing races: (a) two undo requests for
  the same edit landing concurrently (double-click, or two instances), and (b) an undo
  arriving after modify returns but before the edit's asynchronously-persisted rows and
  identifier are durable.
- **Decision**: (a) At-most-once effect: concurrent undo attempts against the same edit
  resolve to a single applied inverse; the loser observes the already-undone state and
  returns the honest `undone: false` result (spec FR-028) — same posture for redo. (b)
  The identifier is only recorded once its rows are durable (FR-004), so an early undo
  finds no identifier yet and reports nothing-to-undo honestly; it never waits, blocks,
  or derives from a partial edit. No new locking surface beyond what at-most-once
  requires.
- **Why this default**: Double-application would insert the inverse twice —
  content-destroying, the worst outcome class (Constitution IV) — so at-most-once is
  non-negotiable; honest refusal for the loser matches the amendment's honesty pattern
  everywhere else. For (b), the window is sub-second in practice and self-heals on the
  next click or poll; blocking a user-facing request on persistence retries would trade
  a rare honest "not yet" for tail latency on every undo.

---

*The following entries were added at plan stage (2026-07-18, /speckit-plan for 016);
RBD-1..7 above are unchanged. Full mechanics in `research.md`.*

## RBD-8: Modify's identifier durability wait — bounded, honest on timeout

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: FR-002 says the edit identifier is returned in every modify result,
  but FR-004 forbids recording it before the edit's asynchronously-persisted rows are
  durable. How long does modify wait, and what does it return if durability is not yet
  confirmed?
- **Decision**: Modify captures its own update payloads during execution, then waits a
  bounded interval (poll ~100–250 ms, ≤5 s total; in practice one round-trip — the
  write path is in-process) until the log's identity-attributed rows provably cover
  every captured payload (struct ranges via `parseUpdateMeta` plus delete-sets via
  `decodeUpdate`). On confirmation it returns `editRange` and inserts the
  `agent_edits` record. On timeout it returns `editRangePending: true` instead of an
  identifier and completes the recording in the background; an undo arriving in that
  window finds no identifier and reports nothing-to-undo honestly (the spec's
  undo-immediately-after-modify edge, RBD-7(b)).
- **Why this default**: FR-004's never-speculative rule is the safety property (a
  partial inverse destroys content); the bounded wait keeps FR-002 satisfied in the
  overwhelmingly common case without letting a persistence hiccup add unbounded tail
  latency to every modify. The coverage check is exact (handles deletion-only edits
  and excludes unrelated same-identity rows), so a recorded range can never select the
  wrong rows.

## RBD-9: Supersession evaluation basis and the residual apply-time race

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: FR-013 says supersession is evaluated against the live state the
  inverse merges into at application time. The inverse is computed on a rebuilt state;
  a collaborator's edit can land between computation and application. What is the
  exact basis, and what happens in the residual window?
- **Decision**: Supersession is evaluated against the full durable log at computation
  time merged with the serving instance's live shared-doc state (bringing in in-flight
  unpersisted edits). The residual cross-instance window resolves by standard CRDT
  merge: the inverse's deletions target only the edit's own struct ids (idempotent
  against racing deletes; racing inserts untouched), so later edits are preserved
  unconditionally and nothing is ever lost. The one asymmetry — a racing deletion of
  content the inverse is concurrently restoring leaves the restored copy in place — is
  accepted and matches the retired popStackItem's own window (it evaluated against its
  instance's state at pop time).
- **Why this default**: eliminating the window entirely would require a cross-instance
  write lock on the document — a new coordination surface contradicting the log-derived
  stateless design — to suppress a loss-free, self-healing rarity.

## RBD-10: Legacy run segmentation (elaborates RBD-2's identification rule)

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: RBD-2 identifies a legacy edit as "the contiguous run of the acting
  identity's own rows immediately following" the persisted pre-edit clock. Two
  back-to-back modify calls with no interleaved foreign row form one contiguous run —
  where is the boundary?
- **Decision**: A contiguous identity run is additionally segmented at `created_at`
  gaps greater than 10 seconds, and the segment nearest the anchor is taken (the
  segment starting immediately after the persisted baseline; for anchorless MCP
  derivation, the trailing segment). Rows within one modify call land sub-second apart
  (script transaction plus sanitization passes), while separate calls are seconds to
  minutes apart. When segmentation still cannot pin the edit (e.g. the first row after
  the baseline is foreign), the surfaces refuse honestly per RBD-2. A pre-016
  session-mechanism undo is itself an ordinary identity row, so a legacy derivation
  may honestly identify it as the latest edit; undoing it re-applies the edit — the
  truthful reading of the log, never a guess.
- **Why this default**: the 10 s threshold is an order of magnitude above observed
  intra-call row spacing and well below realistic inter-call spacing; erring toward
  refusal on ambiguity is the RBD-2 hierarchy (honest unavailability over guessed
  inverse), and any over-coverage that could slip through is bounded to the acting
  identity's own consecutive edits — never another author's content.
