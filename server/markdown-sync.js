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

const crypto = require('crypto');
const Y = require('yjs');
const {
  toMarkdownNodes,
  toMarkdownWithSourceMap,
} = require('./mcp/yjs/serialization');
const { markdownToPm } = require('../shared/markdown');
const { pmJsonToNodes } = require('./mcp/yjs/pm-json-to-nodes');
const { reconstructImages, sanitizeLinkMarks } = require('./markdown-import');

// Fixed attribution identity for CI/repo-originated pushes (research R4). Version
// history renders "Repo Sync (<token owner>)" via createAuthor's agent path.
const SYNC_AGENT_NAME = 'Repo Sync';

// ===========================================================================
// T004 — Offset resolver (research R2): markdown offset ↔ Y.XmlText offset
// ===========================================================================

/** Binary search: index of the run containing `offset` (mdStart ≤ o < mdEnd), or -1. */
function findRun(runs, offset) {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid];
    if (offset < r.mdStart) hi = mid - 1;
    else if (offset >= r.mdEnd) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Array index of the block whose extent [mdStart,mdEnd) contains `offset`, or -1. */
function findBlock(blocks, offset) {
  for (let i = 0; i < blocks.length; i++) {
    if (offset >= blocks[i].mdStart && offset < blocks[i].mdEnd) return i;
  }
  return -1;
}

/** Array index of the block whose extent fully contains `run`, or -1. */
function blockOfRun(blocks, run) {
  for (let i = 0; i < blocks.length; i++) {
    if (run.mdStart >= blocks[i].mdStart && run.mdEnd <= blocks[i].mdEnd) return i;
  }
  return -1;
}

/**
 * Resolve a single markdown offset. Inside a run → text (node + offset); else
 * syntax (with the enclosing block, or null in an inter-block separator).
 */
function resolveMd(sourceMap, offset) {
  const ri = findRun(sourceMap.runs, offset);
  if (ri !== -1) {
    const r = sourceMap.runs[ri];
    return { kind: 'text', textNode: r.textNode, textOff: r.textOff + (offset - r.mdStart) };
  }
  const bi = findBlock(sourceMap.blocks, offset);
  return { kind: 'syntax', block: bi === -1 ? null : sourceMap.blocks[bi] };
}

/**
 * Classify a markdown range [start,end) (research R2, FR-007 text-hunk test).
 *
 * Returns one of:
 *   { kind: 'text', block, segments: [{ textNode, textOff, length, mdStart, mdEnd }] }
 *       — every char in the range lies in runs of a SINGLE block (segments are
 *         the per-run slices to delete/format; for an insertion point start===end
 *         a single zero-length segment marks where to insert).
 *   { kind: 'structural', blocks: [blockObj...] } — touches syntax, crosses
 *         blocks, or lands in an inter-block separator.
 */
function classifyRange(sourceMap, start, end) {
  const { runs, blocks } = sourceMap;

  if (start === end) {
    // Insertion point. Inside a run → split there. At a run boundary → prefer
    // the LEFT run (append to the preceding styled span; typing semantics).
    const inside = findRun(runs, start);
    if (inside !== -1) {
      const r = runs[inside];
      const bi = blockOfRun(blocks, r);
      return {
        kind: 'text',
        block: blocks[bi],
        segments: [{ textNode: r.textNode, textOff: r.textOff + (start - r.mdStart), length: 0, mdStart: start, mdEnd: start }],
      };
    }
    let left = -1;
    for (let i = 0; i < runs.length; i++) if (runs[i].mdEnd === start) left = i;
    if (left !== -1) {
      const r = runs[left];
      const bi = blockOfRun(blocks, r);
      return {
        kind: 'text',
        block: blocks[bi],
        segments: [{ textNode: r.textNode, textOff: r.textOff + (r.mdEnd - r.mdStart), length: 0, mdStart: start, mdEnd: start }],
      };
    }
    let right = -1;
    for (let i = 0; i < runs.length; i++) if (runs[i].mdStart === start) { right = i; break; }
    if (right !== -1) {
      const r = runs[right];
      const bi = blockOfRun(blocks, r);
      return {
        kind: 'text',
        block: blocks[bi],
        segments: [{ textNode: r.textNode, textOff: r.textOff, length: 0, mdStart: start, mdEnd: start }],
      };
    }
    // Insertion inside syntax or between blocks → structural.
    const bi = findBlock(blocks, start);
    return { kind: 'structural', blocks: bi === -1 ? [] : [blocks[bi]] };
  }

  // Proper range: every char must lie in a run, all runs in one block.
  const segments = [];
  let cursor = start;
  let blockIdx = null;
  let ok = true;
  while (cursor < end) {
    const ri = findRun(runs, cursor);
    if (ri === -1) { ok = false; break; }
    const r = runs[ri];
    const bi = blockOfRun(blocks, r);
    if (blockIdx === null) blockIdx = bi;
    else if (blockIdx !== bi) { ok = false; break; }
    const segEnd = Math.min(end, r.mdEnd);
    segments.push({
      textNode: r.textNode,
      textOff: r.textOff + (cursor - r.mdStart),
      length: segEnd - cursor,
      mdStart: cursor,
      mdEnd: segEnd,
    });
    cursor = segEnd;
  }
  if (ok && cursor === end && blockIdx !== null) {
    return { kind: 'text', block: blocks[blockIdx], segments };
  }
  // Structural: collect every block the range overlaps.
  const touched = [];
  for (let i = 0; i < blocks.length; i++) {
    if (start < blocks[i].mdEnd && end > blocks[i].mdStart) touched.push(blocks[i]);
  }
  return { kind: 'structural', blocks: touched };
}

