# Contract: REST Import Routes

Router: `server/api/docs-import.js` → `createImportRouter(persistence)`, mounted in `server/index.js` immediately beside `createExportRouter` (FR-011). Auth middleware: existing `requireAuth` (`server/auth/middleware.js`) — accepts browser sessions and `sk_sqd_`/agent tokens, and already enforces `documents:write` for scoped principals on non-GET methods (research R6).

## PUT `/api/docs/:docId/import`

Import markdown into an existing document.

### Request

| Aspect | Contract |
| --- | --- |
| Body | raw markdown text; `Content-Type: text/markdown` or `text/plain` (UTF-8). Anything else → **415**. |
| Size | > 5 MB → **413** (enforced by the body parser limit, before parsing — CN-1). |
| Query `mode` | `append` (default) \| `replace`. Anything else → **400** (CN-3). |
| Auth | `Authorization` header (session JWT or `sk_sqd_` token). Missing/invalid → **401**. |
| Scope | scoped principals need `documents:write` → else **403** `{ code: "INSUFFICIENT_SCOPE", required, granted }` (shape from `checkScopes`). |
| Role | acting user must be **editor or owner** on `:docId` (`documents.hasRole(docId, userId, 'editor')`). Viewer / no access / nonexistent doc → **403** `{ error }` (same posture as export: no existence oracle). |
| Empty | empty/whitespace-only body, or zero blocks after frontmatter stripping → **400**, document unchanged (CN-11). |

### Response — 200

```json
{
  "docId": "…",
  "mode": "append",
  "clock": 1483,
  "blocks": { "imported": 12 },
  "images": {
    "rehosted": [{ "src": "https://example.com/d.png", "url": "/api/docs/…/images/…" }],
    "copied":   [{ "from": "/api/docs/other/images/…", "to": "/api/docs/…/images/…" }],
    "degraded": [{ "src": "https://10.0.0.1/x.png", "reason": "blocked-address" }],
    "rejected": [{ "src": "data:image/png;base64,…", "reason": "data-url" }]
  }
}
```

**Additive-extensible** (CN-12/FR-014): feature 004 will add fields (e.g. canonical re-export, overlap flags, accepted clock param). Consumers must ignore unknown fields; this feature must not return a non-object body or repurpose these field names.

### Semantics

- `append`: pure insertion after existing content; prior content + attribution untouched; concurrent live edits merge cleanly (SC-006).
- `replace`: body becomes exactly the parsed blocks; single transaction, one undo step, attributed; concurrent edits merge per CRDT semantics (documented Principle IV exception — plan.md Complexity Tracking).
- `insertAfterXPath` is **not** a REST mode (FR-015).
- 500 on unexpected failure, `{ error }` JSON, exception notified — mirroring the export route.

## POST `/api/docs/import`

Create a new document from markdown.

### Request

| Aspect | Contract |
| --- | --- |
| Body / size / content type | identical to PUT (415 / 413 / 400-empty rules). |
| Query `title` | optional explicit title. Precedence: `title` param → frontmatter `squire: title` → first heading text → `Untitled` (FR-008/012). |
| Auth / scope | as PUT (401 / 403-scope). No role check — the document doesn't exist yet; the acting user becomes owner (via `createSeededDocument`). |

### Response — 201

```json
{
  "docId": "…",
  "title": "Payments Redesign",
  "url": "/d/…",
  "clock": 1,
  "images": { "rehosted": [], "copied": [], "degraded": [], "rejected": [] }
}
```

## Error matrix (both routes)

| Condition | Status | Body |
| --- | --- | --- |
| No/invalid token | 401 | `{ error }` |
| Scoped token lacks `documents:write` | 403 | `{ error, code: "INSUFFICIENT_SCOPE", required, granted }` |
| PUT: viewer / no access / unknown doc | 403 | `{ error: "You do not have access to this document" }` (export parity) |
| Unsupported content type | 415 | `{ error }` |
| Body over 5 MB | 413 | `{ error }` |
| Unknown `mode` / empty or effectively-empty body | 400 | `{ error }` |
| Unexpected | 500 | `{ error }` + `notifyException` |

Image failures are **never** an error status — they degrade and are reported in `images` (FR-018).

## Documentation duty (FR-024)

- `get_tool_documentation({ tool: "export_api" })` (`server/mcp/tools/tool-documentation/export-api.js`) gains an IMPORT section beside export: both routes, modes, content types, curl examples, scope note (`documents:write`), and the image-report semantics.
- `README.md` REST API section updated in the same effort.

## Amendment (2026-07-14, design proposal §1.2.1)

The additive-extension hook above was exercised twice: feature 004 added `mode=sync` (its own contract), and the agent-feedback amendment added a **verification receipt** to both routes — the 200/201 bodies now also carry `markdown` (canonical re-export of the post-import state at the returned clock; `blocks` was also added to the 201). New query params on both routes: `flavor=portable|squire` (receipt dialect, default portable) and `frontmatter=true|1|false|0` (default off; stamps the receipt with the `squire:` block so it can be written back as a valid `mode=sync` baseline — "born syncable"). Unknown values → 400 naming accepted values, before any import work. Decision trail: clarifications-needed.md #13; ground truth: design/markdown-import-two-way-sync.md §1.2.1.
