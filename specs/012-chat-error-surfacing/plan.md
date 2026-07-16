# Implementation Plan: Chat Error Surfacing Overhaul

**Branch**: `012-chat-error-surfacing` (identifier only — solo trunk workflow; work happens on `main`) | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-chat-error-surfacing/spec.md`

**Design ground truth**: `design/in-app-ai-assistant.md`, "Error surfacing" (constitution Principle VI — the doc wins). Open decisions ratified-by-default in [clarifications-needed.md](./clarifications-needed.md) (D1–D7).

## Summary

Classify every `POST /api/chat` failure exactly once, server-side, next to the provider call, into a seven-member typed taxonomy (`app_usage_limit`, `byok_insufficient_credits`, `byok_invalid_key`, `provider_overloaded`, `rate_limited`, `byok_misconfigured`, `internal`). Deliver the classification as one structured payload shape `{ error, code, provider? }` over both transport channels — HTTP JSON (honest status per D2) for pre-stream failures, the SSE `error` event for mid-stream failures — never raw provider text, never a generic 500 for a classified non-internal failure. The client renders from a single shared code→message map used identically by the side panel and the full-page chat; it never substring-matches error bodies. Fatal codes bypass reconnect-recovery; usage-limit state is derived (not latched); BYOK misconfiguration is rejected loudly instead of silently billing the operator on the shared key; operator paging matches fault ownership (BYOK billing/key never pages; shared-key exhaustion does).

**Technical approach**: One new server module owns the taxonomy, the status map, and payload construction; per-provider *detection* knowledge (which upstream response means which code) lives in the provider registry (`ai-providers.js`) per the constitution. The chat endpoint calls the classifier at its two existing failure funnels (pre-flight/pre-stream in the outer `catch`, and mid-stream via the AI SDK `onError` seam that feeds `toUIMessageStream`). One new client utility owns the code→message map plus fatality/retry-eligibility; `AiChatContext` parses the structured `code` and drives recovery/latch/interruption behavior from it. No schema migration.

## Technical Context

**Language/Version**: Node.js 22+ (server), React 18 (client)

**Primary Dependencies**: Express, AI SDK v6 (`streamText` / `toUIMessageStream` / `DefaultChatTransport`), `rate-limiter-flexible`; existing in-house SSE plumbing (`pipeAsSSE`, `sseEvent`, `writeSSEHead`, `pushChunk`) in `server/api/chat.js`

**Storage**: PostgreSQL (no schema change this feature); chat transcript via `chatStore`; `ai_usage_log` metering unchanged

**Testing**: Backend Vitest/Jest under `server/__tests__/` and `server/api/__tests__/` (serial-only shared DB per constitution II); frontend Vitest under `client/src/**/__tests__/`

**Target Platform**: Linux server + browser SPA

**Project Type**: Web application (Express backend + React frontend)

**Performance Goals**: No new latency on the hot path — classification runs only on the failure path; the success stream is untouched

**Constraints**: One deploy ships server+client together (D6) → no payload versioning; mid-stream error events stay out of the reconnection replay buffer (FR-010); token-limit compaction path must remain unintercepted (FR-004); app-auth 401 refresh-retry keyed on status not body (D7/FR-005)

**Scale/Scope**: Two chat surfaces (side panel + `/chat`), five providers in the registry, seven taxonomy codes. Touch ~3 server files + ~1 new server module; ~4 client files + ~1 new client util. Est. 25–35 tasks.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

- **I. Documentation Reflects Reality** — No README/dev.md behavioral surface changes for the user-facing docs here (this override forbids editing them anyway); design doc is already the ground truth and matches the spec. The design doc's "Error surfacing" section is the authoritative description and is already accurate to the target state. **PASS** (no doc drift introduced; the plan converges code *to* the doc).
- **II. Test-Backed Changes** — Every behavioral change lands with tests: backend suites for classification/status/notification, frontend suites for the shared map, latch removal, recovery gating, interruption notice. Backend runs serial. No format/serialization (round-trip suite) surface touched. **PASS**.
- **III. Trunk-Based Solo Workflow** — Stay on `main`; no branch, no PR ceremony. **PASS**.
- **IV. Collaboration-Safe Document Operations** — No document mutation, no CRDT/targeting/format-registry surface. Provenance untouched. **PASS** (not applicable).
- **V. Secure by Default** — Payload deliberately strips raw provider internals from the `error` string (FR-009); no new ingestion surface, no sandbox/SVG/image-URL/token change. Removing the silent BYOK→shared-key fallback (FR-019) *closes* an unmetered-cost hole. **PASS** (net security improvement).
- **VI. Design Docs Are Ground Truth** — Plan is a converge-to-design effort; all gaps recorded as RATIFIED-BY-DEFAULT (D1–D7), none resolved silently. The taxonomy, transport shapes, and status intent all trace to the "Error surfacing" section; D3 explicitly declines to add an eighth code because the doc fixes the taxonomy. **PASS**.

**Constitutional single-source rule (Tech constraints)**: per-provider error-detection knowledge MUST live in `ai-providers.js` (mirrors "new providers/models go there, not inline") — FR-003. The plan honors this: the chat endpoint holds zero provider-specific string matches.

Post-Phase-1 re-check: no new violations; Complexity Tracking empty.

## Project Structure

### Documentation (this feature)

```text
specs/012-chat-error-surfacing/
├── spec.md                  # Feature spec (input)
├── clarifications-needed.md # D1–D7 ratified-by-default ledger
├── plan.md                  # This file
├── research.md              # Phase 0 — decisions & rationale
├── data-model.md            # Phase 1 — taxonomy, payload, status map, fatality
├── quickstart.md            # Phase 1 — per-class validation guide
├── contracts/
│   ├── error-payload.md     # The { error, code, provider? } shape + status map + SSE event
│   └── client-error-map.md  # code→message map + fatality/retry contract
├── checklists/
│   └── requirements.md      # Spec quality checklist (passed)
└── tasks.md                 # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
server/
├── api/
│   ├── chat.js              # MODIFY — call classifier at the two failure funnels;
│   │                        #   pre-stream JSON with honest status; mid-stream SSE
│   │                        #   error event carries structured payload; remove the
│   │                        #   status>=400 passthrough's generic body; wire notifier
│   │                        #   ownership; reject byok_misconfigured pre-provider-call
│   ├── ai-providers.js      # MODIFY — add per-provider classifyError(err) to each
│   │                        #   PROVIDERS entry (billing / auth / overload detection);
│   │                        #   export a registry-level classify helper
│   ├── chat-models.js       # MODIFY — resolveChatModel must signal BYOK-unresolvable
│   │                        #   distinctly (no silent shared-key fallback when isByok)
│   └── chat-errors.js       # NEW — the single taxonomy: codes, status map (D2),
│                            #   fatality set, payload builder, classify(err, ctx)
│                            #   orchestrator that consults the provider registry
├── rate-limit.js            # MODIFY (minimal) — chat 429 path carries rate_limited
│                            #   code/payload (reject429 stays uniform for non-chat)
├── email.js                 # UNCHANGED behavior — notifyCreditLimitReached preserved
└── exception-notifier.js    # UNCHANGED API — called only for internal + shared-key
                             #   exhaustion; never for byok_* (caller-side gating)

