# Clarifications — 044-presence-awareness-guard

No blocking questions. Every open decision below was resolved with the best default and
recorded as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** per Constitution
Principle VI (work never blocks on the maintainer; nothing is decided silently). Each is
reversible in `/speckit-plan` if Sam overrides.

---

## Q1 — Ownership model: first-writer-wins vs authenticated clientID binding

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

**Question**: How is "a clientID this connection controls" established, given the protocol
does not bind a clientID to a sender?

**Why it matters**: Determines the whole shape of the guard and whether any new identity
model is introduced (Constitution VI: no second model of the protocol).

**Decision**: **First-writer-wins per document**, enforced from the per-connection
controlled-id set the collaboration server already maintains for presence cleanup. A
clientID belongs to the first connection to announce it; another connection asserting it
is a spoof.

**Rationale**: The Yjs clientID is client-chosen and unauthenticated by protocol design.
The blast radius is cosmetic. A cryptographic binding of clientID → identity would be a
second identity model to maintain and drift from (exactly the failure mode 038's review
called out three times). First-writer-wins reuses the set that already exists, adds no new
model, and is sufficient to stop cross-user hijack.

---

## Q2 — Frame asserting both own and foreign clientIDs: drop whole vs strip foreign

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

**Question**: When one frame declares the sender's own clientID *and* a foreign one, do we
drop the entire frame or re-encode it with the foreign entries removed?

**Why it matters**: y-protocols ships `modifyAwarenessUpdate` precisely to let a central
server strip hijacked identities and forward the rest — so stripping is a real option.

**Decision**: **Drop the whole frame.** Do not partially apply or re-encode.

**Rationale**: A well-behaved client's awareness handler only ever encodes its own single
clientID (`changedClients` is its own added/updated/removed set), so a mixed frame is
already anomalous and honest traffic never hits this path — whole-frame drop costs nothing
in practice. It also matches the 038 edit gate's ratified "drop the frame, do not rewrite
it" policy, keeping one blocked-frame behavior across the gate. `modifyAwarenessUpdate`
(strip-and-forward) is recorded as the considered alternative; adopt it only if a real
client is later found to legitimately batch multiple clientIDs per frame.

---

## Q3 — Reconnect race / same-user tie-break

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

**Question**: If a client reconnects with its stable clientID before the server has reaped
its prior socket, the prior connection still "owns" that id — should the new connection be
blocked?

**Why it matters**: A strict foreign-id rule would flicker a user's own presence on every
fast reconnect; a mishandled carve-out could reopen the spoof.

**Decision**: A connection **may** assert a clientID also held by another connection **of
the same authenticated user**. Only a *different* user asserting the id is a spoof.

**Rationale**: A spoof is by definition a different principal claiming your identity. A
connection sharing the authenticated user of the current owner is either the same person
reconnecting or another of their own tabs — never an attack, since that user can already
control their own presence. This carve-out removes the reconnect-race false positive
without weakening cross-user protection (the property SC-001 actually measures).

---

## Q4 — Observability event: name and rate-suppression

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

**Question**: What event is emitted on a drop, and how is it kept from flooding logs given
awareness frames are high-frequency?

**Why it matters**: The 038 review recorded that `WS_EDIT_BLOCKED` is console-only with no
counter, and that `WS_STEP2_BLOCKED` is noisy-by-frequency. An un-suppressed per-frame log
on a spoof flood would be a log-volume incident of its own.

**Decision**: Emit a distinct named event parallel to `WS_EDIT_BLOCKED` (working name
`WS_AWARENESS_BLOCKED`), **countable**, and **rate-suppressed** (e.g. log-first-then-sample
per connection) so a sustained spoof stream yields a bounded number of log lines. Build the
minimal suppression here rather than assume a metrics pipeline that does not yet exist.

**Rationale**: Meets the detection requirement (FR-007, SC-003) while respecting the
recorded absence of counter infrastructure; the distinct name keeps awareness spoofing
separately countable from edit-frame blocks, as 038 kept `WS_EDIT_BLOCKED` and
`WS_STEP2_BLOCKED` distinct.
