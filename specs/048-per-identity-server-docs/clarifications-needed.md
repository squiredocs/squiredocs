# Clarifications & Decisions Ledger — 048-per-identity-server-docs

Decisions made without live maintainer input during parallel spec authoring
(2026-08-03). Per Constitution Principle VI, nothing here was decided silently;
each entry records the question, why it matters, the chosen default, and the
rationale. The three entries below correspond one-to-one to the "Open for Sam"
items in the ratified design section (design/collaboration-core.md,
"Per-identity server docs"); per the RATIFIED-BY-DEFAULT convention each adopts
the design doc's recommended answer. Sam may overturn any entry.

---

## RBD-048-1 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-03)** — Post-cutover assistant over-refusal is accepted; no stamp discriminator in v1

- **Question** (design "Open for Sam" item 1): with no stamp-level
  discriminator between the chat assistant's two write shapes (session-doc
  edits via `modify` vs per-operation-doc writes like the image insert and the
  welcome seed), new assistant-authored rows still render as "Synced content"
  if lost and resupplied. Add a discriminator (requires a schema migration) to
  buy accuracy on those rare rows, or accept the over-refusal?
- **Why it matters**: it is the one place where post-cutover rows still get an
  honest refusal instead of a recovered author, and closing it costs the
  feature a migration and a second write shape.
- **Decision**: **Accept the over-refusal; no discriminator, no migration in
  v1.** The durable `CHAT_AGENT_NAME` poisoning source stays exactly as the
  047 posture left it, covering pre- and post-cutover assistant rows alike.
