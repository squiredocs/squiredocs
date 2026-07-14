<!-- source: https://squiredocs.com/d/697456a2-b42b-49b3-ae57-875d3e328809
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Agent Surface (MCP)

## What this is

How external AI agents read, edit, and manage documents: the MCP server and its sixteen tools, the sandboxed modify pipeline, the two credential systems (OAuth delegations and `sk_sqd_` API tokens), the REST export API, and the attribution model that makes agent edits first-class, provenance-tracked collaboration — Squire’s core differentiator.

## Transport and tools

An Express router at `/mcp` speaks JSON-RPC (streamable HTTP); `mcp-stdio-bridge.js` is a thin stdio proxy for CLI clients. Sixteen tools (`server/mcp/tools/`): document CRUD and sharing (list/create/share/set_title), reading (read_document, get_collaborators, get_tool_documentation), editing (modify, undo, redo), version history (list/read/name/restore/compare versions), and create_access_token. Each declares a required scope — `documents:read` or `documents:write` — enforced by the registry, with per-document access re-checked inside every tool. Long tool documentation is served via `get_tool_documentation` because MCP clients truncate descriptions around 2 KB.

## Agents are collaborators, not a backdoor

Tools that touch a document open a real y-websocket presence session on the user’s behalf (`server/mcp/agent-presence.js`): the agent appears as a live cursor named “AgentName (UserName)” with `isAgent: true`, its reads animate highlights, and its edits flow through the same update path as human edits — attributed per-update via `agent_name` and surfaced in version history’s recentAuthors. There is no privileged write path.

## The modify pipeline

- **Sandbox: **scripts run in an isolated-vm V8 isolate (128 MB, 5s default / 30s max timeout) inside a worker thread — two layers of heap isolation, no Node APIs (`server/mcp/sandbox/executor.js`). Helpers (xpath, appendBlocks, cloneBlocks, createFormattedText…) are injected globals.
- **Conflict guard: **the chat layer injects the agent’s last-observed clock; if a different author has advanced the doc since, modify reconstructs the baseline, replays the agent’s own updates, and only reports a conflict (editedBy, no edit applied) on real content divergence.
- **Cross-doc sources: **up to 10 read-only sourceDocGuids (8 MB total) exposed as a sources global; cloneBlocks copies content and the image reconciler re-hosts cross-doc images (or strips inaccessible ones) after the script runs.
- **Output: **a markdown line diff (capped) for the chat transcript, operation summary, the new clock, and server-side mermaid/SVG validation errors (diagrams only render client-side, so the server validates in a jsdom worker).

## Credentials

- **OAuth 2.0 for interactive agents: **authorization-code + PKCE with dynamic client registration; consent creates a delegation; access JWTs live 1 hour with 30-day rotating refresh tokens, signed by a dedicated MCP secret. Revoking a delegation cascades to everything it minted.
- **sk_sqd_ API tokens for shell/REST: **SHA-256-hashed at rest, max 25 active per user, scoped, expiring. `create_access_token` lets an agent mint a short-lived token (≤24 h, scopes capped at its own, no chaining, 5-per-minter cap) so bulk export never passes content through model context.

## Agent onboarding and discovery

The onboarding story: a user with a Squire account tells their agentic tool to read `https://squiredocs.com/agents.md`. The agent connects to `/mcp` and the standard OAuth discovery chain takes over — browser consent from the user’s logged-in account, no manual token copying in the happy path.

- **agents.md is the agent-facing front door: **served at `/agents.md` as a static asset. It must contain: the MCP endpoint, exact connect one-liners (e.g. `claude mcp add --transport http squire https://squiredocs.com/mcp`), the in-session connect caveat and OAuth walkthrough guidance (next bullets), both credential options, tool orientation (the `get_tool_documentation` imperative), and the REST export/import recipe. This doc owns agents.md’s contract — drift between agents.md and the implemented surface is a bug.
- **In-session connect caveat (Sam, 2026-07-14): **MCP clients load server config at startup only — a connect command run from an agent’s own shell inside a live session is invisible to that session (and may land in a config file the client never reads). Observed onboarding failure 2026-07-14: an agent ran the one-liner via its Bash tool, and the user’s `/mcp` showed no servers configured. agents.md must therefore instruct an agent already running inside a session to NOT run the connect command itself, and instead give its user these exact steps: (1) run `claude mcp add --transport http squire https://squiredocs.com/mcp` in a separate terminal; (2) verify with `claude mcp list`; (3) restart the session with the conversation preserved — exit, then `claude --continue` (or `claude --resume` to pick a session); (4) run `/mcp` to confirm the squire server is listed and complete the OAuth consent.
- **OAuth walkthrough guidance (Sam, 2026-07-14): **observed friction 2026-07-14: an agent printed the authorization URL inside a numbered-list item (it wrapped across terminal lines and was hard to copy) and mentioned the paste-back step only in passing, so the user didn’t know to return the callback URL. agents.md must instruct agents that when they hand a user a browser OAuth flow they must: (1) print the authorization URL bare on its own line — never inside list markup, quotes, or trailing punctuation — so one click or one selection copies it; (2) before the user opens it, say what happens after approval: the browser lands on a `localhost` callback page which may show a connection error when the agent runs on a remote machine or container, and that this is expected — the approval still succeeded; (3) state explicitly that the user should copy the FULL URL from the browser’s address bar (`http://localhost:…/callback?code=…`) and paste it back as their next message, and that nothing else is needed.
- **Discovery chain (standards, in order): **unauthenticated `POST /mcp` → 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"` → RFC 9728 protected-resource metadata → RFC 8414 authorization-server metadata → RFC 7591 dynamic client registration → authorization-code + PKCE (S256 only) → consent page → token. MCP-native clients complete this with zero manual configuration.
- **Consent login round-trip guarantee: **an unauthenticated user landing on the consent page completes Google login and returns to the consent page with all OAuth parameters intact. The `returnTo` path is constrained to same-origin relative paths (open-redirect defense), carried in a short-lived cookie through the Google redirect, and takes precedence over signup/onboarding redirects.
- **Decision — PKCE only, no device flow (Sam, 2026-07-13): **every target client either drives a localhost-redirect PKCE flow natively or can use an API token; RFC 8628 device flow would add a second consent surface and a polling endpoint for no covered client. Revisit only if a covered client appears that can do neither.
- **API-token fallback: **clients that can’t complete browser OAuth use an `sk_sqd_` token from Settings → AI Agent Access as a bearer header. Semantics unchanged from Credentials above.
- **Accepted gap: **the token endpoint accepts and ignores the RFC 8707 `resource` parameter (spec-permitted); revisit if a client is found to require it echoed.

## REST export API

`GET /api/docs/:docId/export?format=markdown` serializes the persisted doc (works with no client connected); view access suffices; browser sessions and API tokens both accepted. Incremental sync pairs it with list_documents’ `updatedSince` + per-doc `clock`. This is the surface design/sync.mjs rides on; the write half is designed in [Proposal: Markdown Import & Two-Way Repo Sync](https://squiredocs.com/d/b6edb804-cf72-416d-9c97-063a23e669c0).