# Feature Specification: Imports Announce Presence

**Feature Branch**: `037-import-presence`

**Created**: 2026-07-31

**Status**: Draft

**Input**: User description: "Presence during REST markdown import/sync: when an agent runs the REST byte-channel import, it must trigger live presence in the document so watching users can see that changes are being made. Today the import routes mutate the shared doc directly and never write awareness — the doc just changes with nobody visibly there (observed by Sam 2026-07-30 with a Claude Code session syncing a design doc)."

**Design ground truth**: `design/markdown-import-two-way-sync.md` — "Amendment (Sam, 2026-07-30) — imports announce presence (feature 037)" (six ratified bullets); `design/agent-surface-mcp.md` — "Amendment (Sam, 2026-07-30) — REST imports join the presence model (feature 037)" (companion mint-time naming contract) plus the presence-session and reads-never-write sections. Context: `design/collaboration-core.md` (awareness, Redis pub/sub fan-out, presence-claim dedup). Per Constitution Principle VI these amendments are ratified — this spec encodes them; it does not relitigate them.

## The Problem

Agents are supposed to be collaborators, not a backdoor: every MCP tool that touches a document announces itself as a live cursor. The REST byte-channel import (the recommended path for syncing files into Squire) is the one write surface that doesn't — it mutates the shared document with no awareness signal, so a user watching the document sees content change with nobody visibly there. Observed 2026-07-30: a Claude Code session syncing a design doc over the REST import was invisible to the watching user. A related hole ships in the same feature because presence makes people watch imports live: on a multi-replica deployment, the import's content change itself only reaches viewers connected to other replicas if the handling replica happens to already hold a live connection for that document — otherwise the import persists but live viewers see nothing until reload.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Watching user sees the importing agent arrive and work (Priority: P1)

Liz has a design document open in her browser. Her teammate's coding agent pushes an updated version of the corresponding repo file over the REST import surface (any mode: append, replace, or sync). Before any content changes, Liz sees the agent appear in the document as a standard live collaborator — agent avatar and cursor, named for the token it authenticated with — exactly as MCP-driven agents already appear. When the import applies, she sees a temporary selection over the changed content, so she knows what changed and who changed it. Shortly after the import completes, the agent's presence quietly disappears.

**Why this priority**: This is the feature. It restores the "agents are collaborators, not a backdoor" invariant on the last write surface that violated it, and it is the exact failure Sam observed.

**Independent Test**: Open a document in a browser, run a token-authenticated update-mode import from a shell, and observe: (1) an agent presence entry appears before content changes, (2) the content change is accompanied by a temporary selection over the changed range, (3) presence expires on its own after the import.

**Acceptance Scenarios**:

1. **Given** a user viewing a document and an agent holding an editor-capable API token, **When** the agent starts an import against that document in any mode, **Then** the agent's presence (avatar + cursor, agent-flagged) becomes visible to the viewer after the request passes its access checks and before any document content changes.
2. **Given** an import whose pre-apply work is slow (large body, image fetching taking tens of seconds), **When** the viewer watches during that window, **Then** the agent is already visibly present for the whole pre-apply window, not only at the instant of the content change.
3. **Given** an append-mode import that applies successfully, **When** the change lands, **Then** the viewer sees a temporary selection spanning the appended blocks that clears itself after its standard duration (~10 seconds).
4. **Given** a replace-mode import, **When** the change lands, **Then** the temporary selection spans the imported content.
5. **Given** a sync-mode push that changes a subset of blocks, **When** the change lands, **Then** the temporary selection spans from the first through the last changed block.
6. **Given** a completed import, **When** the presence lifetime (~60 seconds) elapses with no further activity, **Then** the agent's presence disappears without any manual cleanup.
7. **Given** the same agent token runs two imports against the same document in quick succession (or an MCP session for the same identity is already present), **When** the viewer looks at the collaborator list, **Then** at most one presence entry appears for that agent identity on that document (existing dedup applies unchanged).

---

### User Story 2 - Import content reaches viewers on every replica (Priority: P1)

Squire runs with multiple server replicas. Liz's browser is connected to replica A; the agent's import request is handled by replica B, which has no live editing connection for that document. The import must still reach Liz's screen live — content change and presence both — not sit persisted-but-invisible until she reloads.

**Why this priority**: Co-equal with Story 1 and folded into this feature by ratified decision: presence makes people watch imports live, so the cross-replica content-delivery hole would be immediately and visibly hit. Without it, Story 1's promise ("watch the import happen") is false on the production topology (2 replicas).

**Independent Test**: On a two-replica deployment (or a test double of the fan-out path), connect a viewer via one replica, route an import (each of append, replace, and sync) to the other replica which holds no live connection for the document, and verify the viewer's document updates live.

