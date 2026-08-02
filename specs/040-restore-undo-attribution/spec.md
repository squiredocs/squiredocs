# Feature Specification: Restore Undo Attribution

**Feature Branch**: `main` (parallel-pipeline mode — no feature branch; merge queue integrates)

**Feature Directory**: `specs/040-restore-undo-attribution`

**Created**: 2026-08-01

**Status**: Draft

**Input**: User description: "040-restore-undo-attribution — make human UI restores genuinely undoable (chat-assistant identity), sentinel unification, unknown-author display, stable history color fallback, documentation closures"

## Context & Verified Findings

> **Amendment (Sam, 2026-08-01) — F1: this feature is an API-level fix plus a client honesty guard.**
> The plan-stage analysis found that no client control can reach a restore's undo: `UndoEditButton`
> renders only inside a chat `modify` tool card and only for the latest one, so a version-history
> restore — which produces no chat card — has no affordance at all. Worse, because
> `POST /api/docs/:docId/undo` selects the identity's most-recent record (LIFO) and uses the
> request's `toolCallId` **only** to stamp the `reverted` flag, once restores enter the queue,
> pressing "Undo edit" on the assistant's card would invert the **restore** and mark the
> **modify** "Reverted". Sam's decision: **option (c)** — (1) re-scope US1/SC-001 to the endpoint
> contract; (2) add the offer-honesty guard (FR-016/FR-017/FR-018, US6) so the button only offers
> what it will actually do; (3) file the document-level undo affordance as follow-on work
> (`promotion-notes.md`). US1's Scope note, the Out of Scope section, and D7 (re-decided) carry
> the consequences.

This feature closes audit findings F2 (MEDIUM), F6 (LOW), F14 (LOW), and two accepted-as-documentation items (F7, FK-policy divergence). All findings were re-verified against the codebase on 2026-08-01. Design ground truth: `design/collaboration-core.md`, "Version history" section, amendment of 2026-07-19 ("replay is the sole source of truth; restore is undoable"): *"Restore participates in log-derived undo: restoreVersion records an agent_edits row (like modify does) so the chat Undo can invert a restore."* Ratified priors: `specs/023-version-history-hardening/` (FR-020, plan.md `''`-sentinel decision, research.md R7) and `specs/016-log-derived-undo/` (FR-001/021/024/026 identity scoping).

**F2 — human UI restores record a dead, un-undoable edit record.** The web UI restore route (`server/index.js:1477-1481`) passes `agentName: null`; `restoreVersion` (`server/version-history.js:646`) stores the update-log row with a null agent name but records the edit record with the `''` sentinel (`:654-662`, because `agent_edits.agent_name` is `NOT NULL`, `migrations/1796000000000_create-agent-edits.js:36`). No undo surface ever queries the `''` identity: the chat surface uses `(userId, 'Squire Docs Assistant')` (`server/api/chat.js:91`, `server/index.js:1584-1588`) and MCP uses `(userId, agentToken.agentName)` (`server/mcp/tools/undo-redo-handler.js:40-44`). All edit-record SQL uses plain `agent_name = $3` equality (`server/undo/edit-records.js:67, 81, 92, 113, 125`), so the human restore's record is unreachable — a dead row. A secondary inconsistency: `hasPendingRecording` (`edit-records.js:108-130`) probes `yjs_updates.agent_name = ''` while the restore's log row has `NULL` — the NULL/`''` split spans the two tables. The result contradicts both the design amendment, 023 FR-020, and `README.md:467`. Agent restores (MCP path, `server/mcp/tools/restore-document-version.js:88-99`) are consistent and DO work today.

**Sam's ratified direction (do not re-litigate)**: human UI restores are recorded under the chat-assistant identity — BOTH the update-log row AND the edit record carry the assistant's agent name — so the chat-assistant identity's undo can honestly invert a restore using the existing exact-clock-set machinery (`undo_target_clocks = [newClock]`). *(Sam's direction said "the chat Undo button"; the plan-stage F1 finding established that no button can reach it — the mechanism is delivered at the endpoints and the button question is settled by D13/US6. The direction itself is unchanged.)* Visible consequence, intentional: a human UI restore is attributed in version history to the assistant identity (e.g. "Squire Docs Assistant (Sam Goldstein)") rather than the bare human. This is the tradeoff that makes the restore undoable and the two tables consistent.

**Latent defect closed with F2**: `recordEdit` (`server/undo/edit-records.js:50-61`) would violate the `NOT NULL` constraint if ever called with a null agent name, and that error is swallowed by `server/mcp/tools/modify.js:584-586` and by the restore's own catch (`version-history.js:663-665`) — an edit left permanently un-undoable with no signal.

