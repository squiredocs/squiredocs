# Feature Specification: Plugin Logic (Plugin M2)

**Feature Branch**: `030-plugin-logic`

**Created**: 2026-07-22

**Status**: Draft

**Input**: User description: "Feature 030-plugin-logic: M2 \"Plugin logic\" from the ratified plugin-marketplace-publishing design"

**Design ground truth**: `/local-dev/design/plugin-marketplace-publishing.md` (ratified 2026-07-21) — sections "The shared artifact set", "First-run onboarding: the /squire:onboard flow", the consent-page first-run change, "Repeatable first-run testing" (the sign-off test matrix), and build milestone **M2 — Plugin logic** only. M1 (feature 029, the test mechanism) is BUILT, merged, and signed off by Sam (2026-07-21 ~8:45pm PT); this feature builds on it. M3 (packaging, manifests, mirrors, publish.mjs, wave submissions) stays gated on M2's exit and is explicitly out of scope. The agents.md contract this content restates is owned by `/local-dev/design/agent-surface-mcp.md` (design principle 4: the plugin restates the contract; it never forks it).

## Overview

M1 delivered the machinery to rehearse a first run cheaply and unattended: the fresh-user faucet, consent auto-approve, synthetic wipe, the headless OAuth-chain driver, the tier-3 rehearsal harness with its transcript grader, and the production single-account reset for Sam's self-test. M2 delivers the thing that machinery exists to tune: the **real plugin logic** — the canonical shared skill and onboarding content (`distribution/shared/skill.md`, `distribution/shared/onboard.md`), the consent page's first-run framing, and the iteration loop that runs the real content through the M1 harness across the full sign-off test matrix until the transcripts are clean and Sam signs off on both mechanics and tone.

