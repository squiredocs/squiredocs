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

## ~~Known, pre-existing, explicitly out of scope~~ — WITHDRAWN, this was wrong

This section originally filed the reconnect behavior as a *"transient ≤15 s,
self-healing cosmetic flicker, pre-existing, out of scope"*. That disposition was
factually wrong, and the post-merge reviewer proved it. The corrected statement:

**The same mechanism the note describes is how the security property lapses.**
`y-websocket`'s `awarenessChangeHandler` records ids into a connection's
controlled set only from the `added` bucket; `applyAwarenessUpdate` classifies an
entry `added` only when `awareness.meta.get(clientID) === undefined`; and
`removeAwarenessStates` deletes `states` but **never** `meta` (there is no
`meta.delete` in y-protocols). So the first time a document sees a clientID it is
`added`, and **every** later announcement of that id — after any reconnect — is
`updated`.

What the note got right: the DISPLAY self-heals. What it missed: the OWNERSHIP
RECORD never does. The id does not re-enter *any* connection's controlled set for
the remaining life of that document, so ownership reads as "unclaimed" and the
guard fails **open**, permanently, for that participant. Reproduced: after Alice
disconnects and reconnects, `owners = []`, and a different authenticated viewer
both overwrote her presence with a forged name and evicted her outright, with
**zero** `WS_AWARENESS_BLOCKED` events. Triggers are ordinary: wifi blip, laptop
sleep, provider backoff reconnect, pod bounce. Only a full page reload — which
mints a *new* clientID and so re-enters the `added` path — restored protection.

"Out of scope" was the wrong call for a second reason: the flicker and the hole
are the same fact, so filing the flicker as pre-existing filed the hole as
pre-existing too. It was neither pre-existing (nothing depended on that map for
security before 044) nor cosmetic.

The fix is in the "Post-merge review" section below, and it does **not** write
`doc.conns` — that part of the original reasoning stands.

---

---

## Post-merge adversarial review — findings and fixes

Three HIGH exploits were reproduced against the merged guard, plus four lower
findings. All are fixed. One further finding (FP-1) surfaced while reproducing
them and is the most operationally significant of the set.

Every fix has a regression test that was **run against the pre-fix behavior and
observed to fail** — by selectively disabling the fix (ledger removed, entry cap
removed, precondition filter removed) and re-running, not by argument.

