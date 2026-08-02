# Feature Specification: Presence Awareness Guard

**Feature Branch**: `044-presence-awareness-guard`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "044-presence-awareness-guard: awareness clientID spoofing guard — connections may only broadcast awareness for clientIDs they control; foreign-clientID frames dropped with rate-suppressed observability event; no disconnects"

## Context & Trust Boundary *(Constitution Principle V — ingestion surface)*

Presence (who-is-here cursors and avatars) is carried by Yjs **awareness** frames on
the collaboration WebSocket. Awareness frames are deliberately **not edits** — they
never reach `Y.applyUpdate` and never write document content (037 invariant, ratified
in `design/collaboration-core.md`). The 038 edit gate therefore passes them straight
through for every role.

That pass-through leaves one integrity gap, reproduced by the 038 post-merge reviewer
and deferred as a tracked follow-on (`specs/038-attribution-integrity/promotion-notes.md`
lines 44–70). The awareness protocol identifies each participant by a **client-chosen
Yjs clientID carried inside the frame payload**, and `applyAwarenessUpdate` accepts an
update for *any* clientID whose clock is higher — it authenticates the clientID against
nothing. A connected viewer can hand-craft an awareness frame carrying **another
participant's clientID** and either overwrite that participant's displayed name/colour
or evict their presence entirely, fanned out to every connection and across instances.

**Trust boundary this feature adds**: an awareness frame arriving on a client WebSocket
connection is untrusted input. A connection may assert presence **only** for the
clientIDs it legitimately controls. Frames asserting a clientID owned by a *different*
connection are dropped before they are applied or relayed.

**Blast radius is cosmetic, not integrity of record**: presence is ephemeral and
decorative, so the worst outcome today is a wrong or missing avatar until the victim's
next awareness tick — no document content, no attribution, no persisted row is affected.
This feature closes the gap because the display is still an integrity surface: a spoofed
"Sam is watching" is a social-engineering primitive, and silently evicting a
collaborator's cursor hides who is present.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A participant's presence cannot be hijacked (Priority: P1)

A collaborator (human or agent) is present on a document with a live cursor and avatar.
Another connected participant — of any role, including view-only — must not be able to
change, impersonate, or remove that collaborator's presence by sending awareness frames
that carry the victim's clientID.

**Why this priority**: This is the entire point of the feature and the tracked 038
finding. Without it, who-is-here display is forgeable by any connected user.

**Independent Test**: Open two connections to the same document, note connection A's
clientID, then from connection B send an awareness frame carrying A's clientID with a
different name/colour (and separately, with a null state to evict). Verify A's presence
is unchanged and no spoofed/evicted state reaches any other connection or instance.
Reproduces the reviewer's exploit and asserts it now fails closed.

**Acceptance Scenarios**:

1. **Given** connection A is present with clientID `Ca`, **When** connection B sends an
   awareness frame asserting clientID `Ca` with a forged user state, **Then** the frame
   is dropped, A's displayed presence is unchanged, and no forged state is broadcast to
   any connection or relayed cross-instance.
2. **Given** connection A is present with clientID `Ca`, **When** connection B sends an
   awareness frame asserting clientID `Ca` with a null (removal) state, **Then** the
   frame is dropped and A's presence is **not** evicted.
3. **Given** connection B sends a frame that asserts **both** its own clientID `Cb` and a
   foreign clientID `Ca`, **When** the guard evaluates it, **Then** the whole frame is
   dropped (no partial application) and neither `Ca` nor `Cb` is updated from that frame.
4. **Given** any of the above, **When** the frame is dropped, **Then** connection B stays
   open and receives no error or notification (matching the existing blocked-frame policy).

---

### User Story 2 - Legitimate presence keeps working (Priority: P1)

Every legitimate way a clientID appears in an awareness frame must continue to display
correctly. The guard must produce **zero** false-positive drops for the real
presence-lifecycle cases that exist in the code.

**Why this priority**: A guard that breaks reconnect, agent presence, import presence, or
multi-instance display would be worse than the cosmetic gap it closes. This is co-equal
P1 with US1 — the fix is only acceptable if it is invisible to honest traffic.

**Independent Test**: Exercise each enumerated legitimate case (below) and confirm
presence appears/updates/clears exactly as it does today.

**Acceptance Scenarios**:

1. **Given** a client announcing or updating **its own** clientID (cursor moves, the 15s
   heartbeat, name/colour set on connect), **When** the frame arrives, **Then** it is
   applied and broadcast normally.
2. **Given** a client clearing its own presence (`setLocalState(null)` — an agent session
   silenced on claim loss, or an app-close/stale-id removal of its own clientID), **When**
   the removal frame arrives, **Then** the client's own presence is removed normally.
