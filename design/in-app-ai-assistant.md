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

## Client surfaces

A dockable panel (right or bottom) on every page, plus a full-page chat-centric mode (`/chat`) with history sidebar and a document side-pane the assistant is kept aware of. Add-selection-to-chat captures passages (with their enclosing heading and doc) as reference chips serialized into a `<referenced_passages>` block. Modify results render as inline color-coded diffs in the transcript.

## Onboarding

Not-yet-engaged users get an idempotently seeded personal “Welcome to Squire Docs” doc (attributed to the assistant) and land with the panel open; a hidden kickoff turn has the assistant read the doc, make exactly one personalized greeting edit, and offer to research a topic. Engagement (owning a real doc with content) stamps `onboarded_at` and ends the flow.