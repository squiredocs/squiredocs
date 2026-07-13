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

## REST export API

`GET /api/docs/:docId/export?format=markdown` serializes the persisted doc (works with no client connected); view access suffices; browser sessions and API tokens both accepted. Incremental sync pairs it with list_documents’ `updatedSince` + per-doc `clock`. This is the surface design/sync.mjs rides on; the write half is designed in [Proposal: Markdown Import & Two-Way Repo Sync](https://squiredocs.com/d/b6edb804-cf72-416d-9c97-063a23e669c0).