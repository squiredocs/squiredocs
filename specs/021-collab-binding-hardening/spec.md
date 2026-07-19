# Feature Specification: Collaborative Editor Binding Hardening

**Feature Branch**: `021-collab-binding-hardening`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Fix the confirmed viewer-attributed remote-content deletion bug in the collaborative editor binding (render-failure catch-blocks delete shared content; an unguarded selection-restore abort plus an ungated editor→Yjs diff 'corrects' the shared doc back to a stale view), add a server guardrail alert for the incident class, and make getYDoc reads clock-gap tolerant."

**Design ground truth**: `design/collaboration-core.md` (commit bcf3edc) — two amendments, both **the** design for this feature:

- Real-time sync → **Amendment (Sam, 2026-07-18) — the editor binding must never destroy remote content (feature 021)**: the four-part binding fix contract (never delete shared content on a render failure — log and skip; guarded selection restore with a safe near-fallback; the editor→Yjs diff gated on the transaction actually changing the doc; detected view/Yjs divergence resolved by re-rendering FROM Yjs, never by "correcting" Yjs from the view) plus the server guardrail (exception-notifier alert when a human-attributed update's delete set covers agent-created content younger than a few seconds).
- Persistence → **Amendment (Sam, 2026-07-18) — reads tolerate clock gaps (feature 021)**: getYDoc detects a clock gap in the fetched rows and briefly retries; a still-gapped result after the retry window is served as-is (the log is append-only — nothing is lost, the next read heals).

## Overview

Forensically confirmed incident (2026-07-18, doc 60c46c15): while an agent was writing into a document, a human who merely had the document **open** — not editing — became the attributed author of a deletion of the agent's freshly-arrived content. The mechanism lives in the collaborative editor binding (`@tiptap/y-tiptap` 3.0.1, `client/node_modules/@tiptap/y-tiptap/dist/y-tiptap.js`), which has two self-repair paths that destroy remote content:

1. **Delete-on-render-failure**: when constructing an editor node from a shared element throws, the catch-blocks in `createNodeFromYElement` / `createTextNodesFromYText` (dist ~859-866, ~894-899) **delete the shared element** — inside a transaction under the binding's own local origin, so the deletion is treated as a local edit: it rides the viewer's socket and is attributed to the viewer's identity (`server/index.js:1777-1779` stamps browser-socket updates with `ws.userId`).
2. **Stale-view write-back**: `_typeChanged` calls `restoreRelativeSelection` with no guard (dist ~690, ~645-700); a selection-restore throw aborts the remote-change render, leaving the editor view stale while the shared doc has advanced. The binding's plugin `update()` hook (dist ~237-273) then runs the full editor→Yjs diff on the **next transaction of any kind** — with no check that the transaction changed the doc — and "corrects" the shared doc back to the stale view, diff-deleting the fresh remote content under the viewer's identity.

Both paths violate the project constitution's Principle IV (collaboration-safe operations, honest provenance): the shared CRDT is damaged, and the damage is attributed to a user who did nothing.

This feature has three parts:

- **Binding fix (client)** — the four behaviors from the amendment, as testable requirements. Whether they are delivered as a patch to the installed dependency or a vendored fork is a plan-phase decision; the spec pins the behaviors **and** that they survive dependency reinstalls/updates (with an automated guard).
- **Server guardrail (detection, not prevention)** — an exception-notifier alert whenever a human-attributed update's delete set covers content an agent created within the last few seconds. The alert makes this class of silent data loss visible; it never blocks the update.
- **Read gap-tolerance (persistence)** — `getYDoc` (`server/postgres-persistence.js:211-235`) replays the update log in clock order with no gap tolerance, while clocks are assigned via MAX+1 retry races and commits land asynchronously; a read racing a mid-commit row can see `{…k, k+2…}` and integrate nothing causally after the gap (observed 2026-07-18: a headings-only skeleton read of a 6KB doc, self-healed on the next read). The fix: detect the gap, briefly retry, serve as-is after the window.

Recovery for past damage is out of scope: log-derived undo (feature 016) can invert viewer-attributed deletions once deployed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A watching viewer's browser can never destroy remote content (Priority: P1)

Sam has a document open in a browser tab while the Squire assistant (or any agent) writes into it. Whatever goes wrong in Sam's tab — a node that fails to render, a selection that cannot be restored, a viewport quirk on mobile — the shared document is never modified by the binding's error handling, and nothing is ever attributed to Sam that Sam didn't do. At worst, Sam's tab shows a degraded view (a skipped node, a repositioned cursor) that converges on the next successful render from the shared doc.

**Why this priority**: This is the confirmed incident: silent, viewer-attributed destruction of agent work. It breaks both product differentiators at once — real-time collaboration and honest attribution — and it is invisible to the victim (the watching human never knows their identity deleted anything).

**Independent Test**: Client-level binding tests that force each failure path (a test-injected throwing node view / schema trap; a selection-restore throw; a forced view/Yjs divergence followed by a doc-unchanged transaction) and assert the shared Y.Doc is byte-for-byte unchanged in every case.

**Acceptance Scenarios**:

1. **Given** a shared doc containing an element whose rendering throws in this client, **When** the binding renders remote changes, **Then** no content is removed from the shared doc, the failing element is skipped, every other element renders, and a log entry records the failure with enough context to debug (element/node type, document identity, the error). *(Incident path (a): today the catch-block deletes the shared element.)*
2. **Given** selection restore throws during a remote-change render, **When** the render runs, **Then** the render still commits with all remote content applied, and the selection degrades to a safe nearby position instead of aborting the render. *(Incident path (b) first half: today the throw aborts the render, leaving a stale view.)*
3. **Given** the editor view has diverged from the shared doc (forced, e.g. via an aborted render), **When** a transaction that does NOT change the editor doc occurs (a selection change, a metadata tick), **Then** no editor→Yjs write-back runs and nothing is deleted from the shared doc — the exact incident repro, as a client test. *(Incident path (b) second half: today the ungated diff deletes the fresh remote content.)*
4. **Given** the binding has detected view/Yjs divergence, **When** it resolves the divergence, **Then** it re-renders the view FROM the shared doc: the shared doc is unchanged and the view converges to it — never the reverse.
5. **Given** an element that fails to render on every attempt, **When** remote updates keep arriving, **Then** the binding keeps skipping that element without entering a rerender loop (no unbounded render/failure cycling, no log flood that makes the client unusable).

---

### User Story 2 - The incident class is visible within seconds, server-side (Priority: P2)

An operator (Sam) is alerted whenever any client — this fixed one, an old cached bundle, a future regression, a third-party client — produces a human-attributed update that deletes content an agent created moments earlier. The alert names the document, the human whose identity carried the deletion, the agent whose content was deleted, and the affected clock range, so the incident can be investigated and (via feature 016) reverted.

**Why this priority**: The client fix removes the known cause; the guardrail removes the *silence*. The incident went unnoticed until forensics — detection-in-seconds is what turns a future recurrence from silent data loss into a pageable event. It also protects against causes the client fix cannot reach (stale bundles, other clients).

**Independent Test**: Server-level test that replays the incident's signature (agent-attributed update creating content, then a human-attributed update whose delete set covers that content within the freshness window) and asserts an alert fires with the required fields; a control test with normal human edits (including a human legitimately deleting old agent content) asserts silence.

**Acceptance Scenarios**:

1. **Given** an agent created content in a document less than the freshness window ago (deployment-tunable, default ~10 seconds), **When** a human-attributed update arrives whose delete set covers that content, **Then** an alert fires carrying the document, the human user, the agent identity, and the affected clock range.
2. **Given** the same arriving update, **When** the guardrail evaluates it, **Then** the update is stored and broadcast exactly as today — the guardrail NEVER blocks, rejects, delays, or modifies an update. Detection only: false positives are acceptable; silence is not.
3. **Given** a human deletes agent content that is older than the freshness window (a normal editorial act), **When** the update is evaluated, **Then** no alert fires.
4. **Given** a malfunction produces a storm of matching updates, **When** alerts would fire repeatedly, **Then** alerting is rate-limited so the storm does not page-bomb, while still conveying that suppressed occurrences happened.

---

### User Story 3 - A document read never serves a torn snapshot when a brief retry would heal it (Priority: P3)

Any reader that rebuilds a document from the update log — version history, diffs, exports, MCP `read_document`, a fresh websocket bind — gets the complete document even when its read races a mid-commit update row. The observed failure (a 6KB document served as a headings-only early-history skeleton) self-heals within one short retry instead of reaching a user or an agent.

**Why this priority**: Real observed incident, but transient and self-healing by nature (append-only log; the next read was already correct). The damage is confusion and downstream misreads (an agent acting on a skeleton read), not data loss.

**Independent Test**: Persistence-level test that stores updates with clocks `…k, k+2…` (withholding `k+1`), issues a read, releases `k+1` during the retry window, and asserts the returned document is the complete one; a second test keeps the gap open past the window and asserts the read returns (as-is) rather than hanging or failing.

**Acceptance Scenarios**:

1. **Given** the fetched update rows contain a clock gap because a mid-commit row is in flight, **When** the document is rebuilt for a read, **Then** the read retries briefly and returns the complete document once the missing row lands (within the retry window).
2. **Given** the gap persists past the bounded retry window (e.g. the writer crashed before commit), **When** the retry window closes, **Then** the read is served as-is — the log is append-only, nothing is lost, and a later read heals — and the gapped serve is logged/observable.
3. **Given** gap-free rows (the overwhelmingly common case), **When** the document is rebuilt, **Then** behavior is unchanged and the read is not meaningfully slower than today.

### Edge Cases

- **Persistent render failure**: a node that fails on every render (not a transient race) is skipped every time; the binding must not spin retrying it (US1 scenario 5), and failure logging for a repeatedly-failing node must be bounded (not once per keystroke of every other collaborator).
- **Text-run render failure**: failures while materializing text runs (not just element nodes) take the same log-and-skip path — the incident's delete-on-catch exists in both the element and text paths.
- **Selection fallback bounds**: the "safe nearby position" must itself be safe — clamped to the rendered document's valid range, including the empty-document case.
- **Divergence with unsaved local typing**: re-rendering from the shared doc while the user has genuinely typed local edits must not discard those edits — local changes that reached the shared doc (the normal editing path) survive by construction; the divergence-resolution path only ever discards *stale view state*, never shared content.
- **Editor recreation**: the editor is recreated on mobile/provider changes (`client/src/components/Editor.jsx:124` — `[isMobile, provider]` deps); the fixed binding behaviors must hold across recreation (each new binding instance carries the fix; no window where a stock binding runs).
- **Guardrail attribution edge**: an agent-attributed update that deletes another agent's fresh content is not this incident class (default: alert only on human-attributed deleters — the incident's defining signature is *viewer* attribution; see RBD-2).
- **Guardrail vs. legitimate fast human revert**: a human genuinely deleting agent content within seconds (e.g. immediately rejecting an agent edit) will alert — accepted as a false positive by design (detection-only, never blocking).
- **Gap at the head of history**: gap detection concerns contiguity *within* the fetched rows; it must not assume a fixed first clock value.
- **Multiple gaps / large gap**: the retry window is bounded regardless of how many rows are missing; the window never compounds per-gap.
- **Empty or single-row reads**: trivially gap-free; zero added cost or behavior change.