M2 also pays the debts 029's promotion notes assigned to it: the grader's quote-vs-perform false-PASS vector (items 5/6 can pass when the model merely reads contract text aloud; item 6's doc-URL regex matches incidental paths) is fixed by anchoring grading to the actual rehearsal server origin and to observable tool-call events, and `--require-claude` is wired into the gate that consumes rehearsals.

Nothing is published in M2. The marketplaces' first impression must be the tuned flow, not the draft — publication, manifests, and mirrors are all M3, which cannot start until this feature's exit gate (clean matrix + Sam's HITL sign-off) is met.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Canonical coaching content that lands a pristine user in the loop (Priority: P1)

A developer with a coding agent installs the Squire Docs plugin and runs `/squire:onboard` having **no Squire Docs account at all**. The onboarding content detects that no Squire Docs tools are present in the session (by tool presence, never a probe call), coaches the user through browser consent — setting the expectation *before* anything opens that signing in with Google creates their account if they've never used Squire Docs — and, once tools appear, flows silently into finding a spec-shaped artifact in their repo, syncing it byte-faithfully, delivering the doc URL as the payoff, and teaching the standing read-spec/write-back loop. A user who is already connected skips straight to the spec. A user who hits any failure rung (declined consent, callback error, abandoned tab, no browser at all) is coached down the design's failure ladder — never improvised auth. Alongside the onboarding command, the installed skill teaches the agent *when* to reach for Squire Docs in real work: sync the spec from the repo before a run, read it at run start, write status/design back after implementing, move files over the byte channel, and keep tokens in `~/.squire/token` and out of the transcript.

**Why this priority**: This content IS the product's activation flow — the design's flagship deliverable and the reason M1's machinery was built. Every other story in this feature exists to exercise, grade, or frame this content.

**Independent Test**: Author the two shared files; a structured review checks every design-fixed element (entry states, the four walkthrough steps in order, the caveat, the four failure-ladder rungs, the five moves, the skill's loop and channel/token rules) is present and that nothing contradicts the Agent Surface contract. Full behavioral validation arrives via Stories 2–4.

**Acceptance Scenarios**:

1. **Given** a session where Squire Docs MCP tools are absent, **When** the onboarding flow runs, **Then** it branches to the auth walkthrough based on tool presence alone — no probe tool call, no attempt to distinguish "no account" from "has an account but never consented" (the copy states that Google sign-in creates the account if none exists, so one path covers both).
2. **Given** the walkthrough begins, **When** the user is coached, **Then** the steps occur in the design's order: (1) the expectation-setting line — browser will open Squire Docs' connect page; signing in with Google creates your account if you've never used Squire Docs, no separate signup step; then approve the connection — delivered BEFORE the browser opens; (2) pointing at the client's native flow (run `/mcp`, pick squire, complete browser consent — never `claude mcp add`, the plugin's server entry is already registered); (3) for remote/sandboxed sessions, the Agent Surface doc's OAuth walkthrough guidance applied verbatim (authorization URL bare on its own line; the expected localhost-callback error explained before the user opens the URL; copy the FULL callback URL and paste it back); (4) after consent and any client restart, tool presence is re-checked and the flow continues directly into finding the spec — no success ceremony.
3. **Given** a session where Squire Docs tools ARE present (prior consent or a loaded `sk_sqd_` token), **When** the onboarding flow runs, **Then** it skips the walkthrough entirely and goes straight to finding the spec, treating token auth as fully authenticated.
4. **Given** any failure rung — user declines consent / approved but the localhost callback errored / signed in but closed the tab / no browser reachable at all — **When** the flow handles it, **Then** the coaching matches the design's ladder for that rung (explain-and-retry via `/mcp`; expected-error paste-back; re-openable consent URL; account-from-any-device plus `sk_sqd_` token minted in Settings → AI Agent Access saved to `~/.squire/token`), and no rung ever invents a non-standard auth path.
5. **Given** a connected session in a repo, **When** the flow looks for a spec, **Then** it searches in the design's order — `.kiro/specs/**`, `specs/**`, `PLAN.md` / `docs/plan.md`, `CLAUDE.md` — offers the best candidate, and if nothing spec-shaped exists offers to draft a starter spec from the README and repo structure.
6. **Given** a chosen spec file, **When** it is synced, **Then** the sync is byte-faithful via the import recipe (frontmatter enabled, receipt written back) — file content never retyped through tool parameters — and the user then receives the doc URL plus what the editor adds (human review and refinement, every edit attributed human-vs-agent and revertible), followed by the closing loop teaching (agent reads the spec before each run, writes status/design back after; teammates and other agents see attributed edits in the same doc).
7. **Given** the installed skill, **When** the agent does ordinary implementation work in a repo with a synced spec, **Then** the skill's standing behavior applies: sync the spec from the repo before a run, read it at run start, write status/design back after implementing, byte channel for file sync, tokens in `~/.squire/token` and never printed into the transcript.
8. **Given** both shared files and the Agent Surface (MCP) contract, **When** they are compared, **Then** the shared content restates the contract without forking it — no contradiction on the channel rule, token handling, connect guidance, or walkthrough steps; any needed contract change would be an amendment to the Agent Surface doc, not local divergence.

---

### User Story 2 - The M1 harness rehearses the REAL content (Priority: P1)

A developer tuning the coaching runs the 029 rehearsal harness and it installs a bundle carrying the real `distribution/shared/` content — not the stub. A minimal assembly step generates an installable bundle (manifest skeleton, MCP config, skill and command files populated from `shared/`) that the harness's already-parameterized `--bundle` path consumes; the canonical files under `distribution/shared/` remain the single source of truth, generated copies carry do-not-hand-edit headers, and an agreement check fails the run if bundle content and `shared/` content diverge. The assembly step is deliberately NOT M3's `publish.mjs`: no mirrors, no submissions, no per-channel manifests beyond what a local rehearsal install needs.

**Why this priority**: Without it, Story 1's content is prose nobody can execute — the design's whole M2 method is "iterated against the M1 harness". It is the bridge between the content and every grading/matrix story below.

**Independent Test**: Run the assembly step, point the harness `--bundle` at its output, and complete one rehearsal; verify the transcript shows the real coaching (not stub markers), that `distribution/shared/` was not modified, and that tampering with a generated file makes the agreement check fail.

**Acceptance Scenarios**:

1. **Given** `distribution/shared/skill.md` and `distribution/shared/onboard.md` exist, **When** the assembly step runs, **Then** it produces an installable bundle whose skill and command content is populated from the shared files, with a do-not-hand-edit marker pointing at `distribution/shared/`.
2. **Given** the assembled bundle, **When** the 029 harness runs with `--bundle` pointed at it, **Then** the rehearsal installs and drives the real content end to end, and the source `distribution/shared/` files are byte-identical before and after (never mutated; endpoint indirection continues to use the harness's throwaway-copy mechanism).
3. **Given** a generated bundle file that has drifted from its `shared/` source, **When** a rehearsal (or the agreement check) runs, **Then** the divergence is detected and reported as a failure — content drift cannot silently ship into rehearsals. (The full drift-vs-shared CI test across all channel bundles is M3.)
4. **Given** the M3 boundary, **When** this feature's deliverables are inspected, **Then** no per-channel manifests, mirror-repo tooling, registry entries, or publish script exist beyond the minimal rehearsal assembly — `distribution/` contains only `shared/` plus whatever the rehearsal assembly needs.

---

### User Story 3 - The consent page becomes a first-run surface (Priority: P2)

A brand-new user, mid `/squire:onboard`, lands on the consent page unauthenticated. Instead of today's "Sign in required — please sign in to authorize this application" (existing-account framing, zero product pitch), they see first-run framing: a "Continue with Google" action with copy stating that sign-in and account creation are the same click, plus one line each for what Squire Docs is (the durable, attributed spec layer for agentic development), what the agent is asking to do, and that every agent edit is attributed and revertible. For the beachhead user this page IS the first impression of the product.

**Why this priority**: It is the only production app change in M2 and the one surface a real first-run user sees before they have an account; it must land before Sam's prod self-test can judge the real first impression. It is independent of the content stories.

**Independent Test**: Load the consent page unauthenticated and verify the new framing elements; complete the sign-in round-trip and verify consent still receives its OAuth parameters; run the existing consent/auth tests to confirm mechanics are unchanged.

**Acceptance Scenarios**:

1. **Given** an unauthenticated visitor on the consent page, **When** it renders, **Then** the primary action reads "Continue with Google" and the copy states that this same click creates the account for someone who has never used Squire Docs.
2. **Given** the same state, **When** the copy is inspected, **Then** it contains one line for each of: what Squire Docs is (the durable, attributed spec layer for agentic development), what the agent is asking to do, and that every agent edit is attributed and revertible.
3. **Given** all user-facing copy on this surface, **When** reviewed, **Then** it uses "Squire Docs" (never bare "Squire"), in the honest-confident voice, and the final wording passes Sam's tone sign-off (part of this feature's exit).
4. **Given** the framing change, **When** the sign-in round-trip runs, **Then** mechanics are unchanged: the validated same-origin returnTo still carries the visitor back to consent with OAuth parameters intact, signup provenance is still stamped `agent_oauth`, and the welcome-doc skip still holds (M1's tier-1 tests stay green).
5. **Given** an already-authenticated user on the consent page, **When** it renders, **Then** the existing consent card behavior is unchanged — the first-run framing applies only to the unauthenticated state.

---

### User Story 4 - Grading that cannot be fooled (Priority: P2)

A developer (or the matrix runner) grades a rehearsal transcript and trusts the result. The 029 grader's known false-PASS vectors are closed: a transcript in which the model merely QUOTES contract text (e.g., reads the skill aloud) without performing the behavior no longer passes the performable items; the doc-URL payoff item passes only for a URL on the actual rehearsal server's origin corroborated by an observed doc-creating tool call — never an incidental `/d/…` path; performable behaviors (byte-channel sync, doc creation) are graded from observable tool-call events, with prose checks reserved for genuinely prose items (the coaching lines). `--require-claude` is wired into the gate that consumes rehearsals, so a broken or skipped model leg can never read as success.

**Why this priority**: M2's exit criterion is "clean rehearsal transcripts" — that claim is only as strong as the grader. These are explicit M2 obligations recorded in 029's promotion notes, and they must land before `--require-all` gates anything.

**Independent Test**: Run the grader against regression fixtures — a quote-only transcript, a transcript containing an incidental `/d/…` path, and a genuine performing transcript — and verify FAIL/FAIL/PASS respectively; run the matrix runner with the model leg forced to fail and verify a non-zero exit.

**Acceptance Scenarios**:

1. **Given** a transcript where the model reads the coaching contract aloud but performs no sync and creates no doc, **When** graded, **Then** the byte-channel and doc-URL items FAIL.
2. **Given** a transcript containing a `/d/…` path that does not match the rehearsal server's origin or is not corroborated by an observed doc-creating tool call, **When** graded, **Then** the doc-URL item FAILs; **Given** a genuine rehearsal where a doc was created on the rehearsal server and its URL delivered, **Then** it PASSes.
3. **Given** the rehearsal capture, **When** a rehearsal runs, **Then** the transcript includes observable tool-call events (not prose only), and the performable items grade against those events.
4. **Given** the silent-reconnect item, **When** graded, **Then** it grades the behavior the design specifies — after tools appear the flow proceeds directly to finding the spec without success ceremony — rather than requiring "reconnect" prose that the design's "success needs no ceremony" rule tells the content NOT to produce (the M1 prose regex is reworked; see clarifications ledger).
5. **Given** the gate that consumes rehearsals (the matrix runner, Story 5), **When** any cell's model leg fails or is skipped, **Then** the gate exits non-zero — `--require-claude` is always in force there; an environment without model access refuses to run rather than silently skipping.

---

### User Story 5 - The full sign-off matrix and the M2 exit gate (Priority: P2)

A developer runs one command and the entire sign-off test matrix executes unattended in the dev pod: fresh user happy path · existing account never consented · already connected (straight to sync) · declined consent · abandoned tab · remote paste-back · headless token fallback · repos containing `.kiro/specs` / `specs/` / `CLAUDE.md` / nothing spec-shaped. Each cell runs the M1 harness (extended where a cell needs it: an unauthenticated no-tools mode, scripted user turns for the failure rungs, a token-fallback mode, per-shape fixture repos) and is judged against a per-cell expected-outcome profile — happy-path cells must pass the full coaching checklist; failure-ladder cells must show their rung's coaching and are exempted from items their scenario cannot reach. When every cell is clean, Sam walks the real flow in production (the M1 single-account reset + `selftest@example.com`) and signs off on **mechanics AND tone** — that sign-off, recorded, is M2's exit and M3's gate.

**Why this priority**: This is the design's exit criterion for M2 verbatim. It composes every other story, so it lands last, but the feature is not done without it.

**Independent Test**: Run the matrix command end to end in the pod; verify one graded, profile-judged result per cell, a non-zero exit if any cell misses its profile, and archived transcripts for Sam's review. The sign-off itself is HITL by definition.

**Acceptance Scenarios**:

1. **Given** the dev pod with the dev server up, **When** the matrix command runs, **Then** every matrix cell executes unattended, each producing an archived transcript and a per-cell grade judged against that cell's expected-outcome profile, and the command's exit status is non-zero unless every cell matches its profile with its model leg completed.
2. **Given** the fresh-user happy-path cell, **When** it runs, **Then** the client starts with no Squire Docs tools (unauthenticated mode — no pre-authorized header), the coaching walkthrough is observed, consent completes via the M1 auto-approve machinery, and the full checklist passes including a real byte-channel sync and a real doc URL on the dev server.
3. **Given** the existing-account-never-consented cell, **When** it runs, **Then** the account is pre-minted via the faucet before the client starts, the coaching is identical to the fresh cell (single find-or-create path), and after consent no duplicate account exists.
4. **Given** the already-connected cell, **When** it runs, **Then** the session starts with tools present (the M1 pre-authorized mode) and the flow skips the walkthrough and goes straight to spec sync.
5. **Given** the declined-consent and abandoned-tab cells, **When** they run, **Then** a scripted user turn reports the event ("I clicked deny" / the tab was closed) and the grade requires the rung's coaching: what the access was for and a retry offer via `/mcp` (declined); the consent URL is re-openable plus retry via `/mcp` (abandoned) — and no improvised auth in either.
6. **Given** the remote paste-back cell, **When** it runs in the pod (where the localhost callback naturally fails), **Then** the coaching shows the bare URL on its own line, the pre-warning about the expected callback error, and the paste-back instruction, and a scripted user turn pastes the full callback URL back.
7. **Given** the headless token-fallback cell, **When** it runs, **Then** the environment has a valid `sk_sqd_` token at the scratch `~/.squire/token` and no OAuth session, the flow treats token auth as fully authenticated, and it proceeds identically to the connected path.
8. **Given** the four repo-shape cells, **When** each runs in its fixture repo, **Then** the spec search follows the design's precedence order, the best candidate is offered (`.kiro/specs` beats `specs/` beats `PLAN.md`/`docs/plan.md` beats `CLAUDE.md`), and the nothing-spec-shaped cell produces a starter-spec offer drawn from the README and repo structure.
9. **Given** a clean full-matrix run, **When** Sam performs the production self-test (single-account reset + real Google + real browser + real prod) and approves both mechanics and tone, **Then** the sign-off is recorded in the feature's artifacts with date and scope — and M3 remains blocked until that record exists.

---

### Edge Cases

- **Both `.kiro/specs/**` and `specs/**` (or several candidates) exist**: precedence is the design's stated order; the flow offers the best candidate rather than silently picking, and the user can choose another.
- **Repo has no README and nothing spec-shaped**: the starter-spec offer falls back to repo structure alone; the flow still ends with a synced doc if the user accepts.
- **`/squire:onboard` re-run after a spec is already synced**: the flow prefers updating/syncing the existing doc (the sync receipt identifies it) over creating a duplicate (clarifications ledger RBD-9).
- **Token file exists but the token is expired or revoked**: tools are absent, which IS the walkthrough branch — the flow coaches reconnect/re-mint per the ladder rather than treating the stale file as authenticated.
- **Client needs a restart after install before the command or tools appear**: the content carries the command-availability caveat; tools-absent-until-consent is a branch, never an error to catch.
- **Model output varies run to run**: cell profiles grade required behaviors and the few design-fixed lines (semantically), not exact wording — but the exit-gate run must be a single full-matrix pass; a cell that only passes intermittently is a content defect to fix, not to retry into passing.
- **No model access (API key absent) when the matrix runs**: the runner refuses to run (fails loudly) rather than skipping model legs — a skipped leg can never look like a pass (`--require-claude` semantics).
- **Shared content edited mid-iteration**: the bundle is assembled from `shared/` per run (or the agreement check fails), so a rehearsal can never exercise stale content silently.
- **Consent page visited authenticated**: unchanged consent card; the first-run framing is strictly the unauthenticated state.
- **Consent copy length/layout on small screens**: the three one-liners must not push the primary action below the fold on common mobile viewports — first-run users arrive from a browser the agent just opened.
- **Any new backend tests**: share one database and run serially (constitution II).
- **Harness cells run concurrently**: not supported — cells run serially like all backend-DB-touching activity; the matrix command enforces this.

## Requirements *(mandatory)*

### Functional Requirements

**Canonical shared skill content (`distribution/shared/skill.md`)**

- **FR-001**: The repository MUST gain `distribution/shared/skill.md` and `distribution/shared/onboard.md` as the canonical, single-source bodies for the plugin's skill and onboarding content (design repo layout). No other copy of this content is authoritative; generated copies MUST carry a do-not-hand-edit marker pointing back to `distribution/shared/`.
- **FR-002**: The skill content MUST teach the standing loop for real work: sync the spec from the repo before a run, read the spec at run start, and write status/design back to the doc after implementing.
- **FR-003**: The skill content MUST restate the byte-channel rule: file content that exists as bytes outside the model moves over the REST byte channel (the import recipe / export API), never retyped through tool parameters — even when the agent has already read the file.
- **FR-004**: The skill content MUST restate token handling: tokens live in `~/.squire/token` (file-based, restrictive permissions), are referenced not printed, and never appear in the transcript, echoes, or argv.
- **FR-005**: Both shared files MUST agree with the Agent Surface (MCP) contract (`design/agent-surface-mcp.md`) — restated, never forked. Any needed change to the contract is an amendment to the Agent Surface doc (an M3-ship obligation for the signup line — see FR-035), never local divergence. A documented cross-check against the contract MUST be part of this feature's verification.
- **FR-006**: All user-facing copy in the shared content and consent surface MUST say "Squire Docs" (never bare "Squire") and follow the honest-confident voice.

**Canonical onboarding content (`distribution/shared/onboard.md`)**

- **FR-007**: The onboarding flow MUST detect entry state by tool presence only — never a probe call: Squire Docs tools present (prior consent or a loaded `sk_sqd_` token) → skip to finding the spec; tools absent → the auth walkthrough. It MUST NOT attempt to distinguish "no account" from "account but never consented"; the copy states that Google sign-in creates the account if none exists, so one path covers both.
- **FR-008**: Walkthrough step 1: before anything opens, the flow MUST set expectations with the design's line — the browser will open Squire Docs' connect page; signing in with Google creates your account if you've never used Squire Docs (no separate signup step); then approve the connection so the agent can create and sync docs.
- **FR-009**: Walkthrough step 2: the flow MUST point the user at the client's native flow — run `/mcp`, pick the squire server, complete browser consent — and MUST NOT instruct running `claude mcp add` (the plugin's server entry is already registered).
- **FR-010**: Walkthrough step 3 (remote/sandboxed sessions): the flow MUST apply the Agent Surface doc's OAuth walkthrough guidance verbatim — authorization URL printed bare on its own line (no list markup, quotes, or trailing punctuation); before the user opens it, the expected localhost-callback error is explained (approval still succeeded); the user copies the FULL callback URL from the address bar and pastes it back as their next message.
- **FR-011**: Walkthrough step 4: after consent (and any restart the client needs), the flow MUST re-check tool presence and continue directly into finding the spec — silently, with no success ceremony; the next thing the user sees is their spec syncing.
- **FR-012**: The content MUST carry the command-availability caveat: a restart may be needed after install before the command appears, and MCP tools staying absent until consent is exactly the walkthrough branch, not an error to catch or report.
- **FR-013**: The flow MUST implement the design's failure ladder, all four rungs, and nothing else: declined consent → explain what the access was for, offer retry via `/mcp`; approved-but-callback-errored → expected, paste-back per step 3; signed-in-but-tab-closed → the consent URL is re-openable, retry via `/mcp`; no browser reachable → create the account from any browser on any device at squiredocs.com, mint an `sk_sqd_` token in Settings → AI Agent Access, save it to `~/.squire/token` per the token rules, and treat token auth as fully authenticated, proceeding identically. The flow MUST never improvise or invent a non-standard auth path (the 008/009 lesson).
- **FR-014**: Find-the-spec (move 2): the flow MUST search the current repo in the design's order — `.kiro/specs/**`, `specs/**`, `PLAN.md` / `docs/plan.md`, `CLAUDE.md` — offer the best candidate, and when nothing spec-shaped exists, offer to draft a starter spec from the README and repo structure.
- **FR-015**: Sync (move 3): the chosen file MUST be synced byte-faithfully via the import recipe (`import_markdown_file`, frontmatter enabled), running the returned recipe so the doc is born sync-ready with a receipt written back; file content is never retyped through tool parameters.
- **FR-016**: Payoff (move 4): the flow MUST print the new doc URL and state what the editor adds — the human reviews and refines there, with every edit attributed human-vs-agent and revertible. The editor is presented as the payoff inside the loop, not the front door.
- **FR-017**: Teach the loop (move 5): the flow MUST close by stating the standing behavior now that the skill is installed — the agent reads the spec before each run and writes status/design back after — and that teammates and other agents see attributed edits in the same doc.
- **FR-018**: Re-running the onboarding flow where the repo's spec is already synced MUST prefer updating/syncing the existing doc (identified via the sync receipt) over creating a duplicate (RBD-9).

**Rehearsal bundle: the harness consumes the real content**

- **FR-019**: A minimal assembly step MUST produce an installable plugin bundle whose skill and command content is populated from `distribution/shared/`, consumable by the 029 rehearsal harness's existing `--bundle` parameter, which becomes the harness's default bundle for M2 iteration. The `distribution/shared/` sources are never mutated by assembly or rehearsal (endpoint indirection continues via the harness's throwaway-copy mechanism, FR-020 of 029).
- **FR-020**: The assembly step MUST NOT be or become M3's `publish.mjs`: no mirror repos, no submissions, no per-channel manifests, no registry entries — `distribution/` after this feature contains only `shared/` plus the minimal rehearsal assembly artifacts (RBD-1).
- **FR-021**: An automated agreement check MUST fail a rehearsal (or the standard suite) when generated bundle content diverges from its `distribution/shared/` source, so drift cannot silently enter rehearsals. (The full drift-vs-shared CI test across all channel bundles is M3.)

**Consent page as first-run surface**

- **FR-022**: The consent page's unauthenticated state MUST replace the "Sign in required / please sign in to authorize this application" framing with a primary "Continue with Google" action and copy stating that sign-in and account creation are the same click.
- **FR-023**: The unauthenticated state MUST additionally carry one line each for: what Squire Docs is (the durable, attributed spec layer for agentic development), what the agent is asking to do, and that every agent edit is attributed and revertible.
- **FR-024**: The framing change MUST be copy/presentation only: the validated same-origin returnTo round-trip, OAuth parameter carriage, signup-provenance stamping, and the welcome-doc skip all behave exactly as before (M1's tier-1 tests remain green), and the authenticated consent card is unchanged. The new unauthenticated framing MUST be covered by a client test asserting its required elements.

**Grader hardening (029 promotion-note obligations)**

- **FR-025**: The doc-URL payoff item MUST pass only when the delivered URL is on the actual rehearsal server's origin AND is corroborated by an observed doc-creating/import tool-call event (or equivalent server-side evidence); incidental `/d/…` paths and URLs on other origins MUST fail it.
- **FR-026**: Rehearsal capture MUST include observable tool-call events, and performable checklist items (byte-channel sync, doc creation/URL) MUST grade against those events rather than prose: a transcript that quotes contract text without performing the behavior MUST fail those items (RBD-2).
- **FR-027**: The silent-reconnect checklist item MUST be reworked to grade the specified behavior — after tools appear, the flow proceeds directly to finding the spec with no success ceremony — resolving the M1 grader's prose-regex conflict with the design's "success needs no ceremony" rule (RBD-10; flagged in the clarifications ledger).
- **FR-028**: Grader regression fixtures MUST exist for the false-PASS vectors: a quote-only transcript and an incidental-`/d/…`-path transcript that must FAIL the corresponding items, and a genuine performing transcript that must PASS them; these run in the standard suite.
- **FR-029**: `--require-claude` MUST be wired into the gate that consumes rehearsals (the matrix runner, FR-030): a cell whose model leg failed or was skipped is an invalid cell and fails the gate; an environment without model access refuses to run the gate rather than skipping legs (RBD-3).

**The sign-off matrix and exit gate**

- **FR-030**: A single command (the matrix runner) MUST execute the full sign-off matrix unattended in the dev pod: fresh-user happy path · existing account never consented · already connected · declined consent · abandoned tab · remote paste-back · headless token fallback · repo shapes `.kiro/specs` / `specs/` / `CLAUDE.md` / nothing spec-shaped — archiving each cell's transcript and grade, running cells serially, and exiting non-zero unless every cell matches its profile.
- **FR-031**: Each matrix cell MUST have an expected-outcome profile: the checklist items that must pass, items exempted as unreachable for that scenario, and any cell-specific assertions (e.g., the declined-consent rung's coaching). "Clean matrix" means every cell matches its profile in a single full-matrix run with all model legs completed (RBD-4, RBD-11).
- **FR-032**: The 029 harness MUST gain the cell-enabling extensions (in scope per the design): an unauthenticated mode that drives the client with the MCP server configured but no pre-authorized credentials (so tools are genuinely absent and the walkthrough branch is exercised); scripted user-simulator turns for multi-turn cells (declined consent, abandoned tab, paste-back — including pasting the callback URL); a token-fallback mode that provisions a real `sk_sqd_` token for the synthetic user at the scratch environment's `~/.squire/token`; and per-shape fixture repos used as the driven session's working directory (RBD-5, RBD-6, RBD-7). No new server endpoints beyond M1's are introduced.
- **FR-033**: The existing-account-never-consented cell MUST pre-mint the synthetic account via the faucet before driving the client, and MUST verify after consent that exactly one account exists for that identity (find-or-create, no duplicate).
- **FR-034**: M2's exit gate is twofold and both parts MUST be recorded in the feature's artifacts: (a) a clean full-matrix run per FR-031; (b) Sam's HITL sign-off on **mechanics AND tone**, obtained via the production self-test (M1's single-account reset + `selftest@example.com` + real browser against prod). M3 work MUST NOT begin, and nothing is published, before the recorded sign-off.
- **FR-035**: The feature MUST record the obligations it hands to M3 (promotion-notes style): the Agent Surface doc gains the signup line ("signing in with Google creates the account if none exists") at ship time; agents.md, the documentation site, and the landing page updates land with shipping; real per-channel manifests, mirror repos, `publish.mjs`, and the full drift CI test replace the rehearsal assembly; and the harness's default `--bundle` moves to `distribution/claude-plugin` when it exists.

### Key Entities

- **Canonical shared artifact set**: `distribution/shared/skill.md` (when-to-use-Squire-Docs skill body) and `distribution/shared/onboard.md` (the `/squire:onboard` flow body) — the single source of truth every channel bundle will be generated from; M2 authors them, M3 distributes them.
- **Rehearsal bundle**: the installable plugin bundle assembled from `shared/` for harness consumption — generated, do-not-hand-edit, agreement-checked against its source; explicitly not the shipping bundle.
- **Coaching contract checklist (hardened)**: the seven-item grading contract from 029, with performable items re-anchored to tool-call events and the rehearsal server origin, and the silent-reconnect item graded behaviorally.
- **Structured rehearsal transcript**: the captured session including observable tool-call events plus prose — the graded artifact and Sam's review material.
- **Matrix cell + expected-outcome profile**: one scenario of the sign-off matrix paired with the checklist items it must pass, the items its scenario cannot reach, and its cell-specific assertions.
- **Matrix runner**: the single-command gate that executes all cells serially, enforces profiles and `--require-claude`, and archives transcripts — the thing whose green run is half of M2's exit.
- **Consent first-run surface**: the consent page's unauthenticated state, reframed as the product's first impression for agent-first users.
- **Exit sign-off record**: the recorded artifact of Sam's mechanics-and-tone approval (date, scope, transcript references) — M3's gate.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: One command runs the full sign-off matrix (all eleven cells) unattended in the dev pod, producing an archived transcript and profile-judged grade per cell, and its exit status is trustworthy: non-zero on any profile miss or incomplete model leg.
- **SC-002**: A single full-matrix run exists in which 100% of cells match their expected-outcome profiles with all model legs completed — the "clean rehearsal transcripts across the full test matrix" of the design's M2 exit.
- **SC-003**: Zero known false-PASS vectors remain: the quote-only and incidental-path regression fixtures fail their items, and a genuine performing transcript passes them, verified in the standard suite.
- **SC-004**: Every rehearsal exercises content byte-identical to `distribution/shared/` (agreement check green in every matrix run), and `distribution/shared/` is never modified by any rehearsal.
- **SC-005**: An unauthenticated consent-page visitor sees all four first-run framing elements (Continue-with-Google action, same-click-creates-account line, product line, attribution/revertibility line), verified by client test, while all existing consent-flow tests (including M1's tier-1 round-trip tests) stay green.
- **SC-006**: A documented cross-check finds zero contradictions between the shared content and the Agent Surface (MCP) contract.
- **SC-007**: Sam's sign-off on mechanics AND tone — from a real production first-run walk — is recorded in the feature's artifacts before any M3 work begins; nothing has been published from this feature.

## Assumptions

- M1 (feature 029) is merged and signed off; its machinery (faucet, auto-approve, wipe, tier-2 driver, tier-3 harness, grader, prod single-account reset) works as specced and is the substrate this feature extends. The harness `--bundle` path is already parameterized (029 RBD-9), so consuming a new bundle needs no harness redesign.
- The rehearsal environment is the Linux dev pod (029 FR-024, macOS Keychain caveat); matrix runs happen there. Sam's prod self-test covers the real-browser/macOS half.
- Model-driven rehearsals require model access (an API key) and are non-deterministic; the matrix runner is an on-demand/pre-sign-off gate, not a per-commit CI job (RBD-3). Deterministic pieces (grader fixtures, agreement check, consent-page tests) run in the standard suites.
- The design's coaching lines are graded semantically (the behavior/meaning must be present), not as byte-exact strings, except where the design fixes the element itself (e.g., the URL bare on its own line).
- The consent-page change is a client-presentation change; the M1-verified server behavior (returnTo round-trip, provenance stamping, welcome-doc skip) is reused untouched.
- "Whatever gate consumes rehearsals" (029's `--require-claude` obligation) is this feature's matrix runner — no other consumer exists yet.
- The Agent Surface doc amendment (signup line) deliberately does NOT land in M2: the design ties it to shipping ("when this ships"), which is M3. Until then the onboard content carries the line without contradicting the doc (the doc is silent on it, not opposed to it).
- Exact prose for the shared content and consent copy is authored at implementation time within this spec's testable constraints; Sam's tone sign-off at the exit gate is the final arbiter of wording (RBD-8).

## Out of Scope

- Everything M3: per-channel manifests (`plugin.json`, `marketplace.json`, `server.json`, etc.), mirror repos, `publish.mjs`, the full drift-vs-shared CI test, registry entries, and all wave submissions.
- agents.md, documentation-site, and landing-page updates — the design ties these to shipping, i.e. M3.
- Any change to the Agent Surface Squire doc itself; the signup-line amendment is recorded as an M3 obligation (FR-035).
- Any new server/dev endpoints beyond M1's set; any new auth machinery (008/009 lesson).
- Replacing or redesigning the M1 machinery itself beyond the extensions FR-032 names.
- Publishing anything, anywhere, before the recorded exit sign-off.
- Everything the design doc lists as out of scope (browser signup funnel reordering, GitHub App, ChatGPT directory, Claude Connectors Directory).