**Acceptance Scenarios**:

1. **Given** a viewer connected to replica A and no live connection for the document on replica B, **When** replica B handles an append- or replace-mode import, **Then** the content change appears in the viewer's document without a reload.
2. **Given** the same topology, **When** replica B handles a sync-mode push, **Then** the changed content appears in the viewer's document without a reload.
3. **Given** a single-replica deployment or an import handled by a replica that already relays the document, **When** an import applies, **Then** behavior is unchanged from today (no duplicate application, no echo).

---

### User Story 3 - Presence never breaks or slows an import (Priority: P2)

An agent's import must succeed and perform exactly as it does today even when the presence machinery is degraded (awareness backend unavailable, session dial failing, position computation erroring). Presence is a courtesy to watchers, not a gate on the byte channel.

**Why this priority**: The byte channel is the contractual sync path for agent workflows; a decorative feature must not introduce a new failure mode or material latency into it. Ratified as the best-effort invariant.

**Independent Test**: Force presence-session creation to fail (or hang) in a test and verify the import completes with an unchanged success response and receipt; measure that a hanging presence attach delays the import by no more than the short cap (~2 seconds).

**Acceptance Scenarios**:

1. **Given** presence-session creation fails outright, **When** an import runs, **Then** the import completes successfully with the same response contract as today and the failure is logged.
2. **Given** presence-session creation hangs, **When** an import runs, **Then** the import proceeds after a short bounded wait (~2 seconds) while the session attempt continues (or fails) in the background, and the import's outcome is unaffected.
3. **Given** the post-apply selection computation errors, **When** an import completes, **Then** the response is unaffected and the error is only logged.
4. **Given** presence succeeds, **When** an import runs, **Then** no document content differs from an import run with presence disabled — presence never writes to the document (reads-never-write invariant on all position computations).

---

### User Story 4 - Presence identity matches version-history attribution (Priority: P2)

When Liz sees "Claude Code (Sam)" editing the document live and later opens version history, the version entry for that change carries the same author identity. Presence and attribution never tell different stories about who made a change.

**Why this priority**: Provenance is a product invariant (Constitution Principle IV); a presence label that disagrees with the recorded author would undermine the trust the feature exists to create.

**Independent Test**: Run an append/replace import and a sync push with a named token; compare the presence label observed by a viewer against the author shown in version history for the resulting version entry.

**Acceptance Scenarios**:

1. **Given** an append- or replace-mode import authenticated with a token named "Claude Code", **When** a viewer sees the presence entry and later checks version history, **Then** both show the token's name (presence in the standard agent form "TokenName (UserName)" with the agent avatar) and the same identity authored the version entry.
2. **Given** a sync-mode push, **When** presence is announced, **Then** it uses the same agent name the sync update is attributed with in history (default "Repo Sync"; on-behalf-of provenance in history unchanged from today).
3. **Given** any import request, **When** the caller attempts to influence the presence label per-request, **Then** there is no such affordance — the label derives solely from the authenticated identity fixed at token mint time.

---

### User Story 5 - Newly minted tokens are named for the agent they serve (Priority: P3)

Because the token's name is now a user-facing presence label, the token-minting surfaces that agents use for the byte channel produce concise names that describe the AGENT the token serves — derived from the connecting client's identity where available (e.g. "Claude Code") — instead of verbose provenance strings (e.g. "Minted by Claude via import_markdown_file"). The name answers "who is here", not "what operation ran" (Sam, 2026-07-31: agent-descriptive, not operation names like "Markdown sync"). Liz sees a cursor labeled like a collaborator, not like an audit record or a task.

**Why this priority**: Companion contract change (ratified in the Agent Surface doc, corrected by Sam 2026-07-31); valuable but independent — presence works with any token name.

**Independent Test**: Mint tokens via the import-recipe tool and via the general token-minting tool without supplying a name; inspect the default names created and the minting tools' guidance to callers.

**Acceptance Scenarios**:

1. **Given** an agent obtains a token via the import-recipe flow, **When** the token is created, **Then** its default display name is a concise agent-descriptive label derived from the connecting client's identity where available (e.g. "Claude Code"), never a verbose provenance string and never an operation name.
2. **Given** an agent mints a token via the general minting tool without supplying a name, **When** the token is created, **Then** its default display name is likewise concise and agent-descriptive; a caller-supplied name is still honored unchanged, and the tool contract instructs agents to name the token after themselves.
3. **Given** tokens that existed before this feature, **When** they are used for imports, **Then** they keep their existing names — no retroactive renaming.

---

### Edge Cases

