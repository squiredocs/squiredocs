# Contract — MCP `list_documents` (`updatedAfter`)

**Entry point**: `server/mcp/tools/list-documents.js`. MCP surface stays **exactly 16
tools**; only this tool's `inputSchema` and `description` change (FR-019). No response
shape changes on either path.

## Input schema delta

New property (added to `inputSchema.properties`):

```js
updatedAfter: {
  type: 'string',
  description:
    'ISO-8601 timestamp. Search path only (requires "search"): admit only documents whose ' +
    'last-updated time (the updatedAt field on results, also bumped by opening a doc) is ' +
    'STRICTLY AFTER this instant — filtered inside each search engine before ranking, so ' +
    'rankings and totals reflect only recent documents. Distinct from updatedSince, which ' +
    'is list-path only and filters on last content edit. Not combinable with updatedSince.',
},
```

`description` (the tool prose) documents `updatedAfter` in the PARAMETERS block alongside
`updatedSince`, stating the contrast explicitly:

- `updatedAfter` — **search path only**; basis `updatedAt` (last-updated, visible on every
  search result); strictly-after; filter-then-search.
- `updatedSince` — **list path only** (unchanged); basis last content edit (update log);
  not bumped by opening a document.

## Handler behavior

| Condition | Behavior |
|-----------|----------|
| `updatedAfter` + `search` (non-empty) | Pass `updatedAfter` through to `search.searchDocuments`; all other search options unchanged. |
| `updatedAfter` without `search` | **Tool error** (thrown): `updatedAfter requires a content search: provide "search". To filter the list path by last content edit, use updatedSince.` (CN-3 — mirrors the existing `updatedSince`-with-`search` error precedent.) |
| `updatedAfter` unparseable | **Tool error**: `updatedAfter must be a valid ISO-8601 timestamp` |
| `updatedAfter` + `updatedSince` together | Always an error: with `search` the existing `updatedSince is not supported together with search` error fires; without `search` the misplaced-`updatedAfter` error fires. Never both applied, never silently ignored. |
| Neither new param | Byte-identical behavior to today on both paths (FR-022). |

## Response (unchanged shape)

Search path: `{ documents: [{ id, title, url, role, updatedAt, snippet, score }],
pagination: { total, limit, offset, hasMore } }` — `total` counts only the filtered set;
every `updatedAt` is strictly after the cutoff; results remain a subset of the caller's
accessible documents (FR-016/020).
