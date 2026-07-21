# Implementation Plan: Durable Chat Error Surfacing

**Branch**: `025-durable-chat-errors` | **Date**: 2026-07-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/025-durable-chat-errors/spec.md`

## Summary

Persist every classified chat-turn failure as a `{ code, provider, at }` record stamped
onto the failed turn's trailing user message inside the existing messages JSONB, and make
the client render every error banner from one durable per-chat turn-error state (fed by
live error events + the loaded transcript's failure record) instead of from transient AI
SDK stream status. On a classified failure the server tears the resumable-stream entry down
immediately so a reconnecting client finds nothing to replay and derives the outcome from
the transcript. Recovery counts as success only when an assistant reply actually lands.

Two mechanism choices are fixed here (both were deferred to plan by the spec/ledger):

- **Stamp durability (FR-004 / ledger D2)** — a **single turn-scoped failure record applied
  by whichever save writes the failed turn**: the `onFinish` full-replace save is made
  *stamp-aware* (it applies the pending record to the trailing user message before every
  save, so it can never persist a failed turn *without* the stamp — this directly closes
  the documented clobber race), and the non-streaming early-return / outer-catch paths
  (which never invoke `streamText`, so `onFinish` never runs) apply the same record via an
  awaited read-modify-write. One record, one place it is derived, applied by every writer —
  race-free under any ordering. See research.md R1 for the rejected alternatives.
- **Regression-test harness (FR-017 / ledger D8)** — the banner-persistence scenarios run
  against the **real `@ai-sdk/react` `Chat` class driven by a scripted fake transport**, so
  the SDK's actual status transitions (resume flips `error → submitted` with `error`
  cleared; clean replay ends at `ready`) are exercised for real. A hand-mocked SDK is what
  let this bug ship; pure-derivation helpers and server logic keep faster plain-unit tests.
  See research.md R6.

## Technical Context

**Language/Version**: Node.js 22+ (server), React 18 + JSX (client); AI SDK v6 (`ai@6.0.141`,
`@ai-sdk/react`).

**Primary Dependencies**: Express + `ai` `streamText`/`toUIMessageStream` (server SSE);
`@ai-sdk/react` `Chat`/`useChat` + `DefaultChatTransport` (client). No new dependency.

**Storage**: PostgreSQL `chats.messages` JSONB (schemaless UIMessage array, full-replace
saves via `server/chat-store.js`). **No migration** — the failure record is additive
metadata on an existing message object (constitution: node-pg-migrate only for DDL; none
needed here).

**Testing**: Jest (backend, serial-only against the shared dev DB — implementer uses a
per-agent DB in a worktree); Vitest (client, safe to run in parallel).

**Target Platform**: Linux server + browser SPA.

**Project Type**: Web application (Express backend + React frontend) — Option 2 layout.

**Performance Goals**: No new hot path. One extra DB read-modify-write **only on a failed
turn** (failures are rare); the success path is byte-for-byte unchanged.

**Constraints**: Taxonomy/copy/actions (`chatErrorMessages.js`, `chat-errors.js`) are
frozen ground truth; the 401 silent-refresh path, token-limit compaction, and BYOK flows
are unchanged; legacy transcripts (no failure metadata) MUST render exactly as today
(additive-only). No cross-tab broadcast.

**Scale/Scope**: ~1 server file (`server/api/chat.js`) + ~1 client file
(`client/src/contexts/AiChatContext.jsx`) carry the behavior change, plus one banner-order
edit in `AiChatBody.jsx` and a small pure-helper module. Two surfaces already share the
context and the copy map, so they change by construction.

**No NEEDS CLARIFICATION remain** — every open product decision was resolved in
`clarifications-needed.md` (D1–D8); the two plan-deferred mechanism choices are fixed above
and justified in research.md.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.1. Re-checked post-design.*

- **I. Documentation Reflects Reality** — PASS. Design ground truth
  (`design/in-app-ai-assistant.md` "Error surfacing", commit `68f22df`) already describes
  this behavior; the spec encodes it (Principle VI). No behavioral change to README/dev.md
  surfaces is introduced (the chat-engine section already covers resumable streams). If
  implementation falsifies any documented mechanism, the doc is amended in the same effort.
  *This planning agent performs no README/dev.md edits (parallel-safe overrides); the
  implement/merge stage owns any doc sync.*
- **II. Test-Backed Changes** — PASS. Every behavioral change is covered: server stamp
  durability + teardown (integration, extends `chat.error-surfacing.test.js`), and the
  client banner-persistence scenarios against the real `Chat` + scripted transport
  (FR-017). Backend tests stay serial (per-agent DB in the worktree). No serialization /
  format-registry change → the round-trip suite is untouched.
- **III. Trunk-Based Solo Workflow** — PASS. Runs inside the pipeline; this agent stays on
  `main`, creates no branch, commits nothing (parallel-safe overrides).
- **IV. Collaboration-Safe Document Operations** — N/A. This feature never touches the Yjs
  document tree, the format registry, or attribution; it only reads/writes the chat
  messages JSONB (not a collaborative CRDT doc). No delete-and-recreate, no positional
  indexing.
- **V. Secure by Default** — PASS. The failure record is codes-only (`{ code, provider, at }`)
  — no raw provider text ever enters durable storage (FR-003/D1), removing a leak channel
  rather than adding one. No new endpoint, ingestion surface, or token scope. Ownership
  checks in `chat-store.js` (`AND user_id`) are preserved by reusing `loadChat`/`saveChat`.
- **VI. Design Docs Are Ground Truth** — PASS. The mechanism is encoded from the amended
  design doc, not re-litigated; the two deferred choices are recorded here and in research.md.

**Result: PASS — no violations. Complexity Tracking table intentionally empty.**

## Project Structure

### Documentation (this feature)

```text
specs/025-durable-chat-errors/
├── plan.md               # This file
├── research.md           # Phase 0 — mechanism decisions (R1–R6)
├── data-model.md         # Phase 1 — the failure record + client state shapes
├── contracts/
│   └── failure-record.md # Phase 1 — persisted + derived contract & invariants
├── quickstart.md         # Phase 1 — manual + automated validation guide
├── clarifications-needed.md   # ledger (D1–D8) — pre-existing
├── checklists/requirements.md # pre-existing
└── tasks.md              # Phase 2 — /speckit-tasks output
```

### Source Code (repository root)

```text
server/
├── api/
│   ├── chat.js                     # CHANGED: turn-scoped failure record; onFinish
│   │                               #   stamp-aware save; RMW stamp on early-return/outer
│   │                               #   catch; immediate teardown (no failure-buffer replay)
│   ├── chat-errors.js              # UNCHANGED (taxonomy/classify — reused)
│   └── __tests__/
│       └── chat.error-surfacing.test.js  # EXTENDED: stamp durability, FR-006 no-stamp,
│                                          #   teardown → GET /:id/stream 204, no replay
└── chat-store.js                   # UNCHANGED (loadChat/saveChat reused)