**F6 — unattributed rows vanish from version author lists.** `createAuthor` (`server/version-history.js:91-114`) returns `null` without a `userId`, and `groupUpdatesIntoVersions` (`:205`) only adds an author when `update.userId` is truthy; the sub-version path (`:794`) likewise yields a null author. Rows with a NULL `user_id` — deleted users (`yjs_updates.user_id` is `ON DELETE SET NULL`, `migrations/009_version_history.js`), legacy rows — render with an empty contributor list. Users cannot distinguish "nobody edited" from "the editor's account was deleted".

**F14 — history badge color fallback uses the wrong palette.** `client/src/components/HierarchicalVersionList.jsx:56` falls back to the client's date-salted presence palette (`client/src/utils/colorUtils.js:58-70`, daily rotation deliberate per commit f61f8141) for a history badge that should be stable over time. Near-dead path, but wrong.

**F7 (accepted, documentation only) — undo identity is display-name equality.** The durability-poll row filter matches identity rows on `(userId, agentName)` display-name equality (`server/mcp/yjs/edit-range.js:184-186`; the original brief's path `server/undo/edit-range.js` was wrong — corrected by the coordinator 2026-08-01). Two `sk_sqd_` tokens of the SAME user sharing a display name are indistinguishable for undo target selection. Cross-user collision is impossible (userId scopes everything) and exact-clock sets keep each inversion surgical; residual risk is only LIFO selection surprise among one person's own sessions. Decision: accept and document; a token-id change is not warranted.

**New finding (coordinator, verified 2026-08-01) — three implementations of "same identity" disagree on null.** The identity comparison exists in three places: `server/mcp/yjs/edit-range.js:185` uses RAW equality (`r.agentName === identity.agentName`), while `server/undo/inverse.js:80` and `server/undo/legacy.js:46` normalize (`(r.agentName ?? null) === (identity.agentName ?? null)`). The raw comparison disagrees with the other two whenever one side is `null` (from the DB) and the other is `undefined` (from an in-process identity object that omitted the field): the normalized comparisons match, the raw one does not. This is the same NULL-vs-sentinel confusion class as F2 (the `''`/NULL split across the two tables), so it is in 040's scope: all three sites converge on one shared, normalized identity-comparison predicate (FR-015) — behavior-preserving for the two already-normalized sites, a bug fix for `edit-range.js`.

**FK-policy divergence (accepted, documentation only).** `yjs_updates.user_id` is `ON DELETE SET NULL` while `agent_edits.user_id` is `ON DELETE CASCADE`. This is coherent and intentional: a deleted user's history rows survive anonymized while their undo chain dies with them (a deleted user cannot undo anyway). The rationale must be captured so a future reader does not "fix" it.

## Collision Contract (parallel features 038 / 039)

This feature implements **after both 038-attribution-integrity and 039-diff-cache-integrity merge**.

**Files this feature touches:**

- `server/version-history.js` — restore recording identity, unknown-author synthesis (version grouping and sub-version paths)
- `server/undo/edit-records.js` — loud `recordEdit` guard; sentinel-rule and FK-rationale documentation; natural home for the shared identity-comparison predicate (FR-015)
- `server/mcp/yjs/edit-range.js` — header comment documenting the display-name-equality limitation (F7, at the `:185` identity filter); switch its raw identity comparison to the shared normalized predicate (FR-015 — bug fix for the `null` vs `undefined` case)
- `server/undo/inverse.js` and `server/undo/legacy.js` — replace their inline normalized comparisons with the shared predicate (FR-015; behavior-preserving)
- `server/api/chat.js` — **constant extraction only** (the assistant identity constant moves to a shared module; `chat.js` re-exports/consumes it)
- `server/index.js` — **small touch to the restore route only** (`/api/docs/:docId/restore` handler, the `agentName` it passes); nothing else in this file
- `client/src/components/HierarchicalVersionList.jsx` — null-id author tolerance; stable fallback color **(verified 2026-08-01: the color half already shipped in 039 as its FR-018 — this feature only adds null-id tolerance and a test)**
- One NEW shared module for the chat-assistant identity constant (new file; no collision)
- `README.md:467` **and `README.md:583`** — corrections applied **by the merge queue**, not by this feature's implementation agent
- **Added by Sam's F1 decision (2026-08-01, option (c))** — the undo-offer honesty guard:
  - `server/undo/undo-service.js` — `getUndoStatus` additively returns each direction's target `edit_clock_start` (FR-016). No new query: the `agent_edits` rows are already fetched.
  - `server/index.js` — the `/undo-status` route passes the additional fields through (still a small, single-route touch).
  - `client/src/components/AiChatMessages.jsx` — `UndoEditButton` offers the control only when the next target matches that part's own `editRange.clockStart` (FR-017/FR-018).
- **Added by verified findings F4/D10–D11** (the tree is clear — 038 and 039 are merged, so these carry no collision risk): `server/onboarding.js` (drop the duplicate assistant-name literal), `server/mcp/tools/modify.js` and `server/api/chat-staleness.js` (adopt the shared identity predicate; behavior-identical at both).

**This feature MUST NOT touch:** any migration (038 owns the only migration slot — this feature adds ZERO migrations), `server/origin.js`, `server/document-service.js`, `server/postgres-persistence.js` (either path), the diff subsystem, or the websocket/attribution layer.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A restore made from the web UI becomes undoable through the undo endpoints (Priority: P1)

A human restores an older version of a document from the version history panel. That restore now enters the document's undo queue as a genuine, invertible tracked edit: the undo-status endpoint reports it as available, the undo endpoint exactly reverts it (returning the document to its pre-restore content, without a counter-restore and without losing any history), and the redo endpoint re-applies it.

**SCOPE — API level, deliberately (F1; Sam's decision 2026-08-01, option (c))**: this story is satisfied at the **endpoint contract**. It does NOT claim a user can click something to undo a restore, because after this feature they still cannot: the only client control that calls `/undo` is bound to a chat `modify` tool card (`client/src/components/AiChatMessages.jsx:541-547`, shown only for `part === lastModifyPart`), and a version-history restore produces no chat card. A user-facing, document-level undo affordance is **explicitly out of scope** and filed as follow-on work (see Out of Scope and `promotion-notes.md`). What this feature guarantees on screen is US6: no control ever offers to undo a restore while claiming it will undo something else.

**Why this priority**: This is the headline defect (F2). The product's own documentation and ratified design (023 FR-020, 2026-07-19 amendment) promise the restore is a tracked, invertible edit; today the recorded edit is unreachable by every undo surface, so the mechanism does not exist at all. Building the mechanism is the prerequisite for any future affordance, and it makes the two stores consistent.

**Independent Test**: On a document with several versions, restore an older version through the restore endpoint, confirm `GET /api/docs/:docId/undo-status` reports `canUndo: true`, call `POST /api/docs/:docId/undo`, and verify the document content equals the pre-restore state exactly.

**Acceptance Scenarios**:

1. **Given** a document with edits at versions V1 → V2, **When** a signed-in user restores V1 from the version history panel, **Then** `GET /api/docs/:docId/undo-status` for the chat-assistant identity reports `canUndo: true`.
2. **Given** a human UI restore was just performed, **When** `POST /api/docs/:docId/undo` is called for that document, **Then** the document content is exactly the pre-restore (V2) content, the undo succeeds (not the honest-empty "nothing to undo"), and the inversion is recorded as a normal forward edit (history is never rewritten).
3. **Given** a human UI restore has been undone, **When** `POST /api/docs/:docId/redo` is called, **Then** the restored (V1) content is re-applied — restore participates in the standard undo/redo cycle.
4. **Given** a human UI restore followed by a chat-assistant edit, **When** undo is invoked twice, **Then** the first undo inverts the chat edit and the second inverts the restore (standard LIFO order for the assistant identity).
5. **Given** a human UI restore, **When** any user opens version history, **Then** the restore appears attributed to the assistant identity acting for that user (e.g. "Squire Docs Assistant (Sam Goldstein)"), marked as an agent-attributed entry — the intentional, user-visible attribution change that makes the restore undoable.

---

### User Story 2 - Agent restores keep working exactly as today (Priority: P1)

An agent connected over MCP restores a document version with `restore_document_version` and then calls `undo`. This flow works today and must not regress: the restore stays attributed to the agent's own identity and the agent's undo still inverts it.

**Why this priority**: The fix for human restores changes shared recording code; the working agent path is the regression surface.

**Independent Test**: Via an MCP agent token, restore an older version, verify version history attributes it to the agent's identity, then call the MCP `undo` tool and verify exact inversion.

**Acceptance Scenarios**:

1. **Given** an agent token with editor access, **When** the agent restores a version over MCP, **Then** the restore's log row and edit record both carry the agent token's own identity (unchanged from today).
2. **Given** an agent MCP restore, **When** the same agent calls the MCP `undo` tool, **Then** the restore is exactly inverted.
3. **Given** an agent MCP restore, **When** a different identity (the same user's chat assistant, or another agent) checks undo availability, **Then** the agent's restore is not offered to that other identity (identity scoping per 016 FR-024 unchanged).

---

### User Story 3 - Version history never shows a silently empty contributor list (Priority: P2)

A user browses version history on a document where some edits were made by a since-deleted account (or by legacy unattributed rows). Instead of versions with no contributors at all, those versions show an explicit "Unknown author" entry, so the user can distinguish "the editor's account no longer exists" from a display bug.

**Why this priority**: Correctness of the history display (F6); lower stakes than undo but user-visible and trust-affecting.

**Independent Test**: Produce version-history data containing rows with no user attribution and verify both the version list and the sub-version drill-down render an "Unknown author" entry with a stable identifier and stable color, and that the client renders it without errors.

**Acceptance Scenarios**:

1. **Given** a version composed entirely of rows with no user attribution, **When** the version list is rendered, **Then** the version shows a synthetic "Unknown author" contributor (stable key, stable neutral color) instead of an empty contributor list.
2. **Given** a version mixing attributed and unattributed rows, **When** rendered, **Then** both the real authors and the single "Unknown author" entry appear (unattributed rows collapse into one entry per version).
3. **Given** the sub-version drill-down of such a version, **When** rendered, **Then** the same "Unknown author" treatment applies (both grouping paths, not just the top level).
4. **Given** an author entry with a null id reaches the client, **When** the version panel renders it, **Then** the avatar/initial/color fallbacks render without a crash or blank element.

---

### User Story 4 - An unattributable edit record fails loudly, never silently (Priority: P2)

An operator reviewing logs after an incident can see immediately when the system attempted to record an undoable edit without an agent identity — an explicit, named rejection at the recording boundary — instead of a swallowed database constraint violation that leaves an edit permanently un-undoable with no signal.

**Why this priority**: Closes the latent defect that produced F2's dead rows; protects every future caller of the recording path.

**Independent Test**: Call the edit-recording boundary without an agent identity and verify it rejects with an explicit error naming the missing identity (not a database NOT-NULL violation), while the enclosing operation (restore/modify) still completes per existing non-fatal parity.

**Acceptance Scenarios**:

1. **Given** the edit-recording boundary is invoked with a missing/null agent name, **When** it executes, **Then** it rejects before touching the database with an explicit error naming the invalid identity — never a raw NOT-NULL constraint violation.
2. **Given** such a rejection occurs inside a restore or modify, **When** the enclosing operation completes, **Then** the operation still succeeds (non-fatal parity with 023) but the rejection is loud in the server logs with its explicit message.
3. **Given** a developer reads the edit-record module, **When** they look for the identity rules, **Then** a single documented sentinel rule states what values `agent_name` may carry and that empty-string writes are retired.

---

### User Story 5 - History colors don't change overnight (Priority: P3)

A user viewing version history sees the same fallback badge color for the same entry today and tomorrow. The presence system's deliberate daily color rotation stays exactly as it is.

**Why this priority**: Near-dead code path (F14), but the current fallback is semantically wrong for history and trivially cheap to fix.

**Independent Test**: Render a history author entry that lacks a server-supplied color on two different dates (or with the date mocked) and verify the fallback color is identical both times and matches the server's no-id neutral fallback.

**Acceptance Scenarios**:

1. **Given** a history author entry with no server-supplied color, **When** the badge renders, **Then** the fallback is the stable neutral color (`#888888`), not the date-salted presence palette.
2. **Given** the presence/cursor system, **When** this feature ships, **Then** presence colors and their deliberate daily rotation are completely unchanged.

---

### User Story 6 - The Undo button never lies about what it will undo (Priority: P1)

A user has asked the chat assistant to edit a document, so the assistant's `modify` card is showing an "Undo edit" button. The user then restores an older version from the version history panel. The modify card's Undo button no longer offers to act — because pressing it would not undo that edit at all.

**Why this priority**: This is the on-screen half of Sam's F1 decision, and it ships with US1 or not at all. `POST /api/docs/:docId/undo` selects the identity's most-recent active record (LIFO); it ignores the `toolCallId` in the request body for target selection and uses it **only** to stamp the `reverted` flag on a chat part (`server/index.js`, `makeUndoRedoHandler`). Before this feature a restore was never in that queue, so the modify card's button was right by accident. FR-001 puts restores into the queue — so without this guard, pressing "Undo edit" on the assistant's card would invert the **restore** and then mark the **modify** card "Reverted": a false statement to the user about what happened to their document. The mechanism that makes US1 possible is exactly what makes this lie possible; they are one shipment.

**Independent Test**: With a completed assistant `modify` on a document, perform a restore, then confirm the modify card offers no Undo control; make the modify the next target again and confirm the control returns; and confirm the endpoint inverted the true target correctly in both cases.

**Acceptance Scenarios**:

1. **Given** a completed assistant `modify` card and a subsequent human UI restore (so the restore is the identity's next undo target), **When** the chat renders, **Then** the modify card offers no Undo control — and in particular no click can mark that modify "Reverted".
2. **Given** a completed assistant `modify` that IS the identity's next undo target, **When** the chat renders, **Then** the Undo control is offered exactly as it is today (no regression to the existing flow).
3. **Given** either case above, **When** the undo endpoint is called directly, **Then** it still inverts the identity's true next target correctly — the guard changes what is *offered*, never what the endpoint *does*.
4. **Given** an undone modify card showing "Reverted" whose record is the identity's next redo target, **When** the chat renders, **Then** the Redo control is offered; the same matching rule governs both directions.
5. **Given** an undo-status response that omits the new field (older server, or the legacy-derivation fallback), or a `modify` result whose durability wait timed out (`editRangePending`, no `editRange` in its output), **When** the chat renders, **Then** the control degrades to today's behavior (offered) rather than disappearing — the guard is fail-open on missing data, never fail-blank.

---

### Edge Cases

- **Restore then unrelated human typing then Undo**: the exact-clock-set machinery (`undo_target_clocks = [newClock]`) scopes the inversion to the restore's own row; interleaved edits by other identities are never inverted (016 FR-001/FR-029 unchanged).
- **Pending-recording probe consistency**: with both the log row and the edit record carrying the assistant identity for a human restore, the pending-recording probe (which joins the two tables on the same identity) is consistent — the NULL/`''` split is gone for new writes.
- **Legacy dead `''` rows already in the database**: remain in place, unreachable and harmless; no migration or backfill (see clarifications-needed.md, RATIFIED-BY-DEFAULT). No undo surface queries `''` today, and none will after this feature.
- **Undo of a restore via the chat UI when no chat message exists**: a restore has no chat tool-call, so there is no "Reverted" marker to set; the undo endpoints already treat that persistence as best-effort and optional.
- **Viewer role**: cannot restore and cannot undo — unchanged; both routes gate on editor access.
- **Fully superseded restore**: if later edits fully supersede the restore, undo returns the existing honest-empty result — no guessed inverse (016 semantics unchanged).
- **Two agent tokens of the same user sharing a display name**: still indistinguishable for undo target selection — accepted and now documented (F7); not changed by this feature.
- **Agent name `null` (DB row) vs `undefined` (in-process identity object)**: the shared predicate (FR-015) treats these as the same identity everywhere; before this feature, the edit-range durability poll alone treated them as different identities, silently disagreeing with the undo inverse and legacy paths.
- **Version with zero rows carrying attribution AND zero rows at all**: impossible (a version is built from rows); the "Unknown author" entry only synthesizes when unattributed rows exist, so "nobody edited" never shows a phantom author.

## Requirements *(mandatory)*

### Functional Requirements

**Restore undo-ability (F2)**

- **FR-001**: A restore performed from the web UI MUST be recorded under the requesting user's chat-assistant identity — the update-log row AND the edit record MUST both carry the assistant agent name (with the requesting user's id) — so the two stores are consistent and the record is reachable by the chat undo surface.
- **FR-002**: After a human UI restore, `GET /api/docs/:docId/undo-status` for the chat-assistant identity MUST report undo available, and `POST /api/docs/:docId/undo` MUST exactly invert the restore (returning the document to its pre-restore content) using the existing exact-clock-set inversion; `POST /api/docs/:docId/redo` MUST re-apply it. No history is rewritten; the inversion lands as a normal forward edit. *(Endpoint-level by design, per D13 — this feature ships no user-facing control that performs it; see Out of Scope.)*
- **FR-003**: Version history MUST attribute a human UI restore to the assistant identity acting for the user (display of the form "Squire Docs Assistant (User Name)", flagged as agent-attributed). This is an intentional, user-visible attribution change: it is the tradeoff that makes the restore undoable and the two stores consistent, per Sam's ratified direction.
- **FR-004**: Agent (MCP) restores MUST retain current behavior with zero regression: recorded under the agent token's own identity, attributed to that identity in version history, and invertible by that same identity's MCP undo. Identity scoping (016 FR-024) is unchanged — one identity's restore is never offered to another identity's undo.
- **FR-005**: The chat-assistant identity name MUST have exactly one authoritative definition, shared by every consumer (chat surface, undo-status route, restore recording), such that the identity used to record a restore and the identity used to query undo can never drift apart. The shared definition MUST be consumable by the version-history layer without creating a circular dependency with the chat surface.
- **FR-006**: The edit-recording boundary MUST reject a missing or null agent name with an explicit, descriptive error before any database write — never surfacing as a database NOT-NULL constraint violation. Callers' existing non-fatal handling stands (the enclosing restore/modify still succeeds), but the rejection message MUST name the actual problem so logs are actionable.
- **FR-007**: The edit-record module MUST document the single sentinel rule for `agent_name`: the column is non-null; permitted values are real agent display names (including the shared chat-assistant identity); empty-string (`''`) writes are retired for all new records; legacy `''` rows may exist and are intentionally unreachable. Existing `''` rows are left in place — no migration, no backfill.

**Unknown-author display (F6)**

- **FR-008**: Versions (and sub-versions) built from update rows lacking user attribution MUST display a synthetic "Unknown author" contributor entry — with a stable identity key and a stable neutral color — instead of an empty contributor list. Unattributed rows within one version collapse into a single such entry. Both the version-grouping path and the sub-version drill-down path MUST apply this.
- **FR-009**: The client version panel MUST tolerate an author entry whose id is null: the badge, name, and color fallbacks MUST render without errors and without blank/broken elements.

**Stable history color fallback (F14)**

- **FR-010**: The version panel's author-badge color fallback MUST be the stable neutral color `#888888` (matching the server's no-id fallback), not the date-salted presence palette. The presence/cursor color system and its deliberate daily rotation MUST NOT be changed or unified with history colors.

**Documentation closures**

- **FR-011**: The edit-range module (`server/mcp/yjs/edit-range.js`, at its identity row filter) MUST carry a header comment documenting the accepted limitation that undo identity is `(userId, agent display name)` equality — two same-user tokens sharing a display name are indistinguishable for target selection — including why this is accepted (userId scopes cross-user; exact clock sets keep inversions surgical; residual risk is LIFO surprise within one person's own sessions) and why a token-id disambiguator is not warranted (two-table migration plus threading through every origin). No behavior change from this documentation item itself; the null-normalization fix at the same site is FR-015.
- **FR-012**: The deliberate FK-policy divergence — history rows survive user deletion anonymized while the user's undo records are deleted with the account — MUST be captured as a rationale comment at the edit-record module (a deleted user cannot undo, so their undo chain dying with them is coherent), so a future reader does not "unify" the policies. The policies themselves MUST NOT change.
- **FR-013**: The product documentation claim at `README.md:467` ("A restore is recorded like any other tracked edit, so the chat assistant's Undo can invert it… both surfaces share identical attribution and broadcast semantics") — currently FALSE for human UI restores — MUST be made true by FR-001/FR-002, and the README wording MUST be corrected to state the actual behavior, including that a web-UI restore is attributed to the assistant identity acting for the user. The README edit is applied by the merge queue, not by this feature's implementation agent.

**Identity-comparison unification (coordinator finding, 2026-08-01)**

- **FR-015**: All three identity-comparison sites — `server/mcp/yjs/edit-range.js:185`, `server/undo/inverse.js:80`, and `server/undo/legacy.js:46` — MUST use one shared, exported identity-comparison predicate (normalized with `?? null` on the agent name), so "is this row mine?" has exactly one definition. This is behavior-preserving for the two already-normalized call sites and a bug fix for `edit-range.js`, whose raw `===` comparison wrongly rejects a match when one side's agent name is `null` (from the DB) and the other's is `undefined` (from an in-process identity object that omitted the field). A test MUST assert that the three surfaces agree for the `null`-vs-`undefined` agent-name case.

**Undo-offer honesty (F1, Sam's decision 2026-08-01, option (c))**

- **FR-016**: `GET /api/docs/:docId/undo-status` MUST additionally report, for each direction, the identifying clock of the record it would act on — the record's **immutable** `edit_clock_start`, not its rewritable `undo_target_*`/`redo_target_*` range, so the identifier survives an undo↔redo cycle. The additions MUST be **purely additive and backward compatible**: `canUndo`/`canRedo` keep their exact current meaning and shape, and the new fields are absent (not null-guessed) whenever no record backs the answer — notably the legacy-derivation fallback, which has no `agent_edits` row. No schema change: the endpoint already performs the `agent_edits` lookups that carry this value.
- **FR-017**: A client control that invokes undo/redo MUST offer to act only when the record it claims to represent IS the identity's next target for that direction — i.e. the chat `modify` card's control renders only when the next target's identifying clock equals that part's own `editRange.clockStart`. When they do not match, the control MUST NOT be offered (it may show a short, honest reason instead of vanishing silently). The guard MUST be **fail-open**: if either value is unavailable — an undo-status response without the new field, or a `modify` output with no `editRange` because its durability wait timed out (`editRangePending`) — the control degrades to today's behavior rather than disappearing.
- **FR-018**: No surface may label an edit "Reverted" (or otherwise represent it as undone) unless that edit is the one that was actually inverted. The `reverted` flag persisted on a chat tool part MUST only ever be set for the record the undo endpoint actually acted on. FR-017's offer guard is the mechanism that keeps this true for the chat surface; the endpoint's own target selection (identity-LIFO) is unchanged.
- **FR-019** *(added 2026-08-02, orchestrator decision D17 — server-side enforcement of FR-018)*: The **server** MUST enforce FR-018 independently of any client guard. When the undo/redo endpoint is supplied a `toolCallId`, it MUST stamp (or clear) that chat part's `reverted` flag **only** when the part identifies the record the endpoint actually inverted — i.e. the part's own `editRange.clockStart` equals the `edit_clock_start` of the acted-on record. On mismatch the endpoint MUST still perform the undo/redo (the endpoint contract of FR-002 and the identity-LIFO target selection are **unchanged**) but MUST NOT write the flag. The check MUST fail **closed** when the part carries no `editRange` (the `editRangePending` case) — the record is known but the part is unidentifiable, so a stamp would be a guess — and fail **open** only when no record backs the action at all (the legacy-derivation undo path), where the identity provably has no other records in the document and so no mislabel is structurally possible. This makes FR-018 true by construction and demotes FR-017's client guard to a UX nicety rather than the sole enforcement.

**Constraints**

- **FR-014**: This feature MUST NOT add any database migration. *(Second clause, now expired: the original text also barred modifying "any file owned by features 038 or 039". Both features MERGED to `main` before this feature's planning; ownership has lapsed and the clause no longer binds. The zero-migration clause still binds absolutely — see SC-007. The forbidden-file list in the Collision Contract's "MUST NOT touch" paragraph stands on its own architectural merits and is still honored.)*

### Key Entities

- **Update-log row**: one durable document change; carries acting identity (user id + optional agent name) and a clock. A restore produces exactly one such row.
- **Edit record**: the undoable unit; scoped by (document, user id, agent name) with a non-null agent name; carries the exact clock set that makes its inversion surgical. A human UI restore's record becomes reachable by carrying the chat-assistant identity.
- **Chat-assistant identity**: the fixed agent display name attributed to the in-app assistant's edits, now also the identity under which human UI restores are recorded; single shared definition.
- **Version author entry**: the contributor displayed per version; gains a synthetic "Unknown author" variant (stable key, neutral color, null user id) for unattributed rows.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: End-to-end **at the endpoint contract**: a human performs a UI restore, then `POST /api/docs/:docId/undo` is called for that document — the document content is byte-identical to the pre-restore state, and a subsequent `POST /api/docs/:docId/redo` re-applies the restored content. This succeeds in 100% of attempts on an otherwise-idle document. *(Deliberately API-level, per Sam's F1 decision: this feature ships no user-facing control that undoes a restore — see US1 Scope, Out of Scope, and `promotion-notes.md`.)*
- **SC-002**: After a human UI restore (and before any other assistant edit), the undo availability check reports undo available — including after a server restart or session expiry (log-derived, no session dependency).
- **SC-003**: Regression: an agent MCP restore followed by that agent's MCP undo behaves exactly as before this feature — restore attributed to the agent, undo inverts it, and no other identity can undo it.
- **SC-004**: Attribution change is visible and intentional: after a human UI restore, version history shows the restore attributed to the assistant identity acting for that user (e.g. "Squire Docs Assistant (Sam Goldstein)"), not the bare human. Reviewers MUST treat this as the deliberate, ratified tradeoff — not a bug.
- **SC-005**: Zero versions render with an empty contributor list when their underlying rows exist: any version containing unattributed rows shows exactly one "Unknown author" entry, in both the version list and the drill-down, and the entry's color is identical across days.
- **SC-006**: Recording an edit without an agent identity produces an explicit, named rejection observable in server logs — a raw database NOT-NULL violation for `agent_name` never appears in logs again for this path.
- **SC-007**: The database schema is unchanged: zero new migrations from this feature.
- **SC-008**: Documentation closures verifiable by inspection: the display-name-equality limitation comment, the sentinel rule, and the FK-divergence rationale each exist at their specified module; the README claim about restore undo is true as written after the merge-queue correction.
- **SC-010**: Undo-offer honesty is provable in all three states: (a) with a completed assistant `modify` card present and a restore as the identity's next undo target, the card offers **no** Undo control and no click path exists that could stamp "Reverted" on it; (b) with that modify as the next target, the control is offered exactly as before this feature; (c) in both states the undo endpoint still inverts the identity's true next target correctly — the guard changes what is offered, never what the endpoint does.
- **SC-011**: The `/undo-status` additions are backward compatible: a client that ignores the new fields observes byte-identical `canUndo`/`canRedo` behavior, and a client that reads them degrades to today's behavior (control offered) whenever a field is absent — including the legacy-derivation fallback and the `editRangePending` modify result. No response ever hides every control because data was missing.
- **SC-012**: No user-visible surface labels an edit "Reverted" that was not the edit inverted. Verifiable by inspection plus test (a): the `reverted` flag is only ever persisted for the record the endpoint acted on.
- **SC-013** *(FR-019, D17)*: The mislabel is impossible **with the client guard bypassed**. Posting directly to `POST /api/docs/:docId/undo` with a `chatId`/`toolCallId` naming a `modify` part while a **restore** is the identity's next undo target: the response reports the undo succeeded, the restore is correctly inverted, and the named part's `reverted` flag is **unchanged** (never set). The same POST with the `toolCallId` of the part that *was* the acted-on record does set the flag — so the enforcement is a discriminator, not a blanket refusal. This holds for a stale-poll click (status fetched before the restore, click after it), which is exactly the ≤30s window the poll-fed client guard alone leaves open.
- **SC-009**: Exactly one identity-comparison predicate exists: the three known sites (`server/mcp/yjs/edit-range.js`, `server/undo/inverse.js`, `server/undo/legacy.js`) all call the shared helper, a test proves the three surfaces agree on the `null`-vs-`undefined` agent-name case, and **the reviewer MUST grep the codebase for any fourth inline `(userId, agentName)` identity comparison that escaped this consolidation** (e.g. `agentName ===`, `agent_name =` outside parameterized identity SQL) and confirm none remains or file it explicitly.

## Out of Scope

- **A user-facing way to undo a restore. Deliberately not delivered here** (F1; Sam's decision 2026-08-01, option (c)). This feature makes a restore genuinely undoable **through the undo endpoints** and makes the chat surface stop offering a control that would misreport what it does — but it ships no button, menu item, or affordance that a user can click to undo a restore. Delivering one means a **document-level** control (most naturally in the version-history panel or the document header) driven by `/undo-status`, with its own design, empty/disabled states, and a mobile/touch pass in the manner of feature 024. Filed as owed follow-on work with the full analysis in `promotion-notes.md`.
- Any database migration or backfill of the legacy `''` / NULL rows (D1).
- Changing the FK policies themselves — FR-012 documents them, it does not unify them.
- A token-id undo disambiguator: F7 is accepted-and-documented (FR-011).
- Presence/cursor colors and their deliberate daily rotation (FR-010 second half).
- Changing what the undo/redo **endpoints** select. Target selection stays identity-LIFO; FR-017 governs only what a client *offers*.
- Per-target chat copy (e.g. an "Undo restore" label). The revised D7 permits only the structural offer guard, not new user-facing wording beyond an optional short reason string.

## Assumptions

- Features 038 (attribution integrity) and 039 (diff cache integrity) merge first; this spec is written against current `main` plus their contracts, and its implementation rebases on their merged result.
- The existing exact-clock-set machinery (`undo_target_clocks = [newClock]`, 023) makes a restore's inversion exact without new mechanism; this feature only fixes which identity the record carries.
- Legacy dead `''` edit records and NULL-agent restore log rows in production are harmless (unreachable by every surface) and are left untouched — no backfill, since no migration slot exists for this feature and the rows have no user-visible effect.
- The "Unknown author" entry needs no avatar image; the existing initial/color fallback path renders it.
- The audit's F7 citation is `server/mcp/yjs/edit-range.js:184-186` (the original brief's `server/undo/` path was a coordinator typo, corrected 2026-08-01); the F7 documentation comment lands there, and the sibling comparisons in `server/undo/inverse.js:80` and `server/undo/legacy.js:46` are consolidated with it via the shared predicate (FR-015).
- No new UI surface is added. **Corrected 2026-08-01 (D13)**: the original wording here — "undo of a restore uses the existing chat Undo control and endpoints" — was **false**. The existing chat control is bound to a `modify` tool card and cannot reach a restore; undo of a restore is available **through the endpoints only**. The single client change this feature makes is the FR-017 offer guard, which *removes* an offer rather than adding a surface. The version panel changes remain display-only.