- **Human-session import**: an import authenticated by a browser session (a human, not an agent identity) announces no agent presence — the human's own client already represents them. Behavior otherwise unchanged.
- **Doc creation via the create-mode import**: no presence — a just-created document has no viewers. Excluded by ratified decision.
- **No-op sync push** (canonicalization yields an empty diff): the agent still appears (it did arrive and inspect), but no temporary selection is shown — there is no changed range to select. No version entry is created (unchanged from today).
- **Import fails after presence opened** (validation error, size cap, baseline rejection): the import's error response is unchanged; the presence session is not torn down synchronously — it expires on its own lifetime like any idle session.
- **Text-less changed range** (e.g. replace with a single image block or horizontal rule): the selection anchors to element boundaries; position computation never inserts anything into the document to make a position computable (reads-never-write).
- **Editor-role check fails or auth fails**: no presence is ever announced — the session opens only after the request has passed authentication and the editor-role gate.
- **Viewer joins mid-import**: a viewer connecting during the pre-apply window sees the agent presence like any other collaborator (standard awareness sync).
- **Concurrent human edits during the import window**: unaffected; the import applies exactly as today (CRDT semantics unchanged), and the temporary selection covers the import's own changed range.

## Requirements *(mandatory)*

### Functional Requirements

**Presence announcement (ratified: mechanism bullet)**

- **FR-001**: Every update-mode import request (all modes: append, replace, sync) authenticated as an agent identity MUST announce live presence in the target document using the same server-side agent-presence session mechanism the MCP tools and chat assistant use — no parallel or bespoke awareness relay.
- **FR-002**: Because the shared mechanism is reused, existing presence guarantees MUST apply unchanged: per-identity dedup (at most one visible presence entry per agent identity per document, across instances) and cross-instance awareness fan-out (viewers on any replica see the presence).
- **FR-003**: Presence MUST be announced only for agent identities; imports authenticated by a human browser session MUST NOT announce an agent presence.
- **FR-004**: The create-mode import (new-document creation) MUST NOT announce presence.
- **FR-005**: The presence session requires the agent's real credential to dial back into the service; the REST handler MUST obtain it either by recovering the bearer credential from the request or by minting a synthetic agent token pair for the same identity (both patterns exist; the choice is left to the plan).

**Timing (ratified: timing bullet)**

- **FR-006**: The presence session MUST be opened after the request passes authentication and the editor-role gate, and before parsing and the image-processing pass begin — viewers see the agent arrive before any content changes, including during pre-apply work that can take tens of seconds.
- **FR-007**: Presence MUST be refreshed at apply time and MUST linger after the response for the standard session lifetime (~60 seconds), then clean itself up automatically; no explicit teardown is part of the request flow.

**Best-effort invariant (ratified: best-effort bullet)**

- **FR-008**: Presence MUST never cause an import to fail: any error in session creation, cursor placement, or selection computation MUST be logged and swallowed, leaving the import's behavior and response contract identical to today.
- **FR-009**: Presence MUST never materially slow an import: session creation is awaited for at most a short cap (~2 seconds), after which the import proceeds and the session attempt completes (or fails) in the background, fire-and-forget.

**Visuals (ratified: visuals-v1 bullet)**

- **FR-010**: The presence rendered is the standard agent presence: agent avatar and live cursor, identical in kind to MCP-tool presence. No new client-side rendering is introduced.
- **FR-011**: After a successful apply, the session MUST show the existing temporary selection (standard ~10-second self-clearing behavior) over the changed range, defined per mode: **append** — the appended blocks; **replace** — the imported content; **sync** — the first through last changed block.
- **FR-012**: When an import results in no content change (e.g. an empty-diff sync push), no temporary selection is shown; the presence session itself still occurs.
- **FR-013**: Every position computation for cursor or selection MUST obey the reads-never-write invariant: positions are computed from existing structure only, anchoring to element boundaries for text-less blocks; presence code paths MUST NOT mutate the document, ever.
- **FR-014**: No modify-style highlight sweep is performed in v1.

**Identity (ratified: identity bullet)**

- **FR-015**: The presence identity MUST mirror version-history attribution for the same change. Append/replace announce as the authenticated token's name in the standard agent form ("TokenName (UserName)", agent-flagged avatar); sync announces under the same agent name its update is recorded with (default "Repo Sync"). On-behalf-of provenance handling in history is unchanged.
- **FR-016**: There MUST be no per-request presence-label override on the import routes; the label derives solely from identity fixed at token mint time.

**Mint-time naming (ratified: identity bullet, companion contract; corrected by Sam 2026-07-31)**

