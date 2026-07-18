# Quickstart Validation — 015-agent-presence-dedup

How to prove the feature works. References: [contracts/presence-claim.md](contracts/presence-claim.md),
[data-model.md](data-model.md), spec Success Criteria SC-001..SC-007.

## Prerequisites

- Repo working tree with the feature implemented; Node 22+.
- Backend Jest runs **serially** against the shared test DB (Constitution II) —
  inside the app-dev pod, or locally per the local-backend-test-stack setup.
- No live Redis needed for any automated scenario (all claim tests use the
  in-memory fake).

## Automated scenarios (the authoritative gate)

Run the feature's suites (serial):

```bash
cd /local-dev
npx jest --runInBand \
  server/mcp/__tests__/agent-presence.test.js \
  server/mcp/__tests__/presence-claim.test.js \
  server/mcp/__tests__/presence-claim-failopen.test.js \
  server/mcp/__tests__/presence-handoff.test.js \
  server/mcp/__tests__/presence-multi-instance.test.js \
  server/__tests__/redis-pubsub.test.js
```

Expected outcomes per scenario:

| Scenario | Suite | Proves |
|---|---|---|
| Claim acquire / heartbeat refresh / owner-checked release vs mocked Redis | `presence-claim.test.js` | FR-002, FR-005, FR-011; contract E1/E5/E6 |
| Atomic first-claim race: two instances, one winner | `presence-multi-instance.test.js` | FR-002, spec edge "simultaneous first tool calls" |
| Takeover handoff: `ensureHeldForWork` on non-holder flips owner, publishes one nudge; receiving instance silences via `setLocalState(null)` while its session stays alive | `presence-handoff.test.js` | FR-006/007/008, SC-003 (asserted < 1 s with fake timers) |
| Holder path no-op: no nudge, no re-announce | `presence-handoff.test.js` | FR-009 |
| TTL failover: holder vanishes, fake clock advances past TTL, survivor probe acquires and re-announces | `presence-handoff.test.js` | FR-010, SC-004 |
| Clean release pickup: cleanup releases, survivor acquires within one heartbeat (no TTL wait) | `presence-handoff.test.js` | FR-011/RBD-4, SC-004 |
| Heartbeat backstop: lost nudge, holder's refresh sees foreign owner, silences | `presence-handoff.test.js` | FR-005, spec edge "nudge lost" |
| Fail-open, Redis absent: no REDIS_HOST → announce as today, zero claim I/O | `presence-claim-failopen.test.js` | FR-012, SC-006 |
| Fail-open, Redis erroring/timing out: ops resolve holder-favoring within `AGENT_CLAIM_OP_TIMEOUT_MS`, tool path never rejects, recovery resumes claiming | `presence-claim-failopen.test.js` | FR-013/RBD-2/RBD-5, SC-007, US4-3/4 |
| Cross-delete guard: stale session cleanup leaves a newer session's key mapping intact; own-mapping cleanup still deletes; full resource teardown either way | `agent-presence.test.js` | FR-014/015, SC-005, US3 |
| Awareness gating: silent sessions perform zero awareness writes; cursor still recorded locally; holder announces user+cursor | `agent-presence.test.js` | FR-003/004, US1-2 |
| Multi-instance simulation: two module instances, one fake Redis + bridged pub/sub, alternating `ensureHeldForWork` calls → at most one holder at every steady-state point, activity always from the executing instance | `presence-multi-instance.test.js` | SC-001/002, US1/US2 |
| Nudge channel: encode/route/self-filter on `presence-claim` channel | `redis-pubsub.test.js` | Contract C |

Then the regression gate (full backend suite, serial, no Redis configured):

```bash
npx jest --runInBand server
```

Expected: everything passes with REDIS_HOST unset — SC-006's "zero regression
without coordination".

## Manual validation (maintainer, post-deploy — mirrors the prod diagnosis)

1. **Steady-state singleton (SC-001)**: on the 2-replica cluster, open a document in
   a browser, run an in-app assistant conversation with several reads/edits. Watch
   the avatar row: exactly one "Squire Docs Assistant (…)" at all times outside
   sub-second handoffs. Grep both pods' logs for `[presence-claim]` and confirm the
   takeover/silence pairs line up with which pod served each tool call (FR-016).
2. **Highlight fidelity (SC-002)**: confirm every read/edit shows its sweep/selection
   in the browser regardless of serving pod.
3. **Failover (SC-004)**: mid-conversation, `kubectl delete pod` the claim holder
   (log-identified). Avatar may blink ≤ ~15 s, then returns; editing never breaks.
4. **Store outage (SC-007)**: scale Redis down briefly. Tool calls keep succeeding
   with visible presence (duplicates tolerated); recovery restores the singleton
   without restarts.

Manual steps stay with the maintainer per pipeline convention; the Jest scenarios
above are the merge gate.
