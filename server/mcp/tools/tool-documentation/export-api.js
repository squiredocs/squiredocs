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
`;

module.exports = { EXPORT_API_DOCUMENTATION };