3. **Given** a client whose prior connection was torn down and who **reconnects with the
   same stable clientID**, **When** it re-announces on reconnect, **Then** its presence is
   restored (the prior owner is gone, so the clientID is its to re-claim).
4. **Given** a server-side presence session (agent presence per feature 015, or import
   presence per feature 037) that connects as an ordinary WebSocket client with its own
   Yjs clientID, **When** it announces, **Then** it appears normally — it is announcing
   an id it controls, not a foreign one.
5. **Given** an awareness update arriving over the **cross-instance Redis relay** (applied
   with the Redis origin, no client connection), **When** it is applied, **Then** it is
   **not** subject to the per-connection guard — it carries clientIDs already validated on
   the originating instance.

---

### User Story 3 - Spoof attempts are observable without flooding logs (Priority: P2)

An operator can tell that awareness spoofing is being attempted, as a countable signal,
without a high-frequency attacker (awareness frames fire on every cursor move and every
15s heartbeat) drowning the logs.

**Why this priority**: Detection makes the guard operable and would surface an actual
social-engineering attempt, but the security property (US1) holds with or without it.

**Independent Test**: Send a sustained stream of spoofed awareness frames from one
connection and confirm a distinct countable event is emitted, and that the number of log
lines is bounded (rate-suppressed) rather than one-per-frame.

**Acceptance Scenarios**:

1. **Given** a connection sends a foreign-clientID awareness frame, **When** it is
   dropped, **Then** a distinct, named observability event is emitted that can be counted.
2. **Given** a connection sends many spoofed frames in a short window, **When** they are
   dropped, **Then** the emitted log volume is suppressed to a bounded rate rather than
   one line per dropped frame.

---

### Edge Cases

- **Unowned clientID (first announcement)**: a frame asserting a clientID that no
  connection currently owns is legitimate — that is exactly how a client's first
  announcement establishes ownership. It is allowed.
- **Reconnect race**: a client reconnects and re-asserts its stable clientID before the
  server has observed its prior socket close, so the prior connection still holds the id.
  A strict foreign-id rule would flicker the user's own presence. Resolved by the
  same-user tie-break (see Assumptions / clarifications ledger): a connection may assert a
  clientID also held by another connection **of the same authenticated user**.