## Requirements *(mandatory)*

### Functional Requirements

**Binding fix — the four amendment behaviors (client)**

- **FR-001**: A failure while rendering a shared element or text run into the editor MUST NOT delete, alter, or otherwise write to the shared document. The current delete-on-render-catch behavior is removed entirely: no code path in the binding's render direction (Yjs → view) may mutate the shared doc.
- **FR-002**: On a render failure, the binding MUST skip only the failing element and render the remainder of the document; a single bad node degrades one node, never the whole view and never the shared content.
- **FR-003**: Every skipped render failure MUST be logged with enough context to debug it: the element/node type, the document's identity, and the underlying error. Logging for a persistently-failing element MUST be bounded (no per-update log flood).
- **FR-004**: Render-failure handling MUST NOT trigger a rerender loop: a failing element that remains failing is skipped on subsequent renders without unbounded render/failure cycling.
- **FR-005**: A failure while restoring the selection during a remote-change render MUST NOT abort the render: the render commits with all remote content applied, and the selection degrades to a safe nearby position (clamped to the rendered document's valid range). The stale-view state that enabled the incident can no longer arise from a selection-restore throw.
- **FR-006**: The editor→Yjs write-back diff MUST run only when the triggering transaction actually changed the editor document. Selection changes, metadata transactions, and other doc-unchanged transactions MUST NOT cause any write to the shared doc — even (especially) when the view has diverged from the shared doc.
- **FR-007**: When the binding detects view/Yjs divergence, it MUST resolve it by re-rendering the view FROM the shared doc. Observable contract: the shared doc's content is unchanged by the resolution, and the view converges to the shared doc. The binding MUST NOT resolve divergence by "correcting" the shared doc from the view.
- **FR-008**: The four behaviors above MUST survive dependency reinstalls and updates: the delivery mechanism (patched installed package vs. vendored fork — plan decides) MUST include an automated guard that fails the build or test run if the underlying dependency changes out from under the fix (e.g. a version-pin test or patch-application verification), so a routine dependency bump cannot silently resurrect the incident.

**Server guardrail — detection, never prevention**

- **FR-009**: The server MUST raise an alert (via the existing exception-notifier channel) when a human-attributed document update's delete set covers content that was created under an agent identity within a freshness window of N seconds. N is deployment-tunable via environment configuration, defaulting to approximately 10 seconds.
- **FR-010**: The alert MUST carry: the document, the human user whose identity the deleting update rides, the agent identity whose content was deleted, and the affected clock range — enough to investigate and (via feature 016 once deployed) invert.
- **FR-011**: The guardrail MUST be detection-only: it never blocks, rejects, delays, or modifies the update it evaluates, and a guardrail evaluation failure never affects update persistence or broadcast. False positives are acceptable; silence is not.
- **FR-012**: Guardrail alerting MUST be rate-limited so a malfunction storm cannot page-bomb: repeated matches within the suppression window are summarized (the operator still learns suppressed occurrences happened), not individually paged.

**Read gap tolerance (persistence)**

- **FR-013**: When rebuilding a document from its update log, the read path MUST detect non-contiguous clocks within the fetched rows before serving the result.
- **FR-014**: On detecting a gap, the read MUST retry briefly within a bounded, deployment-tunable window (environment-configurable), returning the complete document as soon as a retry fetches gap-free rows.
- **FR-015**: A read still gapped when the retry window closes MUST be served as-is (never an error, never an unbounded wait) — the log is append-only and the next read heals — and the gapped serve MUST be observable (logged).
- **FR-016**: Gap-free reads MUST behave exactly as today: no retries, no added waits, and no meaningful slowdown of the hot path (gap detection cost on the order of a single pass over the already-fetched rows).

### Key Entities

- **Shared document (Y.Doc)**: the CRDT the collaborators converge on; the invariant this feature restores is that the binding's render/error paths are read-only with respect to it.
- **Update row (`yjs_updates`)**: one persisted update keyed `(doc_guid, clock)` carrying user and agent attribution — the substrate for both the guardrail (who created / who deleted, when) and gap detection (clock contiguity).
- **Delete set**: the set of content an update removes; the guardrail intersects a human-attributed update's delete set with recently-agent-created content.
- **Guardrail alert**: an exception-notifier event carrying document, human user, agent identity, and clock range; rate-limited under storm conditions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A forced render failure (test-injected throwing node view or schema trap) deletes NOTHING from the shared doc — byte-for-byte unchanged encoded state — while the remainder of the document renders and the failure is logged with node type, document, and error.
- **SC-002**: A forced selection-restore throw during a remote-change render still commits the render: all remote content is present in the view afterwards.
- **SC-003**: The incident's exact repro as a client test: force view/Yjs divergence, then dispatch a transaction that does not change the editor doc — the shared doc loses no content and no editor→Yjs write-back occurs.
- **SC-004**: The guardrail alert fires on the incident's signature (agent creates content; a human-attributed update deletes it within the freshness window) carrying document, user, agent, and clock range — and does NOT fire on normal human editing, including deletion of agent content older than the window.
- **SC-005**: Gap-read test: with row `k+1` withheld and then released during the retry window, the read returns the retried-complete document; with the row withheld past the window, the read returns as-is without error or hang.
- **SC-006**: All existing collaboration tests pass unmodified — the fixes change failure-path behavior only; every green-path behavior (sync, presence, undo, version history, attribution) is bit-identical.
- **SC-007**: A dependency reinstall (or simulated version bump of the bound editor-binding package) with the fix's guard in place either preserves the four behaviors or fails loudly — it can never silently revert to stock behavior.

## Dependencies & Sequencing

- **Parallel-safe with 018/019/020**: the client work (the binding fix) has NO file overlap with the in-flight 018/019/020 server work (search chunking, sync-path discoverability, undo/redo diffs); it can implement in parallel if a pipeline slot frees. The server pieces (guardrail, gap tolerance) touch server-side update handling and `server/postgres-persistence.js`, which none of 018/019/020 modify.
- **No migrations**: the guardrail reads existing per-update attribution; gap tolerance changes only read behavior. No schema changes.
- **Feature 016 (log-derived undo)** is the recovery path for viewer-attributed deletions (past and future); this feature only detects and prevents — it does not build recovery.

## Out of Scope

- **Upstreaming the fix**: contributing the patched behaviors to the upstream binding project is a worthwhile follow-up, not part of this feature.
- **The worklog in-place-edit convention**: already landed (commit 337b102), independent of this feature.
- **Feature 016 recovery flows**: inverting the incident's historical damage is 016's job once deployed.
- **A continuous view/Yjs divergence auditor**: divergence resolution (FR-007) applies where the binding detects divergence; a background integrity checker comparing view and shared doc on every transaction is not in scope (see RBD-3).

## Assumptions

- Per-update attribution in the update log (user and agent identity per row, stamped from the originating socket) is accurate and sufficient for the guardrail to classify updates as human- vs agent-attributed and to date agent-created content — no new attribution machinery is needed.
- The existing exception-notifier is the appropriate alert channel and reaches the operator (it already pages for terminal persistence failure).
- The binding's failure paths are exercised rarely in production once the incident's trigger class is fixed; bounded logging (FR-003) is a debugging aid, not a telemetry firehose.
- Client-side logging uses the existing client logging surface (console/error reporting as available); no new client telemetry pipeline is introduced.
- The retry in FR-014 re-fetches the document's rows (the gap heals because the racing commit lands); serving "as-is" after the window reproduces today's behavior for the pathological case, so the worst case is never worse than the status quo.
