# Feature Specification: Agent Presence Deduplication Across Instances

**Feature Branch**: `015-agent-presence-dedup`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Fix duplicate in-app agent presence across server instances: a Redis-coordinated agent presence claim with work-follows-the-claim handoff (one agent avatar cluster-wide, full highlight fidelity from the pod doing the edits), plus the sessionsByKey cross-delete guard in server/mcp/agent-presence.js."

**Design ground truth**: `design/collaboration-core.md`, "Real-time sync" — **Amendment (Sam, 2026-07-18) — agent presence is Redis-claim coordinated across instances** (RATIFIED). Supporting context: `design/agent-surface-mcp.md`, "Agents are collaborators, not a backdoor". Diagnosed in prod 2026-07-18.

## Overview

When an AI agent works on a document, it appears to human collaborators as a live presence: a named avatar ("AgentName (UserName)"), a cursor, and animated highlights that sweep over the content it reads and edits. That presence is maintained by an agent presence session that each server instance holds in its own memory. With production now running two replicas behind non-sticky routing (the 010/011 cutover dropped the old ingress's client-IP affinity), successive tool calls in one agent conversation land on different pods, each pod creates its own session for the same user+agent+doc, and the cross-instance awareness relay faithfully merges both into every viewer's browser — Sam observed a duplicated "Squire Docs Assistant" avatar in prod on 2026-07-18.

This feature makes the agent's visible presence a cluster-wide singleton without dimming its activity stream: a shared presence claim (one per user+agent+document) decides which instance announces the agent, and the claim follows the work — the instance executing a tool call takes the claim over, so the highlights and cursor sweeps always come from the instance actually doing the reads and edits, at full fidelity. Instances that do not hold the claim keep their working sessions (their edits still merge — that is what the collaboration substrate guarantees) but stay awareness-silent. The feature also fixes a single-instance bookkeeping bug that lets duplicates snowball: a stale session's cleanup unconditionally deletes the session-key mapping even when a newer session owns it, orphaning the newer session so the next tool call spawns yet another one.

Single-instance and coordination-store-less deployments are explicitly unaffected: without the shared store the behavior is unchanged, and a single instance never duplicates.

## User Scenarios & Testing *(mandatory)*

The "users" of this feature are the human collaborators watching a document while an agent works on it, the user who invoked the agent (who trusts the presence display to reflect what their agent is doing), and the operator (Sam) running the multi-replica production cluster.

### User Story 1 - One agent avatar, cluster-wide (Priority: P1)

As a collaborator viewing a document while someone's agent is working in it, I see exactly one presence for that agent — one avatar, one cursor — no matter how many server instances are running or which instance handles each of the agent's tool calls.

**Why this priority**: This is the observed production defect. A duplicated agent avatar misrepresents who is in the document, undermines the attribution story that is Squire's core differentiator, and (via the snowballing bug in User Story 3) gets worse over the life of a conversation.

**Independent Test**: Run two server instances against the same database and coordination store with non-sticky request distribution. Drive an agent conversation whose tool calls alternate between instances while a browser client watches the document. The awareness roster visible to the browser contains at most one entry for that user+agent pair at every observation point outside a brief handoff transition.

**Acceptance Scenarios**:

1. **Given** two instances and non-sticky routing, **When** an agent's tool calls for one document land on both instances during one conversation, **Then** viewers of that document see exactly one avatar for that agent at any steady-state moment.
2. **Given** an instance whose session does not hold the presence claim, **When** that session is created or extended, **Then** it announces no presence (no user identity, no cursor) to viewers.
3. **Given** two agents (or the same agent for two different users, or the same agent on two different documents), **When** both are active concurrently, **Then** each distinct user+agent+document combination gets its own independent single presence — deduplication never merges or suppresses presences across distinct combinations.
4. **Given** a single-instance deployment or a deployment without the coordination store, **When** an agent works on a document, **Then** presence behavior is unchanged from today (one avatar, full activity), with no new errors or latency.

---

### User Story 2 - The presence follows the work: full highlight fidelity (Priority: P1)

As the user who invoked the agent (and any collaborator watching), every read and edit the agent performs is accompanied by its visible activity — cursor movement, sweep highlights over content being read, selections over content being modified — regardless of which server instance executed that particular tool call.

**Why this priority**: Ties with User Story 1 because a naive fix would silently break it. The agent's awareness is a live activity stream, not just an avatar: highlights are emitted by the session on the instance doing the work. If the announcing instance were fixed statically, an agent editing from a silenced instance would make invisible edits — content changing with no visible actor, which is worse than a duplicate avatar. The claim must therefore hand off to whichever instance executes the work.

**Independent Test**: With two instances, execute a read tool call on instance A, then an edit tool call on instance B, then another on instance A. Each call's highlights and cursor activity are observed by a watching browser client; at each point the announcing instance is the one executing the call.

**Acceptance Scenarios**:

1. **Given** the presence claim is held by instance A, **When** a tool call for the same user+agent+document executes on instance B, **Then** instance B takes the claim over, instance A silences its announced presence promptly on notification, and instance B announces the presence and performs the work — the activity stream (highlights, cursor, temporary selections) for that call comes from instance B.
2. **Given** a handoff has occurred, **When** viewers observe the document, **Then** they see one continuous agent presence (the avatar may blink briefly during the handoff — an accepted trade against a persistent duplicate, ratified via the design amendment, Sam, 2026-07-18).
3. **Given** any sequence of tool calls distributed across instances, **When** the conversation completes, **Then** no edit was performed without its visible activity: 100% of document-touching tool calls emitted their presence activity from the executing instance.
4. **Given** the instance executing a tool call already holds the claim, **When** the call executes, **Then** no handoff occurs — no blink, no re-announcement, behavior identical to today's single-session flow.

---

### User Story 3 - Duplicates must not snowball: the session-key cross-delete guard (Priority: P2)

As a user running a long agent conversation, stale presence sessions expiring in the background never orphan the live session, so tool calls keep reusing one session instead of accumulating new ones.

**Why this priority**: This is the single-instance bug that turns a transient duplicate into a growing one. When a stale session's cleanup runs, it deletes the session-key lookup entry unconditionally — even when a newer session for the same user+agent+document has since claimed that key. The newer session becomes unfindable and unextendable: the next tool call cannot reuse it and creates yet another session, so duplicates snowball. It is P2 only because User Stories 1–2 mask its cluster-wide symptom; it remains a correctness bug on a single instance.

**Independent Test**: Exercisable in the existing backend test suite without multi-instance setup: create a session, force it stale, create a replacement session for the same key, then run the old session's cleanup and verify the key still resolves to the replacement.

**Acceptance Scenarios**:

1. **Given** an old session for a user+agent+document and a newer session that now owns the same session key, **When** the old session's cleanup runs (timeout expiry, connection failure, or explicit clear), **Then** the key mapping still resolves to the newer session, which remains findable, extendable, and reusable by subsequent tool calls.
2. **Given** a session that still owns its own key mapping, **When** its cleanup runs, **Then** the mapping is removed as today — the guard only prevents deleting a mapping owned by someone newer.
3. **Given** a long-running conversation with repeated session expiry and recreation, **When** it runs for many cycles, **Then** the number of live sessions per user+agent+document never exceeds one.

---

### User Story 4 - Failover and fail-open: presence survives infrastructure trouble (Priority: P2)

As the operator, an instance crash, a rolling deploy, or a coordination-store outage never breaks agent editing and never leaves the agent invisible for more than a bounded window.

**Why this priority**: The dedup mechanism must not create new failure modes. Agent editing is a core product function; the coordination layer exists only for cosmetic correctness and must degrade toward availability.

**Independent Test**: Kill the claim-holding instance mid-conversation while a session survives on the other instance; measure time until the surviving session announces. Separately, stop the coordination store entirely and verify tool calls still succeed with visible presence.

**Acceptance Scenarios**:

1. **Given** the claim-holding instance dies without releasing its claim, **When** its claim expires, **Then** a surviving session for the same user+agent+document claims and re-announces — the avatar is absent for at most one claim-lifetime window (the accepted worst-case blink).
2. **Given** the claim-holding session ends cleanly (presence duration expires, session cleared), **When** its cleanup runs, **Then** it releases the claim it still holds so a surviving instance's session can claim without waiting for expiry.
3. **Given** the coordination store is unreachable or erroring, **When** an agent performs tool calls, **Then** every call succeeds with full presence activity — coordination failures never fail, delay, or silence the agent's work (duplicate avatars may transiently reappear during the outage; that is the accepted degradation).
4. **Given** the coordination store restarts and loses all claims, **When** active sessions next refresh, **Then** claims are re-established and steady-state single-presence resumes without operator action.

---

### Edge Cases

- **Rapid alternation of tool calls between instances**: each handoff re-points the presence; viewers see one moving presence, not flicker between two announced identities. Handoffs are cheap enough that alternating calls do not degrade tool-call latency.
- **Simultaneous first tool calls on two instances** (the race that created the observed duplicate): claim acquisition is atomic — exactly one instance wins the initial claim and announces; the loser proceeds awareness-silent. The subsequent work-follows-the-claim takeover still applies when the losing instance executes later calls.
- **Claim heartbeat vs. session lifetime**: the claim is refreshed for as long as its owning session is alive, and never outlives it — a claim must not pin the presence to an instance whose session has already been cleaned up.
- **Holder's session expires while a non-holder session survives**: covered by clean release (User Story 4, scenario 2) — the survivor takes over without a full expiry wait.
- **Takeover nudge lost or delayed**: the previous holder also stops announcing when it observes it no longer owns the claim (heartbeat refresh fails to confirm ownership), bounding a missed-nudge overlap to one heartbeat interval.
- **Notification arrives for a claim the instance never held or already released**: silencing is idempotent; no error, no effect on unrelated sessions.
- **The long-lived undo/redo session** (1-hour presence duration) participates in the same claim protocol as any session: while it holds no claim it is silent; it does not pin the claim beyond its heartbeat like any other session. (Its 1-hour orphan lifetime itself is out of scope — see Out of Scope.)
- **Cleanup ordering with the cross-delete guard**: cleanup of the older session must still fully release its own resources (connection, timers, undo history, memory) even when it skips deleting the key mapping it no longer owns — the guard must not leak.
- **Same user+agent active on many documents**: claims are per document; handoff on one document never silences or perturbs the presence on another.

## Requirements *(mandatory)*

### Functional Requirements

**Cluster-wide presence claim**

- **FR-001**: The system MUST maintain at most one announced agent presence per (user, agent, document) combination across all server instances, coordinated through a shared claim in the Redis coordination layer keyed `agent-presence:{userId}:{agentId}:{docGuid}` (Sam-ratified via design amendment, 2026-07-18).
- **FR-002**: Initial claim acquisition MUST be atomic with a time-to-live (acquire-if-absent with expiry: `SET NX PX`), so that concurrent first sessions on different instances resolve to exactly one announcing holder (Sam-ratified, 2026-07-18).
- **FR-003**: Only the claim-holding instance's session announces the agent in awareness (identity, cursor, highlights); sessions on non-holding instances MUST set no awareness state at all while not holding the claim.
- **FR-004**: Non-holding sessions MUST remain fully functional working sessions: document reads and edits through them succeed and merge normally (CRDT semantics); the only suppressed behavior is awareness announcement (Sam-ratified, 2026-07-18).
- **FR-005**: The claim holder MUST refresh its claim's expiry on a heartbeat for as long as the holding session is alive, and MUST stop refreshing when the session is cleaned up. On a heartbeat that discovers the claim is now owned elsewhere, the instance MUST treat itself as a non-holder and silence (backstop for a lost takeover notification).

**Work-follows-the-claim handoff**

- **FR-006**: When an instance executes a document-touching agent tool call for a (user, agent, document) whose claim it does not hold, it MUST take the claim over (unconditional claim write plus a cross-instance takeover notification) before or as part of announcing presence for that call (Sam-ratified, 2026-07-18).
- **FR-007**: On receiving a takeover notification (or otherwise observing loss of the claim), the previous holder MUST immediately clear its entire announced awareness state (the `setLocalState(null)` semantic — full state, not individual fields), without tearing down its working session (Sam-ratified, 2026-07-18).
- **FR-008**: The new claim holder MUST announce the presence and emit the tool call's complete activity stream — cursor position, read-highlight sweeps, temporary selections — from the instance executing the work. Highlight fidelity is a hard requirement: no document-touching tool call may execute with its visible activity suppressed or emitted from a different instance.
- **FR-009**: When the executing instance already holds the claim, the tool call MUST proceed exactly as today: no takeover, no notification, no re-announcement blink.

**Failover and release**

- **FR-010**: If a claim holder disappears without releasing (instance crash, network partition), claim expiry MUST allow a surviving session for the same (user, agent, document) to acquire the claim and re-announce. The presence gap is bounded by one claim lifetime (accepted blink; Sam-ratified, 2026-07-18).
- **FR-011**: A session's cleanup MUST release the claim if — and only if — that session's instance still owns it, so clean expiry hands presence to a survivor promptly while never deleting another instance's claim.

**Fail-open**

- **FR-012**: When no Redis coordination layer is configured, behavior MUST be unchanged from today: sessions announce as they do now, with no errors, no added latency, and no duplicate presence (single-instance deployments never duplicate) (Sam-ratified, 2026-07-18).
- **FR-013**: Runtime coordination failures (store unreachable, command errors, timeouts) MUST never fail, block, or measurably delay agent tool calls or edits. On coordination failure the session MUST degrade to announcing presence locally (availability of presence over deduplication); transient duplicates during a store outage are accepted.

**Instance-local session bookkeeping (the cross-delete guard)**

- **FR-014**: A session's cleanup MUST remove the session-key lookup mapping only when that mapping still points at the session being cleaned up; a mapping owned by a newer session MUST survive the older session's cleanup, leaving the newer session findable, extendable, and reusable.
- **FR-015**: Cleanup of a session that no longer owns its key mapping MUST still release all of that session's own resources (connection, timers, undo history, indexes keyed by session identity) — the guard changes only the shared key mapping, never the rest of teardown.
- **FR-016**: Claim state transitions (acquired, taken over, silenced, released, expired-failover, coordination-failure fallback) MUST be logged with the session key, sufficient for an operator to reconstruct which instance announced the presence at any time.

### Key Entities

- **Presence claim**: the cluster-wide, expiring record of which instance currently announces a given (user, agent, document) presence. Keyed by user + agent + document; carries an owner identity and a lifetime refreshed by heartbeat; at most one exists per combination; transferable by takeover, releasable by its owner, reclaimable on expiry.
- **Agent presence session** (existing, instance-local): the per-instance working session that connects to the document, performs edits, and emits activity. Gains a claim-relationship state: *holder* (announcing) or *silent* (working, not announcing). Multiple sessions for one combination may exist across instances; at most one is a holder.
- **Takeover notification**: the cross-instance message telling the previous holder to silence immediately, so handoff latency is one message hop rather than a claim-expiry wait.
- **Session-key mapping** (existing, instance-local): the lookup from (user, agent, document) to the live local session, used for reuse and extension. Invariant restored by this feature: it always points at the newest live session or nothing.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With two or more instances and non-sticky routing, viewers of a document see exactly one avatar per (user, agent, document) at every steady-state observation across an agent conversation whose tool calls span multiple instances — zero duplicated agent avatars (the observed prod defect) outside handoff/failover transitions.
- **SC-002**: 100% of document-touching agent tool calls display their activity (cursor, highlights, selections) to viewers, with the activity originating from the instance that executed the call — verified across a conversation deliberately alternated between instances. No invisible edits.
- **SC-003**: Handoff overlap and gap are transition-brief: after a takeover, the previous presence is silenced within one cross-instance notification hop (test bound: under 1 second — see ledger RBD-3), and viewers never see two announced presences for one combination persist beyond that transition.
- **SC-004**: After hard loss of the claim-holding instance, a surviving session re-announces within one claim lifetime (test bound: within the configured claim TTL — see ledger RBD-1); after a clean session expiry, a survivor re-announces without waiting for expiry.
- **SC-005**: Cross-delete guard: in a sequence of [old session goes stale → new session takes the key → old session's cleanup runs], the key still resolves to the new session and the next tool call reuses it — live sessions per (user, agent, document) on one instance never exceed one across arbitrarily many expiry/recreate cycles.
- **SC-006**: Zero regression without coordination: the full backend suite passes with no Redis configured, and single-instance agent presence behavior (announce timing, highlights, undo availability) is observably unchanged.
- **SC-007**: Zero coordination-induced failures: with the coordination store down or flapping, agent tool calls succeed at the same rate and latency as before this feature, and presence remains visible (duplicates tolerated only for the outage's duration).

## Out of Scope

Adjacent findings from the 2026-07-18 investigation, explicitly deferred (related, but not this feature):

- **The undo/redo 1-hour orphan session**: undo/redo tool calls create presence sessions with a 3600-second lifetime (`server/mcp/tools/undo-redo-handler.js`), far outliving the conversation. Under this feature such sessions are claim-silent like any other, which masks the visible symptom; shortening or restructuring their lifetime is separate work.
- **Sticky-session routing**: adding cookie-affinity annotations at the ingress would reduce (not eliminate) cross-instance spread but is an infrastructure change with its own trade-offs; the application-level claim must be correct regardless of routing.
- **Undo-stack pod-locality**: an agent's undo history lives in the instance that made the edits; cross-instance conversations can still find undo unavailable on the "wrong" pod. Orthogonal to presence announcement.
- **Human (browser) presence**: browser clients connect directly and are correctly deduplicated by the existing awareness mechanism; only agent-side sessions are in scope.

## Assumptions

- The Redis pub/sub layer (`server/redis-pubsub.js`) is the existing, appropriate channel for the takeover notification; deployments with Redis configured have it shared across all instances (true of the production topology). No new infrastructure is introduced.
- Claim coordination is best-effort by design: the CRDT layer guarantees edit integrity regardless of claim state, so every claim failure mode may safely resolve toward "announce anyway" rather than "block work".
- Production runs 2 replicas (HPA-capped) today; the design must be correct for N replicas, not just 2.
- The accepted UX degradations — a one-notification-hop blink on handoff and an up-to-one-TTL blink on hard failover — are ratified in the design amendment (Sam, 2026-07-18) and are not open questions.
- Decisions the design amendment did not settle (claim TTL/heartbeat values, runtime-error posture, handoff latency test bound, clean release-on-cleanup) are taken as best defaults and recorded as RATIFIED-BY-DEFAULT in `clarifications-needed.md` per Constitution Principle VI.
