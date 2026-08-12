# Feature Specification: Live-Document Consistency

**Feature Branch**: `057-live-doc-consistency` (spec directory; work is orchestrated on the current branch — no feature branch is created by the spec phase)

**Created**: 2026-08-12

**Status**: Draft

**Input**: User description: "057-live-doc-consistency: live-document consistency — torn reads, bindState trust, cross-replica reconciliation"

**Design ground truth**: `design/collaboration-core.md` — "Amendment (2026-08-11) — memoized readers do not self-heal (feature 057)" (committed 3f6b50fb), read together with "Amendment (Sam, 2026-07-18) — reads tolerate clock gaps (feature 021)", "Amendment (Sam, 2026-07-19) — clock order is causal order (feature 023)", and the "Per-identity server docs" section. Source field report: https://squiredocs.com/d/aa76378c-3002-4b76-935a-9f15bc7e376e (a prod read returned a snapshot labeled clock 9 containing updates {1, 5–9}, settling a minute later; the amendment is authoritative).

## Problem Statement

A document's durable truth is its append-only update log in Postgres, and its
live truth is a per-pod in-memory copy that y-websocket serves to browsers,
`read_document`, and `modify`. Four defects let those two truths silently
disagree, and — because the in-memory copy is memoized for the document's
registry lifetime — a disagreement, once created, is frozen and served to every
subsequent reader and writer on that pod:

- **Torn labels (Defect A)**: `read_document` serves content from the pod's
  in-memory copy but labels it with the database's newest clock, fetched by a
  separate query with no fence between them. The label can claim updates the
  content never integrated — exactly the field-reported "clock 9 containing
  {1, 5–9}" snapshot. The export path already fixed this identical two-source
  anti-pattern (capture one clock, build the body at exactly that clock);
  `read_document` never adopted it.
- **Permanent divergence (Defect B)**: cross-replica updates travel Redis
  pub/sub with no replay, no acknowledgement, and no post-bind reconciliation.
  A pod that misses a message (subscriber reconnect window, dropped delivery)
  diverges from the log and *stays* diverged until the doc happens to be
  evicted (~60 seconds of MCP-session idleness at best). Production runs two
  replicas; every fan-out loss is a user-visible consistency incident on one of
  them.
- **Untrusted loads trusted (Defect C)**: the bind-time load does not opt into
  the gap-detection machinery that feature 021 built (it exists and is exercised
  elsewhere), takes no expected tail clock, and then marks the doc bind-complete
  unconditionally. A torn or short load is memoized and *advertised trustworthy*
  to every consumer that checks the trust flag.
- **Premature readiness (Defect D)**: the agent-presence readiness gate counts
  the updates it expects, then resolves on the *first* update event without ever
  re-checking the count — an agent can start acting on a partially-integrated
  document that readiness declared ready.

Second-order effect: a diverged in-memory copy livelocks `modify`'s conflict
gate — the expected document is rebuilt from Postgres while the current content
comes from diverged memory, so every retry sees "content diverged" and refuses,
forever, on that pod.

The ratified contract (design amendment 2026-08-11): reads never label content
with a clock they did not integrate; bind refuses untrusted loads instead of
memoizing them; bound docs reconcile against Postgres (on fan-out reconnect and
via a cheap periodic check — Yjs updates are idempotent and commutative, so
over-applying is free); readiness waits for what it counted; and gapped/short
serves become visible in metrics instead of only in pod logs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A read is never labeled with a clock it did not integrate (Priority: P1)

An agent (or the chat assistant) reads a document via `read_document` while
edits are landing. The snapshot it receives is labeled with a clock that the
served content has actually, fully integrated. If the pod's copy is known to
lag the newest durable state, the response says so explicitly instead of
claiming currency it does not have. An agent baselining follow-up work on the
returned clock never silently loses the updates the label implied.

