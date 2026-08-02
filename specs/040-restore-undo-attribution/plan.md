# Implementation Plan: Restore Undo Attribution

**Branch**: `main` (parallel-agent mode: work happens on `main` / a pipeline worktree — **no branch is created**)

**Date**: 2026-08-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/040-restore-undo-attribution/spec.md`

## Summary

Four audit findings (F2 MEDIUM, F6 LOW, F14 LOW, F7 documentation) plus one coordinator
finding (three disagreeing identity comparisons) in the restore / log-derived-undo stack.

The headline requirement is **F2: a human web-UI restore must be genuinely undoable.**
Today the restore route passes `agentName: null`; `restoreVersion` stores the `yjs_updates`
row with a NULL agent name and writes the `agent_edits` row under the `''` sentinel. No undo
surface ever queries `''` — the chat surface queries `(userId, 'Squire Docs Assistant')`, MCP
queries `(userId, token.agentName)` — so the record is a dead row and the product's own
documentation (README:467, design amendment 2026-07-19, 023 FR-020) is false for that path.

**Amendment (Sam, 2026-08-01) — F1: API-level fix plus a client honesty guard (D13).** The
plan-stage analysis found that no client control can reach a restore's undo (`UndoEditButton`
renders only inside a chat `modify` card, only for the latest one) and that, once restores enter
the identity-LIFO undo queue, pressing that card's Undo would invert the **restore** while
stamping "Reverted" on the **modify**. Sam's decision: (1) US1/SC-001 are re-scoped to the
endpoint contract; (2) a sixth seam is added — the offer-honesty guard (FR-016/FR-017/FR-018,
US6); (3) the document-level undo affordance is filed as follow-on work in `promotion-notes.md`
(OWED-1) and named in the spec's Out of Scope. This plan reflects the amended shape.

**Technical approach**: six small, independently landable seams. No schema change, no new
service, **no new UI surface** (the client change is one render condition, not a new control),
**zero migrations**.

1. **One identity module** — a new zero-dependency leaf, `server/agent-identity.js`, exporting
   `CHAT_AGENT_NAME` (moved from `server/api/chat.js`, which re-exports it for its existing
   consumers) and `isSameIdentity(a, b)` (the normalized `(userId, agentName ?? null)`
   predicate). Zero requires ⇒ the import cycle FR-005 warns about
   (`chat.js` ↔ `version-history.js`) is structurally impossible, and the yjs-only leaf
   `edit-range.js` does not have to take a dependency on the `agent_edits` DB layer.
2. **Restore identity** — `server/index.js`'s restore route passes
   `agentName: CHAT_AGENT_NAME` instead of `null`; `restoreVersion` drops its `agentName ?? ''`
   fallback and threads the one identity into **both** `storeUpdate` and `recordEdit`. The MCP
   restore path is untouched and keeps passing the agent token's own name.
3. **Loud recording boundary** — `recordEdit` validates the agent name before any SQL and
   throws a named error; the existing non-fatal `catch` in `restoreVersion` and
   `modify.js` still keeps the user's content change (023 parity, D6).
4. **Unknown-author synthesis** — `groupUpdatesIntoVersions` emits one collapsed synthetic
   contributor for a version's unattributed rows. Because `getUpdatesForVersion` reuses that
   same function for the drill-down, one change covers both required paths; the single-author
   metadata site (`version-history.js:794`) gets the same treatment.
5. **Predicate adoption + documentation closures** — `edit-range.js`, `inverse.js`,
   `legacy.js` (and, per D11, `modify.js` and `chat-staleness.js`) call the shared predicate;
   the F7 display-name-equality limitation, the `agent_name` sentinel rule, and the FK-policy
   divergence rationale land as comments at their specified modules.
6. **Offer-honesty guard (D13)** — `getUndoStatus` additively returns each direction's target
   record identity, and the chat card offers its control only when that target is its own edit.
   The identifier is the record's **immutable `edit_clock_start`** (D14), not the rewritable
   `undo_target_*`/`redo_target_*` range, so a control does not vanish across an undo↔redo
   cycle; it is already what `modify` returns to the client as `editRange.clockStart`. Both
   rows are already fetched by `nextUndoTarget`/`nextRedoTarget`, so this is a response-shape
   addition with **no new query and no schema change**. The guard is **fail-open** (D15): a
   missing field on either side degrades to today's behavior rather than blanking the control.

**F14 / FR-010 is already delivered.** Feature 039 shipped the identical fix as its FR-018
(`HierarchicalVersionList.jsx:61` already reads `author.color || '#888888'`, with a passing
Vitest case at `HierarchicalVersionList.test.jsx:487`). US5 becomes a **verification-only**
phase in this plan — see research.md R3 and clarifications D9.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server), React 18 (ESM client)

**Primary Dependencies**: `yjs`, `pg`, `express`; no new dependency

**Storage**: PostgreSQL `yjs_updates` + `agent_edits` (**read/write path only — ZERO
migrations in this feature**, FR-014). `agent_edits.agent_name` stays `NOT NULL`.

**Testing**: Jest for server (`server/__tests__/`, `server/undo/__tests__/`,
`server/mcp/__tests__/`), always via `npm run test:server` (a live Redis client keeps a bare
`npx jest` alive forever); Vitest for the client (`client/src/components/__tests__/`)

**Target Platform**: Linux server (k3s), evergreen browsers

**Project Type**: Web application (Express/y-websocket backend + React/TipTap frontend + `shared/`)

**Performance Goals**: none changed. The predicate is a pure comparison on the same fields;
the unknown-author synthesis adds at most one Map entry per version.

**Constraints**: no new env knobs; no migration; no change to presence colors or their
deliberate daily rotation (FR-010); no new UI surface or chat copy (D7); the MCP restore
path must not regress (FR-004).

**Scale/Scope**: 11 production files touched (1 new), ~8 test files extended/added. One
**additive, backward-compatible** HTTP response-shape change (`/undo-status`, FR-016); one
internal module contract added. No new UI surface — the client change is a render condition on
an existing control.

## Verification Against Current `main` (2026-08-01, post-038/039 merge)

Every line the spec cites was re-read on current `main` after 038 and 039 merged. Result:

| Spec citation | Status on `main` | Note |
|---|---|---|
| `server/index.js:1477-1481` restore route passes `agentName: null` | **Moved** — now `server/index.js:1503-1541`, `agentName: null` at **:1525** | route body otherwise unchanged |
| `server/version-history.js:646` storeUpdate, `:654-662` recordEdit `agentName ?? ''` | **Confirmed** at `:646` and `:655-662` | unchanged by 038/039 |
| `server/undo/edit-records.js:50-61` `recordEdit` | **Confirmed** | unchanged |
| `server/mcp/yjs/edit-range.js:185` raw `===` identity filter | **Confirmed at :185** | file requires only `yjs` — a true leaf |
| `server/undo/inverse.js:80` normalized comparison | **Confirmed at :80** | |
| `server/undo/legacy.js:46` normalized comparison | **MOVED to `:56-62`** (`isIdentityRow`) — 038 added the `viaSync === true` channel guard above the comparison | the shared predicate must be composed *under* that guard, not replace it |
| `server/api/chat.js:91` `CHAT_AGENT_NAME` | **Confirmed at :91**, exported at `:1423` | |
| `server/index.js:1584-1588` undo-status identity | **Moved** — now `:1622-1636`, `agentName: chat.CHAT_AGENT_NAME` at **:1632** | no change needed |
| `server/version-history.js:91-114` `createAuthor`, `:205` grouping | **Confirmed** (`createAuthor` `:91`, guard `:205`) | |
| `server/version-history.js:794` sub-version author | **Confirmed** (`author: update ? createAuthor(update) : null`) | this is `getVersionContent`'s single-author metadata; the *drill-down contributor list* is `getUpdatesForVersion` at `:699`, which **reuses `groupUpdatesIntoVersions`** |
| `client/src/components/HierarchicalVersionList.jsx:56` presence-palette fallback | **STALE — already fixed by 039** at `:61` (`author.color \|\| '#888888'`), test at `HierarchicalVersionList.test.jsx:487` | FR-010 needs no code change (D9) |
| `migrations/1796000000000_create-agent-edits.js:36` `NOT NULL` | **Confirmed** | untouched |

**Two comparisons the SC-009 grep found that the spec does not name** (see research R5, D11):
`server/mcp/tools/modify.js:308` and `:327`, and `server/api/chat-staleness.js:111` — all raw
`===` on `(userId, agentName)`. Both are provably behavior-identical under the normalized
predicate (their identity object is an agent token / the chat identity, whose `agentName` is
always a real string, never `undefined`), so they are converted, not merely filed.

**A fourth definition of the constant exists**: `server/onboarding.js:18`
(`const AGENT_NAME = 'Squire Docs Assistant'`, seeded welcome-doc attribution). FR-005 demands
"exactly one authoritative definition" — it is consolidated onto the new module (D10).

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Result: **PASS** (one
tracked deviation, below).*

| Principle | Assessment |
|---|---|
| **I. Documentation Reflects Reality** | **Two** README passages go stale, not one. `README.md:467` currently describes today's broken behavior and points at this spec; FR-001/FR-002 make it stale. `README.md:583` says *"The most recent `modify` diff has an Undo button that reverts the edit"* — after FR-017 that button is conditional on being the identity's next target, so the sentence needs the qualifier (finding F6). Under the parallel-agent protocol the implementing agent does **not** edit `README.md`, `CLAUDE.md`, or `docs/dev.md`; both replacement texts are written into `merge-notes.md` and applied by the merge queue in the merge commit. Tracked in Complexity Tracking. `docs/dev.md` describes no restore/undo behavior — verified, nothing owed. |
| **II. Test-Backed Changes** | Every behavior change gets a test: the restore→undo→redo round trip (integration, real Postgres), the agent-restore non-regression, the loud `recordEdit` rejection, the unknown-author synthesis on both grouping paths, and the predicate's `null`-vs-`undefined` agreement across the three undo surfaces. Backend suites run serially against a per-agent DB (`collab_test_db_040`). No serialization/format change ⇒ the round-trip registry suite is untouched. |
| **III. Trunk-Based Solo Workflow** | No branch, no PR. Work lands on `main` through the pipeline merge queue. No new ceremony. |
| **IV. Collaboration-Safe Document Operations** | Restore already uses the transactional deep-clone path and is unchanged here; no delete-and-recreate, no positional targeting, no format-registry change. **Provenance is directly at stake**: this feature deliberately re-attributes one class of edit (human UI restore → assistant identity acting for that user). That is a ratified product decision (spec FR-003, Sam), it is *more* honest than the current NULL/`''` split, and it is asserted by an explicit test rather than left incidental. FR-018 extends the same honesty rule to the display layer: no surface may mark an edit "Reverted" that was not the edit inverted — provenance must not be misstated on screen either. |
| **V. Secure by Default** | No new endpoint, no new ingestion surface, no sandbox/sanitizer change. The restore route's editor-role gate is untouched; viewers still cannot restore or undo. The identity a restore records is derived server-side from `req.user.userId` plus a server constant — never from request input. |
| **VI. Design Docs Are Ground Truth** | This feature *converges code to* `design/collaboration-core.md`'s 2026-07-19 amendment ("restoreVersion records an agent_edits row … so the chat Undo can invert a restore"), which the code currently falsifies for the web-UI path. No design doc is amended: the amendment already says what this feature makes true. All new decisions are recorded RATIFIED-BY-DEFAULT in `clarifications-needed.md`. |

## Project Structure

### Documentation (this feature)

```text
specs/040-restore-undo-attribution/
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
├── contracts/
│   └── agent-identity.md      # Internal module contract (constant + predicate)
├── clarifications-needed.md   # D1–D12 decision ledger
├── checklists/requirements.md
├── merge-notes.md             # Written during implementation (README deliverable)
└── tasks.md                   # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
server/
├── agent-identity.js              # NEW — CHAT_AGENT_NAME + isSameIdentity (zero requires)
├── index.js                       # restore route: agentName null -> CHAT_AGENT_NAME (:1525)
├── version-history.js             # restore identity passthrough; unknown-author synthesis
├── onboarding.js                  # consume the shared constant (drop local AGENT_NAME)
├── api/
│   ├── chat.js                    # constant extraction only (import + re-export)
│   └── chat-staleness.js          # adopt isSameIdentity (:111)
├── undo/
│   ├── edit-records.js            # loud recordEdit guard; sentinel rule + FK rationale docs
│   ├── inverse.js                 # adopt isSameIdentity (:80)
│   ├── legacy.js                  # adopt isSameIdentity under the viaSync guard (:56-62)
│   └── undo-service.js            # getUndoStatus: additive nextUndo/nextRedo editClockStart
└── mcp/
    ├── yjs/edit-range.js          # adopt isSameIdentity (:185) + F7 limitation comment
    └── tools/modify.js            # adopt isSameIdentity (:308, :327)

