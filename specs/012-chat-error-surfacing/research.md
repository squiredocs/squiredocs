# Phase 0 Research: Chat Error Surfacing Overhaul (012)

All open *product* decisions were pre-resolved as RATIFIED-BY-DEFAULT in
[clarifications-needed.md](./clarifications-needed.md) (D1–D7); this file records the
*technical* decisions the plan rests on, each grounded in the verified current code.

---

## R1 — Where classification hooks into the existing failure funnels

**Decision**: Two hook points, one classifier. (1) **Pre-stream / pre-flight** failures
land in the outer `try/catch` of `POST /api/chat` (`server/api/chat.js` ~888–902) plus the
explicit early returns (quota check ~597–607, model-resolve ~643–646, concurrency 429 ~560).
All of these become `classify(err/ctx) → { error, code, provider?, status }` and reply with
JSON. (2) **Mid-stream** failures reach the AI SDK via `streamText`'s `onError` seam
(~760) and surface as `{ type: 'error', errorText }` chunks inside `pipeAsSSE` (~338–366).

**Rationale**: These are already the *only* two places a chat turn can fail; the design's
"classify once, next to the provider call" maps onto them exactly. No third site is created.

**Alternatives considered**: Classifying in the client (rejected — violates FR-001/single
point and forces body-sniffing); a middleware wrapper (rejected — the failure context, e.g.
`isByok`/`provider`, only exists inside the handler).

---

## R2 — Carrying the structured payload on the SSE error channel

**Decision**: The mid-stream `error` event carries the structured payload as its data. Today
`pipeAsSSE` forwards the raw `{ type:'error', errorText }` to the live client and (correctly)
does **not** buffer it (~356–366). Change: classify the real error object (captured via the
`streamText` `onError` seam / the `toUIMessageStream` error formatter) and emit
`{ type:'error', errorText, code, provider }` — `errorText` stays the honest human string
(FR-009), `code`/`provider` are the new structured fields. The no-buffer rule (FR-010) and
the token-limit interception (~338) are preserved unchanged.

**Rationale**: Reuses the exact event the client already listens on; the AI SDK's
`DefaultChatTransport` surfaces the event to the client `onError`, so the client can read
`code`/`provider` off the parsed payload. `errorText` remaining present covers degraded
clients (D6).

**Key constraint discovered**: The AI SDK's default `toUIMessageStream` error text is a
generic string and the *real* error object (with `statusCode`, provider body) is only visible
in the `onError` callback. So classification of a mid-stream error must read the error object
at the `onError` seam and thread the resulting `{code, provider, error}` into the emitted SSE
event (e.g. via a per-request holder or a custom `onError` formatter on `toUIMessageStream`).
This is an implementation detail for tasks; the plan flags it so mid-stream classification
isn't attempted from the opaque `errorText` string (which would be body-sniffing).

**Alternatives considered**: A separate custom SSE event type (rejected — the client already
handles `type:'error'`; a new type means new plumbing on both ends for no gain).

---

## R3 — Per-provider detection lives in the registry (constitution)

**Decision**: Add a `classifyError(err)` function to each `PROVIDERS` entry in
`server/api/ai-providers.js`, returning the taxonomy-relevant signal for that provider's
upstream shapes: Anthropic 400 "credit balance is too low" → insufficient-credits; OpenAI
`insufficient_quota` (429) → insufficient-credits; Google `RESOURCE_EXHAUSTED` (429) →
insufficient-credits; 401/403 → invalid-key; 429/529/503 (non-billing) → overloaded; else
null (→ `internal`). The chat endpoint and `chat-errors.js` orchestrator call this; **no
provider string literal appears in `chat.js`**.

**Rationale**: Constitution Tech-Constraints + FR-003: provider knowledge lives in one place.
The registry already holds each provider's key column, validation, caching, web-search — error
detection is the same category of knowledge. The billing-vs-overload disambiguation is
inherently per-provider (same HTTP 429 means different things across providers), which is
exactly why it can't be a generic switch in the endpoint.

**Alternatives considered**: A standalone `errorPatterns` table (rejected — splits provider
knowledge across two files, the precise anti-pattern the constitution names).

---

## R4 — BYOK/shared-key exhaustion classification requires a key-ownership flag

**Decision**: The same upstream "out of funds" response classifies to different user-facing
codes depending on *whose key* made the call: on a **BYOK** key →
`byok_insufficient_credits`; on the **shared server** key → `provider_overloaded` (D3) **plus**
an operator notification carrying the true cause. So `classify()` takes an `isByok` /
`onSharedKey` context flag (already known in the handler at ~592) alongside the error.