| # | Finding | Fix | Pinned by |
|---|---|---|---|
| **HIGH-1** | One reconnect un-owns a clientID permanently; the guard then fails open forever (see the withdrawn section above) | Guard-owned **ownership ledger** per document: `Map<clientID, principal>`, written on ALLOWED frames — so a re-announcement re-establishes ownership even though `doc.conns` never will — and *lapsed*, not deleted, when a state goes away | `awareness-spoof-block.test.js` "review HIGH-1" (3 tests, incl. an assertion that `doc.conns` really has forgotten the id, so the test cannot quietly stop testing anything); `ws-awareness-guard.test.js` ledger + rule-2 blocks |
| **HIGH-2** | Cross-instance participants are unowned locally, so a same-pod attacker hijacks them and the spoof relays back to the victim's own pod | The relay **teaches** the ledger: connection-less applies record their ids under `REMOTE_PRINCIPAL`, a Symbol no principal can equal. The relay apply itself stays exempt (FR-008) | `awareness-spoof-block.test.js` "review HIGH-2" (3 tests, including one that the relay still applies and fans out) |
| **HIGH-3** | Net-new DoS: the guard walked frames the applier rejects in 0.16 ms — ~1 s of blocked event loop per 9 MB frame, and *allowed*, so no event was emitted | (a) `maxPayload` on the WebSocket server (32 MB, env-overridable) instead of ws's 100 MiB default; (b) declared entry count checked **before** the loop (`MAX_FRAME_ENTRIES = 64`, fail closed); (c) the holder index over other connections built **once per frame**, lazily, instead of rescanned per id | `awareness-spoof-block.test.js` "review HIGH-3"; `ws-awareness-guard.test.js` entry-cap block (incl. a wall-clock bound) and the cost block (one pass over the document for a 64-id frame); structural pins on `maxPayload` in `ws-edit-gate.test.js` |
| **MEDIUM-4** | First-writer-wins is squattable, and the block event names the victim | The retention window makes the "wait for the socket to drop" variant fail: a lapsed record still refuses another principal. The event payload gains `conflicts: [{ clientId, assertedBy, heldBy }]` and a `reason` | `awareness-spoof-block.test.js` "review MEDIUM-4" (2 tests: the squat is refused *and* Alice is not locked out when she returns; and when a squat does win the race the log identifies the squatter) |
| **LOW-5** | Burst-then-disconnect reported `dropped: 1` for 500 frames | `createDropSuppressor().flush()`, called from a `ws.on('close')` handler registered lazily on the first drop | `ws-awareness-guard.test.js` flush block; `ws-edit-gate.test.js` and `awareness-spoof-block.test.js` burst-then-close tests |
| **LOW-6** | Doc-name divergence between the guard's `getYDoc` name and `setupWSConnection`'s | One name, derived once, passed to both | Structural pin in `ws-edit-gate.test.js` (C1 block); the integration harness mirrors it |
| **LOW-7** | A throw inside `setupWSConnection` left the guard off for a still-listening socket | **Fail closed**: an awareness frame that asserts ids on a connection with no resolved ownership view is dropped (`reason: 'unbound'`). Frames that assert nothing still pass | `ws-edit-gate.test.js` "getOwnership() returning null FAILS CLOSED" (+ the frame-asserts-nothing counterpart) |
| **LOW-8** | The principal is the userId, so a user's agent token can assert that user's browser clientID | No code change — stated as a boundary in `spec.md` (Assumptions) and in the guard's module header, per the finding | — |

### FP-1 (found during the fix, not in the review) — the guard was blocking honest traffic

The y-websocket **client** re-broadcasts every awareness change it applies, and
`_awarenessUpdateHandler` ignores the origin
(`node_modules/y-websocket/src/y-websocket.js`). So in any session with two or
more participants, every honest client sends the server frames carrying the
**other** participants' clientIDs — on every join and every remote cursor move.

Reproduced with two real `WebsocketProvider`s (BroadcastChannel disabled, which is
how two separate browsers behave): each participant produced a
`WS_AWARENESS_BLOCKED` naming the *other* user as the offender. `SC-002`'s "zero
false-positive drops" was false in any two-person session, and the
"expected count: **zero**" guidance below would have been wrong on day one — with
the corollary that a real spoof would have been indistinguishable from routine
noise.

Functionally the echoes are harmless either way (they carry the clock the server
already has, so the applier discards them), which is exactly why the fix is safe:
`assertedIds` filters a frame down to the entries the applier's own precondition
would act on, evaluated in the same synchronous turn the applier runs in. The
guard's id set stays "never narrower than what the applier would ACT ON", which is
what the invariant always meant.

Pinned by `awareness-spoof-block.test.js` "FP-1: two real clients produce no
blocked events" — the only test in the suite that speaks through the real client
rather than hand-crafted bytes, which is why the gap survived the first review.

### Ledger design notes

- **It is not the "second ownership model" 038 kept failing on.** That failure was
  a second *eviction* model. Eviction is still `closeConn` + y-websocket's
  controlled-id set, and `doc.conns` is still never written. The ledger deletes
  nothing from any document; a wrong entry costs a refused presence frame.
- **Retention (5 min) is a reservation, not an eviction.** A lapsed record only
  refuses *another* principal. It covers every reconnect path in this codebase and
  turns MEDIUM-4's squat from a wait into a race the attacker must win against the
  victim's own reconnect.