- **Rationale**: the design doc's own text records this as the intended v1
  posture ("an accuracy cost, never a wrong person, unchanged from the 047
  posture") and lists the discriminator as the thing a migration would buy,
  not as part of this feature. The cost is bounded to lost-then-resupplied
  assistant rows — a population the RBD-045-5 posture already sizes at a few
  events per year — and the failure mode is an honest label, which Sam's
  attribution-first ordering ranks strictly above both a wrong author and
  added deploy risk.

## RBD-048-2 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-03)** — Restore flips to store-then-apply (commit before broadcast)

- **Question** (design "Open for Sam" item 2): confirm restore's ordering
  change — the unified path commits the durable row before broadcasting, and
  a concurrent edit landing during the store await merges with the restore
  instead of being replaced by it. Keep today's live-path
  broadcast-then-store instead?
- **Why it matters**: it changes which half of the crash window restore sits
  in, and (narrowly) what a concurrent editor experiences during a restore.
- **Decision**: **Adopt store-then-apply.** The crash window flips from
  broadcast-without-commit (an applied restore that durable history never
  records) to commit-without-broadcast (the durable row replays on the next
  load — nothing is lost). The merge-with-restore semantics during the store
  await are accepted.
- **Rationale**: the design marks both consequences "accepted" and calls
  commit-without-broadcast "the safer half": a broadcast-lost restore
  self-heals from the append-only log, while a commit-lost restore was
  visible state that history denied. The merge semantics are not new — they
  are exactly what the durable-log path and cross-pod restores (RBD-041-2)
  already do, so the change makes restore consistent rather than introducing
  a third behavior. It also aligns restore with the already-conforming
  store-then-apply patterns (undo inverses, sync push) and preserves the 041
  invariant that the stored bytes are the applied bytes.

## RBD-048-3 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-03)** — The live-peek tripwire is kept in v1; deletion is recorded cleanup, not part of this feature

- **Question** (design "Open for Sam" item 3): the resolver's live-peek
  poisoning source becomes structurally unnecessary for new rows once the
  invariant holds. Delete it (and its init wiring) now, or keep it?
- **Why it matters**: it is process-local knowledge of exactly the kind
  Principle VII restricts, and dead defensive code has a carrying cost; but
  it is also the only production-side detector if a future write path
  regresses to authoring on the shared doc.
- **Decision**: **Keep it in v1, wired, as the fail-honest tripwire.** If a
  path regresses, its resupplied rows render as the honest "Synced content"
  on the authoring pod, never as a wrong author. Deleting the source and its
  `init({ peekSharedDoc })` wiring is recorded cleanup to be done once the
  invariant guards (FR-007) have soaked — a follow-on decision for Sam with
  soak data in hand, not part of this feature.
- **Rationale**: the design states "v1 keeps it" and classifies the retained
  knowledge as Principle VII compliant because it is now defense in depth
  rather than correctness-bearing: no new row's correct resolution depends on
  it, and its loss (eviction, restart, other pod) degrades to an honest label
  at worst. Removing the last production backstop in the same change that
  makes it redundant would leave a regression window with no detector.

## RBD-048-4 — **RATIFIED-BY-DEFAULT (recorded at plan time, 2026-08-03)** — `updateDocument` gates its seed on bind completion; the design's silence on load completion is resolved in the loaded-state reading

- **Question** (design silence, surfaced by the post-spec adversarial review
  and reproduced by the orchestrator with the repo's own yjs): the design says
  "seed it by applying the shared doc's current encoded state" and says
  nothing about LOAD COMPLETION. y-websocket's `getYDoc` fires `bindState`
  without awaiting it, so on a cold document (nobody has it open)
  `getSharedDoc` returns an EMPTY doc: today `updateDocument` transacts on
  that half-loaded doc and the write lands BEFORE the persisted state merges
  on top — a title set loses ~half the time (98/200 trials, Y.Map LWW) and a
  chat-image "append at end" lands at index 0, before the whole document.
  Seeding the ephemeral doc from that empty state inherits the hazard
  verbatim. Does "the shared doc's current encoded state" mean whatever bytes
  happen to be in memory, or the LOADED state?
- **Why it matters**: in the raw-bytes reading, the 048 mechanism ships a
  known, reproduced lost-write/misplaced-write bug on every cold-doc
  server-side operation — directly contradicting the design's own claims that
  the converged operations are behavior-identical and that stored rows
  describe real transitions. The spec's original "Half-loaded document" edge
  case ("no new guard is introduced") restated the silence, not a decision.
- **Decision**: **the loaded-state reading.** `updateDocument` awaits a
  bind-readiness gate before seeding: a new awaitable `waitForDocReady` in
  `server/document-service.js`, built on the 046 `_bindComplete` flag
  (`server/collab-bind-state.js`), throwing `BindFailedError` on a failed
  bind and a timeout error otherwise. It becomes the ONE owner of the
  half-loaded question for write paths, consolidating the three divergent
  predicates (046's `_bindComplete` flag, `docs-import.js`'s
  `waitForDocLoaded` state-vector poll — now deleted and delegated — and
  `updateDocument`'s nothing). The missing test class (updateDocument against
  a doc whose bindState has not completed) is added with it. The
  seed→transact→merge sequence stays synchronous; the gate sits strictly
  before it. Spec FR-013 and the amended "Half-loaded document" edge case
  encode this.
- **Rationale**: recorded as a design-silence resolved RATIFIED-BY-DEFAULT —
  NOT a design contradiction. The design's correctness claims (every stored
  row maps to a real transition; the six operations are behavior-identical
  for users; "a half-loaded doc is exactly as visible to updateFn as it is
  today" — written on the belief that today's visibility was safe, which the
  review falsified) are only satisfiable under the loaded-state reading, so it
  is the design doc's own intent, applied. 046 built exactly this predicate
  for read-to-store paths ("only the binder knows, so the binder says so");
  extending it to the write path is the same principle. If Sam wants the gate
  stated in the design section, that is a Squire-side amendment +
  `node design/sync.mjs` (flagged for the merge queue; exports are never
  hand-edited).

---

## N-048-1 — NOTE (no decision required) — Code comments still carrying the falsified overbroad claim

The module header of `server/resupply-resolution.js` ("Every server-side write
path … transacts on the ONE live `WSSharedDoc`") and the restore residuals
comment in `server/version-history.js` (documenting the live path's
broadcast-then-store ordering as current) restate claims the design section
corrects (research R12 / the resolver contract were overbroad; undo/redo
inverses, sync pushes, and the restore durable path already conform).
Spec FR-011 requires these comments to be corrected during implementation per
Principle VI. Recorded here so the drift is not rediscovered as a surprise.
