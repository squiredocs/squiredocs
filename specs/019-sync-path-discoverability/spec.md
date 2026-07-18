# Feature Specification: Sync-Path Discoverability for External Agents

**Feature Branch**: `019-sync-path-discoverability`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Make the REST import byte channel win the 'sync an existing markdown file' decision for external MCP agents: a seventeenth no-content recipe tool (import_markdown_file), trigger-word contract for first-seen tool text, teaching nudge/soft-refusal on bulk markdown into create_document, first-sync remedy in the sync_baseline_missing error, headline/channel-rule wording, and an agents.md task-named recipe."

**Design ground truth** (both dated 2026-07-18, commit 3b13209):

- `design/agent-surface-mcp.md` → "Agents are collaborators, not a backdoor" — **Amendment (Sam, 2026-07-18) — sync-path discoverability (feature 019)** (RATIFIED): the seventeenth recipe tool, the trigger-word contract for first-seen tool text, the get_tool_documentation headline, the server-instructions trigger phrase, the agents.md heading, and the explicit non-changes.
- `design/markdown-import-two-way-sync.md` → **Amendment (Sam, 2026-07-18) — teaching surfaces for the byte channel (feature 019)** (RATIFIED): the bulk-markdown success nudge and soft refusal with `allowRetyped` escape hatch (never unconditional), and the `sync_baseline_missing` first-time remedy.
- Full failure-point analysis (FP1–FP7, remedies R1–R7): the 2026-07-18 discoverability report, Squire doc `2c794a7b-91c6-44b3-8638-c32da80090c2`.

## Overview

Squire already has a correct, byte-faithful path for moving an existing markdown file into a document: the REST import channel (`POST /api/docs/import`, `PUT /api/docs/:docId/import`, `mode=sync`), reached via a claim-delivered `sk_sqd_` token that never transits model context. The founding retype incident showed the problem is not the channel — it is the *decision moment*. An external MCP agent told to "sync this file into Squire" scans a tool list that contains no sync-shaped affordance, while the wrong path is one silent `create_document({ markdown })` call away. The channel rule lives in prose the agent may never read (server instructions get truncated or skipped; schema-skimming clients surface parameter schemas, not description essays), and the first failed sync attempt (`sync_baseline_missing`) explains what is wrong but not how a first-timer gets a baseline.

This feature makes the byte channel win that decision at every surface an external agent actually sees, in priority order of when the agent sees it:

1. **A sync-shaped tool in the list**: a seventeenth tool, `import_markdown_file`, that takes NO document content and returns a ready-to-run one-shot shell recipe (token claim + curl import + receipt write-back) built on the existing pending-mint machinery. The task name in the tool list is the affordance.
2. **Trigger words in first-seen text**: the words an agent pattern-matches on ("sync", "import an existing file", "already read the file", `mode=sync`) appear in the title lines, redirects, and — critically — the parameter *schema* descriptions that schema-skimming clients surface.
3. **Teaching at the moment of the mistake**: bulk markdown retyped into `create_document` gets a success nudge above a small threshold and an instructive soft refusal (with an explicit `allowRetyped` escape hatch, never an unconditional block) above a large one; the `sync_baseline_missing` rejection gains the first-sync remedy.
4. **A task-named recipe in agents.md** for agents onboarded through the docs page.

Nothing about the underlying channel changes: claim-based token delivery, the receipt contract, and the `rest_api` reference stay exactly as they are, and no MCP tool ever accepts or returns document content it does not accept today.

## User Scenarios & Testing *(mandatory)*

The "users" of this feature are external MCP agents (Claude Code, Kiro, and similar shell-capable coding agents) acting for a Squire user, the shell-less MCP agents that cannot run commands, and the humans whose files those agents sync — who care that the bytes on disk and the document stay exactly faithful to each other.

### User Story 1 - "Sync this file" finds the byte channel on the first try (Priority: P1)

