# Feature Specification: Version History Truth — Attribution Correctness and Failure-Path Honesty

**Feature Branch**: `041-version-history-truth` (parallel-pipeline feature; work happens on `main` per pipeline overrides)

**Created**: 2026-08-02

**Status**: Merged (2026-08-02)

**Input**: User description: "041-version-history-truth — attribution correctness and failure-path honesty in version history. Covers deep-dive report items A1, A2, A4, A5, B2-B9 (excluding B1), A3 (narrow), D3-D5 doc honesty; A6/A7 at spec author's discretion."

**Source material**: `/local-dev/tmp/version-history-deep-dive-2026-08-02.md` (2026-08-02 deep-dive report). All report claims cited below were re-verified against the code on 2026-08-02 by this spec's author.

**Design ground truth**: `design/collaboration-core.md`, including the 2026-08-02 amendment (Sam D19): a human web-UI restore records NO edit record and is NOT an undo target; only agent/MCP restores are recorded and undoable by that agent. Nothing in this feature revives what 040 D19 cut.

## Product framing

Squire Docs' product promise for this area is **100% accurate attribution, never lose edits**. The core machinery honors that promise; the edges do not. Today the product can show the wrong author list on a named version, render a database outage as "No version history yet", silently bind an empty document over a load failure, count invisible noise edits in drill-down counts, stamp a chat card "Reverted" when a different edit was undone, and block undo for a minute after a routine reconnect. Each of these is a place where what the user sees diverges from what actually happened. This feature makes the displayed story match the recorded truth, and makes every remaining degradation loud instead of silent.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Named versions and drill-downs credit exactly the right people (Priority: P1)

A collaborator opens version history on a shared document. Named versions show, as contributors, exactly the people (humans and agents) whose edits fall inside that named version's own range — never someone who only edited elsewhere in the surrounding activity burst. Expanding a version into its individual edits shows the same set of edits, with the same counts, that the timeline itself accounts for.

**Why this priority**: Attribution is the product's differentiator. A named version crediting a person who never touched it is the most direct violation of "100% accurate attribution" in the whole report, and it is user-visible on every shared document.

**Independent Test**: On a document where user A edits, then user B edits later within the same activity burst, name a version covering only A's range. The named version must list only A. Expand any version containing noise-classified edits: the drill-down must show only the edits the timeline counts, and its edit counts must match the timeline's accounting.

**Acceptance Scenarios**:

1. **Given** an activity burst where user A makes edits at clocks 1-5 and user B at clocks 6-10, **When** a named version is created covering clocks 1-5, **Then** the named version lists only user A as an author (plus its creator badge), and user B is not credited.
2. **Given** the same burst, **When** the surrounding auto-version is split into fragments around the named version, **Then** each fragment lists only the authors (and sync-push provenance) of edits within that fragment's own range.
3. **Given** a version range containing edits classified as meaningless noise, **When** the user expands that version's individual edits, **Then** noise-only sub-groups are hidden by the same rule the timeline uses (explicit noise dropped; unknown kept), and each sub-group's edit count counts only the edits the timeline would count — the drill-down and the timeline never disagree on totals.
4. **Given** a named version whose boundary edit was classified as noise, **When** the timeline is rendered, **Then** the named version still shows the correct authors and timestamp derived from its own range instead of an empty author list with a fallback timestamp.

---

### User Story 2 - Failures look like failures, never like an empty or new document (Priority: P1)

When the system cannot load version history, a diff preview, or the document itself, the user sees an explicit error they can retry — never a screen that claims the data does not exist.

**Why this priority**: This is the "never lose edits" promise seen from the user's chair. A transient 500 that renders as "No version history yet", or a database outage that opens a document as blank, reads as permanent data loss and can *cause* real damage (a client with local state re-supplying a whole document as new edits under its own attribution).

**Independent Test**: Simulate a failing history endpoint and a failing diff endpoint while opening version history: both must render error states with no empty-state text. Simulate a storage failure while opening a document with existing content: the document must refuse to open (client retries) rather than open blank.

**Acceptance Scenarios**:

