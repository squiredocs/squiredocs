<!-- source: https://squiredocs.com/d/75b5055d-f4f8-4b3c-8955-f6c3f7841fc7
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire In-App AI Assistant

## What this is

The built-in chat assistant: a first-party MCP agent wired into every page. Covers the streaming chat engine, the multi-provider model layer, BYOK, credit metering, the chat-only tools, and onboarding. The assistant reuses the agent surface — it holds a synthetic agent identity (`in-app-chat` / “Squire Docs Assistant”) so its edits are attributed exactly like any external agent’s.

## Chat engine

- `POST /api/chat` (`server/api/chat.js`) streams via AI SDK v6 `streamText` with the MCP registry wrapped as SDK tools (`server/api/chat-tools.js` — which prefers full chatDescriptions over truncated MCP ones and injects the conflict-guard baseline clock). Up to 100 agentic steps; tool use is cut off near the cap.
- **Resumable streams: **chunks are buffered per chat so a reconnecting client replays and tails the live stream (`GET /api/chat/:id/stream`); the client context keeps one persistent Chat per id so streaming continues in the background across navigation.
- **Context compaction: **on a token-limit error, older messages are summarized with a small model and the turn retries — reactive, not proactive.
- **Chat-only tools: **`insert_image` (chat attachment → S3 → doc), `view_image` and `view_svg_blocks` (vision over doc images and rasterized SVG), plus a universal webFetch and provider web search.

## Models, providers, BYOK

All provider knowledge lives in `server/api/ai-providers.js` (constitutionally: new models go here, nowhere else): anthropic, google, openai, z.ai, openrouter — each declaring key storage, client factory, validation, web-search strategy, and caching behavior. Anthropic gets ephemeral prompt caching with a moving breakpoint; GLM reasoning echoes and Anthropic tool-adjacency quirks are normalized in history hygiene. The shared assistant runs on server keys (Anthropic/Google only); BYOK users unlock the rest — keys are validated against the provider before being stored encrypted, and never returned. Model resolution: active BYOK choice → admin-set shared default (`app_settings`) → env → built-in default.

## Credits and metering

Non-BYOK usage is metered to `ai_usage_log` with cache-aware token pricing; quota = monthly `ai_credit_cents` plus admin-granted extra credits (debited oldest-first). Credits are reserved up front and reconciled after the turn (TOCTOU guard); hitting the limit 429s and notifies the admin. BYOK requests skip metering entirely.

## Error surfacing

Every chat failure is classified **once, server-side, next to the provider call**, into a small typed taxonomy, and travels to the client as a structured code — never as raw provider text or a generic 500. The client renders messages from codes; it never substring-matches error bodies. Two transport channels, one shape: failures before any content stream back as HTTP JSON `{ error, code, provider? }` with an honest status (402/429/4xx, not 500); failures mid-stream ride the SSE error event with the same structured payload.

**Taxonomy: **`app_usage_limit` (in-app monthly credits exhausted, pre-flight quota check), `byok_insufficient_credits` (the user’s own provider account is out of funds — Anthropic 400 "credit balance is too low", OpenAI 429 insufficient_quota, Google 429 only when the body shows billing/quota exhaustion — quotaFailure, free-tier, billing details; a bare RESOURCE_EXHAUSTED is ordinary per-minute rate limiting and classifies as overloaded, otherwise routine Gemini throttles on the shared key would page the operator as out-of-funds), `byok_invalid_key` (provider 401/403 on a user key), `provider_overloaded` (429/529/503 on any key), `rate_limited` (our per-user request limiter), `byok_misconfigured` (BYOK enabled but the key/model cannot be resolved), and `internal` (everything else). Token-limit errors stay out of the taxonomy — they are handled by compaction-and-retry, invisibly.

- **Fatal codes end the turn honestly.** Billing, key, and rate-limit codes go straight to a specific banner with the action that actually fixes it (top up in the provider console, check Settings, wait). Only `internal`/network errors may enter the reconnect-recovery path — no fake "Reconnecting…" for an empty wallet.
- **A user’s billing problem is not a server fault.** BYOK billing/key errors never page the operator via the exception notifier; `app_usage_limit` keeps its per-user-per-month admin email. Exhaustion of the **shared server key** is an operator incident: classified for the user like any provider billing error, but it does notify.
- **Usage-limit state is derived, not latched.** The client clears the limit banner on the next send attempt (it re-trips immediately if still true); topping up, enabling BYOK, or a month rollover must not require a page reload.
- **BYOK misconfiguration fails loudly.** If BYOK is active but the key or model cannot be resolved, the request is rejected with `byok_misconfigured` — it never silently falls back to the shared server key (which would bill the operator, unmetered).
- **Mid-stream fatal errors are never swallowed.** When stream recovery finds a persisted partial reply but the triggering error was a fatal code, the transcript keeps a "response interrupted" notice with the reason instead of clearing the error — a truncated answer must be visibly truncated.
- **One rendering source.** The side panel and the full-page chat render identical messages from the same code→message map; provider names come from the structured payload, not client-side inference of what mode was active when the error happened.

## Client surfaces

A dockable panel (right or bottom) on every page, plus a full-page chat-centric mode (`/chat`) with history sidebar and a document side-pane the assistant is kept aware of. Add-selection-to-chat captures passages (with their enclosing heading and doc) as reference chips serialized into a `<referenced_passages>` block. Modify results render as inline color-coded diffs in the transcript.

## Onboarding

Not-yet-engaged users get an idempotently seeded personal “Welcome to Squire Docs” doc (attributed to the assistant) and land with the panel open; a hidden kickoff turn has the assistant read the doc, make exactly one personalized greeting edit, and offer to research a topic. Engagement (owning a real doc with content) stamps `onboarded_at` and ends the flow.

**Amendment (Sam, 2026-07-18) — undo/redo results carry diffs (feature 020): **the undo and redo tools (and the chat Undo/Redo button path — one shared handler since 016) return the same diff payload modify emits: the server computes the line diff (hunk starts, formatting annotations, truncation) from the pre/post states of the INVERSE application, persists it on the tool part, and the transcript renders it with the same DiffView on undo/redo tool cards that modify cards use today. This is deliberately computed from what actually happened, not the mirror of the original edit’s diff — after supersession rules, an undo may revert less than the original edit inserted, and the diff shows that honest post-supersession reality. Raised by Sam during 016 live testing (the "Undoing in README ✓" card was a bare label beside modify’s rich diff).

**Amendment (Sam, 2026-07-19) — word-level two-tier diff highlighting (feature 022): **the transcript diff (modify and undo/redo cards alike) highlights what changed within a line, not just whole lines. The server pairs adjacent -/+ lines in the diff post-processing pass and attaches word-level segments (`diffWordsWithSpace` via a shared helper — the same segmentation the version-history diff uses), and the chat DiffView renders changed words as a stronger highlight layered over the existing line tint (two-tier, GitHub-style). The payload field is additive (`inlineSegments`); persisted tool parts from before the feature render exactly as before. Unpaired wholly-added/removed lines carry no word emphasis — the row tint already says it all.