**Why this priority**: This is the field-reported defect the amendment
ratifies a fix for, and the one with the widest blast radius: every torn label
is a false promise to a caller that uses clocks as baselines (diffs, conflict
gates, sync). Honest labeling is also the observable symptom by which every
other defect in this feature was found.

**Independent Test**: Under a fault-injected lagging in-memory copy (doc
integrated through clock N, log at clock N+k), call `read_document` and verify
the labeled clock is N (the highest fully-integrated clock), a staleness
indicator is present, and the labeled clock is never N+k.

**Acceptance Scenarios**:

1. **Given** a bound doc whose in-memory copy has integrated updates {1..9}
   and a log whose newest clock is 9, **When** `read_document` runs, **Then**
   the response is labeled clock 9 with no staleness indicator.
2. **Given** a bound doc whose in-memory copy has integrated {1..5} while the
   log's newest clock is 9 (missed fan-out), **When** `read_document` runs,
   **Then** the labeled clock reflects only what the content integrated, the
   response carries an explicit staleness indicator, and a repair is triggered
   so a subsequent read converges to clock 9.
3. **Given** the field-report shape — content integrating {1, 5–9} (a torn
   load with an interior gap), **When** `read_document` runs, **Then** the
   label is the highest *contiguous* integrated clock (1), never 9.

---

### User Story 2 - A pod that misses fan-out converges without waiting for eviction (Priority: P1)

Two app pods serve the same document. Pod B misses a Redis pub/sub message
(subscriber blip, dropped delivery). Within a bounded, short window — not
"whenever the doc happens to be evicted" — pod B's copy has fetched and applied
the rows it missed from Postgres, and readers and editors on pod B see the same
document as pod A. An agent whose `modify` was refusing with a divergence error
on pod B succeeds once reconciliation has run.

**Why this priority**: This is the only mitigation that closes the fan-out-loss
window (design amendment, bullet 3). Without it, every other fix only makes
divergence honest; with it, divergence is bounded and self-healing. It also
dissolves the `modify` livelock, which otherwise makes an agent permanently
unable to edit through an affected pod.

**Independent Test**: Bind a doc on a pod, suppress fan-out delivery for one
update committed elsewhere, verify the pod diverges, then verify the periodic
check detects and repairs the divergence within one period and that a
previously-refused `modify` succeeds afterward.

**Acceptance Scenarios**:

1. **Given** a bound doc that missed one fan-out update, **When** the periodic
   divergence check runs, **Then** the pod fetches the rows above its
   integrated clock, applies them, and the in-memory copy equals the
   log-rebuilt doc.
2. **Given** a Redis subscriber that disconnects and reconnects, **When** the
   subscription is (re)established, **Then** every doc bound on that pod
   reconciles against Postgres, covering the entire blind window.
3. **Given** a pod whose diverged copy made `modify`'s conflict gate refuse
   with content-divergence on every retry, **When** reconciliation applies the
   missing rows, **Then** the same `modify` succeeds (regression test for the
   livelock).
4. **Given** reconciliation applies rows the pod had in fact already
   integrated (over-apply), **Then** the document content is unchanged and no
   spurious updates are persisted or broadcast (idempotence).
5. **Given** Redis is entirely unavailable, **Then** the periodic
   database-driven check still runs and still bounds divergence (fail-open:
   the repair channel does not depend on the broken fan-out channel).

---

### User Story 3 - Incomplete loads are refused, never memoized as trusted (Priority: P2)

A document's bind-time load races a mid-commit write, or returns fewer rows
than the log provably holds. Instead of freezing that torn snapshot into the
registry and advertising it trustworthy, the server refuses the bind; clients
retry with their existing backoff and the next attempt binds a complete load.
The trust flag consumers check (`live-doc-trust`) is only ever set over a
verified-complete load.

