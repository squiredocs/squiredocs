# Data Model: Markdown Import Surfaces

No new persisted entities and **no database schema change** (research.md R7). All entities below are either in-memory contracts (request/result shapes) or reuses of existing storage (`document_images` rows, S3 objects, Yjs update log). Field contracts here are the source for `contracts/` artifacts.

## 1. ImportRequest (in-memory, per call)

The untrusted unit of work. One is formed per surface invocation and handed to the import module.

| Field | Type | Source | Validation |
| --- | --- | --- | --- |
| `markdown` | string | request body / tool arg / sandbox arg | ≤ 5 MB (rejected pre-parse, 413); non-empty after trim on all surfaces except `fromMarkdown` (400 / validation error); CRLF + BOM normalized before frontmatter detection |
| `mode` | `'append' \| 'replace' \| 'insertAfterXPath'` | query param / module option | REST: only `append`/`replace`, default `append`; unknown → 400. Module: all three; `insertAfterXPath` requires `xpath` |
| `xpath` | string (only with `insertAfterXPath`) | module option | no match → error **without mutation** |
| `target` | docGuid \| `'create'` | route param / tool semantics | PUT: doc must exist, principal must hold editor role; POST/create: new doc owned by acting user |
| `principal` | ActingPrincipal (below) | auth middleware / agentToken | required on every surface; no anonymous path |
| `title` (create only) | string? | tool arg / query param | precedence: explicit → frontmatter `squire: title` → first heading text → `Untitled` (FR-008) |

## 2. ActingPrincipal

Existing concept, reused. Session user (`req.user` via `requireAuth` — no scopes array, passes scope checks by design), `sk_sqd_` token principal (scopes array; `documents:write` enforced on non-GET by `checkScopes`), or agent delegation (`agentToken` with `userId` + `agentName`). Attribution: every import transaction carries `{ userId, agentName? }` origin via `documentService.updateDocument` — one attributed version-history entry per import (FR-004).

## 3. FrontmatterBlock (transient)

| Field | Type | Notes |
| --- | --- | --- |
| `raw` | string | the full leading `---\n…\n---` block, if syntactically present at document start |
| `squire` | object? | recognized keys consumed; **this feature reads only `title`**; unknown `squire:` fields ignored silently (contract owned by feature 003) |
| `residue` | string? | non-`squire:` keys re-serialized; materialized as a leading fenced `yaml` code block in the body (CN-5); absent when only `squire:` keys existed |
| `malformed` | boolean | YAML didn't parse → whole block treated as ordinary markdown content; import never fails on frontmatter (FR-006/007) |

## 4. ImportResult / ImportReport (response contract — the shape feature 004 extends)

Computed in-memory; returned to the caller; never persisted. **Additive-extensible JSON object** (CN-12): 004 will add fields (canonical re-export, overlap flags) — nothing here may assume a closed shape.

**PUT response** (200):

| Field | Type | Notes |
| --- | --- | --- |
| `docId` | string | target document guid |
| `mode` | `'append' \| 'replace'` | mode actually applied |
| `clock` | number | document clock after the import transaction |
| `blocks` | `{ imported: number }` | summary of top-level blocks materialized (extensible object, not a bare number) |
| `images` | ImageReport | below |

**POST response** (201): `docId`, `title`, `url` (`/d/:docId`), `clock`, `images` (ImageReport). Owner = acting user.

**MCP `create_document` return** (extends the current `{ docGuid, title, url, message }`): adds `blocks` and `images` when `markdown` was supplied.

**Error shapes** follow the export route's model: 401 (no/invalid auth), 403 (no access / not editor / `INSUFFICIENT_SCOPE` shape from `checkScopes`), 400 (empty body, unknown mode, effectively-empty after frontmatter), 413 (over size cap), 415 (content type not `text/markdown`/`text/plain`).

## 5. ImageReport (member of ImportResult)

Itemized outcome for every image reference the import encountered. Image failures never fail the import (FR-018).

| Field | Type | Notes |
| --- | --- | --- |
| `rehosted` | `Array<{ src, url }>` | external URL fetched once, stored, node src rewritten to app URL; deduplicated (N references → 1 entry, 1 stored copy) |
| `copied` | `Array<{ from, to }>` | cross-document app URLs copied via existing reconciliation (FR-020) |
| `degraded` | `Array<{ src, reason }>` | external image degraded to a plain link (fetch failure, SSRF block, size, type, redirect cap, budget exhausted, storage disabled); reason is a stable enum-ish string |
| `rejected` | `Array<{ src?, reason }>` | `data:` srcs (never fetched/stored; node degrades to alt text, dropped when alt empty — CN-6) and stripped inaccessible cross-doc refs |

Degradation node form: plain link, text = alt text if present else the URL, href = original URL (FR-018).

## 6. RehostedImage (persisted — existing tables only)

Reuses `document_images` rows + S3 objects, created via `documentImages.storeImage`:

| Attribute | Value |
| --- | --- |
| `id` / `s3Key` | new UUID; `doc-images/<targetDocId>/<id>` (existing scheme) |
| `doc_id` | target document (owns the copy) |
| `uploader_id` | acting user (attribution — FR-016) |
| `mime_type` / `byte_size` | from the validated fetch; must pass existing allowlist (png/jpeg/gif/webp) and 15 MB cap |
| Node reference | image node `src` = app URL `/api/docs/:docId/images/:imageId`; N markdown references to the same URL share one row/object |

## 7. FetchBudget (transient, per import)

| Bound | Default | Behavior at bound |
| --- | --- | --- |
| unique external URLs fetched | 20 | further externals degrade to links, reason `budget-exhausted` |
| redirects per fetch | 3 | degrade, reason `too-many-redirects` |
| per-fetch wall clock | 10 s | degrade, reason `timeout` |
| bytes per image | 15 MB (existing cap) | abort mid-stream, degrade, reason `too-large` |
| address policy | non-global IPs blocked per hop | degrade, reason `blocked-address`; **no connection ever made** to a blocked address (SC-004) |

## State transitions

**Import (append)**: parse → frontmatter strip → materialize nodes → insert at fragment end → rehost pass → single transaction commit → report. Pure insertion: concurrent edits merge cleanly (SC-006).

**Import (replace)**: same, but the transaction deletes existing top-level blocks and inserts the new ones **in one transaction** against the same fragment (no fragment recreation; one undo step; attribution intact). Documented Principle IV exception — see plan.md Complexity Tracking.

**Import (insertAfterXPath)**: locate target first; on no-match, abort before any mutation. Otherwise identical to append at the located index.

**Image node lifecycle on import**: `external http(s)` → fetched+rehosted (app URL) | degraded (plain link). `data:` → rejected (alt text / dropped). `app URL, same doc` → untouched. `app URL, other doc` → copied or stripped per existing access-checked reconciliation.