As a shell-capable external agent asked to "sync this existing markdown file into Squire", I find a tool in the tool list whose name and first description line match my task, call it without pasting any file content, receive a single ready-to-run shell command, run it, and the file is imported byte-faithfully with a receipt written back over the file — leaving the file a valid sync baseline for future pushes.

**Why this priority**: This is the core remedy for the founding retype incident. The tool LIST is the one surface every MCP client shows; a task-shaped entry there beats any amount of prose. Without it, the wrong path (`create_document({ markdown })`) remains the only visible affordance.

**Independent Test**: Connect an MCP client, list tools, call `import_markdown_file` with no arguments, execute the returned command in a shell against a live server with a real markdown file, and verify: document created with the file's content (byte-faithful per the receipt), receipt written back over the file, and a subsequent `mode=sync` push from that file succeeds.

**Acceptance Scenarios**:

1. **Given** a connected agent with write scopes, **When** it lists tools, **Then** seventeen tools are listed, one named `import_markdown_file` whose first description line contains "sync".
2. **Given** a markdown file on the agent's disk, **When** the agent calls `import_markdown_file()` (no arguments) and runs the returned compound command with the file path filled in, **Then** one shell invocation claims a token, imports the file's bytes over HTTP, and writes the frontmattered receipt back over the file — and no document content or token ever appeared in the tool call or its result.
3. **Given** the receipt-stamped file from scenario 2, **When** the agent later pushes it with `mode=sync`, **Then** the push is accepted (the write-back made the file a valid baseline).
4. **Given** an existing document the agent wants to sync into, **When** it calls `import_markdown_file({ docGuid, intent: "sync" })`, **Then** the returned command targets that document's sync route instead of creating a new document.
5. **Given** an agent whose principal lacks write scope, **When** it calls `import_markdown_file`, **Then** the call is rejected with the standard insufficient-scope error naming the required scope.
6. **Given** a shell-less agent, **When** it calls `import_markdown_file`, **Then** the result's guidance tells it what to do instead (inline token delivery for REST-capable agents; the in-context `create_document` path for small content) rather than leaving it stuck.

---

### User Story 2 - Trigger words reach schema-skimming agents (Priority: P1)

As an external agent that only ever sees tool names, title lines, and parameter schemas (my client truncates or elides long descriptions), I still hit the words "sync", "import", "existing file", and the byte-channel redirect at the exact moments I am deciding how to move a file — including inside the `markdown` parameter's own schema description, and even when I have already read the file into context.

**Why this priority**: Ties with User Story 1: the recipe tool only wins if the *wrong* tools' first-seen text actively deflects. FP-analysis showed agents that had already read a file rationalize retyping ("it's already in my context"); the deflection must pre-empt exactly that.

**Independent Test**: Inspect the live tool list and server-initialization payload as an MCP client sees them; assert each named trigger word appears on its named surface, and every changed description remains under the 2 KB client truncation cap.

**Acceptance Scenarios**:

1. **Given** the tool list, **When** an agent reads `create_document`'s title (first) line, **Then** it names syncing/importing an existing file as the case NOT to use this tool for.
2. **Given** `create_document`'s byte-channel redirect, **When** an agent that has already read the file consults it, **Then** it finds the sentence stating that even if the file has already been read, the file remains the source of truth and the byte channel must be used.
3. **Given** a schema-skimming client that surfaces only parameter schemas, **When** the agent inspects `create_document`'s `markdown` parameter, **Then** the parameter's own schema description carries a one-sentence redirect away from retyping existing files.
4. **Given** `modify`'s description, **When** an agent is replacing or syncing document content from an existing file, **Then** the redirect covers "or syncing" and names `mode=sync`.
5. **Given** `get_tool_documentation`'s description, **When** an agent skims its headline, **Then** the headline names the REST byte channel and the `rest_api` tool id alongside the script tools.
6. **Given** the server instructions delivered at initialize, **When** an agent reads the channel rule, **Then** it contains the trigger phrase "to sync/import an existing file".
7. **Given** any changed or new tool description, **When** its size is measured in UTF-8 bytes, **Then** it is at most 2,048 bytes (test-asserted), and the server instructions remain comfortably under the same cap.

