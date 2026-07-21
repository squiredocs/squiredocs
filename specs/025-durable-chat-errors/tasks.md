---
description: "Task list for 025-durable-chat-errors implementation"
---

# Tasks: Durable Chat Error Surfacing

**Input**: Design documents from `/specs/025-durable-chat-errors/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: INCLUDED — the spec explicitly mandates regression tests (FR-017/D8) and the
constitution requires test-backed changes (Principle II). Test tasks precede the
implementation they cover within each phase.

**Organization**: Grouped by user story. The shared stamp/teardown/consolidation machinery
is Foundational (it underpins every story); each story phase adds its story-specific wiring
+ its behavioral tests so it stays independently testable.

**Environment note**: backend Jest is serial-only against the shared dev DB — the
implementer runs it in a worktree against a **per-agent DB** (MEMORY: "Backend test DB is
serial-only" / "Local backend test stack"). Client Vitest is parallel-safe.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 for user-story phases only

## Path Conventions

Web app: server code under `server/`, client under `client/src/` (per plan.md Structure).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffold the two new files the rest of the work builds on.

- [ ] T001 [P] Create `client/src/utils/chatTurnError.js` with exported stubs
  (`deriveTurnError`, `hasPartialReply`, `stampFailure`) and JSDoc referencing
  data-model.md §2.
- [ ] T002 [P] Create `client/src/test/scriptedChatTransport.js`: a scripted fake transport
  that drives the real `@ai-sdk/react` `Chat` class, able to script an error part, a
  `reconnectToStream` returning non-null (SDK → `submitted`, error cleared) vs `null`/204
  (status untouched), and a clean replay ending at `ready` (research.md R6).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The server persistence/teardown mechanism and the client one-durable-state
consolidation. **Every user story renders from durable state / the persisted record**, so
no story phase can begin until this is complete.

**⚠️ CRITICAL**: Blocks all user-story phases.

### Server — persistence & teardown (`server/api/chat.js`, serial; single file)

- [ ] T003 Introduce a turn-scoped `pendingFailureStamp = { code, provider, at }` derived
  from the `classify()` signal. Set it at `classifyStreamError` (~L931), captured
  **independently** of `capturedStreamSignal` (which the SSE path nulls out), and alongside
  each **post-save** `sendClassifiedError(signal)` call (usage-limit L725, byok-misconfigured
  L782, no-model L790, image-unsupported L812, outer catch L1115). (FR-001/FR-002)
- [ ] T004 Make the `onFinish` full-replace save **stamp-aware**: in `runStream`'s
  `onFinish` (~L1028), before `chatStore.saveChat`, apply `pendingFailureStamp` to `saved`'s
  trailing **user** message metadata (additive `metadata = { ...metadata, failure }`). This
  closes the documented clobber race (the partial-reply save can never persist a failed turn
  without the stamp). (FR-004, research.md R1)
- [ ] T005 Add an awaited `stampTurnFailure(record)` read-modify-write
  (`loadChat` → set `metadata.failure` on trailing user message → `saveChat`) and invoke it
  on the post-save early returns and the outer catch. Ensure the **pre-save** stream-cap
  rejection (L671, before the L699 user-message save) and any draft-chat failure **never**
  stamp (structurally distinct path, not a "trailing is user" heuristic). (FR-002/FR-006/D3)
- [ ] T006 Add `teardownEntry()` (`entry.done = true; entry.chunks.length = 0;
  activeStreams.delete(chatId)`). Branch the post-`runStream` epilogue (L1099): if this turn
  set `pendingFailureStamp` → `teardownEntry()`, else keep `cleanupEntry(30_000)` (success
  window unchanged). Outer catch (L1103) → `teardownEntry()`. (FR-005, research.md R3)

### Client — one durable state + derived rendering

- [ ] T007 [P] Implement the pure helpers in `client/src/utils/chatTurnError.js`:
  `deriveTurnError(messages)` = the `failure` stamp on the **last `role === 'user'`** message
  or `null` (this single rule yields trailing-turn keying, interrupted-partial banners, and
  older-stamp-inert by construction — do NOT neutralize on "last message is assistant with
  content"); `hasPartialReply`; `stampFailure` (applies to the last **user** message, not
  `messages[length-1]`). Unknown/absent code → null so `parseChatError` floors to `internal`
  at render. (data-model §2, research R4)
- [ ] T008 In `client/src/contexts/AiChatContext.jsx`, collapse `errorInfoByChat`,
  `usageLimitReached`, and `interruptedByChat` into one durable `turnErrorByChat` map
  (keep `reconnectingChatId`). Repoint `handleChatError` and `clearChatError` to write/clear
  `turnErrorByChat[chatKey]`. (FR-007/FR-009, D7)
- [ ] T009 In `AiChatContext.jsx`, populate `turnErrorByChat` from `deriveTurnError(messages)`
  on every transcript load / re-sync path: the load-messages effect (~L577), `recoverChat`
  refetch (~L337), `reloadChatFromDb` (~L495), and the bfcache `pageshow` path. (FR-007)
- [ ] T010 In `AiChatContext.jsx` value memo (~L812), derive the exposed props:
  `effectiveError = deriveTurnError(chat.messages) ?? turnErrorByChat[activeKey]`; then
  `errorInfo` (via `parseChatError`), `usageLimitReached` (`code === 'app_usage_limit'`),
  `interruptionReason` (`hasPartialReply`). Self-neutralization is by the stamp on the last
  user message (NOT message position — an interrupted partial keeps its banner); clear the
  **live** `turnErrorByChat[key]` when a reply lands, and on send (supersession). No write to
  the stored transcript record. (FR-010/FR-011)
- [ ] T011 [P] In `client/src/components/AiChatBody.jsx`, render every banner from the durable
  derived props only — delete the `status === 'error' && error` render gate (L63) — and
  reorder so the transient `reconnecting` indicator can never suppress a durable failure
  banner once an attempt concludes (D7). SDK `status`/`error` are no longer render gates. (FR-008)

**Checkpoint**: failures persist server-side and the client holds one durable per-chat state
rendered without any SDK-status gate. Stories can now proceed.

---

## Phase 3: User Story 1 - A failed turn stays visibly failed (Priority: P1) 🎯 MVP

**Goal**: A classified failure's banner appears and stays — no reconnect, status transition,
replay, or recovery cycle can make it vanish while unaddressed; per-chat.

**Independent Test**: Force a classified failure, watch the banner on both surfaces 30 s+
untouched; drive resume/replay transitions and confirm it never disappears.

- [ ] T012 [P] [US1] Client test in `client/src/contexts/__tests__/` (real `Chat` + scripted
  transport): a live-error banner **stays** across `error → submitted` (error cleared) and a
  clean replay ending at `ready`; and error state is per-chat (fail A, B shows none). (SC-001/SC-003)
- [ ] T013 [P] [US1] Server test in `server/api/__tests__/chat.error-surfacing.test.js`: after
  a classified failure (mid-stream and before-content) `GET /api/chat/:id/stream` returns
  `204` with no failure-buffer replay; a successful turn keeps the 30 s replay window. (FR-005)
- [ ] T014 [US1] Make T012/T013 pass: finalize the `AiChatBody` derivation + teardown so no
  status transition, resume, buffer replay, or recovery cycle can hide an unaddressed
  banner. (FR-005/FR-008)

**Checkpoint**: reported bug's live-session symptom is fixed and covered.

---

## Phase 4: User Story 2 - Failures survive reloads and re-syncs (Priority: P1)

**Goal**: The failure banner re-derives from the saved transcript on any reload / re-fetch.

**Independent Test**: Fail a turn, reload, see the same banner derived from the loaded
transcript; a reconnect in the old replay window finds nothing and derives from the transcript.

- [ ] T015 [P] [US2] Server stamp-durability test in
  `server/api/__tests__/chat.error-surfacing.test.js`: after a failure the loaded transcript's
  trailing user message carries `metadata.failure` for (a) mid-stream w/ partial reply (one
  fold save), (b) each post-save early return (RMW), (c) the before-content outer catch; the
  record is exactly `{ code, provider?, at }`; a **pre-save** stream-cap rejection leaves no
  record and no prior turn mutated. (FR-001/FR-003/FR-004/FR-006)
- [ ] T016 [P] [US2] Client test: a transcript bearing `metadata.failure` on its trailing
  user turn **populates** the banner on load with identical copy/action (same code); a second
  concurrent load derives the same; a reconnect in the old window (204) → outcome derived from
  transcript. (SC-002)
- [ ] T017 [US2] Make T015/T016 pass end-to-end; assert additive-safety — an unknown
  `metadata.failure` key survives `validateUIMessages` and is dropped by
  `convertToModelMessages` (never reaches a provider). (FR-016, research.md R7)

**Checkpoint**: the root-cause persistence fix is proven across reload paths.

---

## Phase 5: User Story 3 - Recovery is honest (Priority: P2)

**Goal**: Recovery counts as success only when an assistant reply actually lands; a resume
that merely connects (or replays nothing) leaves the banner.

**Independent Test**: Simulate a failed turn + a resume that establishes a connection but
delivers no content; the banner stays and "Reconnecting…" ends without claiming success.

- [ ] T018 [P] [US3] Client test (real `Chat` + scripted transport): a failed recovery
  (resume opens, no reply lands) → banner **stays**; a recovery whose refetch finds a
  persisted reply → reply shown, no banner; a fatal code → no recovery attempted. (SC-003, US3.1-3)
- [ ] T019 [US3] In `AiChatContext.jsx`, replace `waitForEstablish` (resolves on
  `submitted`/`streaming`) with `waitForReply` (resolves only when an assistant message with
  visible content lands); `recoverChat` uses it. Confirm the derived banner is the
  belt-and-suspenders even if the SDK mis-reports. (FR-012, research.md R5)

**Checkpoint**: the false-success recovery hole is closed at the source.

---

## Phase 6: User Story 4 - The banner lifecycle is derived, not managed (Priority: P2)

**Goal**: Next send supersedes the banner; a landed reply neutralizes it — no clearing write.

**Independent Test**: Fail a turn, send a new message → banner clears on send; a reply
landing clears the banner with no stored-record write.

- [ ] T020 [P] [US4] Client test: next send clears the banner immediately (re-trips only if
  the new turn fails); a landed assistant reply (streaming or completed) neutralizes it with
  **no** clearing write; Retry on a retryable code re-sends and clears with the send. (SC-004, US4.1-3)
- [ ] T021 [US4] Confirm the supersede-on-send clear (`sendMessage`) and the stamp-driven
  read-side neutralization (last user message no longer stamped) satisfy T020 with no
  explicit write to the stored transcript record. Verify an interrupted partial is NOT
  neutralized. (FR-011)

**Checkpoint**: one durable state stays sufficient — no latch needs manual clearing.

---

## Phase 7: User Story 5 - Truncated replies are visibly truncated, forever (Priority: P3)

**Goal**: A mid-stream-interrupted partial reply carries its interruption notice live and on
every later load, derived from the persisted record.

**Independent Test**: Interrupt a streaming reply with a classified failure, reload, and see
the partial reply still carrying the interruption notice.

- [ ] T022 [P] [US5] Client test: an interrupted partial reply shows the notice + banner
  live and again on reload (derived from `metadata.failure` + trailing partial content); the
  next send clears the notice while the partial reply remains in the transcript. (SC-006, US5.1-3)
- [ ] T023 [P] [US5] Server test in `chat.error-surfacing.test.js`: a mid-stream failure
  persists the partial assistant reply **and** the failure stamp in the single fold save, so
  the interruption is derivable after a fresh load. (FR-004)
- [ ] T024 [US5] Confirm the interruption derivation (`turnError` present +
  `hasPartialReply`) renders identically on both surfaces via the shared copy map. (FR-013)

**Checkpoint**: supersedes 012's session-only notice (D5) with a durable one.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T025 [P] Pure-unit tests in `client/src/utils/__tests__/chatTurnError.test.js`:
  trailing-turn keying, unknown code → `internal` floor (D6), legacy transcript → null
  (FR-016), older stamp deeper in transcript is inert, `stampFailure` additivity (preserves
  `refs`/`kind`).
- [ ] T026 Run guardrail regressions unchanged: `server/api/__tests__/chat-errors.test.js`,
  `ai-providers.classify.test.js`, and the retained `AiChatContext.test.jsx` non-transition
  cases — confirm 401 refresh (FR-014), token-limit compaction / BYOK (FR-015), and taxonomy
  copy (FR-013) are untouched.
- [ ] T027 [P] Additive-safety cross-check: assert `convertToModelMessages` never forwards
  `metadata.failure` to the provider and compaction/history-hygiene carry-or-drop it without
  error. (Assumptions, research.md R7)
- [ ] T028 Run the quickstart.md manual matrix M1–M8 on both surfaces (side panel + `/chat`).
- [ ] T029 Doc-sync gate (implement/merge stage, not this planning agent): if implementation
  falsified any documented mechanism, amend `design/in-app-ai-assistant.md` (via the Squire
  source + `design/sync.mjs`) and README/dev.md in the same effort. (Principle I/VI)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup — **BLOCKS all user stories**.
- **User Stories (Phase 3–7)**: all depend on Foundational. US1 and US2 (both P1) are the
  MVP; US3–US5 build on the same machinery.
- **Polish (Phase 8)**: after the desired stories.

### Task-level dependencies

- Server chain (same file, serial): T003 → T004 → T005 → T006.
- Client chain: T007 [P] can go early; T008 → T009 → T010 (same file, serial); T011 [P]
  (different file) after T010's derived props exist.
- T014 depends on T011 + T006; T017 depends on T004/T005 + T009; T019 depends on T009/T010;
  T021 depends on T010; T024 depends on T010/T011.
- Tests within a story (marked [P]) are authored first and should fail before the
  make-it-pass task in the same phase.

### Parallel opportunities

- T001, T002 (Setup) in parallel.
- T007 (client helpers) parallel with the server chain T003–T006.
- Within each story, the [P] test tasks (T012/T013, T015/T016, etc.) in parallel.
- After Foundational, US3–US5 wiring is largely independent (different concerns) once their
  shared derivations exist.

---

## Parallel Example: User Story 2

```bash
# Author both failing tests together, then implement:
Task: "Server stamp-durability test in server/api/__tests__/chat.error-surfacing.test.js"  # T015
Task: "Client transcript-derived banner test in client/src/contexts/__tests__/"            # T016
```

---

## Implementation Strategy

### MVP (US1 + US2, both P1)

1. Phase 1 Setup → Phase 2 Foundational (the whole stamp/teardown/consolidation).
2. Phase 3 (US1) + Phase 4 (US2): live-session durability + reload durability — this is the
   reported bug's full root-cause fix. **Stop and validate** on both surfaces.

### Incremental delivery

3. US3 (honest recovery) → US4 (derived lifecycle) → US5 (durable interruption), each
   independently testable, each riding the same machinery.
4. Polish: guardrail regressions, additive-safety, quickstart matrix, doc-sync.

---

## Notes

- [P] = different files, no incomplete-task dependency.
- No migration, no new endpoint — the record is additive JSONB metadata.
- Backend tests serial-only (per-agent DB in the worktree); client Vitest parallel-safe.
- Guardrails frozen: taxonomy/copy/actions, the 401 path, token-limit compaction, BYOK.