- **Bounds are per principal (32 ids), not global LRU.** A global bound would let a
  flooder churn ids until a victim's record fell off the end — re-opening HIGH-1 on
  demand. Over-quota pruning only ever forgets the flooder's own entries.
  `REMOTE_PRINCIPAL` is exempt from the quota (a document can legitimately have any
  number of participants on other instances) and bounded by the per-document cap,
  which refuses new records rather than evicting existing owners.
- **Lifetime**: a `WeakMap` keyed by the doc, so it dies with the doc. No global
  registry, no timer, no cleanup handler to forget.

### What SC-001 can now truthfully claim

Corrected in `spec.md`. In short: a clientID **recorded to a different principal**
cannot be overwritten or evicted — including for a participant who is reconnecting,
recently dropped (within retention), or present on another instance. Enforcement is
**per instance, at the socket where the frame enters**; relay applies remain exempt,
so the cross-instance property is "every instance guards its own clients", not "the
relay validates what it receives". Excluded by design: first-writer-wins on an id
nobody has ever announced (Q1), and same-principal assertion (Q3/LOW-8).

## Owed to Sam (not gating merge)

1. **Design-doc amendment — now a CORRECTION, not an addition.** The 2026-08-02
   awareness amendment in `design/collaboration-core.md` (and README's presence
   bullet) inherited SC-001's "on the local instance or cross-instance", which was
   not true as shipped and is not true unqualified now. `design/` is an export —
   amend the Squire source doc, then `node design/sync.mjs`. Agents must not
   hand-edit the export (Constitution VI). Proposed replacement wording:

   > A connection may announce presence only for the Yjs clientIDs it owns. The
   > server records ownership per document as it allows frames: a connection's own
   > announced ids, ids nobody holds and no record remembers, and ids last owned by
   > the same authenticated user (reconnect, second tab). A frame asserting anyone
   > else's clientID is dropped whole before it is applied, broadcast or relayed,
   > and the drop is counted. Ownership records outlive the socket by a few minutes,
   > so a participant who drops off keeps their identity until they return.
   > Participants on another instance are recorded as belonging to that instance and
   > cannot be impersonated from this one — the guard runs on the socket a frame
   > arrives on, and relayed awareness is applied unguarded, so cross-instance
   > protection is exactly each instance guarding its own clients. Two limits are
   > deliberate: a clientID nobody has ever announced belongs to whoever announces
   > it first, and one user's own connections may assert each other's ids.
2. **Manual presence walk, post-deploy** (quickstart §"Manual check"):
   two-browser presence, agent avatar, kill-and-restore the network on one tab
   and confirm the avatar returns within ~15 s with **no** `WS_AWARENESS_BLOCKED`
   for that reconnect.
3. **`grep WS_AWARENESS_BLOCKED`** on a day of prod logs. Expected count: **zero**
   — which only became a truthful expectation with the FP-1 fix above; before it,
   every two-person session produced one per participant. Any hit is either a real
   attempt or a false positive worth chasing. The payload carries `reason`
   (`foreign-id` / `entry-cap` / `unbound` / `connection-closed`), `foreignIds`,
   `conflicts` (asserting **and** holding principals — on a squat the sender is the
   victim), `dropped` and `sinceLastLog` to triage with.
4. **Watch for `1009` WebSocket closes** after deploy. `WS_MAX_PAYLOAD_BYTES`
   defaults to 32 MB where the transport previously accepted 100 MiB. Nothing this
   editor can produce comes close (images are stored out of band; inline diagram
   rasters are capped at ~1 MB each), but the failure mode is a reconnect loop that
   is hard to read from the client, which is why the value is env-overridable.

## Note for the merge queue

`README.md` describes presence/collaboration but was **not** edited (out of this
stage's scope). If the merge queue wants the guard mentioned, the presence
section is the place: one sentence that a connection may only announce presence
for its own client, and that frames claiming another participant's identity are
dropped. No user-visible behavior changes for honest traffic, so it is a
"nice to state", not a correction of anything now inaccurate.
