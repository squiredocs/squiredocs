/**
 * Documentation for the REST export API (not an MCP tool).
 *
 * Served via get_tool_documentation({ tool: "export_api" }) so agents can
 * discover how to move document content over plain HTTP — by reference, with
 * an API token — instead of piping it through model context via read_document.
 */

const EXPORT_API_DOCUMENTATION = `Export documents as Markdown over HTTP (REST), without content passing through model context.

═══════════════════════════════════════════════════════════════════════════
WHEN TO USE THIS
═══════════════════════════════════════════════════════════════════════════

Use the REST export API when you need document content as files — bulk
exports, repo snapshots, backups, feeding other tools. The content moves
directly over HTTP to wherever you point it (a file, a pipe), so it never
enters your context window. Use read_document instead when you need to look
at the content yourself.

Requires: a shell with curl (or any HTTP client) and an API token (prefixed
sk_sqd_; older sqd_ tokens are still accepted).

═══════════════════════════════════════════════════════════════════════════
GETTING A TOKEN
═══════════════════════════════════════════════════════════════════════════

Two ways:

1. Mint one yourself (no user action needed): call the create_access_token
   MCP tool. It issues a temporary sk_sqd_ token capped at your own scopes
   (default documents:read — all the export API needs) that expires
   automatically (default 1 hour, max 24). The token is returned once, with
   a ready-to-use curl example; it is revoked automatically if your own
   credential is revoked, and it cannot mint further tokens.

2. A user creates a personal access token under Settings → API Tokens and
   provides it to you (typically via an environment variable). These tokens
   do not expire and are shown only once at creation.

Scopes: exporting needs documents:read. GET requests require documents:read;
mutating requests (POST/PUT/PATCH/DELETE) require documents:write. New tokens
get both scopes by default. A request with an insufficient scope fails with
403 {"code": "INSUFFICIENT_SCOPE"}.

═══════════════════════════════════════════════════════════════════════════
EXPORT ONE DOCUMENT
═══════════════════════════════════════════════════════════════════════════

GET /api/docs/:docId/export?format=markdown

curl -sf -H "Authorization: Bearer $SQUIRE_TOKEN" \\
  "https://squiredocs.com/api/docs/<docId>/export?format=markdown" -o doc.md

The docId is the document GUID — the same id used by MCP tools and visible
in document URLs (https://squiredocs.com/d/<docId>). The response is the
document serialized to Markdown (same serializer as read_document's markdown
format), as a text/markdown attachment. View access is sufficient.

═══════════════════════════════════════════════════════════════════════════
QUERY OPTIONS
═══════════════════════════════════════════════════════════════════════════

format=markdown | md | bundle     (default markdown)
flavor=portable | squire          (default portable on all formats; pass squire for full fidelity)
frontmatter=true|1 | false|0      (default off; bundle defaults on)

Unknown values are rejected with 400 naming the accepted values. The route
now defaults to flavor=portable (repo-friendly) on every format; pass
flavor=squire for the full-fidelity dialect (the internal canonical form).

flavor=portable degrades HTML-only inline marks so the file renders cleanly
on GitHub: underline → _emphasis_, highlight → **bold**, styled spans
(color/font/size) → plain text. Content is never lost, only styling; the
set of marks actually degraded is reported in the frontmatter lossy list.
Marks with native markdown forms, diagram fences, tables, task lists
(- [ ] / - [x]) and hard breaks are identical in both flavors.

frontmatter=true prepends a single YAML block whose squire: key carries
docGuid, title, clock (version counter at export), exportedAt (UTC),
lastModifiedBy, flavor, plus lossy (only when marks degraded) and images
(bundle exports only). Sync tooling can identify the source document and
version snapshot from the file alone.

format=bundle streams a zip: the markdown file plus every resolvable
document image under assets/<docSlug>/<imageId>.<ext>, with in-document
image references rewritten to those relative paths — the file renders with
images anywhere (GitHub, local editors). The frontmatter images map records
relative path → image id for later re-import. Unresolvable images keep
their app URL and are skipped (the export still succeeds). Defaults to
flavor=portable and frontmatter=true; both overridable.

curl -sf -H "Authorization: Bearer $SQUIRE_TOKEN" \\
  "https://squiredocs.com/api/docs/<docId>/export?format=bundle" -o doc.zip

═══════════════════════════════════════════════════════════════════════════
EXPORT MANY DOCUMENTS
═══════════════════════════════════════════════════════════════════════════

Loop over guids (from list_documents, or a checked-in manifest):

for guid in $(cat guids.txt); do
  curl -sf -H "Authorization: Bearer $SQUIRE_TOKEN" \\
    "https://squiredocs.com/api/docs/$guid/export?format=markdown" \\
    -o "export/$guid.md"
done

═══════════════════════════════════════════════════════════════════════════
INCREMENTAL SYNC
═══════════════════════════════════════════════════════════════════════════

list_documents returns clock (the document's update counter) and
lastModifiedAt (timestamp of the last content edit) per document, and accepts
updatedSince (ISO-8601) to return only documents edited after that time.
Record clock or a timestamp with each exported snapshot, then re-export only
what changed:

const changed = await list_documents({ updatedSince: "2026-07-01T00:00:00Z" });
// export only changed.documents[].id via curl as above

lastModifiedAt reflects actual content edits (the Yjs update log), unlike
updatedAt, which is also bumped when a document is merely opened.

═══════════════════════════════════════════════════════════════════════════
IMPORT MARKDOWN (the inverse of export)
═══════════════════════════════════════════════════════════════════════════

Two routes push markdown INTO Squire, over the same auth model as export.
Both require documents:write (GET needs read; mutating methods need write) and
take a raw markdown body — Content-Type text/markdown or text/plain (UTF-8);
any other type → 415. Bodies over 5 MB → 413 (rejected before parsing). An
empty/whitespace-only body (or one that is only frontmatter, for PUT) → 400.

CREATE a new document from markdown:

  POST /api/docs/import[?title=<title>]

  curl -sf -X POST -H "Authorization: Bearer $SQUIRE_TOKEN" \\
    -H "Content-Type: text/markdown" --data-binary @doc.md \\
    "https://squiredocs.com/api/docs/import"

  Title precedence: ?title= → frontmatter 'squire: title' → the first heading
  → "Untitled" (a title-donor heading stays in the body). The acting user
  owns the new document. 201 → { docId, title, url, clock, images }.

IMPORT into an existing document:

  PUT /api/docs/:docId/import?mode=append|replace   (default append)

  curl -sf -X PUT -H "Authorization: Bearer $SQUIRE_TOKEN" \\
    -H "Content-Type: text/markdown" --data-binary @section.md \\
    "https://squiredocs.com/api/docs/<docId>/import?mode=append"

  append inserts after existing content; replace makes the body exactly the
  imported blocks (one undo step, attributed). Requires the editor role on the
  document (owner qualifies); viewer / no access / unknown doc → 403 (same
  posture as export: no existence oracle). Unknown mode → 400. 200 →
  { docId, mode, clock, blocks, images } — additive-extensible.

TWO-WAY SYNC (push repo edits back — mode=sync):

  PUT /api/docs/:docId/import?mode=sync[&baselineClock=<int>]

  Pushes an edited repo file back to Squire. Its edits replay as native CRDT
  operations anchored at the file's export-time baseline, exactly as if the
  repo editor were a collaborator who went offline at that clock, edited, and
  reconnected — so concurrent live edits merge deterministically (no conflict
  states, no retry, no clobber). Unlike replace, sync preserves the CRDT
  identity, marks, undo history, and attribution of every untouched block.

  1. Pull with frontmatter (the baseline):
       curl ... "…/export?format=markdown&frontmatter=true" > doc.md
     The 'squire: clock' frontmatter is the baseline. Edit doc.md, then:
  2. Push:
       curl -sf -X PUT -H "Authorization: Bearer $SQUIRE_TOKEN" \\
         -H "Content-Type: text/markdown" --data-binary @doc.md \\
         "https://squiredocs.com/api/docs/<docId>/import?mode=sync"

  Baseline: taken from 'squire: clock' (or the baselineClock param, which
  overrides). The frontmatter 'squire: docGuid', if present, must equal the
  target. Provenance: the version entry is authored by the token identity
  ("Repo Sync (<user>)"); optional on-behalf-of metadata may be supplied via
  headers X-Squire-On-Behalf-Of-{Name,Email,Commit,Url} (each ≤256 chars,
  surfaced in version history strictly as plain text).

  200 receipt (content-changing):
    { docId, mode:"sync", noop:false, clock,
      markdown,      // canonical re-export of the post-push doc + refreshed
                     // frontmatter — ALWAYS rewrite your local file from this;
                     // it is the next valid baseline
      overlaps:[ { blockIndex, blockType, excerpt, docSide, pushSide } ],
                     // advisory: blocks changed on BOTH sides since baseline —
                     // never block/alter the push; review in version history
      operations:{ textHunks, structuralHunks } }

  200 no-op: a byte-identical / formatting-only / lossy-degradation-only push
  stores nothing, creates no version entry, and returns { noop:true, clock:
  <current>, markdown:<current re-export> } — so pull→push loops never
  generate phantom edits.

  Rejections (leave the document untouched, no version entry):
    400 sync_baseline_missing     no squire.clock and no baselineClock param
    400 sync_baseline_invalid     malformed / negative / beyond current clock (+ currentClock)
    410 sync_baseline_unavailable a clock the server can no longer reconstruct
    409 sync_doc_mismatch         frontmatter docGuid ≠ the target (identity, NOT an edit conflict)
  The server never falls back to whole-document replacement — mode=replace
  remains the explicit opt-in for clobber writes.

IMAGE REPORT (both routes, the "images" field):
  {
    "rehosted": [{ "src": "<external URL>", "url": "<app image URL>" }],
    "copied":   [{ "from": "<other-doc app URL>", "to": "<app URL>" }],
    "degraded": [{ "src": "<external URL>", "reason": "<why>" }],
    "rejected": [{ "src": "data:…", "reason": "data-url" }]
  }
  External http(s) images are fetched server-side (SSRF-safe) and rehosted
  into the document; failures (blocked address, too large, wrong type, budget,
  storage disabled) degrade to a plain link and are itemized — an image
  problem never fails the import. data: images are dropped to their alt text.
  After import the stored document contains zero external and zero data: srcs.
`;

module.exports = { EXPORT_API_DOCUMENTATION };
