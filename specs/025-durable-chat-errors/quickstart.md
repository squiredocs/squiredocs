# Quickstart & Validation Guide — 025-durable-chat-errors

How to prove the feature works. Automated suites are the gate (Constitution II); the manual
matrix confirms the real-session experience on both surfaces.

## Prerequisites

- Dev stack in the Minikube `app-dev` pod (see `docs/dev.md`). Mutagen sync can leave a
  stale dev server — restart if in doubt.
- **Backend tests are serial-only against the shared dev DB.** The implementer runs them in
  a worktree against a **per-agent DB** (see MEMORY: "Local backend test stack" /
  "Backend test DB is serial-only"). Never launch concurrent backend runs.
- Client Vitest is safe to run in parallel.

## Automated validation

### Server (Jest, serial)

```bash
# in the pod / worktree, per-agent DB configured
node --test server/api/__tests__/chat.error-surfacing.test.js   # extended: stamp + teardown
node --test server/api/__tests__/chat-errors.test.js            # taxonomy unchanged (regression)
```

Assert (contracts/failure-record.md §C):
- mid-stream failure → partial reply **and** `metadata.failure` both persisted (one save);
- post-save early return (usage-limit, byok-misconfigured, no-model, image-unsupported) →
  `metadata.failure` on trailing user message;
- before-content outer-catch failure → `metadata.failure` present;
- pre-save stream-cap rejection → **no** `metadata.failure`, prior turns untouched (FR-006);
- after a failure `GET /:id/stream` → `204`, no buffer replay; success keeps the 30 s window;
- persisted record is exactly `{ code, provider?, at }` — no raw text.

### Client (Vitest)

```bash
cd client && npx vitest run src/utils/__tests__/chatTurnError.test.js \
  src/contexts/__tests__/AiChatContext.test.jsx
```

- `chatTurnError.test.js` — pure derivations: `deriveTurnError` (trailing-turn keying,
  unknown code → still a banner via `internal`, legacy transcript → null, older stamp inert),
  `hasPartialReply`, `stampFailure` additivity (targets the last user message, preserves
  `refs`/`kind`).
- Real-`Chat` + scripted transport scenarios (FR-017 / contracts §D):
  1. live error → banner; scripted resume flips `error → submitted` (error cleared) → **banner stays**;
  2. clean replay ends at `ready` → **banner stays**;
  3. failed recovery (resume opens, no reply lands) → **banner stays**;
  4. reload: transcript with `metadata.failure` → banner derived, identical copy;
  5. next send → banner clears; landed reply (streaming/completed) → neutralized, no clearing write.

## Manual validation matrix (both surfaces: side panel + `/chat`)

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| M1 (SC-001) | Fatal failure stays | Exhaust shared credits (or force `provider_overloaded`), send | Correct banner appears and is still there 30 s+ untouched, both surfaces |
| M2 (SC-002) | Survives reload | After M1, reload the page | Same banner (same copy + action), derived from transcript |
| M3 (SC-003) | No silent no-reply | Force a mid-stream `internal`, let auto-recovery run incl. a resume that yields nothing | Either the reply shows or the banner does — never a bare user message |
| M4 (SC-006) | Durable interruption | Interrupt a streaming reply with a classified failure, reload | Partial reply + "response interrupted" notice + banner, on the fresh load |
| M5 (SC-004) | Supersede + neutralize | With a banner up, send next message | Banner clears on send; re-appears only if the new turn fails; a landed reply clears it with no reload |
| M6 (US1.3) | Per-chat isolation | Fail chat A, switch to B and back | A shows its banner, B shows none |
| M7 (D3/edge) | Pre-persist failure | Trip the per-user stream cap | Banner in-session; after reload **no** banner (nothing in transcript); composer draft restored |
| M8 (US4.3) | Retry affordance | On a retryable code, click Retry | Last message re-sent, banner clears with the send |

## Out of scope to verify (guardrails unchanged)

- 401 silent-refresh-and-resend (FR-014), token-limit compaction (FR-015), BYOK
  key-resolution/metering (FR-015) — confirm only that existing tests still pass.
- Taxonomy/copy/actions (`chatErrorMessages.js`) — no copy change expected (FR-013).
- Legacy transcript render parity (FR-016) — covered by `deriveTurnError` legacy case.
