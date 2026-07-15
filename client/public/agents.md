# Squire Docs for agents

Squire Docs is a collaborative rich-text editor with real-time multi-user
editing, full version history, and provenance on every change. Documents are
live Yjs documents, and every edit — human or agent — is attributed to its
author and reversible through version history. Agents connect over the Model
Context Protocol (MCP) or the REST API, edit documents alongside human
collaborators (each shown as a named, colored cursor), and read or write
markdown that round-trips with the files in your repo.

## Choose your channel

There are three ways to connect, in order of how little they ask of you. Pick
the first one that fits — you do **not** need to work through them in order, and
you do not need all three.

1. **Log in over REST — a shell is all you need.** Have a shell?
   Nothing to install — the login flow is a plain-REST API you drive with
   `curl`. This is the recommended path for an agent with a terminal and no
   credential yet.
2. **Register the MCP server with a credential** you already hold, so a fresh
   client session starts fully authenticated.
3. **MCP-native OAuth discovery** — no credential yet and you would rather let
   your MCP client's built-in OAuth take over.

### 1. Log in over REST — a shell is all you need

The device-pairing login is a first-class REST API. With a shell you can
complete the whole pairing with `curl` and get a real credential —
**registering an MCP server is NOT a prerequisite**, and neither is a CLI
install or an OAuth step. Three endpoints, all anonymous (the handle you
receive is the only
credential they need, carried in `Authorization: Bearer`):

- `POST /api/login/start` — begin a pairing. Body `{"agentName":"<short name>"}`;
  returns a one-time user code, the `/activate` URL, a `handle`, and the poll
  interval.
- `GET /api/login/status` — poll it with `Authorization: Bearer <handle>` until
  it reports approved. Add `?inline=true` only if you have no shell to run the
  claim command (it returns the credential in-band once, warned).
- `GET /api/login/claim` — the canonical one-shot claim; writes the credential
  to a file.

1. Start the pairing (no credential required):

```
curl -fsS -X POST https://squiredocs.com/api/login/start \
  -H 'Content-Type: application/json' -d '{"agentName":"<short display name>"}'
```

2. Relay to your user: print the `/activate` URL **bare, on its own line**, and
   tell them to open it, sign in, and enter the code. They approve a skeptical
   consent page (your name is shown as self-declared and unverified).

3. Poll politely — about every 5 seconds, backing off on any `slow_down`:

```
curl -fsS -H "Authorization: Bearer sqlh_..." https://squiredocs.com/api/login/status
```

4. On approval you receive, once, a `claimCommand`: a `curl` recipe against
   `GET /api/login/claim` that writes the credential to a file with owner-only
   (`0600`) permissions. Run it within the claim window — the token never enters
   your context or the conversation.

5. **Never print, echo, or paste the credential** into the conversation. The
   handle is safe transcript residue; the credential is not.

Then use the credential — no MCP client required:

- **Work over REST immediately** — the token authenticates the REST endpoints
  below. List your documents, then export or import markdown; document
  collaboration needs no MCP client at all.
- **Or register the MCP server with the credential** (channel 2) so a restarted
  session loads fully authenticated.

The approved payload also carries a `nextSteps` block with these exact recipes
pre-filled for the file you wrote the credential to.

#### No MCP connection? Bootstrap with curl

The MCP endpoint is itself plain JSON-RPC over HTTP, and the two login tools are
anonymous-callable — so **an agent with a shell needs no MCP client
attachment**, no CLI install, and no OAuth to get a credential. Do not conclude
that registering the server is a prerequisite; it isn't. If you would rather
drive the MCP protocol directly than call the REST endpoints above, start the
same pairing with a `tools/call`:

```
curl -s -X POST https://squiredocs.com/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"login","arguments":{"agentName":"<short display name>"}}}'
```

Poll the same way with `login_status`, relaying the code and `/activate` URL to
your user exactly as above. Either surface drives the one login state machine.

### 2. Register the MCP server with a credential

If you already hold an `sk_sqd_` credential (from the login flow above or from
**Settings → AI Agent Access**), register the server with it so the client
session starts fully authenticated — no OAuth step. For credential-holders this
is the only recommended registration form; **always pass the credential with
`--header`** (adjust the file path to wherever you wrote it):

```
claude mcp add --transport http squire https://squiredocs.com/mcp \
  --header "Authorization: Bearer $(cat ~/.squire/credential)"
```

**If you are an agent reading this from inside a running session:** do not run
the command above yourself. MCP clients load server config at startup, so your
session will not see the server — `/mcp` will still report nothing, and the
write may even land in a config file the client never reads. Instead, give your
user these exact steps:

1. In a separate terminal (outside this session), run the `claude mcp add …
   --header …` command above.
2. Verify it registered: `claude mcp list` should show `squire`.
3. Restart the session without losing this conversation: exit, then run
   `claude --continue` (or `claude --resume` to pick from past sessions).
4. In the restarted session, run `/mcp` — confirm `squire` is listed.

### 3. MCP-native OAuth discovery

