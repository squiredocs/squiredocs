# Contract — `import_markdown_file` MCP tool (US1)

**Module**: `server/mcp/tools/import-markdown-file.js` · **Registry scope**:
`documents:write` (`server/mcp/tools/index.js` TOOL_SCOPES) · **Advertised**: yes
(tool list count after 019: sixteen).

## Input schema (design-pinned; nothing more may be added)

```json
{
  "type": "object",
  "properties": {
    "docGuid": { "type": "string", "format": "uuid" },
    "intent": { "type": "string", "enum": ["create", "update", "sync"] }
  },
  "required": []
}
```

**MUST NOT** accept document content, file contents, or a file path (FR-002).

## Description contract

- First line contains the word **"sync"** and names the task (syncing/importing an
  existing markdown file) — FR-006, SC-001.
- ≤ 2,048 UTF-8 bytes (shared registry byte test).

## Intent resolution (RBD-1 / FR-004)

| Input | Resolved | REST call in the command |
|---|---|---|
| `{}` | create | `POST /api/docs/import?frontmatter=true` |
| `{ docGuid }` | sync | `PUT /api/docs/:docGuid/import?mode=sync&frontmatter=true` |
| `{ intent: "create" }` | create | `POST /api/docs/import?frontmatter=true` |
| `{ docGuid, intent: "update" }` | update | `PUT /api/docs/:docGuid/import?mode=replace&frontmatter=true` |
| `{ docGuid, intent: "sync" }` | sync | `PUT /api/docs/:docGuid/import?mode=sync&frontmatter=true` |
| `{ intent: "update" \| "sync" }` (no docGuid) | — | instructive parameter error |
| `{ docGuid, intent: "create" }` | — | instructive parameter error (contradictory) |

Invalid `intent` values are rejected by the registry's enum validation.

## Result shape

`{ command, intent, docGuid?, claimExpiresInSeconds, message, guidance }` — see
data-model.md. The `command` is ONE compound shell block (research R2):

1. `FILE=path/to/your.md` placeholder — the only agent edit (RBD-2).
2. One-shot claim → `~/.squire/token` (existing convention), failure branch names
   already-claimed/expired (5 min) and says to call the tool again.
3. curl import of `--data-binary @"$FILE"` for the resolved route with
   `frontmatter=true`.
4. Receipt write-back over `$FILE` via
   `GET /api/docs/$DOC/export?format=markdown&frontmatter=true` (create intent
   extracts `$DOC` with escape-safe UUID grep from the JSON response).

## Security invariants (FR-005 / SC-003 / SC-009 — test-asserted)

- Result payload (all fields, all intents) contains **no** document content and
  **no** `sk_sqd_` token; the only secret is the `one_time_use_` claim secret,
  appearing exactly once, inside `command`.
- Mint path is `prepareClaimDelivery()` extracted from `create_access_token`
  (research R1): same no-chaining guard, same delegation-liveness re-check, same
  `createPendingMint` record, scopes `["documents:read","documents:write"]`
  (RBD-6), default token TTL, 300 s claim window. Claim endpoint unchanged.
- Read-only principal (`documents:read` only): refused at the tool boundary with
  the standard insufficient-scope error naming `documents:write` (FR-001) — a
  recipe that cannot work is never issued.
- Tokens minted by `create_access_token` cannot invoke a successful mint here
  either (no-chaining applies at this second call site).
- The tool performs no document existence/access probe (FR-008): unknown or
  inaccessible `docGuid` still yields a recipe; the REST call fails later with the
  channel's existing 403 semantics.

## Errors

| Condition | Behavior |
|---|---|
| missing `documents:write` | registry scope error (standard wording) |
| `update`/`sync` without docGuid | `Invalid parameters …: intent '<i>' targets an existing document — pass docGuid, or omit intent to create a new one` (instructive; exact wording implementation-chosen, must name docGuid) |
| `create` with docGuid | instructive parameter error naming the contradiction |
| minted-token caller (chained) | no-chaining error (same as create_access_token) |
| revoked delegation | mint-refused error (same as create_access_token) |
