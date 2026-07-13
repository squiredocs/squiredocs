/**
 * Two-way sync push engine (feature 004).
 *
 * Replays a pushed markdown file's edits onto a live Squire document as native
 * CRDT operations anchored at the export-time baseline clock — as if the repo
 * editor were a collaborator who forked at that clock, edited offline, and
 * reconnected. Y.Doc in / update out; the live doc is never consulted during
 * diff/replay (FR-004). See specs/004-two-way-sync/.
 *
 * ===========================================================================
 * T001 — VERIFIED CONSUMED SURFACES FROM FEATURES 001/002/003 (as SHIPPED)
 * ===========================================================================
 * Verified against the actual code on branch tip (merge 3c2ce51). Several
 * module locations differ from plan.md's assumptions; all surfaces EXIST and
 * are shaped compatibly, so implementation proceeds. Deviations noted with ►.
 *
 * 001 — GENERALIZED PARSER
 *   ► Location: `shared/markdown` (index.js), NOT `server/markdown-to-pm.js`.
 *   `require('../shared/markdown')` → { markdownToPm, parseInline }.
 *   `markdownToPm(md, diffMark=null, { strict=false })` — TOLERANT by default
 *   (never-lose-content net wraps the tolerant path). Output is PM-doc JSON.
 *
 * 002 — IMPORT ROUTE + MODULE + MATERIALIZER
 *   Route: `server/api/docs-import.js` — PUT /api/docs/:docId/import,
 *     modes append|replace (unknown mode → 400). Auth: `requireAuth` (session
 *     or sk_sqd_ token; enforces documents:write on non-GET for scoped
 *     principals) + `documents.hasRole(docId, userId, 'editor')`. Body capped
 *     MAX_IMPORT_BYTES (5 MB), content-type text/markdown|text/plain. Response
 *     is additive-extensible (CN-12) — 004 adds mode=sync + receipt fields.
 *   Module: `server/markdown-import.js` — exports importMarkdown, prepareImport,
 *     reconstructImages, sanitizeLinkMarks, rejectDataImages, hasRealContent.
 *   ► Materializer: `server/mcp/yjs/pm-json-to-nodes.js` → `pmJsonToNodes(pmJson,
 *     { XmlElement, XmlText })` → detached Y nodes. Import's canonical pipeline:
 *     markdownToPm → reconstructImages → sanitizeLinkMarks → rejectDataImages →
 *     pmJsonToNodes. Structural replacement reuses this (does NOT re-implement).
 *
 * 003 — EXPORT OPTIONS, FRONTMATTER, IMAGE MAP
 *   Serializer: `server/mcp/yjs/serialization.js` — `toMarkdown(frag,{flavor,
 *     lossy})` / `toMarkdownNodes(nodes,{flavor,lossy})`. flavor 'squire'
 *     (byte-identical to pre-feature) | 'portable' (degrades HTML-only marks;
 *     `lossy` Set is populated with names actually degraded). Also
 *     `buildFrontmatter(meta, foreignRaw)`.
 *   ► Frontmatter parser: `shared/markdown/frontmatter.js` (imported DIRECTLY,
 *     not via the parser index) → `parseFrontmatter(md)` = { body, squire,
 *     foreignRaw }. `squire` carries { docGuid, title, clock, flavor, lossy[],
 *     images{relPath:imageId}, ... } (advisory, bounded plain data). F5 guard:
 *     buildFrontmatter strips stale squire keys from foreignRaw.
 *   ► Registry: `shared/format-registry.js` (NOT server/). { INLINE_MARKS,
 *     STYLE_PROPS, attrsToCSS, ... }. Each INLINE_MARK: { name, yjsAttr, wrap? |
 *     htmlTag?, altWrap?, portable? }.
 *   Re-export (receipt): docs-export.js pattern — getExportMeta(pool,docId) →
 *     {clock,lastModifiedBy}; buildFrontmatter(...) + '\n' + toMarkdown(...).
 *
 * PERSISTENCE (`server/postgres-persistence.js`)
 *   getYDocAtClock(docGuid, clock) → Y.Doc (gc:true — fine, fork only creates
 *     NEW ops); getStateVectorsAtClocks(docGuid, [clocks]) → Map<clock,SV>;
 *     storeUpdate(docGuid, update, userId, agentName) → clock (T021 adds
 *     onBehalfOf arg); _getCurrentUpdateClock(client, docGuid) → max|−1 (private,
 *     needs a client — use a MAX(clock) query for current-clock reads);
 *     _queryUpdatesWithUsers / _mapUpdateRow for the timeline read path; pool via
 *     `persistence.pool` / `persistence.getPool()`.
 *
 * STORE-THEN-APPLY REFERENCE (`server/version-history.js` restoreVersion, ~581)
 *   temp doc → capture pre-SV → transact mutation → encodeStateAsUpdate(temp,SV)
 *   → persistence.storeUpdate(...) → Y.applyUpdate(sharedDoc, update,
 *   createOrigin(userId, agentName)). We mirror this; fork starts at BASELINE
 *   clock and pins a synthetic clientID. `cloneXmlElement` there is the identity-
 *   preserving clone; our materialization uses pmJsonToNodes.
 *
 * document-service: getSharedDoc(docGuid) (binds/loads the live shared doc),
 *   updateDocument. origin: createOrigin(userId, agentName).
 *
 * SERIALIZER REFACTOR (003 fixer, current state — build the source map on TOP):
 *   renderInline builds a per-op inlinePlan ({pairs,key}); portable merges
 *   adjacent ops with identical key. getChildText threads renderInline for
 *   headings/list-items/table-cells. renderListItem renders non-paragraph
 *   taskItem children through processNode. Blockquote uses a parts-splice
 *   capture; final assembly joins blocks with '\n\n' then
 *   `.replace(/\n{3,}/g,'\n\n').trim()`. Source map rides this structure;
 *   toMarkdown output stays byte-identical.
 * ===========================================================================
 */

// Fixed attribution identity for CI/repo-originated pushes (research R4). Version
// history renders "Repo Sync (<token owner>)" via createAuthor's agent path.
const SYNC_AGENT_NAME = 'Repo Sync';

module.exports = {
  SYNC_AGENT_NAME,
};