**Why this priority**: This closes the door through which a transient race
becomes a frozen, pod-lifetime lie. It reuses machinery that already exists
(the 021 gap-retry on reads, the 041 bind-refusal path); the change is that
bind *opts in* and refuses on incomplete instead of memoizing. It ranks below
Stories 1–2 because reconciliation (Story 2) would eventually repair even a
torn bind, and honest labels (Story 1) stop a torn bind from lying meanwhile.

**Independent Test**: Fault-inject a gapped row fetch at bind time and verify
the bind is refused via the existing refusal path (doc evicted, connections
closed with the retryable code, refusal metric recorded with a gap-specific
reason) and that the trust flag is never set; then let the fetch heal and
verify the retried bind completes.

**Acceptance Scenarios**:

1. **Given** a bind-time load whose fetched rows contain an interior clock
   gap that survives the in-call retry budget, **When** bindState runs,
   **Then** the bind is refused (no memoization, trust flag unset, doc
   evicted, clients told to retry) and a metric records a gap-typed refusal.
2. **Given** a bind-time load that returns rows short of the tail clock
   captured before the fetch (short read), **When** bindState runs, **Then**
   the bind is refused identically.
3. **Given** a transient gap that heals within the existing retry budget,
   **When** bindState runs, **Then** the bind completes normally, the trust
   flag is set, and no refusal is recorded.
4. **Given** a genuinely new document (zero rows), **When** bindState runs,
   **Then** the empty bind completes normally (a short-read refusal must not
   misfire on legitimate emptiness).

---

### User Story 4 - Readiness means the counted updates are integrated, and consistency defects are measurable (Priority: P3)