---

### User Story 3 - The mistake itself teaches: nudge and soft refusal (Priority: P2)

As an agent that retypes bulk markdown into `create_document` anyway, I am taught at the moment of the mistake: a modest paste succeeds but the result points me to the byte channel; a large paste is refused once with an error that explains BOTH the byte-channel route AND the `allowRetyped: true` escape hatch — and if I genuinely cannot use a shell, retrying with `allowRetyped: true` always works.

**Why this priority**: P2 because it is the safety net behind the P1 surfaces — it catches agents that ignored every deflection. It must never become a wall: small in-context seeds are the designed use of `create_document`, and shell-less agents have no byte channel at all.

**Independent Test**: Call `create_document` with markdown bodies below, between, and above the two thresholds, with and without `allowRetyped: true`, and assert the exact success/nudge/refusal/escape behaviors.

**Acceptance Scenarios**:

1. **Given** markdown under the nudge threshold (default 2 KB), **When** `create_document` is called, **Then** the result is unchanged from today — no nudge, no new fields, zero behavior change.
2. **Given** markdown at or above the nudge threshold but under the refusal threshold, **When** `create_document` is called, **Then** the document is created normally and the SUCCESS result appends a pointer to `POST /api/docs/import` describing it as byte-faithful and receipt-verified.
3. **Given** markdown at or above the refusal threshold (default 10 KB) and no `allowRetyped`, **When** `create_document` is called, **Then** the call fails with an instructive error — no document is created — and the error text explains both the byte-channel route and that retrying with `allowRetyped: true` will be honored.
4. **Given** the same oversized markdown with `allowRetyped: true`, **When** `create_document` is called, **Then** the document is created (the escape hatch is always honored — the refusal is never unconditional) and the success result still carries the byte-channel nudge.
5. **Given** thresholds tuned via environment configuration, **When** the operator changes them, **Then** the nudge and refusal trigger at the configured byte lengths without code changes.
6. **Given** multi-byte (non-ASCII) markdown, **When** thresholds are evaluated, **Then** the measurement is the UTF-8 byte length of the `markdown` argument, not its character count.

---

### User Story 4 - First sync failure explains the way in (Priority: P2)

As an agent making its first-ever sync push of a file that has no baseline frontmatter, the `sync_baseline_missing` rejection I receive tells me the first-time remedy — do an initial import with `frontmatter=true` and write the returned receipt back over the file — instead of only telling me what is missing.

**Why this priority**: The first sync attempt is the highest-intent moment in the whole funnel: the agent has already chosen the right channel and is one missing concept (the baseline) from success. Today's message names the mechanism but not the bootstrap.

**Independent Test**: Push a frontmatter-less file with `mode=sync` and assert the 400 body's message includes the remedy text.

**Acceptance Scenarios**:

1. **Given** a `mode=sync` push with no `squire.clock` frontmatter and no `baselineClock` parameter, **When** the request is rejected with `sync_baseline_missing`, **Then** the rejection includes the remedy: "First sync of this file? Do an initial import with frontmatter=true and write the returned markdown receipt back over the file — it is then a valid sync baseline."
2. **Given** the other sync rejection codes (`sync_doc_mismatch`, `sync_baseline_invalid`, `sync_baseline_unavailable`), **When** they occur, **Then** their messages are unchanged.

---

### User Story 5 - agents.md answers the task by name (Priority: P3)

As an agent (or its human) onboarding through the public agents.md page, I can find a recipe under a heading named for my task — "Sync a repo file" — that walks the full loop: mint or recipe-tool, initial import with `frontmatter=true`, receipt write-back, and subsequent `mode=sync` pushes.

**Why this priority**: P3 because agents.md is read at onboarding time, not at the decision moment; it complements but does not gate the in-band surfaces.

**Independent Test**: Fetch `/agents.md` and verify the task-named heading exists with the four recipe steps.