client/src/
├── contexts/
│   ├── AiChatContext.jsx           # CHANGED: consolidate to one durable turnErrorByChat +
│   │                               #   transient reconnecting flag; derive usage-limit &
│   │                               #   interruption; populate from transcript metadata;
│   │                               #   honest recovery (wait-for-reply, not wait-for-status)
│   └── __tests__/
│       └── AiChatContext.test.jsx  # EXTENDED (existing mocked-SDK suite retained for the
│                                   #   non-transition paths it already covers)
├── components/
│   └── AiChatBody.jsx              # CHANGED: banners derive from durable state; SDK status
│                                   #   is never a render gate; reconnecting subordinate (D7)
├── utils/
│   ├── chatErrorMessages.js        # UNCHANGED (frozen copy/taxonomy — FR-013)
│   ├── chatTurnError.js            # NEW: pure derivations (deriveTurnError, hasPartialReply,
│   │                               #   stampFailure) shared by context + tests
│   └── __tests__/
│       └── chatTurnError.test.js   # NEW: pure-unit tests for the derivations
└── test/
    └── scriptedChatTransport.js    # NEW: scripted fake transport driving the real Chat
                                    #   through faithful SDK status transitions (FR-017)
```

**Structure Decision**: Existing web-app layout (Express `server/`, React `client/src/`).
The behavior change concentrates in `server/api/chat.js` and
`client/src/contexts/AiChatContext.jsx`; a new pure-helper module
(`client/src/utils/chatTurnError.js`) holds the derivations so they are unit-testable in
isolation and shared verbatim by the context and the banner. No new directories at the
package level, no migration, no new endpoint.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| —         | —          | —                                    |