// ===========================================================================
// T005 — Baseline reconstruction, canonicalization, synthetic clientID
// ===========================================================================

/** SHA-256 hex of a string (UTF-8). */
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Deterministic 31-bit synthetic Yjs clientID for a push (research R4). Same
 * (doc, baseline clock, canonical content) → same id, so a retried push replays
 * identical ops under the same identity and CRDT application dedupes it. A
 * different push from the same baseline gets a different id (a distinct offline
 * editor). Bit 31 cleared to stay in uint32 space; never 0.
 */
function syntheticClientId(docGuid, baselineClock, contentSha256) {
  const h = crypto
    .createHash('sha256')
    .update(`squire-sync ${docGuid} ${baselineClock} ${contentSha256}`, 'utf8')
    .digest();
  const id = h.readUInt32BE(0) & 0x7fffffff;
  return id === 0 ? 1 : id;
}

/**
 * Reconstruct the document at `baselineClock` and serialize its canonical
 * markdown + source map in the pushed file's flavor (FR-010: degradation cancels
 * out because the pushed file is diffed against a baseline in the same flavor).
 *
 * @returns {Promise<{ fork: Y.Doc, fragment: Y.XmlFragment, baselineSV: Uint8Array,
 *                     canonicalMd: string, sourceMap: object }>}
 */
async function buildBaseline(persistence, docGuid, baselineClock, { flavor = 'squire' } = {}) {
  const fork = await persistence.getYDocAtClock(docGuid, baselineClock);
  const fragment = fork.get('default', Y.XmlFragment);
  const baselineSV = Y.encodeStateVector(fork);
  const { markdown: canonicalMd, sourceMap } = toMarkdownWithSourceMap(fragment.toArray(), { flavor });
  return { fork, fragment, baselineSV, canonicalMd, sourceMap };
}

/**
 * Canonicalize pushed markdown BODY (frontmatter already stripped) the same way
 * an import would (tolerant parse → image reconstruction → link sanitation →
 * materialize), then serialize in the pushed flavor. Formatting-equivalent
 * inputs collapse to identical canonical strings (FR-005/FR-009).
 */
function canonicalizePushed(body, { flavor = 'squire' } = {}) {
  let pmJson = markdownToPm(body);
  pmJson = reconstructImages(pmJson);
  pmJson = sanitizeLinkMarks(pmJson);
  const nodes = pmJsonToNodes(pmJson);
  if (nodes.length === 0) return '';
  const scratch = new Y.Doc();
  try {
    const frag = scratch.get('default', Y.XmlFragment);
    scratch.transact(() => frag.insert(0, nodes));
    return toMarkdownNodes(frag.toArray(), { flavor });
  } finally {
    scratch.destroy();
  }
}

module.exports = {
  SYNC_AGENT_NAME,
  // T004
  resolveMd,
  classifyRange,
  findRun,
  findBlock,
  // T005
  sha256,
  syntheticClientId,
  buildBaseline,
  canonicalizePushed,
};
