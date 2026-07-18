# Contract — read_document absorbs read_document_version (DR-1, design c790282)

**Design authority**: `design/agent-surface-mcp.md`, Amendment (Sam, 2026-07-18) —
"surface-area reduction folded into 019". Supersedes spec FR-024's no-consolidation
clause and SC-001's "seventeen" for exactly this item. Ledgered as DR-1.

## read_document (advertised)

Input schema gains one optional property:

```json
"versionId": {
  "type": "string",
  "description": "Optional: read the document as of this version — a version UUID or a clock number as a string (e.g. \"42\"). Omit for current content."
}
```

Semantics with `versionId` (identical xpath/format semantics to today's
`read_document_version`):

- Access check via `documents.hasAccess`; **no presence session, no highlights**
  (historical reads must not move the live cursor).
- Result shape: `{ content, blockCount, characterCount, matchCount?, version }`
  where `version` is `{ id, name, clockStart, clockEnd, timestamp }` — i.e. the
  current read_document_version shape. Without `versionId`, behavior and result
  shape are byte-identical to today (url, clock, lastModified*, recentAuthors).
- Unknown version / no access: existing error wording unchanged.

Shared implementation: the historical-read core moves to
`server/mcp/tools/read-helpers.js`; both entry points call it.

## read_document_version (hidden deprecation alias)

- **Leaves `getToolList()`** — not advertised to any client.
- **Still accepted by `executeTool`**: `server/mcp/tools/index.js` keeps the
  module in a `HIDDEN_TOOL_ALIASES` map consulted by `getTool()`. Name, schema,
  handler behavior unchanged (thin delegate to the shared core).
- `TOOL_SCOPES.read_document_version` stays `documents:read`.
- Advertised tool count after 019: **sixteen** (import_markdown_file added,
  read_document_version hidden).

## get_tool_documentation scope drop (DR-1 item 3)

Remove `get_tool_documentation` from `TOOL_SCOPES` — no scope required (static
text; a write-only token must be able to read the docs it needs). Test: a
principal with scopes `['documents:write']` only can call it via `executeTool`.

## Chat-layer consequences (all test-covered)

| File | Change |
|---|---|
| `server/api/chat.js` | VERSION HISTORY workflow prompt: "read_document (with versionId) or compare_document_versions for details" |
| `server/api/chat-tools.js` | `XPATH_TOOLS` drops `read_document_version` (chat no longer exposes it; paging guidance keys off `read_document`) |
| `server/api/chat-staleness.js` | a `read_document` call **with `versionId` must NOT count as a snapshot** of current content (must not record/clear staleness) — guard `!input.versionId` at both snapshot-recording sites |
| `server/api/chat-dedup.js` | `read_document` dedup key includes `versionId` when present (per docGuid, versionId, xpath, format — today's read_document_version rule); a versioned read never supersedes a current read or vice versa |

## Out of scope (explicitly deferred/rejected by the amendment)

- Cutting `set_document_version_name`; chat/MCP exposure partitioning (deferred
  pending prod telemetry on `mcp.tool.execute` spans).
- Versions mega-tool; undo/redo merge (rejected).