server/__tests__/
├── version-history.test.js        # T031 restore-identity cases updated; unknown-author cases
├── undo-status-api.test.js        # restore -> canUndo true
└── restore-undo-roundtrip.test.js # NEW — US1/US2 end-to-end (real Postgres)

server/undo/__tests__/
├── edit-records.test.js           # loud guard
└── identity-predicate.test.js     # NEW — three-surface null/undefined agreement (SC-009)

client/src/components/
└── AiChatMessages.jsx             # UndoEditButton: offer only when the next target is this part

client/src/components/__tests__/
├── HierarchicalVersionList.test.jsx  # null-id author tolerance (FR-009); FR-010 already covered
└── UndoEditButton.test.jsx           # NEW — offer-honesty guard (US6, FR-017, SC-010/SC-011)
```

**Structure Decision**: existing web-application layout. One new server module
(`server/agent-identity.js`) and two new test files; everything else is an edit to a file that
already exists. Nothing lands in `shared/` — the constant and predicate are server-only
(the client never compares undo identities).

## Phase Sequencing

Foundational work (the shared module + the loud guard) must land before any user story, because
US1 depends on the constant being importable from `version-history.js`/`index.js` without a
cycle, and US4's guard changes what `restoreVersion` does when it is handed a null identity.
After that:

- **US1 (P1)** and **US2 (P1)** are one seam and one test file — implement together (US2 is
  the regression fence around US1's shared-code change).
- **US6 (P1)** ships **with US1 or not at all** (D13): US1's mechanism is precisely what makes
  the chat card's Undo able to misreport. Its server half (FR-016) can land in parallel; its
  client half (FR-017) must not be merged ahead of US1, or it would hide working controls for
  no reason.
- **US4 (P2)** rides on the foundational guard; only its tests are separate.
- **US3 (P2)** is independent of everything above (version-history display path).
- **US5 (P3)** is verification-only (already delivered by 039).
- **FR-015 predicate adoption** is independent of all user stories and can land in parallel.
- **Documentation closures** (FR-007, FR-011, FR-012) land with the modules they annotate.

## Out of Scope (explicit)

- **A user-facing way to undo a restore** (D13; spec Out of Scope; `promotion-notes.md` OWED-1).
  This feature delivers the mechanism and stops the chat card from misreporting — it ships no
  control a user can click to undo a restore. That needs a document-level affordance with its
  own design and mobile/touch pass.
- Changing what the undo/redo **endpoints** select — target selection stays identity-LIFO;
  FR-017 governs only what a client *offers*.
- New user-facing wording, including per-target labels like "Undo restore" (revised D7 / D16).
- Any migration or data backfill of the legacy `''` / NULL rows (D1).
- Changing the FK policies themselves (FR-012 documents them; it does not unify them).
- A token-id undo disambiguator (F7 is accepted-and-documented, FR-011).
- Presence/cursor colors and their daily rotation (FR-010).
- Chat/undo UI copy distinguishing "undo restore" from "undo edit" (D7).
- `server/origin.js`, `server/document-service.js`, `server/postgres-persistence.js`, the diff
  subsystem, the websocket/attribution layer.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Constitution Principle I: the implementing agent ships a behavior change without updating `README.md` in the same commit | The parallel-agent pipeline forbids feature agents from touching `README.md`/`CLAUDE.md`/`docs/dev.md` — concurrent agents would collide on the same lines, and the merge queue owns doc reconciliation. `README.md:467` was *just* rewritten (by the merge queue) to describe today's broken behavior and to point at this spec, so this feature necessarily makes it stale again. | Editing `README.md` in the feature worktree: rejected because the merge queue rewrote that exact paragraph for 040's benefit and would have to resolve the conflict anyway. Mitigation: `merge-notes.md` carries the **exact replacement paragraph**, ready to paste, as a required task deliverable — the doc is corrected in the merge commit, one commit later, never later than that. |
| FR-015 consolidation extends to two call sites the spec does not name (`modify.js`, `chat-staleness.js`) | SC-009 requires the reviewer to grep for a fourth inline identity comparison and "confirm none remains or file it explicitly". Leaving two known raw comparisons in place would fail that check by construction and force a re-litigation at review time. | Filing them as follow-ons: rejected because both are provably behavior-identical under the predicate (their identity objects always carry a real string `agentName`), so the conversion is free, and "one definition of same-identity" is the whole point of FR-015. Recorded as D11. |
