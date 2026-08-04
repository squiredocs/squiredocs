---
name: "the-pipeline"
description: "Run the Squire design-to-merged pipeline: Squire docs as design ground truth, parallel spec/plan/implement agents in worktrees, a serial merge queue with full verification, adversarial review with same-day fixes, and a decisions ledger — for new features, design amendments, and feedback triage alike. Use when orchestrating any multi-feature Squire work, converging code to a design-doc change, or processing feedback from Sam or the in-app assistant."
metadata:
  author: "squire"
  source: "adapted from Semalab/cto-tool zil branch liz-pipeline skill, 2026-07-13"
---

# The Squire design pipeline

The operating model for design-driven feature work in this repo. You (the orchestrating session) stay in the loop between stages; agents do the work. Squire dogfoods itself: the design docs live in Squire Docs.

## Ground rules (always)

- `design/` is ground truth (constitution Principle VI). Code, specs, and priors lose to it; material silences become flagged gaps, never ad-hoc decisions.
- Design changes are made IN SQUIRE first (each file's `source:` header URL; use the Squire Docs MCP, read `get_tool_documentation({tool:"modify"})` before your first script), then `node design/sync.mjs` re-exports, then commit, then converge code to match. Never hand-edit exports. New docs: create in Squire, add to the `DOCS` map in sync.mjs, and add them to the "Squire Architecture Design Index" doc (both its area listing and its Repo Sync Manifest table).
- Sync auth: mint a `documents:read` token via the MCP `create_access_token` tool (max 24 h) and write it to `design/.squire-token` (gitignored) or export `SQUIRE_API_TOKEN`.
- When reality falsifies a documented mechanism, amend the doc with the why — don't silently diverge.
- **Strategy docs stay current with what they spawned.** When a design proposal, spec, or feature is derived from a strategy/source doc (current instance: the "agent-first activation" strategy doc, https://squiredocs.com/d/a6e1809e-fcc8-4b26-b45f-970b3ea4f06a), the ORCHESTRATOR — not subagents — keeps that strategy doc in sync: as derived work is specced/built/shipped, update the relevant section with a link to the design doc / `specs/NNN-slug` and its current status, and resolve or annotate the strategy doc's open questions in place as answers land. Same edit discipline as any Squire doc — MCP `modify`, xpath targeting, in-place edits, never delete-and-recreate; append annotations to open questions rather than replacing them.
- Decisions Sam hasn't answered get the best default, recorded as **RATIFIED-BY-DEFAULT (Sam pre-authorized, date)** in the feature's `clarifications-needed.md` with question/why/rationale; his later confirmations upgrade them in place. Never block on him; never decide silently.
- Every feature accumulates `promotion-notes.md` (prototype relaxations owed at promotion) — review dispositions land there too.

## Status events (mobile ledger)

The ORCHESTRATOR (you, never subagents) publishes high-level pipeline events to the Pipeline Events doc at https://squiredocs.com/d/60c46c15-61ce-477d-a9a1-f6d42d4384d4 so Sam can track runs from his phone.

Doc structure (maintain it exactly): H1 title → intro paragraph → `## In flight now` → the STATUS list → `## Events` → the newest-first event list → `## Features` → the FEATURES list (one bullet per numbered feature: bold `NNN-slug`, a one-sentence what-it-is in user terms, then an italic status — e.g. _Implementing._ / _Merged GREEN; review running._ / _COMPLETE — deployed + verified._). When a feature changes stage, update its Features bullet IN PLACE (setFormattedContent) in the same modify call as the event; add a new bullet when a feature's pipeline starts. It's the at-a-glance catalog answering "what are all these numbers?" — keep each entry to one line of substance. Target each list via its LEVEL-2 heading: `//heading[@level=2][contains(., "In flight now")]/following-sibling::bulletList[1]` and `//heading[@level=2][contains(., "Events")]/following-sibling::bulletList[1]`. The `@level=2` predicate is LOAD-BEARING: the H1 is "Pipeline Events", so an un-leveled `contains(., "Events")` matches the H1 first and silently returns the WRONG list (this bug shipped once, 2026-07-18 — an event landed in the status list). Never use a bare `//bulletList`. In every update script, assert the two resolved lists are different nodes before writing (`if (statusList === eventsList) throw ...`), and if either resolves null, READ the doc first and repair the structure instead of writing blind.

**The status list is a live snapshot, not a log**: on EVERY event publish, bring it up to date — but **edit in place, never delete-all+reinsert**. Update existing listItems' text via setFormattedContent, append/remove only the items that actually changed. WHY (2026-07-18 incident): rapid whole-list delete+recreate into a doc a human has open triggers y-tiptap's render-failure self-repair, which DELETES the fresh content and attributes it to the viewer — the watched-doc equivalent of the modify tool's own never-delete-and-recreate rule. Keep it reflecting current reality — one bullet per in-flight agent (`NNN-slug · stage · model · since H:MMam/pm PT`), one per queued item worth seeing (`NNN-slug · queued behind NNN`), and a single `idle` / `PAUSED (reason)` bullet when nothing runs. Keep it ≤6 bullets — it's the at-a-glance answer to "what's happening right now"; the history lives below in Events.

Event rules:

- **Newest first**: insert each event at the TOP of the Events list (`list.insert(0, [item])` via the Squire MCP modify tool — read `get_tool_documentation({tool:"modify"})` first if you haven't this session), and refresh the In-flight-now status list in the same modify call.
- **One line per event**, mobile-readable: `**MM-DD H:MMam/pm PT · NNN-slug** — what happened`. Bold the timestamp+feature lead-in. Timestamps are ALWAYS Pacific time (America/Los_Angeles — use `TZ=America/Los_Angeles date` to get it right, don't hand-convert).
- **High-level only** — stage transitions, not activity: pipeline started, design amendment committed, spec complete, plan/analyze complete (+ gate result), spec artifacts committed, implementer started/finished, merge queue green/red, review findings count, fixes landed, pipeline complete. Roughly one event per pipeline stage per feature; never per-task or per-file noise.
- Publish the event at the moment the stage transition happens (e.g. right after spawning the implementer, right after the merge-queue verification finishes) — the doc is Sam's live view, not an end-of-run report.
- Failures and stops are events too (`merge queue RED: backend suite failing`, `analyze gate STOPPED the line: 2 HIGH findings`) — bad news lands in the ledger before Sam has to ask.
- Publishing must never block the pipeline: if the MCP write fails, note it in your next status message to Sam and move on.

## The feature pipeline (new specs and converges)

1. **Spec** (Fable agent): follows the speckit-specify skill with the parallel-safe overrides below. Returns a summary + its recorded decisions.
2. **Plan → tasks → analyze** (Opus agent; Fable only for subsystem-replacement or CRDT/serialization-core features): one agent runs all three speckit skills. Analyze findings are reported, never auto-fixed beyond self-introduced drift. CRITICAL/HIGH findings stop the line; MEDIUMs get folded into the implement brief.
3. **COMMIT THE SPEC ARTIFACTS BEFORE SPAWNING IMPLEMENTERS** (worktrees see only committed state).
4. **Implement** (Opus agent, `isolation: "worktree"`): branches `NNN-slug` off `main`, follows speckit-implement, commits granularly with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer, never pushes/merges. Collision-plan concurrency: docs-only stages fan out wide; implementation runs 2-3 max, never two features touching the same Express router, the shared prosemirror schema/format registry, migration ordering, or the same client surface. Migrations: at most ONE in-flight feature may add node-pg-migrate files at a time (they're globally ordered); others queue behind it.
5. **Merge queue** (you, serially): `git merge --no-ff` into `main`, resolve spec-file add/add conflicts as theirs-for-tasks.md (checkmarks) / ours-for-clarifications.md (ratification headers), then the authoritative verification in the main tree: `npm run migrate`, `npm test` (backend is serial-only — never overlap another backend run on the same DB), `npm run build`. Worktree "environmental" failures are re-checked here before believing them.
6. **Review** (Fable agent, read-only): per-feature post-merge review of the actual diff, lenses ordered by what would hurt most: document ACL/permission enforcement and agent-content trust invariants (sandbox, SVG sanitizer, image-src guardrail) first, then CRDT identity preservation (no delete-and-recreate, no positional targeting), then correctness. Findings must name file:line + a concrete failing scenario; speculative findings are dropped by instruction.
7. **Fix** (you directly for small; an Opus fixer in the main tree for bundles): land findings same-day, record dispositions in promotion-notes, correct any falsified decision rationale in the ledger. HIGHs get fixed with a strict default and flagged for Sam to ratify; LOW/accepted items become promotion notes.

Deploy is NOT part of the agent pipeline: after the queue is green, tell Sam what's ready and let him trigger the deploy scripts (or do it only on his explicit ask).

## Parallel-agent overrides (paste into every spec/plan brief)

- Stay on the current branch; never create/switch branches, never commit (docs agents) — implementers branch in their own worktree only.
- Never run create-new-feature.sh, never write `.specify/feature.json` (shared, racy); mkdir the pre-assigned `specs/NNN-slug/` and copy the template. Pre-assign feature numbers up front so parallel runs never race.
- Prefix any .specify script with `SPECIFY_FEATURE=<dir> SPECIFY_FEATURE_DIRECTORY=<abs-path>` per call.
- `check-prerequisites.sh` WRITES `.specify/feature.json` unless called with `--paths-only` (the only read-only flag combination) — the analyze skill's mandated `--json --require-tasks --include-tasks` invocation clobbers sibling agents' pointers (hit 2026-08-04 by 051's analyze; agent self-detected and restored). Parallel agents: source `common.sh` and use `get_feature_paths --no-persist`, or restore the file's prior value immediately after.
- Never edit `CLAUDE.md`, `README.md`, or `docs/dev.md` from a parallel agent — doc updates happen in the merge queue where they can be reconciled (constitution Principle I).
- No user interaction: defaults + ledger, or stop-and-report when genuinely blocked.

## Worktree environment (paste into every implementer brief)

- `npm ci && (cd client && npm ci)` — worktrees don't inherit node_modules.
- Copy `.env` from the main tree if present; Redis is shared and fine.
- Backend tests: NEVER point at the shared test DB from a worktree. Create a per-agent database (`createdb collab_test_db_<nnn>`) and run every test command with `DATABASE_URL=postgres://...collab_test_db_<nnn>` — the test helpers respect it (`server/__tests__/helpers/db.js`). Within one DB, backend tests are serial-only (`--runInBand` is already wired in; don't defeat it).
- Client tests (vitest) and `npm run build` are worktree-safe as-is.

## Feedback triage (Sam or the in-app assistant)

Validate against code before believing or dismissing — agent-reported issues tend to contain a real finding wrapped in a wrong conclusion. Then route: UI/behavior bug → fix directly in the main tree with tests; design-level ask → Squire amendment → `node design/sync.mjs` → converge (worktree agent for big, direct for small); agent-experience gap (MCP tool confusion, unhelpful errors) → fix the guidance where the mistake happens (tool descriptions, `get_tool_documentation` content, instructive errors) and prefer teaching errors over bare exceptions. Live diagnosis beats speculation: server logs, the dev DB (`psql`), and the `support_requests` table are queryable — look first, then dispatch a hunter with your evidence and explicit hypotheses to discriminate.

## What not to delegate

Long-running jobs (backfills, bulk migrations, seed-from-backup) are background shell jobs YOU own (`run_in_background: true`, verify against the DB after) — agents stall silently on babysitting work. Delegate investigation and code; keep execution-and-wait loops. And verify every agent's completion claims against ground truth (DB counts, git state, test output) before reporting them upward.

## Conventions

- Commits: this repo's style is a plain descriptive first line (no conventional-commit prefixes), the Fable trailer, merge commits describing the feature.
- Model tiering: Fable for specs and reviews (judgment ends), Opus for plans/implement/fixes (workhorse), Haiku for lookups. Reviewer ≥ implementer; never same-tier-reviews-itself when avoidable.
- Status to Sam: lead with what landed and what needs his eye; keep a per-feature ledger (tasks n/n, review verdict, fixes) so the closing report writes itself.