**Acceptance Scenarios**:

1. **Given** the published agents.md, **When** a reader scans its headings, **Then** a heading named "Sync a repo file" exists.
2. **Given** that section, **When** an agent follows it end-to-end, **Then** it covers: getting a write-scoped token (or calling `import_markdown_file`), the initial import with `frontmatter=true`, writing the receipt back over the source file, and ongoing `mode=sync` pushes.

---

### Edge Cases

- `import_markdown_file({ intent: "update" })` or `{ intent: "sync" }` **without** a `docGuid`: rejected with an instructive parameter error (those intents target an existing document).
- `import_markdown_file({ docGuid, intent: "create" })`: rejected — `create` makes a new document; a supplied `docGuid` signals contradictory intent.
- The recipe's one-shot claim expires (5-minute claim window) before the agent runs the command: the command's failure branch says so; the agent simply calls the tool again for a fresh recipe. No token was minted or leaked.
- The agent runs the recipe command twice: the second run fails at the claim step (one-shot redemption) with the command's built-in failure message; nothing is double-imported.
- Markdown exactly at a threshold boundary: "at or above" semantics — a body of exactly the nudge-threshold byte length gets the nudge; exactly the refusal-threshold byte length gets the refusal.
- `allowRetyped: true` on a small (sub-refusal) call: accepted and ignored — never an error, no behavior difference below the refusal threshold except that the nudge still appears in its band.
- Oversized markdown that ALSO has other failure causes (e.g. no title and empty body): the size refusal is evaluated before import side effects — a refused call must create nothing.
- A shell-less agent hits the 10 KB refusal: the escape hatch is exactly for it — the error text explains `allowRetyped: true`, and the retry succeeds. The refusal is never a hard block for any caller.
- Misconfigured thresholds (refusal ≤ nudge, zero, or negative): the system falls back to the defaults rather than refusing everything or nothing.
- `import_markdown_file` called by a principal whose own scopes cannot mint a write token: standard insufficient-scope error at the tool call — the agent never receives a recipe that would fail at claim time.
- The document targeted by `docGuid` does not exist or is not accessible: the recipe is still returned (the tool does not probe documents); the REST call in the recipe fails with the channel's existing 403 semantics, exactly as a hand-written curl would.

## Requirements *(mandatory)*

### Functional Requirements

**The seventeenth tool: `import_markdown_file` (recipe, no content)**