client/src/
├── utils/
│   └── chatErrorMessages.js # NEW — code→message map (D1 copy), fatality set,
│                            #   retry-eligible set, parseChatError(payload/Error)
├── contexts/
│   └── AiChatContext.jsx    # MODIFY — parse structured code (no body-sniffing);
│                            #   derive usageLimit (drop the latch); gate recovery on
│                            #   fatality; session-scoped interruption notice; app-401
│                            #   refresh keyed on status
├── components/
│   ├── AiChatBody.jsx       # MODIFY — render message from the shared map; show
│   │                        #   interruption notice; retry only when code allows
│   └── AiPanel.jsx          # MODIFY — remove errorByokRef/PROVIDER_LABELS inference;
│                            #   feed code + provider from payload
└── pages/
    └── ChatPage.jsx         # MODIFY — pass the classified errorMessage (today it
                             #   passes none)

server/__tests__/ , server/api/__tests__/   # NEW/EXTEND — classification, status,
client/src/**/__tests__/                     #   notification, map, latch, recovery
```

**Structure Decision**: Existing web-app layout. Two new single-purpose modules (`server/api/chat-errors.js`, `client/src/utils/chatErrorMessages.js`) hold the two single sources of truth the design mandates (one server-side classification point, one client-side rendering point). Per-provider detection stays in the registry (`ai-providers.js`) — the chat endpoint imports the classifier and holds no provider string matches.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
