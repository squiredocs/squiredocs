# Squire Docs for agents

Squire Docs is a collaborative rich-text editor with real-time multi-user
editing, full version history, and provenance on every change. Documents are
live Yjs documents, and every edit — human or agent — is attributed to its
author and reversible through version history. Agents connect over the Model
Context Protocol (MCP) or the REST API, edit documents alongside human
collaborators (each shown as a named, colored cursor), and read or write
markdown that round-trips with the files in your repo.

## Connect

For Claude Code and other Claude CLI clients, run this **in a terminal, not
from inside a running agent session**:

```
claude mcp add --transport http squire https://squiredocs.com/mcp
```

**If you are an agent reading this from inside a running session:** do not run
the command above yourself. MCP clients load server config at startup, so your
session will not see the server — `/mcp` will still report nothing, and the
write may even land in a config file the client never reads. Instead, give
your user these exact steps:

1. In a separate terminal (outside this session), run:
   `claude mcp add --transport http squire https://squiredocs.com/mcp`
2. Verify it registered: `claude mcp list` should show `squire`.
3. Restart the session without losing this conversation: exit, then run
   `claude --continue` (or `claude --resume` to pick from past sessions).
4. In the restarted session, run `/mcp` — confirm `squire` is listed and
   complete the OAuth login it offers.

For any MCP-native client: point it at the endpoint URL below. The client's
built-in OAuth discovery follows the standard chain (RFC 9728
`WWW-Authenticate` → `/.well-known/oauth-protected-resource/mcp` → the
authorization-server metadata at `/.well-known/oauth-authorization-server`
→ dynamic client registration → authorization-code + PKCE consent). No
manually configured client IDs, secrets, or endpoint URLs are required
beyond the address above.

If the client can't complete browser OAuth (headless scripts, CI jobs, older
tools), use a personal access token from **Settings → AI Agent Access**
(prefix `sk_sqd_`, or legacy `sqd_`) and pass it as a bearer credential.

## MCP endpoint

```
https://squiredocs.com/mcp
```

- `POST /mcp` — main MCP message endpoint (JSON-RPC).
- `GET /mcp` — server information and discovery.

## Authentication

Two options:

- **OAuth 2.0** (PKCE flow) — the standard interactive path; the MCP client
  guides you through authorization. Endpoints are advertised under
  `https://squiredocs.com/mcp/auth/` (authorize, token, revoke, register).
- **API tokens** — personal access tokens prefixed `sk_sqd_` (legacy `sqd_`
  tokens remain valid), created from the Settings page. Pass as a bearer token:
  `Authorization: Bearer sk_sqd_...`. Tokens authenticate both MCP and the REST
  `/api` routes. Scopes are enforced: reads require `documents:read`, mutations
  require `documents:write`. An MCP-connected agent with no token can mint a
  temporary one itself with `create_access_token` (scoped at or below its own
  grant, expiring within 24 hours, revoked with the minting credential).

## Core tools

- `read_document` — read a document (optionally filtered by XPath).
- `modify` — apply an edit via a TypeScript script (the primary editing tool).
- `create_document` — create a document, optionally populated from markdown.
- `list_documents` — list documents you can access.
- `get_tool_documentation` — full API reference for the script-based tools.

Additional tools include `list_document_versions`, `read_document_version`,
`compare_document_versions`, `restore_document_version`,
`set_document_version_name`, `set_document_title`, `share_document`,
`get_collaborators`, `undo`, `redo`, and `create_access_token`.

`modify` and `compare_document_versions` take TypeScript scripts against a large
scripting API that does not fit in their tool descriptions. **Always call
`get_tool_documentation({ tool: "modify" })` before writing your first script.**

## REST endpoints

With an `sk_sqd_` bearer token you can move markdown over plain HTTP:

- `GET /api/docs/:docId/export?format=markdown` — export a document as markdown.
  Options: `flavor=squire|portable` (default `portable`), `frontmatter=true|false`
  (default off), `format=bundle` for a zip of markdown plus image assets with
  relative references (bundle also defaults to `portable`, with frontmatter on).
- `POST /api/docs/import` — create a new document from a `text/markdown` body
  (owner = the acting user).
- `PUT /api/docs/:docId/import?mode=append|replace` — import markdown into an
  existing document (default `append`; requires the editor role).

Import routes require `documents:write`, accept `text/markdown` / `text/plain`
bodies capped at 5 MB, and return an itemized image report. Example export:

```
curl -H "Authorization: Bearer sk_sqd_..." \
  "https://squiredocs.com/api/docs/<docId>/export?format=markdown" -o doc.md
```

## Start here

Once connected, call `get_tool_documentation` for the full scripting API,
built-in helpers, XPath targeting, examples, and common pitfalls before writing
your first `modify` script. For the REST export/import recipe specifically, call
`get_tool_documentation({ tool: "export_api" })`.