An agent session's readiness gate resolves only when the update count it
fetched has actually integrated into the session's doc, not on the first
update event. Separately, every gapped or short serve, every refused bind, and
every reconciliation repair emits a metric, so the operator can see the rate
of consistency defects in dashboards instead of grepping pod logs (the field
report's defect class was invisible until a user hit it).

**Why this priority**: Readiness is a narrower window than the other defects
(one gate at session start), and telemetry does not change behavior — but both
are ratified contract bullets and both are cheap once the machinery above
exists.

**Independent Test**: Delay integration of all-but-one counted update and
verify readiness does not resolve until the count is met (and that the
existing timeout still bounds the wait, resolving honestly). Verify each new
metric increments under its fault-injection scenario.

**Acceptance Scenarios**:

1. **Given** a readiness gate that counted N updates, **When** only the first
   update event has fired, **Then** the gate has not resolved; **When** the
   integrated contiguous state covers the counted updates, **Then** it
   resolves.
2. **Given** counted updates that never fully arrive, **When** the existing
   readiness timeout elapses, **Then** the gate resolves the way it does today
   on timeout (bounded wait; no hang; no behavioral regression).
3. **Given** a gapped serve, a short bind load, and a reconciliation repair
   (each fault-injected), **Then** each emits its distinct metric via the
   existing telemetry counter mechanism.

---

### Edge Cases

- **Persistent gap (potentially unbindable doc)**: feature 023's per-document
  write serialization should make *permanent* interior gaps impossible (a gap
  can only be observed mid-commit), but if one ever exists — e.g. operator
  surgery on the log — refuse-on-incomplete would refuse forever. Posture:
  fail closed and page (RBD-057-4); see the ledger and the flagged design gap.
- **Reconciliation racing local edits**: rows applied by reconciliation
  interleave with concurrent local transactions. Yjs idempotence/commutativity
  makes this safe by construction; reconciliation must apply with a
  non-persisting origin (like the existing db-load sentinel) so applied rows
  are not re-persisted or re-broadcast as new edits.
- **Reconciliation vs. the 021 editor invariant**: reconciliation only ever
  *applies missing updates* to the live doc. It never rebuilds, never
  delete-and-recreates, never "corrects" the doc toward a reconstruction —
  the y-tiptap never-destroy-remote-content invariants stay untouched.
- **Doc evicted mid-reconciliation**: a repair pass racing eviction must not
  resurrect the doc in the registry or leak listeners; applying to an evicted
  doc is a no-op path, not an error page.
- **Readiness gate on an empty or single-update doc**: counted = 1 must still
  resolve on that one update; counted = 0 (no updates) must resolve
  immediately.
- **Staleness marker on a fresh bind**: a doc read milliseconds after binding,
  before any fan-out arrives, must not carry a spurious staleness marker when
  the pod is in fact current (marker only when the same call's durable-clock
  query provably exceeds the integrated clock).
- **Both pods behind**: the periodic check on each pod compares against
  Postgres, not against the other pod, so mutual divergence heals on both
  sides independently.
- **Redis fully down**: fan-out is lost entirely; the periodic check becomes
  the sole propagation path and divergence stays bounded by one period
  (Story 2, scenario 5). No new hard dependency on Redis is introduced.
- **Refusal storms**: a database outage at bind time already pages through a
  per-document throttle; gap-typed refusals must not add unthrottled paging
  (RBD-057-3).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (one-source clock)**: `read_document` MUST serve content and clock
  label from one source of truth. The labeled clock MUST be the highest clock
  whose updates are contiguously integrated into the served content. It MUST
  be impossible for the label to claim a clock the content did not integrate.
  (Adopts the export path's capture-then-build atomicity contract; the
  concrete strategy default is RBD-057-1.)

- **FR-002 (staleness honesty)**: when the serving call can see that durable
  state is newer than what the served content integrated, the response MUST
  carry an explicit, machine-readable staleness indicator (labeled clock plus
  newest known durable clock), and MUST trigger a repair so subsequent reads
  converge. A current copy MUST NOT carry the indicator.

- **FR-003 (bind opts into completeness)**: the bind-time document load MUST
  opt into the existing gap-detection machinery and MUST capture an expected
  tail clock *before* the row fetch, so both interior gaps and short reads are
  detected. The existing in-call retry budget applies (RBD-057-3 keeps its
  current defaults).

- **FR-004 (refuse, don't memoize)**: a bind-time load that is still
  incomplete (gapped or short) after the retry budget MUST be refused through
  the existing bind-refusal machinery — no memoization, doc evicted,
  connections closed with the retryable code so clients retry — and the
  bind-complete trust flag MUST only ever be set over a verified-complete
  load. Refusal reasons MUST distinguish incomplete-load from load-error.

- **FR-005 (reconcile on fan-out (re)connect)**: whenever the cross-replica
  subscription is established or re-established, every document bound on that
  pod MUST reconcile against the durable log: fetch the rows above its
  integrated clock and apply them.

- **FR-006 (periodic divergence check)**: each pod MUST periodically compare
  every bound document's integrated clock against the durable log's newest
  clock via a cheap check, and MUST fetch-and-apply missing rows for any
  document found behind. Steady-state cost MUST be bounded independently of
  per-document row counts — the no-divergence case performs no per-document
  row fetches (cadence and cost bound: RBD-057-2). This path is the hot
  collaboration server; the check MUST NOT add latency to reads, edits, or
  fan-out application.

- **FR-007 (apply-only repairs)**: reconciliation MUST only apply missing
  updates to the live document. It MUST NOT rebuild the document, delete and
  recreate content, or mutate the document toward a reconstruction
  (Constitution IV; the 021 editor-binding invariants). Applied rows MUST use
  a non-persisting origin so they are neither re-persisted nor re-broadcast.

- **FR-008 (idempotent over-apply)**: reconciliation MUST be safe to run
  concurrently with live edits and safe to over-apply (rows already
  integrated): content is unchanged and no spurious updates are produced.

- **FR-009 (readiness waits for the count)**: the agent-presence readiness
  gate MUST resolve only when the update count it fetched has integrated into
  the session's document, not on the first update event. The existing
  readiness timeout MUST still bound the wait with today's timeout semantics
  (RBD-057-5).

- **FR-010 (telemetry)**: gapped/short serves, incomplete-load bind refusals,
  and reconciliation repairs MUST each emit a distinct counter through the
  existing telemetry-metrics mechanism (precedent: the bind-refusal counter),
  so defect rates are visible without log grepping.

- **FR-011 (livelock regression test)**: the suite MUST include a regression
  test proving that a pod whose diverged copy made `modify`'s conflict gate
  refuse converges after reconciliation and the same `modify` then succeeds.
  (The livelock is expected to resolve via reconciliation alone, with no
  change to the conflict gate itself; the test is the proof.)

- **FR-012 (supersession note)**: the 039-era read-completeness contract's
  "Non-consumers" section (its premise that serving-only readers "self-heal on
  the next read") is superseded by the 2026-08-11 design amendment for
  memoized/bound readers. The implementation MUST annotate
  `specs/039-diff-cache-integrity/contracts/read-completeness.md` (§
  Non-consumers) with a pointer to this feature rather than leaving the
  retired premise standing unqualified.

- **FR-013 (no Redis hard dependency)**: the repair machinery MUST fail open:
  with Redis unavailable, the periodic database-driven check still runs and
  still bounds divergence. Reconciliation MUST NOT make fan-out delivery a
  correctness precondition (that is the defect, not the fix).

### Key Entities

- **Durable update log**: the append-only per-document sequence of updates in
  Postgres, each at a unique clock; post-023, clock order is causal order by
  construction. The single source of durable truth.
- **Bound live document**: the per-pod in-memory copy serving browsers,
  reads, and edits for its registry lifetime; a cache of the log plus not-yet-
  persisted local edits — never the sole carrier of correctness (Constitution
  VII).
- **Integrated contiguous clock**: the highest clock N such that the live
  document has integrated every update ≤ N; the only clock a read may be
  labeled with.
- **Staleness indicator**: the explicit read-response signal that durable
  state is newer than the served content (integrated clock + newest known
  durable clock).
- **Bind trust flag**: the marker consumers use to decide whether the live
  copy may be used to derive durable artifacts; after this feature it implies
  a verified-complete load.
- **Reconciliation pass**: fetch rows above the integrated clock, apply them
  to the live document under a non-persisting origin; triggered by fan-out
  (re)connect, the periodic check, or a staleness-marked serve.
- **Bind refusal**: the existing fail-closed path (evict, retryable close,
  throttled page, counter) now also covering incomplete loads with a distinct
  reason.
- **Readiness gate**: the agent-session barrier that promises "the document
  you counted is the document you have".

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Under fault-injected torn and lagging loads, zero reads are
  labeled with a clock exceeding the content's integrated contiguous clock
  (the field-report shape — label 9, content {1, 5–9} — is impossible by
  construction, verified by test).
- **SC-002**: A pod that misses a fan-out message converges to durable truth
  within one reconciliation period (default cadence per RBD-057-2, ≤ 60
  seconds worst case) instead of waiting for document eviction; verified by a
  multi-instance integration test.
- **SC-003**: An agent whose edits were being refused by the divergence
  livelock succeeds on the first attempt after reconciliation, with no manual
  intervention (FR-011 test).
- **SC-004**: 100% of fault-injected incomplete bind loads are refused and
  retried to a complete bind; zero incomplete loads are memoized or marked
  trusted.
- **SC-005**: The steady-state cost of the periodic check is bounded and
  small: no measurable added latency on reads, edits, or fan-out application,
  and the no-divergence case performs no per-document row fetches (asserted
  by test on query behavior, not wall-clock).
- **SC-006**: Every defect class this feature addresses (gapped/short serve,
  incomplete-load refusal, reconciliation repair) is observable as a distinct
  metric; each is shown to increment under its fault-injection test.
- **SC-007**: The full existing collaboration/read/modify suites pass
  unchanged except where this feature's contract deliberately changes
  behavior (torn labels, unconditional trust flag, first-event readiness).

## Assumptions

- The 2026-08-11 design amendment is ratified ground truth; its four contract
  bullets plus the telemetry requirement (from the feature directive,
  following the existing bind-refusal counter precedent) define scope.
- The verified defect mechanism from the feature investigation is trusted
  as-is: two-source label in `server/mcp/tools/read-document.js` (content
  :111 vs clock :139/:148); no-replay fan-out (publish `server/index.js`
  :2205, apply :2148–2153, subscribe `server/redis-pubsub.js` :396–420, not
  awaited :2125); bind without gap detection or tail check and unconditional
  trust (`server/collab-bind-state.js` :275, :310; `server/live-doc-trust.js`
  :90); first-event readiness (`server/mcp/agent-presence.js` :372, count at
  :374 never rechecked); livelock (`server/mcp/tools/modify.js` :340–357).
- The 021/023 machinery is intact and reusable: gap scan
  (`server/postgres-persistence.js` `_findFirstGap` :402), bounded gap-retry
  (`_fetchRowsWithGapRetry` :455), per-document write serialization
  (`pg_advisory_xact_lock` :315), and the 041 refusal path
  (`server/bind-failure.js`). This feature wires existing machinery in, it
  does not rebuild it.
- `COLLAB_READ_GAP_RETRIES` is not overridden in production (defaults: 2
  retries / 400ms budget); RBD-057-3 keeps those defaults.
- Production topology is 2 app replicas (`k8s/base/app-deployment.yaml:7`)
  behind non-sticky routing; Constitution VII forbids solving any of this by
  pinning to one replica.
- Yjs update application is idempotent and commutative (design amendment,
  bullet 3): over-applying already-integrated rows is free. Reconciliation's
  correctness leans on this.
- Post-023 write serialization means observed interior gaps are transient
  (mid-commit) in an intact log; a *permanent* gap indicates log damage and
  is handled by posture, not by serving it (RBD-057-4).
- No schema change is expected: all state involved (rows, clocks) already
  exists; new state is in-memory bookkeeping (integrated clock) and counters.

### Considered and rejected (recorded per the design amendment)

- **Read-side advisory locks / transaction-visibility fences**: taking the
  per-document lock (or a txid-visibility fence) on the read path to close
  the mid-commit window. Rejected: the write path already serializes commits
  per document (023's `pg_advisory_xact_lock`), so DB-side ordering is not
  the dominant tear — fan-out loss is. Read-side locking would put a lock
  acquisition on the hottest read path to close the smaller half of the
  problem, and does nothing for a pod that missed a pub/sub message.

## Out of Scope

- **The sync/merge engine**: `server/markdown-sync.js` apply-correctness and
  receipt honesty belong to the sibling feature `056-sync-apply-correctness`.
  Boundary: 056 owns `markdown-sync.js`; 057 owns
  `server/mcp/tools/read-document.js`, `server/collab-bind-state.js`, the
  Redis pub/sub fan-out and its apply path (`server/redis-pubsub.js`,
  `server/index.js`), and `server/mcp/agent-presence.js`. Neither feature
  edits the other's files.
- **Changing `modify`'s conflict gate**: the livelock resolves via
  reconciliation; the gate's semantics are unchanged (FR-011 proves it).
- **Guaranteed-delivery fan-out** (Redis Streams, acks, replay cursors):
  reconciliation-against-Postgres is the ratified mitigation; replacing the
  transport is not.
- **Browser/client-side changes**: clients already retry refused binds with
  backoff (041); no client work is in scope.
- **Durable-before-broadcast** and the publish-before-commit attribution
  window (045's territory): unchanged by this feature.
- **The 021 editor-binding patches** (y-tiptap/y-prosemirror): untouched;
  this feature only adds an apply-only repair path that respects them.
- **Cursor-ops read-mutates-doc ticket** (read_document highlighting
  inserting empty nodes): separate known issue, not part of this contract.