- **Mixed frame (own + foreign ids)**: the whole frame is dropped; no partial apply.
- **Undecodable / malformed awareness payload**: a frame that fails to decode **before a
  single complete entry** asserts no ids; the guard lets it through and the applier's own
  handling stands (no new behavior, matching the edit gate's "undecodable ⇒ pass-through,
  y-websocket rejects it the same way" rule). A frame with a **decodable prefix** is a
  different case and is *not* covered by that rule: `applyAwarenessUpdate` is not atomic,
  so it applies entries 1..N-1 before throwing on entry N. Every clientID decoded before
  the failure therefore counts as asserted and is evaluated normally — otherwise
  `[spoof of Ca][garbage]` would pass the guard and still land. (Plan decision D-044-1,
  research R2; the guard's view of a frame must never be narrower than the applier's.)
- **Empty awareness frame (zero clients)**: asserts nothing; nothing to spoof; allowed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The server MUST drop — never apply, never re-broadcast, never relay
  cross-instance — any awareness frame arriving on a client WebSocket connection that
  asserts a Yjs clientID the connection does not legitimately control.
- **FR-002**: A connection legitimately controls a clientID when the clientID is (a) in
  that connection's own controlled-id set (already announced by it), (b) currently owned
  by **no** connection on the document, or (c) owned only by other connection(s) of the
  **same authenticated user** (self reconnect / multi-tab). Ownership is first-writer-wins
  per document and is derived from the per-connection controlled-id set the collaboration
  server already maintains for presence cleanup — this feature adds no second identity
  model.
- **FR-003**: The guard MUST extract the asserted clientIDs from the awareness frame by
  parsing it the **same way the applier parses it** (the same decoding primitive
  `applyAwarenessUpdate` uses, including acceptance of non-minimal varint encodings), so
  the guard's view of which ids a frame asserts cannot drift from the applier's view. (The
  038 varint lesson, applied to the awareness payload: message type → awareness sub-array
  → per-client clientID/clock/state.)
- **FR-004**: A dropped frame MUST NOT mutate any awareness state, MUST NOT be broadcast
  to other connections, and MUST NOT be published to the cross-instance relay. The
  offending connection MUST stay open and MUST NOT be notified (detection/drop only,
  matching the pre-existing `WS_EDIT_BLOCKED` policy — no disconnects).
- **FR-005**: The guard MUST NOT change edit-frame classification. Sync step1/step2/update
  gating (feature 038) is unaffected; awareness frames remain "not an edit." The guard is
  an additional, orthogonal check on awareness frames only.
- **FR-006**: The following legitimate cases MUST keep working unchanged (enumerated from
  the code, not guessed):
  - (a) a client announcing or updating its **own** clientID;
  - (b) a client removing its **own** clientID via a null-state frame (`setLocalState(null)`);
  - (c) a client reconnecting with a stable clientID after its prior connection was torn down;
  - (d) server-side agent-presence and import-presence sessions that connect as ordinary
    WebSocket clients with their own Yjs clientID;
  - (e) cross-instance awareness applied via the Redis relay (no client connection), which
    carries clientIDs already validated on the originating instance and is out of scope for
    the per-connection guard (FR-008).
- **FR-007**: When a frame is dropped, the server MUST emit a distinct, named, countable
  observability event, **rate-suppressed** so that a sustained stream of spoofed frames
  produces a bounded number of log lines rather than one per frame.
- **FR-008**: The guard applies only to awareness frames on authenticated client
  WebSocket connections. It MUST NOT gate the server's own cross-instance relay apply path
  (connection-less applies), which is not a client frame.

### Key Entities

- **Awareness frame**: an untrusted client message whose payload declares one or more
  `(clientID, clock, state)` tuples. The clientID is inside the payload and is
  client-chosen — the protocol does not bind it to the sender.
- **Controlled-id set**: the set of clientIDs a single connection has announced; the
  collaboration server already maintains one per connection for presence eviction on
  disconnect. It is the ownership record this feature reads.
- **Connection principal**: the authenticated user behind a connection (used only for the
  same-user tie-break in FR-002c).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The reviewer-reproduced spoof/evict has a **0%** success rate: a connection
  asserting another user's clientID can neither change nor remove that user's displayed
  presence, on the local instance or cross-instance.
- **SC-002**: **Zero** false-positive drops across the enumerated legitimate cases
  (FR-006 a–e): reconnect, own-id removal, agent presence, import presence, and
  multi-instance presence all display exactly as before.
- **SC-003**: Every distinct spoofing connection produces at least one countable
  observability event, and a sustained spoof flood produces a bounded (rate-suppressed)
  number of log lines rather than one per dropped frame.
- **SC-004**: Presence responsiveness for legitimate traffic is unchanged — the guard adds
  no round-trip and no perceptible latency to honest cursor/heartbeat updates.

## Assumptions

- **Ownership is first-writer-wins, not authenticated binding.** The Yjs clientID is
  client-chosen and the protocol authenticates it against nothing; the minimal integrity
  fix is to make ownership first-writer-wins per document, enforced from the controlled-id
  set the server already maintains. Cryptographically binding clientID to identity is out
  of scope and unnecessary for a cosmetic-blast-radius gap. (Ledger Q1.)
- **A mixed own+foreign frame is dropped whole**, not stripped-and-forwarded. Well-behaved
  clients only ever assert their own single clientID, so whole-frame drop has no cost on
  honest traffic and matches the 038 gate's "drop, don't rewrite" policy. (Ledger Q2.)
- **Same-user assertion is never a spoof.** A spoof is by definition a *different* user
  asserting your id; a connection asserting a clientID also held by another connection of
  the same authenticated user is a self reconnect/multi-tab case and is allowed — this
  also removes the reconnect-race false positive. (Ledger Q3.)
- **No telemetry counter infrastructure exists yet.** The 038 review recorded that
  `WS_EDIT_BLOCKED` is console-only with no counter; this feature builds the minimal
  rate-suppressed emission for its own event rather than assuming a metrics pipeline.
  (Ledger Q4.)
- **The enforcement point already exists.** The 038 edit gate intercepts each inbound
  frame before the collaboration library sees it; the awareness guard hooks the same
  interception point for awareness frames, so no new message plumbing is introduced.
- Design ground truth is `design/collaboration-core.md` (presence = Yjs awareness;
  eager disconnect eviction; agent presence via the same mechanism). This feature does not
  change any documented presence mechanism; if implementation reveals otherwise, the
  design doc must be amended per Constitution VI.

## Dependencies

- The per-connection controlled-id set maintained by the collaboration server for presence
  eviction (feature 038 US5 relies on the same set). This feature reads it; it must not
  break that cleanup contract.
- The 038 frame-interception wiring (`server/ws-edit-gate.js` install path) as the place
  the awareness check is added, without altering edit classification (FR-005).