1. **Given** the history timeline request fails, **When** the version history panel renders, **Then** it shows an error state ("couldn't load history" + retry affordance), and never the "No version history yet" / "Edit the document to start tracking" empty state.
2. **Given** a version is selected and its diff request fails, **When** the preview area renders, **Then** it shows an error state, never the neutral "Select a version to preview" placeholder.
3. **Given** the document store is unreachable, **When** a client opens a document that has persisted content, **Then** the collaboration session is refused/failed so the client retries — an empty document is never served in place of a load failure — and the failure is reported to the exception notifier (not logged as a routine new-document event).
4. **Given** a genuinely new document (no persisted state, no error), **When** a client opens it, **Then** it still opens normally as an empty document.

---

### User Story 3 - The open history panel stays truthful over time (Priority: P2)

While a user has the version history panel open, what it displays tracks reality: new edits from collaborators appear, renames and boundary changes are reflected in the header and contributors, and expanded drill-downs never show stale or falsely empty content after a change.

**Why this priority**: These are the places the UI actively shows *wrong* labels (stale header title, stale contributors, a restore button acting on a version id from a pre-split world, false "No individual updates"). Wrong beats missing in severity, but the blast radius is the open panel only, hence P2.

**Independent Test**: With the panel open and a version selected, rename that version (or trigger an auto-resplit by naming a mid-range clock) from the same or another session; the header, contributors footer, and restore gating must update. Separately, with a version's drill-down expanded, perform a rename/delete/name operation and confirm the drill-down reloads instead of showing "No individual updates".

**Acceptance Scenarios**:

1. **Given** a version is selected and the history list refreshes (after rename, naming, delete, restore, or live refresh), **When** the refreshed list arrives, **Then** the selection is reconciled against the fresh list: header title, contributors, current-version status, and restore gating reflect the refreshed version, and a selection that no longer exists is handled explicitly (reselect its successor or clear with the default selection rule) rather than left pointing at a stale snapshot.
2. **Given** naming a mid-range clock split the containing version, **When** the user uses the header "Restore this version" button, **Then** the restore acts on a version that exists in the post-split world — never on a click-time version id whose range no longer exists.
3. **Given** the panel is open while a collaborator edits the document, **When** new edits are recorded, **Then** the timeline reflects them without requiring the user to close and reopen the panel.
4. **Given** a version row is expanded showing individual edits, **When** any operation triggers a history refresh, **Then** expanded rows re-fetch their individual edits; the user never sees "No individual updates" for a version that has them.

---

### User Story 4 - Restore does exactly what its label claims (Priority: P2)

When anyone restores a version, the stored restore operation is exactly the transition the user was shown: computed against the document as it actually is at that moment, refusing (with a clear retry message) when the historical record cannot be completely read, and never corrupting server memory bookkeeping for documents nobody has open.

**Why this priority**: Restore is the highest-stakes write in the area. Today its stored row can silently differ from its label when live edits interleave, its fail-closed read has a hole (a short tail passes the completeness check), and restoring an unopened document permanently leaks server state.