**Rationale**: The registry `classifyError` can only see the upstream shape; the
BYOK-vs-shared distinction is request context, not provider knowledge, so it belongs in the
orchestrator (`chat-errors.js`), which combines provider signal + request context → final
code + notification decision. This keeps the registry pure (provider shapes only) and the
notification-ownership rule (US5) in one place.

**Alternatives considered**: Deriving BYOK from the error (impossible — the error doesn't
know); an eighth `service_billing` code (rejected by D3 — the design fixes the taxonomy).

---

## R5 — `byok_misconfigured` must be rejected before the provider call

**Decision**: `resolveChatModel` (`server/api/chat-models.js` ~283–298) currently falls through
to the shared default when a BYOK model/key can't resolve — this is the silent, unmetered
fallback FR-019 bans. Change: when `isByok` is true and the BYOK branch fails to resolve,
`resolveChatModel` must signal that distinctly (e.g. return a discriminated
`{ error: 'byok_misconfigured' }` or throw a tagged error) rather than silently falling to the
shared key. The handler maps that to a pre-stream `byok_misconfigured` 400 and never issues a
request on the shared key. Non-BYOK shared-default resolution fallbacks (env → default) are
unchanged.

**Rationale**: The falsy-return today is indistinguishable from "no model configured at all"
(→ 500 at ~643). Separating the BYOK-misconfig case is the whole of US4 and is required for
SC-006 (zero shared-key requests, zero unmetered usage).

**Alternatives considered**: Detecting misconfig in the handler by re-inspecting
`byokSettings` (rejected — duplicates resolution logic and re-introduces the drift the single
resolver exists to prevent).

---

## R6 — Client: one map, structured code only, no body-sniffing

**Decision**: New `client/src/utils/chatErrorMessages.js` exports (a) `MESSAGES` — code→
`{ text, action }` map (D1 copy; `byok_insufficient_credits` interpolates the payload
`provider` via `PROVIDER_LABELS`, moved server-agnostic here); (b) `FATAL_CODES` set (all
except `internal`); (c) `RETRYABLE_CODES` set (`internal`, `provider_overloaded`); (d)
`parseChatError(errorOrPayload)` → `{ code, provider, text }`, falling back to `internal`
(showing the payload `error` text) for unknown/absent codes (FR-013). `AiChatContext`'s
`handleChatError` (~320) reads `code` from the parsed payload instead of
`msg.includes('usage limit')` / `msg.includes('401')`.

**Rationale**: FR-011/FR-013/SC-007. The map is imported by both `AiChatBody` (shared by
panel + page) so the two surfaces are identical by construction (SC-002). Provider naming
comes only from the payload (FR-008/FR-014), letting the `AiPanel` `errorByokRef` +
`PROVIDER_LABELS` client-inference hack (~38–46) be deleted.

**Alternatives considered**: Keeping message text in `AiChatBody` (rejected — two surfaces
would drift; the page currently renders no specific text at all).

---

## R7 — Recovery gating, derived usage-limit, interruption notice

**Decision**: (a) `handleChatError` consults `FATAL_CODES`: fatal → render banner
immediately, skip `recoverChat`; only `internal`/network enter the existing recovery path
(FR-015). (b) The `usageLimitReached` boolean latch (`AiChatContext` ~329, set true forever)
becomes derived: cleared on each send attempt and re-set only by a fresh `app_usage_limit`
rejection (FR-017) — implemented by clearing on send and setting from the parsed code. (c)
When `recoverChat` (~288–314) finds a persisted partial reply (`isAwaitingAssistant` false
branch, ~302–305) but the triggering error was a fatal code, instead of the unconditional
`instance.clearError()` it keeps a **session-scoped** "response interrupted: <reason>" notice
(D5) alongside the partial reply (FR-016).

**Rationale**: These three are the recovery-behavior requirements; each maps to an exact line
in the current `AiChatContext` recovery machinery. Session-scoped (not persisted) per D5 keeps
the chat-store schema unchanged — no migration.

**Alternatives considered**: Persisting the interruption marker into the transcript (rejected
by D5 — larger data-model change the design doesn't ask for).

---

## R8 — No schema migration

**Decision**: This feature introduces **no** database schema change. Taxonomy codes are
computed at request time; the interruption notice is session-only (D5/R7); metering tables are
untouched. Migration ordering (globally serialized across features) is **not** engaged.

**Rationale**: Verified against every touched surface — classification is pure request-time
logic, payload is transport-only, client state is in-memory. Flagged explicitly because the
plan brief requires prominence if a migration were needed: **none is.**