No credential yet, and you would rather let your MCP client's native OAuth take
over? For Claude Code and other Claude CLI clients, run this **in a terminal, not
from inside a running agent session** — the bare (uncredentialed) form, because
here your client's OAuth discovery supplies the credential:

```
claude mcp add --transport http squire https://squiredocs.com/mcp
```

For any MCP-native client, point it at the endpoint URL below. The client's
built-in OAuth discovery follows the standard chain (RFC 9728
`WWW-Authenticate` → `/.well-known/oauth-protected-resource/mcp` → the
authorization-server metadata at `/.well-known/oauth-authorization-server`
→ dynamic client registration → authorization-code + PKCE consent). No
manually configured client IDs, secrets, or endpoint URLs are required
beyond the address above.

After registering with the bare form, restart the session with the conversation
preserved (`claude --continue`), run `/mcp`, and complete the OAuth login it
offers.

#### Walking your user through browser OAuth

When you hand your user an authorization link — whether your MCP client printed
it or you are driving the flow yourself — present it like this:

- Print the authorization URL **bare, on its own line** — never inside a
  numbered list, quotes, or trailing punctuation. Long URLs wrap in terminals,
  and list markup breaks one-click copying.
- Before they open it, say what happens after they approve: the browser lands on
  a `http://localhost:.../callback` page. If you are running on a remote machine
  or in a container, that page will show a connection error — tell them up front
  this is expected and the approval still succeeded.
- Say exactly what to send back: copy the **full URL from the browser's
  address bar** (`http://localhost:.../callback?code=...`) and
  paste it as their next message. Nothing else is needed.

## Already inside a session? Log in with the `login` tool

**This is the recommended path when you are an agent already running inside a
session with no Squire credential yet.** If your MCP client has the Squire server
attached, it already completed the protocol handshake, so even unauthenticated
you can see and call exactly two tools — `login` and `login_status` — which
bootstrap a real credential without you ever running the `claude mcp add`
command yourself. No Squire server attached to your session at all? You can still
do this over plain REST (channel 1 above).

1. Call `login({ agentName })` with a short display name for yourself. It returns
   a one-time user code, a verification URL (`/activate`), and a `handle`.
2. Relay to your user: print the `/activate` URL **bare, on its own line**, and
   tell them to open it, sign in, and enter the code.
3. Poll `login_status({ handle })` politely — about every 5 seconds, and back off
   whenever it returns `slow_down` — until it reports approved.
4. On approval you receive a one-time claim recipe: a `curl` command against
   `GET /api/login/claim` that writes the credential to a file with owner-only
   (`0600`) permissions. Run it within the claim window. If you have no shell,
   poll `login_status({ handle, inline: true })` once to receive the credential
   in-band instead (opt-in, warned).
5. **Never print, echo, or paste the credential** into the conversation. The
   handle is safe transcript residue; the credential is not. Write the token into
   your MCP client config or an env file, then have your user reconnect the
   client (the restart-with-context steps above) so it loads the credential —
   there is no mid-session toolset upgrade.

Manage or revoke this access anytime in **Settings → AI Agent Access**.

## MCP endpoint

```
https://squiredocs.com/mcp
```

- `POST /mcp` — main MCP message endpoint (JSON-RPC).
- `GET /mcp` — server information and discovery (also names the REST login door).

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
`get_collaborators`, `undo`, `redo`, and `create_access_token`. Two more —
`login` and `login_status` — bootstrap a credential from inside a session (see
"Already inside a session?" above) and are the only tools an unauthenticated
session can call. Eighteen tools in all; an authenticated session sees them all,
an anonymous one sees only the two login tools.

`modify` and `compare_document_versions` take TypeScript scripts against a large
scripting API that does not fit in their tool descriptions. **Always call
`get_tool_documentation({ tool: "modify" })` before writing your first script.**

## REST endpoints

With an `sk_sqd_` bearer token you can list, export, and import documents over
plain HTTP — no MCP client at all. **The channel rule:** markdown that already
exists as bytes outside the model (a file on disk, another tool's output) should
travel this byte channel — never retyped through MCP tool parameters; model
context should only carry content you are creating or transforming.

- `GET /api/docs` — list the documents you can access. This is the "list docs"
  recipe the login `nextSteps` block teaches; run it as-is with your credential:

```
curl -fsS -H "Authorization: Bearer sk_sqd_..." "https://squiredocs.com/api/docs"
```

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
document's `squire:` frontmatter (docGuid, clock): write it back over your source
file and the file is immediately a valid `mode=sync` baseline. Example export:

```
curl -H "Authorization: Bearer sk_sqd_..." \
  "https://squiredocs.com/api/docs/<docId>/export?format=markdown" -o doc.md
```

## Start here

Once connected, call `get_tool_documentation` for the full scripting API,
built-in helpers, XPath targeting, examples, and common pitfalls before writing
your first `modify` script. For the REST recipe (list, export, import, and
two-way sync) specifically, call `get_tool_documentation({ tool: "rest_api" })`.
