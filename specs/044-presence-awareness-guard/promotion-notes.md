# 044-presence-awareness-guard — promotion notes

Seeded by the implementer for the merge queue and the post-merge adversarial
review. Branch `044-presence-awareness-guard`, off `main` @ `62bccbc7` (after
041 and 042 merged, both of which touch `server/index.js`).

**What shipped**: the MEDIUM the 038 post-merge reviewer reproduced and deferred
(`specs/038-attribution-integrity/promotion-notes.md` lines 44–70) is closed. A
connection may assert awareness only for clientIDs it controls — its own, an
unclaimed one, or one held by another connection of the same authenticated user.
Anything else drops the whole frame, silently, with a rate-suppressed
`WS_AWARENESS_BLOCKED` event. Three files: `server/ws-awareness-guard.js` (new),
`server/ws-edit-gate.js`, `server/index.js`. No migrations, no schema change, no
env vars, no client surface.

---

## Decisions taken during implementation

### D-044-1 — a decodable *prefix* asserts its ids (plan-time, confirmed in code)

`applyAwarenessUpdate` applies entries in a loop and `messageListener` swallows
the throw, so a failure on entry N leaves 1..N-1 applied. The parser is
therefore incremental: every clientID decoded before a failure counts as
asserted. Only a frame failing before one complete entry asserts nothing and
passes through.

**Verified discriminating.** The truncated-tail-smuggle test
(`[well-formed spoof of Ca][garbage]`) was run against a deliberately
all-or-nothing parser and **failed**, then passed against the shipped one. If a
future "simplification" makes the parse atomic, that test fails — which is the
point.

**Spec amended (analyze finding I1).** The spec's "Undecodable / malformed
awareness payload" edge case now distinguishes the two cases explicitly rather
than leaving a literal reading that the exploit satisfies.

### D-044-2 — the guard reads the state string, never `JSON.parse`s it

Confirmed against the applier: it does `JSON.parse(readVarString(...))`, so a
frame whose entry-2 state is invalid JSON applies entry 1 and throws. The guard
sees entry 2's clientID where the applier never would — a **superset**,
conservative in the safe direction, and it keeps JSON parsing off the
per-cursor-tick path (SC-004). Cost is a theoretical false-positive drop on a
frame no honest client can emit (`encodeAwarenessUpdate` always
`JSON.stringify`s). Unit-tested as a deliberate superset, not as an accident.

### D-044-3 — the first drop emits immediately, so its payload reads `dropped: 1` (NEW)

`tasks.md` T019/T020 and `quickstart.md` Scenario 3 said a 500-frame burst
produces "one emission carrying `dropped: 500`". That is not simultaneously
satisfiable with contract §2's "the **first** `record()` always returns a
payload", which is the half SC-003 actually requires ("every distinct spoofing
connection produces at least one countable event"). A suppressor that waited for
the window to close would report richer counts but could stay **silent for a
full minute about an attack in progress**.

**Resolved in favour of the contract**: first drop emits (`dropped: 1`), the
accumulated counts arrive with the next windowed emission
(`dropped: 501, sinceLastLog: 500`). Both halves of SC-003 hold: every spoofing
connection is announced, and volume is bounded. `quickstart.md` Scenario 3 was
corrected to match; the tasks' phrasing is superseded by this note.

---

## Analyze-gate MEDIUMs — dispositions

| Finding | Disposition |
|---|---|
| **I1** — spec's "undecodable" edge case contradicted D-044-1 | **Fixed in the spec.** The bullet now separates "fails before entry 1" (pass through) from "decodable prefix" (asserts its ids). |
| **C1** — SC-004 had no task | **Micro-assertion added**, not accepted-as-untested: a unit test gives another connection a booby-trapped `Set` whose `has` throws, and asserts the honest path (sender owns the id) resolves in exactly one `Set.has` on its own set and never walks another connection's. That is the whole performance claim (research R8) made executable. |
| **A1** — AC-1's literal text vs SC-003 | **Implemented per SC-003.** US3 is a per-connection countable event with suppressed repeats. AC-1's literal "a distinct, named observability event is emitted [per dropped frame]" is superseded: every *connection* that spoofs produces at least one event; repeats within the window are counted, not logged. See D-044-3. |
| **C2** — FR-004's never-relayed property proven only indirectly | **Accepted, and the reasoning is in the test.** The Redis awareness publisher is driven by `doc.awareness.on('update')`; a frame that is never applied fires no update event, so "never applied ⇒ never relayed". Stated in a comment in the fan-out test so a reviewer does not read the absent Redis harness as a coverage gap. Building one would mean standing up Redis to observe an event that provably cannot fire. |

---

## FR-008 (Redis relay exemption) — no code, deliberately

The cross-instance path calls `applyAwarenessUpdate(doc.awareness, …, ORIGIN_REDIS)`
directly and never traverses `ws.emit`, so it is exempt by construction. Adding
code would mean inventing a bypass in order to test it. Covered instead by a
test that **pins** the exemption: it applies a clientID owned by no local
connection through the relay path and asserts it applies and fans out. If a
future refactor routes relay traffic through a connection, that test fails and
the contract gets re-decided rather than silently lost.

---

## Known, pre-existing, explicitly out of scope

**Same-user reconnect can transiently evict the reconnected client's own
presence** (≤15 s, self-healing). `y-websocket`'s `awarenessChangeHandler` only
records `added` ids into a connection's controlled set, so a reconnect that
re-asserts a still-owned id registers as `updated` and never enters the new
connection's set; when the stale socket is reaped, `closeConn` evicts the id and
the client re-adds it on its next tick.

This predates the feature and the guard deliberately **does not** "fix" it by
writing to `doc.conns` — that would make the guard a second maintainer of the
ownership record, which is the exact "second model" failure 038 hit three times.
Flagged here so a reviewer does not misattribute the flicker to this feature.

---

## Owed to Sam (not gating merge)

1. **Design-doc amendment.** `design/collaboration-core.md` documents presence as
   awareness and eager disconnect eviction, but says nothing about *who may
   assert an id*. Worth adding. `design/` is an export — amend the Squire source
   doc, then `node design/sync.mjs`. Agents must not hand-edit the export
   (Constitution VI).
2. **Manual presence walk, post-deploy** (quickstart §"Manual check"):
   two-browser presence, agent avatar, kill-and-restore the network on one tab
   and confirm the avatar returns within ~15 s with **no** `WS_AWARENESS_BLOCKED`
   for that reconnect.
3. **`grep WS_AWARENESS_BLOCKED`** on a day of prod logs. Expected count: **zero**.
   Any hit is either a real attempt or a false positive worth chasing — the event
   payload carries `foreignIds`, `dropped` and `sinceLastLog` to triage with.

## Note for the merge queue

`README.md` describes presence/collaboration but was **not** edited (out of this
stage's scope). If the merge queue wants the guard mentioned, the presence
section is the place: one sentence that a connection may only announce presence
for its own client, and that frames claiming another participant's identity are
dropped. No user-visible behavior changes for honest traffic, so it is a
"nice to state", not a correction of anything now inaccurate.
