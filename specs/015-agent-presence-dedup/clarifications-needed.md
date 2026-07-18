# Clarifications Ledger — 015-agent-presence-dedup

Decisions the design amendment (`design/collaboration-core.md`, "Real-time sync" —
**Amendment (Sam, 2026-07-18) — agent presence is Redis-claim coordinated across
instances**) did not answer were taken with the best default and recorded here as
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)** per Constitution Principle VI.

Decisions the amendment already made are Sam-ratified 2026-07-18 and are cited in the
spec, not re-decided: the claim key shape (`agent-presence:{userId}:{agentId}:{docGuid}`),
atomic `SET NX PX` acquisition + heartbeat refresh, only-the-holder-announces,
work-follows-the-claim takeover (unconditional SET + pub/sub nudge, previous holder
silences via `setLocalState(null)`), highlight fidelity as a hard requirement,
non-holders stay awareness-silent but fully working, TTL-expiry failover with an accepted
one-TTL blink, fail-open without Redis, the accepted handoff blink on pod bounce, and the
sessionsByKey cross-delete guard.

---

## RBD-1: Claim TTL and heartbeat interval values

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment mandates `SET NX PX` + heartbeat refresh but names no
  numbers. The TTL bounds the worst-case failover blink (US4/SC-004); the heartbeat
  bounds the missed-nudge overlap (FR-005) and the Redis chatter per active session.
- **Decision**: Claim TTL 15 seconds, heartbeat refresh every 5 seconds (TTL/3), both
  configurable via environment with these defaults (spec SC-004 test bound).
- **Why this default**: 15 s caps the failover avatar gap well under the 60 s default
  presence duration (a longer TTL would make the "blink" most of the presence's life),
  while TTL/3 heartbeats survive two consecutive missed refreshes before a false
  expiry — the standard lease ratio. Sub-second TTLs would make routine GC pauses or
  Redis latency spikes look like holder death. Env-configurable because prod topology
  tuning is an ops concern (hardened-cluster deploys), not a redeploy concern.

## RBD-2: Posture on Redis runtime errors mid-session

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment states fail-open when Redis is *absent* and that errors
  "must never break agent editing", but not what an announcing decision does when Redis
  is *configured but failing* (down, timing out, mid-restart).
- **Decision**: On any coordination error, the session behaves as if it holds the claim:
  it announces (or keeps announcing) and proceeds with full activity. Duplicate avatars
  are tolerated for the duration of the outage; normal claim behavior resumes when Redis
  recovers (spec FR-013, SC-007, US4 scenarios 3–4).
- **Why this default**: The failure hierarchy is unambiguous: an invisible working agent
  (silence on error) violates the highlight-fidelity hard requirement, while a transient
  duplicate is exactly the pre-feature status quo — cosmetic and self-healing. Fail
  toward availability of presence, matching the amendment's fail-open spirit.

## RBD-3: "Silences immediately" — the measurable handoff bound

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment says the previous holder silences "immediately" on the
  takeover nudge; a spec needs a testable bound for how long two announced presences may
  overlap during handoff.
- **Decision**: Silencing happens synchronously upon receipt of the takeover
  notification — the bound is one cross-instance pub/sub hop, asserted in tests as under
  1 second end-to-end (spec SC-003). The heartbeat (RBD-1) backstops a lost nudge at one
  heartbeat interval (FR-005).
- **Why this default**: One message hop is the physical floor for cross-instance
  signaling on the existing pub/sub channel; 1 s is a generous, non-flaky test ceiling
  for it. Anything stricter tests Redis latency, not our logic; anything looser would
  allow visible double-avatar dwell.

## RBD-4: Clean release of the claim on session cleanup

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment covers failover by TTL *expiry* (crash case) but does not
  say whether a session ending cleanly (presence duration elapsed, explicit clear)
  releases its claim or lets it expire.
- **Decision**: Cleanup releases the claim if and only if this instance still owns it
  (owner-checked delete), so a surviving instance's session can claim and re-announce
  without waiting out the TTL; the expiry path remains the crash backstop (spec FR-011,
  US4 scenario 2).
- **Why this default**: Letting a dead session's claim linger buys nothing and turns
  every routine expiry into a worst-case blink. The owner-check is required for
  correctness — an unconditional delete would recreate, at the cluster level, the exact
  cross-delete bug this feature fixes locally (an older actor deleting a newer owner's
  entry).

## RBD-5: Per-operation fail-open bound on claim commands (added at plan stage)

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: RBD-2 settles the *posture* on Redis runtime errors (announce anyway),
  but with the shared ioredis client's retry behavior (`maxRetriesPerRequest: 3`,
  backoff) a claim command against a flapping Redis can stay pending for multiple
  seconds — long enough to violate FR-013's "never measurably delay agent tool calls"
  before the error posture even engages. A concrete time bound is needed for when a
  pending claim operation is abandoned in favor of failing open.
- **Decision**: Every claim operation (acquire, takeover, refresh, release) is raced
  against `AGENT_CLAIM_OP_TIMEOUT_MS`, default **500 ms**, env-configurable like the
  RBD-1 values. On timeout (or error) the session proceeds as holder per RBD-2; the
  abandoned command's eventual settlement is swallowed. Recorded in plan.md
  (Architecture Decision 5) and contracts/presence-claim.md § D.
- **Why this default**: 500 ms is two orders of magnitude above healthy in-cluster
  Redis round-trips (sub-5 ms), so it never fires in normal operation, yet keeps the
  worst added tool-call latency during a brownout well under perceptibility against
  multi-second tool calls. Letting ioredis retries run to completion would produce
  seconds-scale stalls — a direct FR-013 violation; failing open instantly on first
  error without any wait would flap the claim state on single dropped packets.
