# Contract: Export API Query Options

**Route**: `GET /api/docs/:docId/export` (existing route in `server/api/docs-export.js`, extended).
**Auth**: unchanged — `requireAuth` (session or `sk_sqd_` token with `documents:read` scope) +
document view access via `documents.getRole` (403 otherwise).

## Query parameters

| Param | Values | Default (`format=markdown`) | Default (`format=bundle`) | Notes |
|-------|--------|------------------------------|---------------------------|-------|
| `format` | `markdown`, `md`, `bundle` | `markdown` | — | any other value → 400 (`Unsupported export format: X`) |
| `flavor` | `squire`, `portable` | `squire` (RD-1) | `portable` (RD-3) | any other value → 400 |
| `frontmatter` | `true`/`1` (on), `false`/`0` (off) | off | on (RD-3) | any other value → 400 |

Both bundle defaults are overridable (`format=bundle&flavor=squire&frontmatter=false` is legal).

## Responses

| Case | Response |
|------|----------|
| `format=markdown`/`md` | `200`, `text/markdown; charset=utf-8`, `Content-Disposition` attachment `<sanitized>.md` (existing behavior); body = serialized markdown, prefixed by frontmatter when enabled |
| `format=bundle` | `200`, `application/zip`, attachment `<sanitized>.zip`; see [bundle-zip-layout.md](./bundle-zip-layout.md) |
| unknown `format`/`flavor`/`frontmatter` value | `400` JSON `{ error }` naming the bad parameter and accepted values |
| no access | `403` JSON (unchanged) |
| server failure | `500` JSON (unchanged, exception-notified) |

## Backward compatibility (FR-022 / SC-003)

A request with no new parameters (`GET …/export`, `GET …/export?format=markdown`, `format=md`)
returns **byte-identical output** to the pre-feature system, with one deliberate exception class:
documents containing task lists or hard breaks — previously exported lossily (checklists as plain
bullets via the editor's degraded schema; hard breaks dropped) — now export their true content
(`- [ ]` markers, trailing-backslash breaks) in every flavor. This is the bug-fix half of the
feature (FR-004/FR-007); documents using neither construct are byte-identical. Flavor `squire`
remains the default; flipping defaults is deferred to a future v2 route (RD-1, out of scope).

## Serializer options (internal contract, consumed by MCP/read paths too)

`toMarkdown(fragment, { flavor = 'squire', lossy = null })` — backward-compatible optional argument;
existing call sites (MCP `read_document`, diff service, chat tools, sync script) pass nothing and
get squire flavor. `lossy` (a `Set`) is populated with names of marks actually degraded; surfaces
that emit frontmatter read it after serialization.
