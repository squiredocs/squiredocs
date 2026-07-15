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
claude mcp add --transport http squire https://squiredocs.com/mcp && claude mcp login squire
```

**If you are an agent reading this from inside a running session:** do not run
the command above yourself. MCP clients load server config at startup, so your
session will not see the server — `/mcp` will still report nothing, and the
write may even land in a config file the client never reads. Instead, tell
your user to exit this session and run this single command:

```
claude mcp add --transport http squire https://squiredocs.com/mcp && claude mcp login squire && claude --continue
```

It registers the server, completes the browser OAuth login right from the
terminal, and resumes this conversation (`claude --resume` picks from past
sessions instead). If anything doesn't take, the steps also work one at a
time: after the add, `claude mcp list` should show `squire`; if the login
didn't complete, run `/mcp` inside the restarted session to finish it there.

For any MCP-native client: point it at the endpoint URL below. The client's
built-in OAuth discovery follows the standard chain (RFC 9728
`WWW-Authenticate` → `/.well-known/oauth-protected-resource/mcp` → the
authorization-server metadata at `/.well-known/oauth-authorization-server`
→ dynamic client registration → authorization-code + PKCE consent). No
manually configured client IDs, secrets, or endpoint URLs are required
beyond the address above.

If the client can't complete browser OAuth (headless scripts, CI jobs, older
tools), use a personal access token from **Settings → AI Agent Access**
(prefix `sk_sqd_`, or legacy `sqd_`) and pass it as a bearer credential —
saved to a file, never pasted into the conversation (see
[Handling API tokens](#handling-api-tokens-never-through-the-conversation)).

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
  `Authorization: Bearer $(cat ~/.squire/token)` (see
  [Handling API tokens](#handling-api-tokens-never-through-the-conversation)
  below). Tokens authenticate both MCP and the REST
  `/api` routes. Scopes are enforced: reads require `documents:read`, mutations
  require `documents:write`. An MCP-connected agent with no token can mint a
  temporary one itself with `create_access_token` (scoped at or below its own
  grant, expiring within 24 hours, revoked with the minting credential).

### Handling API tokens (never through the conversation)

A token is a secret. It should move from Settings to disk to the
`Authorization` header without ever appearing in the chat transcript, in your
output, or in your shell history.

- **Ask your user not to paste the token into the conversation.** Have them
  save it to a file themselves and just tell you when it's in place:

  ```
  mkdir -p ~/.squire && umask 077 && cat > ~/.squire/token
  # paste the token, press Enter, then Ctrl-D
  ```

- **Reference the file, never the raw value.** Use
  `-H "Authorization: Bearer $(cat ~/.squire/token)"` in HTTP calls, or set
  `export SQUIRE_TOKEN="$(cat ~/.squire/token)"` once per shell. Never print,
  echo, or log a token, and never retype one into a command line — argv is
  visible in shell history and process lists.
- **Tokens you mint yourself:** `create_access_token` returns no token. It
  returns a one-shot `claimCommand` — run it as-is; it fetches the token over
  HTTPS and writes it straight to `~/.squire/token`, so the secret never
  appears in the conversation at all. The claim dies after the first use or
  5 minutes. Only if you cannot run shell commands, pass `inline: true` and
  treat the in-band token by the rules above (write it out with a heredoc if
  a shell ever becomes available; never echo it).
- **If a token does land in the conversation**, save it to the file, stop
  repeating it, and remind your user they can revoke and re-issue it under
  **Settings → AI Agent Access** at any time.

### Walking your user through browser OAuth

When you hand your user an authorization link — whether your MCP client
printed it or you are driving the flow yourself — present it like this:

- Print the authorization URL **bare, on its own line** — never inside a
  numbered list, quotes, or trailing punctuation. Long URLs wrap in
  terminals, and list markup breaks one-click copying.
- Before they open it, say what happens after they approve: the browser
  lands on a `http://localhost:.../callback` page. If you are running on a
  remote machine or in a container, that page will show a connection error —
  tell them up front this is expected and the approval still succeeded.
- Say exactly what to send back: copy the **full URL from the browser's
  address bar** (`http://localhost:.../callback?code=...`) and paste it as
  their next message. Nothing else is needed.

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

With an `sk_sqd_` bearer token you can move markdown over plain HTTP. **The
channel rule:** markdown that already exists as bytes outside the model (a file
on disk, another tool's output) should travel this byte channel — never retyped
through MCP tool parameters; model context should only carry content you are
creating or transforming.

- `GET /api/docs/:docId/export?format=markdown` — export a document as markdown.
  Options: `flavor=squire|portable` (default `portable`), `frontmatter=true|false`
  (default off), `format=bundle` for a zip of markdown plus image assets with
  relative references (bundle also defaults to `portable`, with frontmatter on).
- `POST /api/docs/import` — create a new document from a `text/markdown` body
  (owner = the acting user).
- `PUT /api/docs/:docId/import?mode=append|replace|sync` — import markdown into
  an existing document (default `append`; requires the editor role). `mode=sync`
  replays a frontmattered repo file's edits as CRDT operations anchored at its
  export-time baseline.

Import routes require `documents:write`, accept `text/markdown` / `text/plain`
bodies capped at 5 MB, and return an itemized image report plus a `markdown`
receipt — the canonical re-export of the resulting document, for exact
verification. Pass `frontmatter=true` to get the receipt stamped with the
document's `squire:` frontmatter (docGuid, clock): write it back over your
source file and the file is immediately a valid `mode=sync` baseline. Example
export:

```
curl -H "Authorization: Bearer $(cat ~/.squire/token)" \
  "https://squiredocs.com/api/docs/<docId>/export?format=markdown" -o doc.md
```

## Start here

Once connected, call `get_tool_documentation` for the full scripting API,
built-in helpers, XPath targeting, examples, and common pitfalls before writing
your first `modify` script. For the REST recipe (export, import, and two-way
sync) specifically, call `get_tool_documentation({ tool: "rest_api" })`.