**Independent Test**: Restore a version while a concurrent editor types; the stored restore transition must be built from the live document state (concurrent edits are not silently folded into the "restore" row's before-state from a stale read). Restore against a truncated update log tail; the restore must refuse. Restore a document no one has open; server memory must not retain a loaded copy afterwards.

**Acceptance Scenarios**:

1. **Given** the document is loaded in memory on the serving instance, **When** a restore executes while live edits are arriving, **Then** the restore delta is built from the live document state within a transaction on that document, so the stored restore row is the actual transition applied — concurrent edits do not interleave invisibly between "what was read" and "what was stored".
2. **Given** the update log for the target version is missing rows at its tail (not just interior gaps), **When** a restore is requested, **Then** the target read detects the incomplete tail and the restore refuses with the existing "still syncing — retry" behavior; no restore row is stored.
3. **Given** a document that is not loaded on any instance, **When** it is restored (or an agent edit on it is undone/redone), **Then** the operation uses an honest is-loaded check — it must not implicitly create an in-memory document — and after the operation completes, server memory holds no leaked loaded document.
4. **Given** the restore succeeds, **Then** attribution and undo behavior follow the 2026-08-02 design amendment exactly: a human web-UI restore records no edit record; an agent/MCP restore is recorded under the acting agent and undoable by that agent.

---

### User Story 5 - Undo is available when it should be, and "Reverted" never lies (Priority: P2)

The chat Undo works immediately after routine reconnects instead of claiming an edit is "still being recorded", and a chat card only ever gets stamped "Reverted" when the edit on that card is the one that was actually undone.

**Why this priority**: The undo surface is how users trust agents. A 60-second false lockout after every reconnect erodes it slowly; a card that says "Reverted" about the wrong edit is a direct attribution lie (reachable across a user's chats and by direct API call).

**Independent Test**: After a client reconnect re-supplies updates (sync-channel rows), invoke undo immediately: it must not be blocked by the pending-recording guard. Undo from a chat card whose edit is not the actual LIFO undo target (e.g. a newer edit from another chat exists): the undo may proceed per existing semantics, but the card must not be stamped "Reverted"; the mismatch is logged.

**Acceptance Scenarios**:

1. **Given** the newest log row for the acting identity is a sync-channel (reconnect catch-up) row, **When** undo status or undo is requested, **Then** the pending-recording guard ignores sync-channel rows and undo proceeds normally — reconnects never produce "still being recorded — retry shortly".
2. **Given** an undo request carries a chat card reference, **When** the undo succeeds, **Then** the system verifies the card's recorded edit range corresponds to the record actually undone before stamping; on match the card is stamped, on mismatch the stamp is skipped and the mismatch is logged.
3. **Given** a direct API call supplies an arbitrary card reference, **When** the undo succeeds against some other record, **Then** that card is not stamped "Reverted".

---

### User Story 6 - Silent degradations become loud (Priority: P3)

Every remaining path where attribution or undo correctness degrades leaves an explicit trace: a marker in the record, a log line, and (for attribution loss) a notification — nothing degrades invisibly.

**Why this priority**: These paths are rare and currently believed unreachable or near-unreachable; the requirement is observability, not new behavior. But an invisible degradation in the attribution system is a slow poison for the product promise.

**Independent Test**: Feed the persistence path a null/primitive transaction origin: the stored row must carry a malformed-origin marker and the event must be logged and reported like the other malformed-origin classes. Review the undo inverse-computation fallback: it must either enforce the sync-channel exclusion or carry a load-bearing explanation of why it cannot be reached with sync rows.

**Acceptance Scenarios**:

1. **Given** an update arrives with a null or primitive (non-string, non-object) transaction origin, **When** it is persisted, **Then** it persists unattributed WITH a malformed-origin marker, an error log, and the same notification treatment as the existing malformed-origin classes — never a silently clean-looking unattributed row.
2. **Given** the undo inverse computation falls back to a spanning clock range, **When** that code path is reviewed or exercised, **Then** it either excludes sync-channel rows by the same guard the legacy path uses, or carries an invariant comment stating exactly why sync rows cannot reach it — the current silence (correct only by timing) is eliminated.

---

### User Story 7 - The code's own story matches the shipped behavior (Priority: P3)

Developers and agents reading the undo/restore code and the MCP tool descriptions get the post-040-cut truth: human web-UI restores are not recorded and not undo targets; agent restores are recorded edits the agent's own undo tool inverts.

**Why this priority**: Stale docstrings are how the next regression gets written — agents take docs literally (Constitution Principle I). Pure documentation, so P3.

**Independent Test**: Read the chat-agent identity module, the edit-records sentinel-rule comment, and the MCP restore tool description; each must describe current behavior with no pre-cut claims.

**Acceptance Scenarios**:

1. **Given** the chat-agent identity module's docstring, **Then** it no longer claims a web-UI restore is recorded under the chat-assistant identity; it describes the identity's actual current uses.
2. **Given** the edit-records sentinel-rule comment, **Then** it no longer says the chat-assistant identity "is what a human web-UI restore now records under".
3. **Given** the MCP restore tool description, **Then** it tells agents the truth: an agent's restore is itself a recorded edit that the agent's own undo tool can invert (in addition to counter-restore), per the design amendment.

---

### Edge Cases

- Named version range contains zero attributed rows after author-scoping (all rows lost their user): the version shows the single "Unknown author" entry (existing 040 FR-008 rule), not an empty list.
- Named version range contains only noise-classified rows (report A7): authors/timestamp derive from the range's rows under the timeline's keep-unknown/drop-noise rule; if that leaves nothing, fall back per FR-003 (never a crash, never a phantom author from outside the range).
- Selection reconciliation when the selected version was deleted (named version removed): clear or reselect per the panel's default-selection rule; never keep operating on the deleted id.
- History refresh returns an error while a selection exists: the panel shows the error state; the last-good list may remain visible, but no operation may act on stale ids without a reconcile.
- Live refresh while the user is scrolled into older history: refresh must not yank scroll position or collapse the user's expansions (expansions re-fetch, not reset, where the version still exists).
- bindState failure on a document that truly has no rows yet vs. a query failure: only an actual load error fails the bind; "no rows" remains the legitimate new-document path.
- Restore requested while the document is NOT loaded in memory anywhere: the live-doc transaction path does not apply; the restore proceeds via the durable-log path (current behavior) with the B7 tail check; cross-pod serialization remains a documented residual (see Assumptions).
- Undo card-stamp verification when the chat part predates range recording (no stored edit range on the card): skip the stamp and log — absence of evidence is a mismatch, not a pass.
- Repeated bind failures during a sustained outage: refusing the bind must not create a crash loop or unbounded notification spam (notification path may dedupe/rate-limit per its existing conventions).

## Requirements *(mandatory)*

### Functional Requirements

**Attribution accuracy (US1)**

- **FR-001**: A named version's author list MUST be computed from the edit rows within its own clock range (`clock_start`..`clock_end`), applying the same meaningful-filter rule as the timeline (explicit noise dropped, unknown kept). It MUST NOT inherit the containing auto-version's author list. (Report A1; `server/version-history.js:285-304`.)
- **FR-002**: When an auto-version is split into fragments around named versions, each fragment MUST carry only the authors and on-behalf-of provenance of rows within the fragment's own clock range — never the parent auto-version's full lists. (Report A1; `server/version-history.js:335-341` and the pre-range fragment.)
- **FR-003**: A named version MUST resolve authors and timestamp from its own range even when no matching auto-version exists (e.g. its boundary row was noise-classified). An empty author list is permitted only when the range genuinely contains no rows at all; rows without user attribution follow the existing Unknown-author rule. (Report A7, folded into A1's fix since both are cured by range-scoped author computation.)
- **FR-004**: The sub-version drill-down MUST apply the same meaningful-filter rule as the timeline before grouping, and each sub-version's displayed edit count MUST count only the rows that survive that filter (not `clockEnd - clockStart + 1`). Timeline totals and drill-down counts MUST agree for the same range. (Report A2; `server/version-history.js:754-773`, `:791`.)

**UI truth (US2, US3)**

- **FR-005**: A failed history timeline load MUST render a visible error state with a retry affordance. The "No version history yet" empty state MUST render only when a successful response contains zero versions. (Report B4; the hook's existing error state must actually be rendered — `useVersionHistory.js` + `EditorView.jsx`/panel components; the orphaned `.version-history-error` CSS gets wired up.)
- **FR-006**: A failed diff/preview load for a selected version MUST render an error state in the preview area; the neutral "Select a version to preview" placeholder MUST render only when nothing is selected. (Report B4.)
- **FR-007**: After every history refresh (post-rename, post-name, post-delete, post-restore, and live refresh), the current selection MUST be reconciled against the refreshed version list: the header title, contributors, current-version status, and restore gating MUST reflect the refreshed data, and every action (restore, rename, delete) MUST operate on ids that exist in the refreshed list. A selection that no longer exists MUST be explicitly re-resolved (successor or default selection), never silently retained. (Report A4; `useVersionHistory.js` + `EditorView.jsx` + `VersionPreview.jsx`.)
- **FR-008**: While the version history panel is open, newly recorded versions MUST become visible without closing and reopening the panel (live refresh — mechanism unspecified at spec level; polling or subscription both acceptable). (Report B5.)
- **FR-009**: When a history refresh invalidates cached drill-down data, versions that are currently expanded MUST re-fetch their individual edits; the "No individual updates" empty text MUST only ever describe a genuinely empty successful response. (Report B5; `HierarchicalVersionList.jsx` expanded-state vs. wiped cache.)

**Failure-path honesty — collaboration bind (US2)**

- **FR-010**: The document-load path for a collaboration session MUST distinguish "no persisted state" from "load failed". On an actual load error it MUST report to the exception notifier and refuse/fail the bind so clients retry; it MUST NOT bind an empty in-memory document over a load failure, and MUST NOT log the failure as a routine new-document event. The legitimate new-document path (no rows, no error) is unchanged. (Report B2; `server/index.js:469-474`. Decision RBD-041-1, ratified by default.)

**Failure-path honesty — restore (US4)**

- **FR-011**: When the document is loaded in memory on the serving instance, restore MUST build its delta from the live document state inside a transaction on that document, so the stored restore row is exactly the transition applied to the live doc. Full cross-pod serialization of restore against writes on other instances is OUT of scope and MUST be recorded as a residual limitation in the code/docs where the guarantee is described. (Report B3; `server/version-history.js` restoreVersion. Decision RBD-041-2, ratified by default.)
- **FR-012**: Restore's target-version read MUST verify the update log actually reaches the target clock (tail-completeness, per the 039 mechanism) in addition to the existing interior-gap check, so restore's fail-closed guarantee holds against a short tail. On an incomplete read the existing refuse-with-retry behavior applies and nothing is stored. (Report B7; `server/postgres-persistence.js:783-798` — `getYDocAtClock` currently has no tail-completeness option at all; only the diff-rows fetcher does.)
- **FR-013**: The live-apply path MUST use an honest is-loaded probe: asking "is this document loaded?" MUST NOT create the document (the current lookup creates docs as a side effect, making the "not loaded" branches unreachable). Restores/undos/redos of documents not loaded anywhere MUST NOT leave a newly created in-memory document behind (no leak; eviction currently only happens on connection close). (Report B8; `server/live-apply.js:33`, `server/document-service.js:31-39` via y-websocket's creating `getYDoc`.)

**Failure-path honesty — undo (US5, US6)**

- **FR-014**: The pending-recording guard MUST exclude sync-channel (`via_sync`) rows when probing the identity's newest log row, so reconnect catch-up re-supply never blocks undo with a false "still being recorded". (Report B6; `server/undo/edit-records.js:182-204`.)
- **FR-015**: The chat "Reverted" stamp MUST be applied only after verifying that the referenced chat card corresponds to the record actually undone (the card's recorded edit range matches the undone record's range). On mismatch — including a card with no recorded range — the stamp MUST be skipped and the mismatch logged; the undo/redo result itself is unaffected. Direct API calls with arbitrary card references MUST NOT be able to stamp an unrelated card. NOTHING cut by 040 D19 is revived: no restore-undo, no offer guards. (Report A3, narrow scope; `server/index.js:1582-1589`. Decision RBD-041-3, ratified by default.)
- **FR-016**: The undo inverse-computation spanning-range fallback MUST either apply the same sync-channel exclusion guard the legacy path applies, or carry a load-bearing invariant comment stating precisely why sync-channel rows cannot reach it. (Report B9; `server/undo/inverse.js:105-113`.)

**Silent-degradation observability (US6)**

- **FR-017**: The origin-parsing final fallback (null/primitive origins) MUST degrade loudly: persist unattributed WITH a distinct malformed-origin marker, an error log, and inclusion in the same notification treatment as the existing malformed-origin classes — never a marker-less, log-less unattributed row. (Report A5; `server/origin.js:186`, notification wiring near `server/index.js:328`.)

**Documentation honesty (US7)**

- **FR-018**: The stale pre-cut docstrings MUST be corrected to post-040-D19 truth: the chat-agent identity module (`server/agent-identity.js:20-30`) and the edit-records sentinel rule (`server/undo/edit-records.js:24-26`) no longer claim human web-UI restores are recorded under the chat-assistant identity.
- **FR-019**: The MCP restore tool description (`server/mcp/tools/restore-document-version.js:29-32`) MUST state that an agent's restore is itself a recorded edit which that agent's own undo tool can invert, in addition to the counter-restore path — matching the design amendment and FR-004-of-040 behavior that survived the cut.

### Deferred (explicit, with rationale)

- **A6 (created_at monotonicity across pods)**: DEFERRED. Version grouping trusts wall-clock `created_at` ordering; cross-pod clock skew can shift version *boundaries* (never authors, now that FR-001-003 scope authors by clock range). Severity LOW, no attribution lie is possible after this feature, and a real fix (grouping keyed on clock order with timestamps as display-only) changes version-boundary behavior for all existing documents — that deserves its own design pass, not a rider on a truth-fix feature. Recorded as decision RBD-041-6.

### Key Entities

- **Version (auto)**: A time-grouped run of edit rows (clock range, authors, timestamp, provenance). Authors MUST derive only from rows in its own range (post-split fragments included).
- **Named version**: A user-created label over a clock range (`clock_start`..`clock_end`). Carries creator plus authors of its own range only.
- **Sub-version (drill-down group)**: A finer-grained grouping inside a version's range; obeys the same meaningful-filter and counting rules as the timeline.
- **Edit row (`yjs_updates`)**: One persisted update: clock, author identity, meaningful flag, sync-channel flag (`via_sync`), optional malformed-origin marker. The `via_sync` flag now participates in the pending-recording guard; the malformed-origin marker now covers all malformed classes.
- **Edit record (`agent_edits`)**: The undo bookkeeping row for agent edits (and agent restores). Human web-UI restores never create one (design amendment 2026-08-02).
- **Chat tool card**: The chat message part representing a modify; stores the edit's recorded clock range; its "Reverted" stamp is now verified against the actually-undone record.
- **Selection (panel state)**: The client-side pointer to the version/sub-version being previewed; now reconciled against every refreshed list instead of holding a click-time snapshot.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any named version, 100% of listed authors have at least one edit row inside the named range; zero authors are listed whose edits fall only outside it (verified by automated tests covering named-inside-burst, split-fragment, and noise-boundary cases).
- **SC-002**: For any version range, the timeline's edit accounting and the drill-down's displayed counts agree exactly (0 discrepancies across the test matrix, including ranges containing noise rows).
- **SC-003**: With history or diff endpoints failing, 0 user-visible renders of "No version history yet" / "Select a version to preview" occur; 100% of such failures render an error state, and the history error state offers a working retry.
- **SC-004**: With the document store unreachable, 0 documents with persisted content open as blank; 100% of such bind attempts are refused and reported to the exception notifier; documents with genuinely no history still open normally.
- **SC-005**: After a rename or mid-range naming with the panel open, the header title, contributors, and restore gating reflect the post-refresh state within one refresh cycle; the header restore acts on a post-split version id in 100% of cases.
- **SC-006**: A new collaborator edit becomes visible in an open history panel without reopening it (within the chosen refresh interval); an expanded drill-down never renders "No individual updates" for a non-empty range after any CRUD operation.
- **SC-007**: Undo invoked immediately after a reconnect catch-up succeeds (or honestly reports nothing-to-undo) with 0 occurrences of the false "still being recorded" lockout attributable to sync-channel rows.
- **SC-008**: In the cross-chat and direct-API scenarios, 0 chat cards are stamped "Reverted" for an edit other than the one undone; every skipped stamp produces a log line.
- **SC-009**: A restore of a document loaded nowhere leaves server in-memory document count unchanged after completion; a restore against a tail-incomplete log refuses and stores nothing.
- **SC-010**: Every persisted unattributed row caused by a malformed origin (all classes, including null/primitive) carries a malformed-origin marker and produced a log/notification event — 0 silent unattributed rows in the covering tests.
- **SC-011**: A doc-truth sweep of the three named documentation surfaces (agent-identity docstring, edit-records sentinel comment, MCP restore description) finds 0 pre-cut claims.

## Assumptions

- The three pre-authorized default decisions (bind-refusal on load failure; live-doc restore delta with cross-pod serialization as residual; edit-range verification for the Reverted stamp) are recorded as RATIFIED-BY-DEFAULT in `clarifications-needed.md` (RBD-041-1..3) and are treated as settled for planning.
- The design amendment of 2026-08-02 (`design/collaboration-core.md`, Sam D19) is ground truth: this feature must not create any path by which a human web-UI restore becomes an undo target, directly or incidentally (e.g. FR-015's verification must not grow into offer-guard machinery).
- Report item B1 (publish-before-commit window) stays closed per 038's documentation-only decision; nothing here reopens it. FR-011's transaction addresses restore-side interleaving only.
- Chat modify tool cards already persist the edit's clock range (feature 016 contract), so FR-015's verification has stored evidence to check; cards from before range-recording exist and are handled as mismatch (skip + log).
- The live-refresh mechanism for FR-008 is a plan-level choice (poll vs. reuse of the still-connected collaboration channel); the spec constrains only the outcome, plus the edge-case constraints on scroll/expansion preservation.
- Dead-code removal, structural refactors (report section C), new standalone test suites (section E beyond this feature's own acceptance coverage), the presence-spoof guard (G), and A6 are handled by other pipeline features (042, 043, 044) or deferred; this spec deliberately excludes them.
- Test coverage obligations follow Constitution Principle II: every FR here is a behavioral change and ships with tests in the affected suites; backend suites run serially against the shared DB.
