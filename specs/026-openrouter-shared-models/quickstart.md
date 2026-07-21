# Quickstart / Validation Guide — 026-openrouter-shared-models

Runnable scenarios that prove the feature works end-to-end. Implementation detail lives in
`tasks.md`; this is the run/validate guide. Backend tests are **serial-only on a per-agent DB**
(Constitution II) — the implementer works in a worktree with `createdb collab_test_db_026` and a
matching `DATABASE_URL`.

## Prerequisites

- Repo checked out; backend deps installed. Run inside the app-dev pod (or the worktree test stack).
- OpenRouter catalog is fetched **unauthenticated** for authoring: `curl -s
  https://openrouter.ai/api/v1/models` (verified reachable, HTTP 200, 2026-07-21).
- No `OPENROUTER_API_KEY` is required to run the suite (dormant-safe path is the default); a couple
  of scenarios set/unset it via test env to exercise eligibility.

## Setup (worktree test DB, per repo convention)

```bash
createdb collab_test_db_026
export DATABASE_URL="postgres://…/collab_test_db_026"
# run backend migrations for the test DB per docs/dev.md, then:
```

## Scenario A — Dormant-safe backward compatibility (SC-007, US2-1)

Prove no-key behavior is byte-for-byte today's.

```bash
# with OPENROUTER_API_KEY UNSET
npx jest server/api/__tests__/admin.test.js server/api/__tests__/chat-models*.test.js --runInBand
```
Expect: shared-model `models`/`providers` contain **no** openrouter entries; PUT of a gateway key →
400; existing suites green with no key present.

## Scenario B — Admin selects a gateway model (SC-001, US1)

With `OPENROUTER_API_KEY` set in the test env:
1. GET `/settings/shared-model` → `models` includes `kimi-k3`, `qwen3.7-max`, `qwen3.7-plus`,
   `minimax-m3`, `or-glm-*`; `providers` includes `{ id: 'openrouter', label: 'OpenRouter' }`.
2. PUT `{ modelKey: 'kimi-k3' }` → 200; response `modelKey === 'kimi-k3'` and
   `effectiveModelKey === 'kimi-k3'`.
3. Admin picker renders provider `<optgroup>`s (AdminPage test or manual): Kimi/Qwen/MiniMax/GLM
   under "OpenRouter", Claude under "Anthropic", Gemini under "Google".

## Scenario C — Metered shared turn on a gateway model (SC-002, FR-007)

Send a non-BYOK chat turn with a gateway shared default set (via existing chat test harness helpers —
**do not edit** `chat.js`/`chat-store.js`). Assert exactly one `ai_usage_log` row priced from the
gateway entry's registry pricing. A BYOK turn produces none.

## Scenario D — Graceful degradation on key removal (SC-003, FR-005, D4)

1. Store `modelKey: 'kimi-k3'`, then UNSET `OPENROUTER_API_KEY`.
2. GET `/settings/shared-model` → `effectiveModelKey` is the fallback (`AI_CHAT_MODEL` | `claude-opus`),
   **not** `kimi-k3`; openrouter absent from `models`/`providers`.
3. A non-BYOK resolution (`resolveChatModel`) returns the fallback model with a logged warning — **no**
   unauthenticated client instantiated, **no** BYOK key drafted.

## Scenario E — BYOK invariants preserved (SC-004, FR-008)

With BOTH `OPENROUTER_API_KEY` and a user BYOK openrouter key configured:
1. A BYOK turn uses the **user's** key (assert the shared key is never used) and skips metering.
2. Break the BYOK key/model reference → `byok_misconfigured`, **no** fallback to the shared key
   despite it now existing.

## Scenario F — Shared-key credit exhaustion is an operator incident (SC-005, FR-006)

Simulate an OpenRouter 402 on a **shared** (non-BYOK) turn: user sees `provider_overloaded` (never a
top-up instruction), operator is notified. Assert via the classifier/orchestration seam for provider
`openrouter` (no taxonomy/orchestration code change — test only).

## Scenario G — Honest image handling per vision flag (SC-006, FR-003/D5)

- Vision-flagged entry (only if `supportsImages: true` was earned by live verification): image
  attachment succeeds.
- Text-only entry (the default at plan time): UI gate + server `model_no_image_support` pre-flight
  reject the attachment; a transcript with historical image parts loads without crashing
  (`replaceUnsupportedImageParts`). Assert the text-only path by test.

## Full suite

```bash
# serial — never run concurrent backend jest against the same DB
npx jest server/api/__tests__ --runInBand
# frontend picker test, if present
npx vitest run client/src/pages/__tests__/AdminPage
```

## Go-live (operator, out of code scope — D6, promotion notes)

1. Seed `OPENROUTER_API_KEY` — prod via the hardened cluster SOPS flow, local in `.env`.
2. Fund the OpenRouter account (balance is an operational resource; exhaustion pages the operator).
3. Optionally select a gateway model as the shared default in the admin area.
4. Live vision round-trip per candidate entry before flipping any `supportsImages: true` (D5).
5. Rollback = delete the secret (FR-005 degrades a stored gateway default gracefully).
