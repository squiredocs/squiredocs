---
description: "Task list for feature 012 — Chat Error Surfacing Overhaul"
---

# Tasks: Chat Error Surfacing Overhaul

**Input**: Design documents from `/specs/012-chat-error-surfacing/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: INCLUDED — the spec mandates them (constitution Principle II; spec Assumptions:
"every behavioral change lands with tests"). Backend suites are **serial-only** against the
shared DB — never run concurrent backend runs.

**Organization**: Grouped by user story (US1–US5, priority order) for independent delivery.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no incomplete-task dependency)
- **[Story]**: US1–US5; Setup/Foundational/Polish carry no story label
- Exact file paths included.

## Path notes

- Server: `server/api/`, `server/` ; server tests `server/__tests__/`, `server/api/__tests__/`
- Client: `client/src/` ; client tests `client/src/**/__tests__/`
- No database migration in this feature (research R8).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the two new single-source modules' files and their test files so later
tasks fill them in.

- [X] T001 [P] Create empty server classifier module `server/api/chat-errors.js` with a file header describing it as the single server-side classification point (taxonomy, status map, fatality, payload builder, classify orchestrator).
- [X] T002 [P] Create empty client util `client/src/utils/chatErrorMessages.js` with a header describing it as the single client rendering/behavior source (message map, fatality/retry sets, parseChatError).
- [X] T003 [P] Create backend test file `server/api/__tests__/chat-errors.test.js` (skeleton, imports chat-errors).
- [X] T004 [P] Create backend test file `server/api/__tests__/ai-providers.classify.test.js` (skeleton, imports ai-providers).
- [X] T005 [P] Create frontend test file `client/src/utils/__tests__/chatErrorMessages.test.js` (skeleton, imports the util).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared taxonomy shape, status map, fatality data, payload builder, per-provider
detection, and client map that EVERY user story imports. No user story can wire behavior until
these exist.

**⚠️ CRITICAL**: Blocks Phases 3–7.

- [X] T006 [P] In `server/api/chat-errors.js` define the seven taxonomy codes as constants and the D2 status map (`app_usage_limit`→402, `byok_insufficient_credits`→402, `byok_invalid_key`→400, `byok_misconfigured`→400, `rate_limited`→429, `provider_overloaded`→429, `internal`→500) per `contracts/error-payload.md`.
- [X] T007 [P] In `server/api/chat-errors.js` add the fatality set (all codes except `internal`) and a `buildErrorPayload({ code, provider, error })` returning `{ error, code, provider? }` (honest string, no raw provider internals — FR-009).
- [X] T008 In `server/api/ai-providers.js` add a `classifyError(err)` function to each `PROVIDERS` entry (anthropic, google, openai, zai, openrouter) mapping that provider's upstream shapes to a signal: insufficient-credits (Anthropic 400 "credit balance is too low"; OpenAI `insufficient_quota`; Google `RESOURCE_EXHAUSTED`), invalid-key (401/403), overloaded (429/529/503 non-billing), else null. Export a registry-level `classifyProviderError(providerId, err)` helper. No provider literals leave this file (FR-003).
- [X] T009 In `server/api/chat-errors.js` implement the `classify(err, ctx)` orchestrator: combine the provider signal (via `classifyProviderError`) with request context (`isByok`, `onSharedKey`, `isRateLimited`, `isUsageLimit`, `isByokMisconfigured`) to pick the final code (incl. D3: shared-key exhaustion → `provider_overloaded` + notify flag), returning `{ code, provider, status, error, notifyOperator, notifyAdminCredit }`. Never returns 500 for a non-`internal` classified failure (FR-006). Token-limit and app-auth errors are out of scope and must not be passed in (FR-004/FR-005).
- [X] T010 [P] Write backend unit tests in `server/api/__tests__/ai-providers.classify.test.js` for each provider's `classifyError` (billing/auth/overload/null cases with realistic upstream shapes).
- [X] T011 [P] Write backend unit tests in `server/api/__tests__/chat-errors.test.js` for `classify()`: each context → correct code/status/notify flags; BYOK-vs-shared billing split (D3); status-map correctness; non-internal never 500.
- [X] T012 [P] In `client/src/utils/chatErrorMessages.js` implement `MESSAGES` (code→`{text, action}`, D1 copy), `PROVIDER_LABELS` (anthropic/google/openai/zai/openrouter), `FATAL_CODES`, `RETRYABLE_CODES`, and `parseChatError(errorOrPayload)→{code, provider, text}` with `internal` fallback for unknown/absent codes showing the payload's `error` text (FR-013). No substring-to-behavior logic.
- [X] T013 [P] Write frontend unit tests in `client/src/utils/__tests__/chatErrorMessages.test.js`: every code resolves a distinct message; provider interpolation from payload; unknown code → internal fallback; fatality/retry set membership.

**Checkpoint**: Classification backbone + client map exist and are unit-tested. User stories can now wire behavior.

---

## Phase 3: User Story 1 — Every chat failure shows a specific, honest, actionable message (Priority: P1) 🎯 MVP

**Goal**: The classified code reaches the client over both channels and renders one identical,
actionable message in the side panel and the full-page chat; no raw provider text, no generic
500 for classified failures.

**Independent Test**: Induce each of the seven classes; verify each renders its own distinct
message identically in both surfaces with correct HTTP status (or SSE payload mid-stream) and
no raw provider text.

### Tests for User Story 1 ⚠️

- [X] T014 [P] [US1] Backend integration test `server/api/__tests__/chat.error-surfacing.test.js`: pre-stream failures return JSON `{error, code, provider?}` with the honest status for each class (quota→402 `app_usage_limit`; overloaded→429; invalid-key→400; etc.); classified non-internal never 500.
- [X] T015 [P] [US1] Backend test in the same file: mid-stream failure emits the SSE `error` event carrying `{type:'error', errorText, code, provider?}` and is NOT written to the reconnection replay buffer (FR-010); token-limit chunk still triggers compaction (unchanged, FR-004).
- [X] T016 [P] [US1] Frontend test `client/src/contexts/__tests__/AiChatContext.errors.test.js`: `handleChatError` selects behavior from the parsed `code` (no `.includes()` on body text); unknown code → internal render.

### Implementation for User Story 1

- [X] T017 [US1] In `server/api/chat.js` outer `catch` (~888–902) and the early returns (quota ~597–607, model-resolve ~643–646, concurrency ~560), replace ad-hoc statuses/bodies with `chat-errors.classify(...)` + `buildErrorPayload` → `res.status(status).json(payload)`; set `Retry-After` for `rate_limited`/`provider_overloaded` when known. Remove the generic `'Internal server error'` body for classified non-internal cases.
- [X] T018 [US1] In `server/api/chat.js` mid-stream path: capture the real error at the `streamText` `onError` seam (~760) / the `toUIMessageStream` error formatter, classify it, and emit the SSE `error` event with `{errorText, code, provider}` in `pipeAsSSE` (~356–366) — keeping the no-buffer rule and the token-limit interception (~338) intact (research R2).
- [X] T019 [US1] In `server/rate-limit.js`, make the chat per-user 429 carry the structured `rate_limited` payload (via chat-errors) while leaving `reject429`/the uniform body for non-chat routes unchanged (spec: non-chat 429 out of scope).
- [X] T020 [US1] In `client/src/contexts/AiChatContext.jsx` `handleChatError` (~320): replace body-sniffing (`msg.includes('usage limit')`, etc.) with `parseChatError` → `code`; store the parsed `{code, provider, text}` as the instance's error state for rendering. **Also** convert the app-auth retry trigger (~332–345, currently `msg.includes('401')||'expired token'||'unauthorized'`) to be keyed on the response **status 401**, not body text — the silent refresh-and-retry behavior is preserved and app-auth stays outside the taxonomy (FR-005/FR-013/D7). No `.includes()` on error text remains in this function.
  **Mechanism (H1 resolution, D8)**: pass a custom `fetch` to the `DefaultChatTransport` constructor (~192) that wraps global fetch and, when `!response.ok`, reads the body text and throws `Object.assign(new Error(bodyText), { status: response.status })` — so `handleChatError` receives a status-bearing error before the transport's own body-only throw. `parseChatError` accepts this error (JSON body → code) and the 401 branch keys on `error.status === 401`. SSE mid-stream errors have no status; `parseChatError` handles both shapes.
- [X] T021 [US1] In `client/src/components/AiChatBody.jsx` (~47–58) render the banner text/action from the shared `MESSAGES` map using the parsed `code`+`provider`; keep the usage-limit banner path but source its copy from the map; Retry button only when `code ∈ RETRYABLE_CODES`.
- [X] T022 [US1] In `client/src/pages/ChatPage.jsx` (~143–151) pass the classified `errorMessage` (derived from the parsed code) into `AiChatBody` so the full page shows specific text (FR-014); today it passes none.
- [X] T023 [US1] In `client/src/components/AiPanel.jsx` remove `errorByokRef`/`prevErrorRef`/`errorWasByok` inference and the client-side `PROVIDER_LABELS` error-mode guess (~20, ~38–46, ~231); feed `code`+`provider` from the parsed payload so both surfaces use the same map (FR-008/FR-014).

**Checkpoint**: US1 fully functional — all seven classes render identical, honest messages in both surfaces. MVP.

---

## Phase 4: User Story 2 — Fatal errors end the turn honestly; interruptions stay visible (Priority: P2)

**Goal**: Fatal codes skip reconnect-recovery and render immediately; a mid-stream fatal error
that left a persisted partial reply shows a session-scoped "response interrupted: <reason>"
notice.

**Independent Test**: Induce a fatal error (a) pre-stream → banner, no "Reconnecting…"; (b)
mid-stream after partial content persisted → partial reply + interruption notice.

### Tests for User Story 2 ⚠️

- [X] T024 [P] [US2] Frontend test in `client/src/contexts/__tests__/AiChatContext.errors.test.js`: a fatal `code` bypasses `recoverChat` (no reconnect); `internal`/network still enters recovery (FR-015).
- [X] T025 [P] [US2] Frontend test: mid-stream fatal error where recovery finds a persisted partial reply keeps a session-scoped interruption notice instead of clearing the error (FR-016/D5).

### Implementation for User Story 2

- [X] T026 [US2] In `client/src/contexts/AiChatContext.jsx` `handleChatError` (~347–376): gate the recovery path on fatality — if `code ∈ FATAL_CODES`, render the banner and restore the draft (FR-018) without calling `recoverChat`; only `internal`/network proceed to recovery.
- [X] T027 [US2] In `client/src/contexts/AiChatContext.jsx` `recoverChat` (~299–314): when the persisted state has a complete-looking partial reply but the triggering error was fatal, set a session-scoped interruption notice `{chatId, reason}` (reason from the code's message) instead of the unconditional `clearError()` (~303).
- [X] T028 [US2] In `client/src/components/AiChatBody.jsx` render the interruption notice ("response interrupted: <reason>") beside the partial reply when present (session-scoped; absent after reload — D5).

**Checkpoint**: Fatal errors never fake a reconnect; truncated replies are visibly truncated in the live session.

---

## Phase 5: User Story 3 — Usage-limit state recovers without a page reload (Priority: P2)

**Goal**: The usage-limit banner is derived per send, not latched — top-up/BYOK-enable/rollover
resume chat with no reload.

**Independent Test**: Trip limit → banner; raise credit / enable BYOK → send without reload →
succeeds, banner gone; send again with limit still in force → banner returns.

### Tests for User Story 3 ⚠️

- [X] T029 [P] [US3] Frontend test in `client/src/contexts/__tests__/AiChatContext.errors.test.js`: usage-limit clears on the next send attempt and re-appears only on a fresh `app_usage_limit` rejection; no permanent latch (FR-017).

### Implementation for User Story 3

- [X] T030 [US3] In `client/src/contexts/AiChatContext.jsx` remove the permanent `setUsageLimitReached(true)` latch (~329) and instead clear the usage-limit state at the start of each send attempt, re-setting it only when a send is rejected with `app_usage_limit` (derived state — FR-017).
- [X] T031 [US3] Verify/adjust the send entry point (wherever `sendMessage` is dispatched in `AiChatContext.jsx`) clears the interruption notice and usage-limit state for the new attempt so a successful resend shows a clean transcript.

**Checkpoint**: A lifted limit resumes chat with zero reloads; the banner re-derives correctly.

---

## Phase 6: User Story 4 — BYOK misconfiguration fails loudly, never bills the operator (Priority: P2)

**Goal**: BYOK-on-but-unresolvable is rejected with `byok_misconfigured` before any provider
call; never falls back to the shared server key.

**Independent Test**: Enable BYOK, corrupt stored model/key; send → `byok_misconfigured`; verify
no shared-key request and no operator-billed usage.

### Tests for User Story 4 ⚠️

- [X] T032 [P] [US4] Backend test `server/api/__tests__/chat-models.byok.test.js`: `resolveChatModel` with `isByok` true and an unknown model key / unresolvable key signals `byok_misconfigured` distinctly and does NOT fall back to the shared default; non-BYOK env→default fallback unchanged.
- [X] T033 [P] [US4] Backend test in `server/api/__tests__/chat.error-surfacing.test.js`: a misconfigured-BYOK send returns 400 `byok_misconfigured` pre-stream and records zero usage on the shared key (SC-006).

### Implementation for User Story 4

- [X] T034 [US4] In `server/api/chat-models.js` `resolveChatModel` (~283–298): when `isByok` and the BYOK model/key cannot resolve, return a discriminated misconfig signal (e.g. `{ error: 'byok_misconfigured' }`) instead of falling through to the shared default; leave the non-BYOK shared-default chain (env→DEFAULT_MODEL_KEY) intact. Update the JSDoc that currently documents the silent fallthrough.
- [X] T035 [US4] In `server/api/chat.js` model-resolution site (~637–646): map the misconfig signal to a pre-stream `byok_misconfigured` 400 via chat-errors (before reserving credits / any provider call); keep the genuine "no model configured at all" case as `internal` 500.

**Checkpoint**: Misconfigured BYOK is rejected loudly; the shared key is never silently billed.

---

## Phase 7: User Story 5 — Operator notifications match fault ownership (Priority: P3)

**Goal**: BYOK billing/key failures never page the operator; `app_usage_limit` keeps its admin
email; shared-key exhaustion notifies the operator with the true cause.

**Independent Test**: BYOK billing failure → no exception notification; in-app quota → admin
email (once per user/month); shared-key exhaustion → operator notified, user sees
`provider_overloaded`.

### Tests for User Story 5 ⚠️

- [ ] T036 [P] [US5] Backend test in `server/api/__tests__/chat.error-surfacing.test.js` (or a dedicated notifications test): `byok_insufficient_credits`/`byok_invalid_key` → `notifyException` NOT called (FR-020); `internal` → called (FR-023); shared-key exhaustion → called with the true cause (FR-022); `app_usage_limit` → `notifyCreditLimitReached` preserved, per user/month (FR-021).

### Implementation for User Story 5

- [X] T037 [US5] In `server/api/chat.js`, drive operator/admin notifications from the `classify()` result's `notifyOperator`/`notifyAdminCredit` flags: call `notifyException` only for `internal` and shared-key exhaustion; never for `byok_*`; preserve the existing `notifyCreditLimitReached` on `app_usage_limit` (already at ~599–604) without double-sending.
- [X] T038 [US5] Ensure the shared-key-exhaustion notification carries the true cause (billing exhaustion, not "overload") while the user payload stays `provider_overloaded` (D3) — thread the true-cause detail through the notifier call, not the user payload.

**Checkpoint**: Paging matches fault ownership across all classes.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T039 [P] Run the full backend chat/error suites serially and the frontend chat suites; fix any regressions (serial DB per constitution II).
- [ ] T040 [P] Grep the client chat error path to confirm zero body-text→behavior matching remains (SC-007); confirm the app-401 refresh-retry is keyed on response status, not body text (FR-005/D7).
- [ ] T041 Run `specs/012-chat-error-surfacing/quickstart.md` per-class + behavior validations end-to-end (both surfaces).
- [ ] T042 [P] Confirm design/spec alignment: no design-doc amendment needed (converge-to-design); if implementation falsified any documented mechanism, amend the Squire source + `node design/sync.mjs` (NOT a hand-edit) — otherwise note "no drift".

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)**: no dependencies.
- **Foundational (P2)**: depends on Setup; **blocks all user stories**.
- **US1 (P3)**: depends on Foundational. MVP.
- **US2, US3 (P4/P5)**: depend on Foundational; both live mostly in `AiChatContext.jsx` +
  `AiChatBody.jsx` — sequence them (shared files) rather than parallelize.
- **US4 (P6)**: depends on Foundational; mostly `chat-models.js` + `chat.js` resolve site —
  independent of US2/US3.
- **US5 (P7)**: depends on Foundational + US1's classify wiring in `chat.js`.
- **Polish (P8)**: after desired stories complete.

### Story independence

- US1 is the MVP and the base others build on (classification reaching the client).
- US2, US3 both edit `AiChatContext.jsx`/`AiChatBody.jsx` — not parallel-safe with each other.
- US4 is file-isolated (`chat-models.js` + one `chat.js` site) — parallelizable with US2/US3.
- US5 shares `chat.js` with US1 — do after US1.

### Within each story

- Tests first (must fail), then implementation.
- Server classify before client render; models/resolvers before endpoints.

### Parallel opportunities

- Setup T001–T005 all [P].
- Foundational: T006/T007 (server data), T010/T011 (server tests), T012/T013 (client) parallel
  across the server/client split; T008 before T009 (orchestrator needs registry helper).
- US4 can run alongside US2/US3 (different files).

---

## Parallel Example: Foundational

```bash
# Server data shape + client map in parallel (different files):
Task: "T006 taxonomy codes + status map in server/api/chat-errors.js"
Task: "T012 message map + parseChatError in client/src/utils/chatErrorMessages.js"
# Their unit tests in parallel:
Task: "T011 classify() unit tests in server/api/__tests__/chat-errors.test.js"
Task: "T013 map unit tests in client/src/utils/__tests__/chatErrorMessages.test.js"
```

---

## Implementation Strategy

### MVP first (US1)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL) → 3. Phase 3 US1 → STOP & validate the
   seven classes in both surfaces → deploy/demo.

### Incremental delivery

US1 (MVP) → US2 (honest fatal/interruption) → US3 (derived latch) → US4 (loud misconfig) →
US5 (notification hygiene). Each is independently testable and additive.

---

## Notes

- No database migration (research R8) — migration ordering is not engaged.
- [P] = different files, no incomplete-task dependency.
- Backend tests are serial-only against the shared DB (constitution II).
- Per-provider detection stays in `ai-providers.js` (FR-003) — no provider literal in `chat.js`.
- Design doc wins on any conflict (Principle VI); D1–D7 are ratified-by-default.
- Commit to `main` after logical groups (solo trunk workflow) — but this feature's brief
  defers commits/deploy to the maintainer.