- **FR-017**: The import-recipe minting flow and the general token-minting tool MUST default newly minted token names to concise labels that describe the agent the token serves — derived from the connecting client's identity where available (e.g. "Claude Code") — never verbose provenance strings and never operation names (e.g. not "Markdown sync"). The name answers "who is here", not "what operation ran". Caller-supplied names remain honored; existing tokens keep their names.
- **FR-017a**: The minting tools' contract (descriptions/documentation) MUST tell agents to name the token after themselves, so caller-supplied names also converge on agent-descriptive labels.

**Cross-replica content fan-out (ratified: folded-in fix bullet)**

- **FR-018**: An import's content change (append, replace, and sync push) MUST reach live viewers on all replicas regardless of whether the handling replica holds a live editing connection for the document — the required outcome is "content updates always fan out"; the mechanism (the established live-apply publish pattern already used by undo and restore, or equivalent) is left to the plan, including the shape needed where imports transact on the shared document rather than applying an encoded update.
- **FR-019**: The fan-out fix MUST NOT double-apply updates on replicas that already relay the document, and MUST leave single-replica behavior unchanged.

### Key Entities

- **Presence session**: an ephemeral server-side collaborator entry (avatar, name, cursor, agent flag) tied to one agent identity on one document; bounded lifetime (~60 s default, clamped 1–300 s), deduplicated per identity per document across instances; carries temporary selections (~10 s self-clearing).
- **Agent identity**: the authenticated non-human actor behind a request — for the byte channel, an API token (name fixed at mint time) acting for a user; for sync pushes, the sync agent name the update is attributed with. The single source for both presence labels and version-history attribution.
- **Changed range**: the span of document content an import altered, per mode (appended blocks / imported content / first-to-last changed block); the target of the post-apply temporary selection.
- **Import request**: a byte-channel write against an existing document in one of three modes (append, replace, sync); unchanged in contract by this feature except for the presence side effect.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 100% of agent-authenticated imports against an open document, a watching user sees the importing agent's presence before any content changes, for all three modes.
- **SC-002**: Repeating the 2026-07-30 observation (a coding-agent session syncing a design doc while the user watches) shows a named agent cursor arrive, a temporary selection over the changed content, and automatic departure — the "document changes with nobody there" report cannot recur for agent imports.
- **SC-003**: On a two-replica deployment, a viewer connected to the non-handling replica sees the import's content change live (no reload) in 100% of cases, for all three modes.
- **SC-004**: With the presence machinery artificially failing or hanging, import success rate and response contract are identical to the pre-feature baseline, and added latency from presence never exceeds the short cap (~2 s) per request.
- **SC-005**: Imports with presence enabled produce zero presence-attributed document mutations: for any import, final document content is identical to the same import with presence disabled.
- **SC-006**: For every import that creates a version entry, the presence label shown to viewers matches the author identity recorded in version history (100% agreement across the mode × identity matrix).
- **SC-007**: Tokens minted through either minting surface without a caller-supplied name have concise agent-descriptive display names (no "Minted by … via …" provenance strings and no operation names among new defaults).

## Assumptions

- The existing agent-presence machinery (session creation, lifetime clamp 1–300 s, temporary selections, presence-claim dedup, awareness fan-out) is reused as-is; this feature adds callers, not presence capabilities. Its established defaults (~60 s session, ~10 s selection) are used unchanged — no new tunables.
- The client already renders agent presence (avatar, cursor, temporary selection) with no changes; "visuals v1" is entirely server-driven through existing awareness channels.
- Authentication and the editor-role gate on the import routes are unchanged; presence introduces no new authorization semantics (session creation may additionally verify access, but the route's own gates run first and remain authoritative for the import).
- Version-history attribution for imports (token identity for append/replace; sync agent name with on-behalf-of provenance for sync) is unchanged; this feature aligns presence *to* it, not the reverse.
- The production topology of record is 2 replicas; the fan-out requirement is stated for N replicas.
- Undo-on-import is out of scope: REST imports do not record agent-edit undo targets today, and this feature does not change that (recorded as an explicitly deferred question in `clarifications-needed.md`).
- Renaming existing tokens is out of scope; only defaults for newly minted names change.

## Out of Scope

- Presence on the create-mode import — ratified exclusion; a just-created document has no viewers.
- Modify-style highlight sweeps over imported content — ratified as not-v1.
- Per-request presence label overrides — ratified exclusion; identity is fixed at mint time.
- Undo/redo support for REST imports (no agent-edit undo targets recorded today; explicitly deferred, see `clarifications-needed.md`).
- Retroactive renaming of existing tokens.
- Any change to import request/response contracts, receipts, scopes, rate limits, or the sync protocol itself.
- New client-side rendering or presence UI.