- **FR-001**: The MCP server MUST expose a seventeenth tool named `import_markdown_file`. The design doc's "Transport and tools" count becomes seventeen, and the tool appears in the registry with a required scope of `documents:write` (its recipe mints a write-capable token; a read-only principal must be refused at the tool boundary, not at claim time).
- **FR-002**: The tool MUST NOT accept document content, file contents, or a file path through any parameter. Its input schema is at most `{ docGuid?: string, intent?: "create" | "update" | "sync" }`, both optional. No document content and no token may ever pass through the tool's input or output in either direction.
- **FR-003**: The tool MUST return ONE ready-to-run compound shell command that performs, in a single invocation: (a) the one-shot token claim (existing pending-mint machinery — the tool creates a pending mint exactly as `create_access_token`'s claim delivery does), (b) the curl import of the file's bytes for the resolved intent, and (c) the receipt write-back — the import is requested with a frontmattered receipt and the command writes that receipt back over the source file, leaving it a valid sync baseline. The file path appears in the command as a single fill-in placeholder at the front (see Assumptions/RBD-2); the agent substitutes it and runs the command unmodified otherwise.
- **FR-004**: Intent resolution: `create` → new-document import (`POST /api/docs/import`); `update` → replace-content import into the existing document (`PUT /api/docs/:docId/import?mode=replace`); `sync` → baseline-anchored sync push (`PUT /api/docs/:docId/import?mode=sync`). When `intent` is omitted, it defaults to `sync` if `docGuid` is present, else `create`. `update`/`sync` without `docGuid`, or `create` with one, are parameter errors (see Edge Cases). (RBD-1)
- **FR-005**: All security properties of the claim flow MUST be preserved unchanged: the claim secret is one-shot (first claim wins), expires on the existing claim window (5 minutes), the minted token is scope-capped at the caller, TTL-bounded, cannot mint further tokens, is revoked with its minting credential, appears under Settings → API Tokens, and the raw token goes server → disk (or server → process-local shell state) without ever entering model context or the tool result. The recipe command MUST NOT print, echo, or persist the token anywhere the model would re-read beyond the existing `~/.squire/token` convention.
- **FR-006**: The first line of the tool's description MUST contain the word "sync" and name the task (syncing/importing an existing markdown file) — the tool-list title line is the primary affordance.
- **FR-007**: The tool result MUST include guidance for shell-less agents: that without a shell they should use `create_access_token({ inline: true })` plus the `rest_api` reference if they can make HTTP requests, or the in-context `create_document`/`modify` path for small content. A shell-less caller is informed, never stranded or hard-blocked. (RBD-5)
- **FR-008**: The tool MUST NOT probe or validate the target document's existence or the caller's access to it beyond scope checking — the recipe is generated statelessly and the REST channel's existing auth semantics (missing ≡ no access ≡ 403) apply when the command runs.

**Trigger-word contract for first-seen text**

- **FR-009**: `create_document`'s title (first) line MUST name syncing/importing an existing file as the excluded case, so the exclusion is visible in clients that render only the first line.
- **FR-010**: `create_document`'s byte-channel redirect MUST add the already-read-it sentence: even if the agent has already read the file, the file remains the source of truth — use the byte channel.
- **FR-011**: The `markdown` **parameter schema description** of `create_document` MUST itself carry a one-sentence redirect away from retyping existing files (schema-skimming clients never see the prose description; the current parameter description is 143 bytes and has ample budget).
- **FR-012**: `create_document`'s description MUST be trimmed to make room for FR-009/FR-010: measured today it is 1,917 UTF-8 bytes (131 bytes of headroom), which the added title-line wording and already-read-it sentence will exceed. Trimming candidate: the five-bullet "WHY INCREMENTAL" rationale collapses to one line (the rationale is teaching prose, not contract). No contract content (parameter semantics, title precedence, at-least-one-of rule) may be dropped. (RBD-4)
- **FR-013**: `modify`'s byte-channel redirect MUST cover "or syncing" and name `mode=sync`, and its description MUST be trimmed below the cap: measured today it is 2,049 UTF-8 bytes — **already 1 byte over the 2,048-byte cap** (earlier working notes claiming ~370 of headroom measured characters, and optimistically at that; the cap is bytes and clients truncate). Trimming candidate: the NON-NEGOTIABLE RULES block duplicates content that lives canonically in `get_tool_documentation({ tool: "modify" })`. The script contract, parameter list, and returns summary may be tightened but not dropped. (RBD-4)
- **FR-014**: `get_tool_documentation`'s headline (first line) MUST name the REST byte channel and the `rest_api` tool id alongside the script tools (measured current size: 922 bytes; ample budget).
- **FR-015**: The server-instructions CHANNEL RULE sentence MUST gain the trigger phrase "to sync/import an existing file". Measured current size: 1,128 bytes; the amended instructions MUST stay comfortably under the 2 KB client cap (target ≤ 1,536 bytes). (RBD-7)
- **FR-016**: Every changed or new MCP tool description MUST be measured and test-asserted at ≤ 2,048 **UTF-8 bytes** (not characters — the descriptions contain multi-byte punctuation, and character counts undercount by up to ~1%). Budgets are computed against whatever `main` holds at implement time, not against today's text (see Assumptions). Measured today for the record (bytes): `create_document` 1,917; `modify` 2,049; `get_tool_documentation` 922; `create_access_token` 1,225; server instructions 1,128.

**Teaching nudge and soft refusal on `create_document`**

- **FR-017**: The nudge/refusal trigger MUST be the UTF-8 byte length of the `markdown` argument. Thresholds MUST be environment-tunable with defaults of 2,048 bytes (nudge) and 10,240 bytes (refusal); invalid configurations (refusal ≤ nudge, non-positive, non-numeric) fall back to the defaults. (RBD-3)
- **FR-018**: At or above the nudge threshold, `create_document` MUST succeed exactly as today and append to its SUCCESS result a pointer to `POST /api/docs/import`, described as byte-faithful and receipt-verified.
- **FR-019**: At or above the refusal threshold without `allowRetyped: true`, the first call MUST be refused with an instructive error that creates nothing and whose text explains BOTH (a) the byte-channel route and (b) that retrying the identical call with `allowRetyped: true` will be honored. The refusal MUST never be unconditional: `allowRetyped: true` is always honored, on any call, for any caller (shell-less agents have no byte channel — the escape hatch is their path).
- **FR-020**: A retry (or first call) with `allowRetyped: true` at or above the refusal threshold MUST succeed and MUST still carry the success nudge of FR-018. `allowRetyped` on a sub-refusal call is accepted and has no effect. `allowRetyped` MUST be added to `create_document`'s input schema so clients that validate arguments can pass it.
- **FR-021**: Below the nudge threshold there MUST be zero behavior change: identical result shape, fields, and messages as today. Small in-context seeds remain the designed use of `create_document({ markdown })`.

**First-sync remedy**

- **FR-022**: The `sync_baseline_missing` rejection MUST include the first-time remedy text: "First sync of this file? Do an initial import with frontmatter=true and write the returned markdown receipt back over the file — it is then a valid sync baseline." The other sync rejection codes are unchanged.

**agents.md**

- **FR-023**: agents.md MUST gain a task-named recipe section headed "Sync a repo file" covering: obtaining the one-shot recipe via `import_markdown_file` (or minting a write-scoped token), the initial import with `frontmatter=true`, writing the receipt back over the source file, and subsequent `mode=sync` pushes. The agents.md contract remains owned by the design doc (`design/agent-surface-mcp.md`); the published file and the design contract MUST stay in agreement.

**Explicit non-changes (design-pinned)**

- **FR-024**: The following MUST NOT change: no content-accepting MCP import tool is added; no refusal anywhere is unconditional; no tool is renamed; the claim-based token delivery mechanics, the import receipt contract, and the `rest_api` reference content stay as-is.

### Key Entities

- **Import recipe**: the value `import_markdown_file` returns — one compound shell command (claim + curl + receipt write-back) plus guidance fields; parameterized only by a file-path placeholder, intent, and optional target document; contains no content and no secret other than the one-shot claim secret (existing, accepted transcript residue).
- **Pending mint**: the existing one-shot, hash-at-rest, claim-window-limited record behind claim delivery; feature 019 creates them from a second call site and changes nothing about them.
- **Teaching thresholds**: two environment-tunable byte lengths (nudge, refusal) evaluated against the `markdown` argument's UTF-8 byte length.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An MCP client listing tools sees exactly seventeen tools; `import_markdown_file` is present, requires write scope, and its first description line contains "sync". (Registry/scope test.)
- **SC-002**: The recipe works end-to-end against a live server: starting from a plain markdown file and zero credentials, running the tool's returned command (file path filled in) yields — in one shell invocation — a created/updated document whose receipt matches the file byte-for-byte per the receipt contract, and the written-back file passes a subsequent `mode=sync` push. (Integration test.)
- **SC-003**: The `import_markdown_file` tool call and result contain no document content and no `sk_sqd_` token in any field, for every intent. (Test-asserted on the result payload.)
- **SC-004**: Every changed or new tool description measures ≤ 2,048 UTF-8 bytes and the server instructions ≤ 1,536 UTF-8 bytes, asserted by an automated test (byte-length, not character-length) that fails on regression — including `modify`, which measures over the cap today and must land under it.
- **SC-005**: Each trigger surface carries its pinned words, verified by test: `create_document` title line (existing-file exclusion), already-read-it sentence, `markdown` schema-description redirect, `modify` "or syncing" + `mode=sync`, `get_tool_documentation` headline naming the byte channel + `rest_api`, server-instructions phrase "to sync/import an existing file", agents.md "Sync a repo file" heading.
- **SC-006**: `create_document` with a ≥ 10 KB markdown body and no `allowRetyped` returns an instructive refusal (nothing created) whose text names both the byte-channel route and the escape hatch; the identical call with `allowRetyped: true` succeeds and its result carries the nudge. Bodies in the 2–10 KB band succeed with the nudge appended.
- **SC-007**: `create_document` calls with markdown under 2 KB produce results byte-identical in shape to the pre-019 behavior (zero behavior change), covered by existing tests continuing to pass unmodified.
- **SC-008**: A frontmatter-less `mode=sync` push returns `sync_baseline_missing` including the remedy sentence, and an agent following that remedy verbatim (initial import with `frontmatter=true`, write receipt back) gets an accepted sync push on the next attempt. (Integration test.)
- **SC-009**: All claim-flow security tests continue to pass unchanged: one-shot redemption, claim expiry, scope capping, no-chaining, revocation cascade.

## Assumptions

- **Parallel surface-area effort**: a separate research effort is examining MCP tool surface-area *reduction*; 019 deliberately adds a tool. The tension is accepted and bounded: `import_markdown_file` is deliberately thin — no content, no state, a pure recipe generator over existing machinery — and any consolidation/rename decisions belong to that other effort (FR-024 pins no renames here). That analysis is expected to recommend a `read_document_version` → `read_document` merge and description diets which may land with or before 019; 019's description budgets and trigger-word placements are therefore computed against **whatever `main` holds at implement time**, not against today's text — the byte caps and required trigger words are invariant, the surrounding prose is not.
- **Measured sizes are today's baseline, not the contract** (2026-07-18, this repo; UTF-8 bytes): `create_document` description 1,917 (131 headroom — insufficient for the FR-009/FR-010 additions, hence the FR-012 trim); `create_document` `markdown` param schema description 143; `modify` description 2,049 — already 1 byte over the cap (hence the FR-013 trim); `get_tool_documentation` 922; `create_access_token` 1,225; server instructions 1,128. The 2,048-byte cap reflects observed MCP client truncation, is measured in bytes (the text contains multi-byte punctuation), and is treated as hard.
- **The recipe builds on, not beside, the pending-mint machinery**: `server/mcp/auth/pending-mints.js` (one-shot Redis redemption, 300 s claim window, hash-at-rest) and the claim endpoint are reused as-is; feature 019 adds a caller, not a mechanism.
- **`update` maps to replace-content import**: "update this doc from the file" means the file wins wholesale (`mode=replace`), matching the file-is-source-of-truth framing; incremental merge is what `sync` is for. (RBD-1)
- **File path via placeholder, not parameter**: the design pins the input schema to at most `{ docGuid?, intent }`, so the command carries a fill-in path variable rather than the tool accepting a path. (RBD-2)
- **Shell-less detection is impossible server-side**; the accommodation is informational (FR-007 guidance, FR-018 escape hatch), never behavioral branching on client identity.
- **Thresholds are operational tuning**, not product variation: env-configurable with fixed defaults (RBD-3); no per-user or per-client configuration.
- All decisions the design amendments did not pin were taken with best defaults and recorded as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)** in `clarifications-needed.md` (RBD-1 … RBD-7).

## Out of Scope

- Tool renames or consolidation of the existing sixteen tools (owned by the parallel surface-area effort).
- Any content-accepting MCP import tool (explicit design non-change).
- Changes to the `rest_api` reference content, the receipt contract, or the claim-based token delivery mechanics.
- Rate limiting, size limits, or auth changes on the REST import routes themselves (the 5 MB cap and `documents:write` gate stand as-is).
- The in-app chat agent's surfaces (`chatDescription`); 019 targets the external MCP surface.
- Database migrations (none for 019).
