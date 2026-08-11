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
const { diffChars, diffLines, diffArrays } = require('diff');
const {
  toMarkdown,
  toMarkdownNodes,
  toMarkdownWithSourceMap,
  buildFrontmatter,
} = require('./mcp/yjs/serialization');
const { markdownToPm } = require('../shared/markdown');
const { INLINE_MARKS } = require('../shared/format-registry');
const { pmJsonToNodes } = require('./mcp/yjs/pm-json-to-nodes');
const {
  reconstructImages,
  sanitizeLinkMarks,
  rejectDataImages,
  stageImagePass,
} = require('./markdown-import');
const { createSyncPushOrigin } = require('./origin');
const { applyLiveUpdate } = require('./live-apply');
const defaultRedisPubSub = require('./redis-pubsub');
const searchIndexer = require('./search-indexer');
const { withSpan } = require('./telemetry/spans');

// Fixed attribution identity for CI/repo-originated pushes (research R4). Version
// history renders "Repo Sync (<token owner>)" via createAuthor's agent path.
const SYNC_AGENT_NAME = 'Repo Sync';

// On-behalf-of provenance (D6): whitelist of fields + per-field length cap. This
// is the authoritative storage gate — untrusted metadata, stored as plain text.
const ON_BEHALF_OF_FIELDS = ['name', 'email', 'commit', 'url'];
const ON_BEHALF_OF_MAX = 256;

/** Whitelist + length-cap on-behalf-of metadata before storage (D6). */
function sanitizeOnBehalfOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const field of ON_BEHALF_OF_FIELDS) {
    const v = raw[field];
    if (typeof v === 'string' && v.length > 0) out[field] = v.slice(0, ON_BEHALF_OF_MAX);
  }
  return Object.keys(out).length > 0 ? out : null;
}

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
 * The pushed markdown's block extents (feature 055, research R1).
 *
 * The alignment pre-pass needs to know where each PUSHED block starts and ends
 * in the canonical pushed string, exactly as `sourceMap.blocks` says for the
 * baseline. Those extents must byte-agree with the canonical string, so they
 * come from the serializer that produced it — `toMarkdownWithSourceMap` on the
 * canonicalization scratch fragment — and never from splitting the string on
 * `\n\n`, which is wrong inside a fenced code block (the one construct whose
 * canonical form can contain a blank line) and would make block boundaries a
 * second, drift-prone notion.
 *
 * Only `{ mdStart, mdEnd, blockIndex }` survives: the source map's `blockNode`
 * points into the scratch document, which is destroyed on the way out, and the
 * pushed side carries no collaboration identity anyway (only the baseline's
 * nodes do). Handing a dead node reference downstream could only invite a bug.
 */
function pushedBlockExtents(sourceMap) {
  return sourceMap.blocks.map((b) => ({
    mdStart: b.mdStart,
    mdEnd: b.mdEnd,
    blockIndex: b.blockIndex,
  }));
}

/** Pushed BODY → detached, post-synchronous-policy Yjs nodes (shared prelude). */
function pushedNodes(body) {
  let pmJson = markdownToPm(body);
  pmJson = reconstructImages(pmJson);
  pmJson = sanitizeLinkMarks(pmJson);
  return pmJsonToNodes(pmJson);
}

/**
 * Canonicalize pushed markdown BODY (frontmatter already stripped) the same way
 * an import would (tolerant parse → image reconstruction → link sanitation →
 * materialize), then serialize in the pushed flavor. Formatting-equivalent
 * inputs collapse to identical canonical strings (FR-005/FR-009).
 */
function canonicalizePushed(body, { flavor = 'squire' } = {}) {
  const nodes = pushedNodes(body);
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

/**
 * `canonicalizePushed` plus the pushed block extents (055). Deliberately a
 * sibling rather than a replacement: `canonicalizePushed` keeps returning a
 * bare string for the callers that only want one, and the two serializer
 * entry points are contractually byte-identical, which a test pins.
 *
 * @returns {{ markdown: string, blocks: Array<{mdStart,mdEnd,blockIndex}> }}
 */
function canonicalizePushedWithBlocks(body, { flavor = 'squire' } = {}) {
  const nodes = pushedNodes(body);
  if (nodes.length === 0) return { markdown: '', blocks: [] };
  const scratch = new Y.Doc();
  try {
    const frag = scratch.get('default', Y.XmlFragment);
    scratch.transact(() => frag.insert(0, nodes));
    const { markdown, sourceMap } = toMarkdownWithSourceMap(frag.toArray(), { flavor });
    return { markdown, blocks: pushedBlockExtents(sourceMap) };
  } finally {
    scratch.destroy();
  }
}

/**
 * Async counterpart to canonicalizePushed that applies the FULL import image
 * policy before serializing (F1). Runs the exact staged pipeline prepareImport
 * uses: parse → reconstructImages → sanitizeLinkMarks → rejectDataImages →
 * materialize → staged external rehost/degrade + access-checked cross-doc
 * reconciliation (with the acting user as `imageContext.userId`) → serialize the
 * POST-POLICY nodes. So the canonical string that drives the diff — and thus
 * every structural fragment re-parsed during replay (mdToNodes) — carries only
 * vetted srcs: app URLs, degraded links, or dropped alt text. A `data:` payload,
 * an unfetched external src, or a cross-doc ref the pusher can't read never
 * reaches the fork. Returns { markdown, images, blocks } — `blocks` being the
 * pushed block extents the 055 alignment pre-pass aligns against (research R1).
 *
 * The empty-content early returns carry `blocks: []` rather than omitting the
 * field: an empty pushed document is a real push (it deletes every block), and
 * it reaches the aligner through exactly these two returns.
 */
async function canonicalizePushedStaged(body, { flavor = 'squire', imageContext } = {}) {
  let pmJson = markdownToPm(body);
  pmJson = reconstructImages(pmJson);
  pmJson = sanitizeLinkMarks(pmJson);
  const rejected = rejectDataImages(pmJson);
  const detached = pmJsonToNodes(pmJson);
  if (detached.length === 0) {
    return {
      markdown: '', blocks: [],
      images: { rehosted: [], copied: [], degraded: [], rejected },
    };
  }
  const { nodes, images } = await stageImagePass(detached, imageContext, rejected);
  if (nodes.length === 0) return { markdown: '', blocks: [], images };
  const scratch = new Y.Doc();
  try {
    const frag = scratch.get('default', Y.XmlFragment);
    scratch.transact(() => frag.insert(0, nodes));
    const { markdown, sourceMap } = toMarkdownWithSourceMap(frag.toArray(), { flavor });
    return { markdown, blocks: pushedBlockExtents(sourceMap), images };
  } finally {
    scratch.destroy();
  }
}

/**
 * Resolve `./assets/…` image references in a pushed body back to their document
 * image app-URLs via the file's `squire.images` map (relPath → imageId), so a
 * bundle-exported file diffs against the doc's app-URL baseline and unchanged
 * refs produce zero ops (FR-010 spirit for images; spec Images edge case).
 * Untrusted input — only rewrites references whose relPath is in the map.
 */
function resolveImageRefs(body, imageMap, docGuid) {
  if (!imageMap || typeof imageMap !== 'object') return body;
  let out = body;
  for (const [relPath, imageId] of Object.entries(imageMap)) {
    if (typeof relPath !== 'string' || typeof imageId !== 'string') continue;
    if (!/^[0-9a-fA-F-]{36}$/.test(imageId)) continue; // imageId must be a uuid
    const appUrl = `/api/docs/${docGuid}/images/${imageId}`;
    // Replace only inside an image/link destination: `](relPath)`.
    out = out.split(`](${relPath})`).join(`](${appUrl})`);
  }
  return out;
}

/**
 * Parse a markdown fragment into detached Yjs nodes (import canonicalization).
 * Runs the SYNCHRONOUS portion of the import image policy — reconstructImages →
 * sanitizeLinkMarks → rejectDataImages — as defense-in-depth (F1): the async
 * rehost/cross-doc passes already ran up front in canonicalizePushedStaged, so
 * every fragment re-parsed here is post-policy, but stripping any stray `data:`
 * image guarantees one can never be materialized into the fork even if a raw
 * src ever reached this path.
 */
function mdToNodes(md) {
  if (md.trim() === '') return [];
  let pm = markdownToPm(md);
  pm = reconstructImages(pm);
  pm = sanitizeLinkMarks(pm);
  rejectDataImages(pm); // mutates pm.content in place; drops data: image nodes
  return pmJsonToNodes(pm);
}

// ===========================================================================
// T007 — Diff → anchored hunks → classification (research R3)
// ===========================================================================

// Coalesce two same-block text hunks separated by fewer than this many common
// characters into one (implementation-tunable; not protocol surface).
const COALESCE_DISTANCE = 3;

// diffChars edit-distance cap; over it we fall back to coarse line hunking (R11).
const MAX_EDIT_LENGTH = 10000;
// Above this combined input size we skip the whole-document char diff entirely
// (its O(N·D) cost is unbounded for large inputs) and go straight to line-level
// coarse hunking — a small edit still yields a precise char hunk on its line.
const COARSE_INPUT_THRESHOLD = 64 * 1024;
// Within coarse mode, a changed line-cluster larger than this on either side is
// replayed as a whole (structural) rather than char-diffed — bounds the work.
const COARSE_CLUSTER_MAX = 16 * 1024;

// ===========================================================================
// 055 — Block-alignment pre-pass (research R2–R4, R6)
//
// Before any character diffing happens, the baseline and the pushed document
// are aligned BLOCK BY BLOCK. Exactly-equal blocks anchor via a block-level
// LCS; the blocks in the gaps between anchors are paired by similarity; and
// character diffing then runs only INSIDE a matched pair. Blocks that pair
// with nothing — or pair too weakly to be "the same block, edited" — become
// whole-block insert/delete/replace operations instead.
//
// That is what makes a cross-block splice impossible rather than unlikely: a
// character hunk is computed from one baseline block string and one pushed
// block string, so it cannot reach past either. The old whole-document
// character diff could (and did) match the "Deployment" in one heading against
// the "Deployment" in another and splice an edit into the wrong block.
// ===========================================================================

// Two blocks are "the same block, edited" at or above this Dice similarity;
// below it they are different blocks and the push replaces one wholesale.
// Implementation-tunable, not protocol surface (FR-011).
const SIMILARITY_THRESHOLD = 0.5;

// A gap whose pairing matrix would exceed this many cells degrades to
// positional pairing (research R4). Bounds the worst case — a wholesale
// rewrite of a many-hundred-block document is one giant gap — without ever
// reaching for a whole-document fallback.
const MAX_GAP_DP_CELLS = 10000;

// Similarity scores are sums of floating-point Dice values, so DP totals are
// compared with a tolerance rather than for exact equality.
const SIM_EPSILON = 1e-9;

/**
 * Dice similarity of two block strings with the bounded ladder of research R3,
 * plus the character diff that produced it (so a matched pair never pays for
 * the same diff twice — the hunk builder reuses these parts).
 *
 * Every step is deterministic and symmetric, which is what lets the same push
 * plan the same way twice (FR-011):
 *   1. identical            → 1        (no diff run at all)
 *   2. either side oversized → 0       (bounded work, RBD-055-6)
 *   3. lengths too far apart → 0       (sound: C <= min(|a|,|b|), so the true
 *                                       Dice score could not reach threshold)
 *   4. diff cap tripped      → 0       (cap-exceeded pairs are below threshold)
 *   5. otherwise             → 2C/(|a|+|b|), C = common characters
 *
 * @returns {{ sim: number, parts: Array|null }}
 */
function blockSimilarityDetail(a, b) {
  if (a === b) return { sim: 1, parts: null };
  const la = a.length;
  const lb = b.length;
  if (la > COARSE_CLUSTER_MAX || lb > COARSE_CLUSTER_MAX) return { sim: 0, parts: null };
  const total = la + lb;
  if (total === 0) return { sim: 1, parts: null };
  if ((2 * Math.min(la, lb)) / total < SIMILARITY_THRESHOLD) return { sim: 0, parts: null };
  const parts = diffChars(a, b, { maxEditLength: MAX_EDIT_LENGTH });
  if (!parts) return { sim: 0, parts: null };
  let common = 0;
  for (const p of parts) if (!p.added && !p.removed) common += p.value.length;
  return { sim: (2 * common) / total, parts };
}

/** The Dice similarity of two block strings (research R3). Deterministic, symmetric. */
function blockSimilarity(a, b) {
  return blockSimilarityDetail(a, b).sim;
}

/** [start, start+count) as an array of indices. */
function indexRun(start, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(start + i);
  return out;
}

/**
 * Pair the blocks of ONE gap: the order-preserving matching that maximizes
 * total similarity (research R4). Candidates below the threshold are never
 * matched, so a pair always means "the same block, edited".
 *
 * Optimal-within-order is the standard alignment DP; the traceback tie-break
 * is fixed (diagonal, then baseline, then pushed) so the result is a function
 * of the inputs alone. Over MAX_GAP_DP_CELLS the gap degrades to positional
 * pairing — i-th with i-th, still similarity-gated, still order-preserving —
 * which is deterministic too and costs O(max(N, M)) comparisons.
 */
function pairGap(baseIdxs, pushedIdxs, baseMds, pushedMds) {
  const N = baseIdxs.length;
  const M = pushedIdxs.length;
  if (N === 0 || M === 0) return [];
  const detailOf = (i, j) => blockSimilarityDetail(baseMds[baseIdxs[i]], pushedMds[pushedIdxs[j]]);

  if (N * M > MAX_GAP_DP_CELLS) {
    const pairs = [];
    for (let t = 0; t < Math.min(N, M); t++) {
      const d = detailOf(t, t);
      if (d.sim >= SIMILARITY_THRESHOLD) {
        pairs.push({ baseIdx: baseIdxs[t], pushedIdx: pushedIdxs[t], sim: d.sim, parts: d.parts, degraded: false });
      }
    }
    return pairs;
  }

  const details = [];
  for (let i = 0; i < N; i++) {
    const row = [];
    for (let j = 0; j < M; j++) row.push(detailOf(i, j));
    details.push(row);
  }

  // dp[i][j] = best achievable total similarity over the first i baseline and
  // first j pushed blocks of this gap.
  const dp = [];
  for (let i = 0; i <= N; i++) dp.push(new Array(M + 1).fill(0));
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      const s = details[i - 1][j - 1].sim;
      let best = Math.max(dp[i - 1][j], dp[i][j - 1]);
      if (s >= SIMILARITY_THRESHOLD) best = Math.max(best, dp[i - 1][j - 1] + s);
      dp[i][j] = best;
    }
  }

  const pairs = [];
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    const s = details[i - 1][j - 1].sim;
    if (s >= SIMILARITY_THRESHOLD && dp[i - 1][j - 1] + s >= dp[i][j] - SIM_EPSILON) {
      pairs.push({
        baseIdx: baseIdxs[i - 1],
        pushedIdx: pushedIdxs[j - 1],
        sim: s,
        parts: details[i - 1][j - 1].parts,
        degraded: false,
      });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j] - SIM_EPSILON) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  pairs.reverse();
  return pairs;
}

/**
 * Align two block-string sequences (research R2/R4).
 *
 * `anchors` are exactly-equal blocks found by the block-level LCS — the same
 * `diffArrays` approach the overlap detector already uses, so the engine has
 * ONE notion of what "the same block" means. Everything between two anchors is
 * a gap, paired by similarity. Whatever pairs with nothing is a residual run,
 * reported in document order for the gap emitter to turn into whole-block ops.
 *
 * @returns {{ anchors: Array, pairs: Array, residualRuns: Array }}
 */
function alignBlocks(baseMds, pushedMds) {
  const parts = diffArrays(baseMds, pushedMds);
  const anchors = [];
  const gaps = [];
  let baseIdx = 0;
  let pushedIdx = 0;
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (!p.added && !p.removed) {
      for (let n = 0; n < p.value.length; n++) anchors.push({ baseIdx: baseIdx++, pushedIdx: pushedIdx++ });
      continue;
    }
    // A gap is a removed run and/or the added run paired with it. jsdiff emits
    // removed-before-added; the reverse is handled too so the walk can never
    // mis-attribute a gap's position.
    let baseIdxs = [];
    let pushedIdxs = [];
    const next = parts[k + 1];
    if (p.removed) {
      baseIdxs = indexRun(baseIdx, p.value.length);
      baseIdx += p.value.length;
      if (next && next.added) {
        pushedIdxs = indexRun(pushedIdx, next.value.length);
        pushedIdx += next.value.length;
        k += 1;
      }
    } else {
      pushedIdxs = indexRun(pushedIdx, p.value.length);
      pushedIdx += p.value.length;
      if (next && next.removed) {
        baseIdxs = indexRun(baseIdx, next.value.length);
        baseIdx += next.value.length;
        k += 1;
      }
    }
    // `afterBaseIdx` is the baseline block this gap follows (-1 at document
    // start) — the anchor a pure insertion in this gap hangs off.
    gaps.push({ baseIdxs, pushedIdxs, afterBaseIdx: (baseIdxs.length ? baseIdxs[0] : baseIdx) - 1 });
  }

  const pairs = [];
  const residualRuns = [];
  for (const gap of gaps) {
    const gapPairs = pairGap(gap.baseIdxs, gap.pushedIdxs, baseMds, pushedMds);
    pairs.push(...gapPairs);

    // Residual runs are the leftovers between pairing landmarks: the blocks
    // before the first pair, between consecutive pairs, and after the last.
    let bCursor = 0;
    let pCursor = 0;
    let prevBase = gap.afterBaseIdx;
    const emitRun = (bEnd, pEnd) => {
      const baseIdxs = gap.baseIdxs.slice(bCursor, bEnd);
      const pushedIdxs = gap.pushedIdxs.slice(pCursor, pEnd);
      if (baseIdxs.length > 0 || pushedIdxs.length > 0) {
        residualRuns.push({ baseIdxs, pushedIdxs, afterBaseIdx: prevBase });
      }
      if (baseIdxs.length > 0) prevBase = baseIdxs[baseIdxs.length - 1];
      bCursor = bEnd;
      pCursor = pEnd;
    };
    for (const pr of gapPairs) {
      emitRun(gap.baseIdxs.indexOf(pr.baseIdx), gap.pushedIdxs.indexOf(pr.pushedIdx));
      bCursor += 1;
      pCursor += 1;
      prevBase = pr.baseIdx;
    }
    emitRun(gap.baseIdxs.length, gap.pushedIdxs.length);
  }

  return { anchors, pairs, residualRuns };
}

/**
 * Turn residual runs and degraded pairs into forced whole-block hunks
 * (research R6). These bypass hunk classification entirely — a paragraph the
 * push rewrote wholesale must be replaced as a block, not re-classified into a
 * giant character edit over the same extent.
 *
 * Two apply-time hazards are closed here, at plan time, where they are
 * statically decidable:
 *   - ONE insertion hunk per anchor. `applyHunks` inserts each boundary
 *     insertion at `anchor + 1`, so two hunks sharing an anchor would land in
 *     reverse order. A run's pushed blocks are therefore joined into a single
 *     hunk.
 *   - Never anchor an insertion on a block a forced replace covers. Replacements
 *     are applied before insertions and insertion anchors resolve by node
 *     identity, so the anchor node would already be gone and the insertion
 *     would silently fall to the end of the document. Instead the inserted text
 *     is folded onto the replace hunk that swallowed its anchor.
 */
function emitForcedHunks(alignment, baseBlocks, baseMds, pushedMds) {
  const { pairs, residualRuns } = alignment;
  const replaceByLastBlock = new Map(); // baseline index -> forced replace hunk
  const covered = new Set();
  const forced = [];

  const addReplace = (baseIdxs, pushedIdxs) => {
    const first = baseBlocks[baseIdxs[0]];
    const last = baseBlocks[baseIdxs[baseIdxs.length - 1]];
    const hunk = {
      oldStart: first.mdStart,
      oldEnd: last.mdEnd,
      newText: pushedIdxs.map((p) => pushedMds[p]).join('\n\n'),
      forced: true,
      blocks: baseIdxs.map((b) => baseBlocks[b]),
    };
    for (const b of baseIdxs) covered.add(b);
    replaceByLastBlock.set(baseIdxs[baseIdxs.length - 1], hunk);
    forced.push(hunk);
    return hunk;
  };

  // Degraded pairs first: a pair whose in-pair character diff gave up is a
  // whole-block replacement of exactly that block. (Defensive — the similarity
  // ladder already scores a cap-tripping pair 0, so it never becomes a pair in
  // the first place. Kept because the alternative failure mode is silence.)
  for (const pr of pairs) {
    if (pr.degraded) addReplace([pr.baseIdx], [pr.pushedIdx]);
  }

  for (const run of residualRuns) {
    if (run.baseIdxs.length > 0) {
      addReplace(run.baseIdxs, run.pushedIdxs);
      continue;
    }
    if (run.pushedIdxs.length === 0) continue;
    const newText = run.pushedIdxs.map((p) => pushedMds[p]).join('\n\n');
    const anchorIdx = run.afterBaseIdx;
    const foldInto = anchorIdx >= 0 && covered.has(anchorIdx) ? replaceByLastBlock.get(anchorIdx) : null;
    if (foldInto) {
      foldInto.newText = foldInto.newText === '' ? newText : `${foldInto.newText}\n\n${newText}`;
      continue;
    }
    const at = anchorIdx >= 0 ? baseBlocks[anchorIdx].mdEnd : 0;
    forced.push({ oldStart: at, oldEnd: at, newText, forced: true, blocks: [] });
  }

  return forced;
}

/**
 * Turn one character diff's parts into anchored hunks `{ oldStart, oldEnd,
 * newText }` in BASELINE coordinates (adjacency-0 clustering), then coalesce
 * near-adjacent hunks. `baseOffset` rebases the diff of a single block's string
 * into whole-document coordinates.
 */
function hunksFromParts(parts, baseOffset, baselineMd) {
  const raw = [];
  let oldPos = baseOffset;
  let cur = null;
  for (const part of parts) {
    if (part.added) {
      if (!cur) cur = { oldStart: oldPos, oldEnd: oldPos, newText: '' };
      cur.newText += part.value;
    } else if (part.removed) {
      if (!cur) cur = { oldStart: oldPos, oldEnd: oldPos, newText: '' };
      cur.oldEnd = oldPos + part.value.length;
      oldPos += part.value.length;
    } else {
      if (cur) { raw.push(cur); cur = null; }
      oldPos += part.value.length;
    }
  }
  if (cur) raw.push(cur);

  // Within-block coalescing.
  const merged = [];
  for (const h of raw) {
    const last = merged[merged.length - 1];
    if (last) {
      const gap = h.oldStart - last.oldEnd;
      if (gap >= 0 && gap < COALESCE_DISTANCE) {
        const gapText = baselineMd.slice(last.oldEnd, h.oldStart);
        if (!gapText.includes('\n\n')) {
          last.oldEnd = h.oldEnd;
          last.newText = last.newText + gapText + h.newText;
          continue;
        }
      }
    }
    merged.push({ ...h });
  }
  return merged;
}

/**
 * Plan a push as hunks in BASELINE coordinates, block-aligned (feature 055).
 *
 * The pre-pass decides WHICH baseline block each pushed block corresponds to,
 * and only then does any character diffing happen — inside a matched pair, on
 * that pair's two block strings. Blocks that matched nothing (or matched too
 * weakly to be the same block) come back as forced whole-block hunks tagged for
 * `planPush` to route straight to structural.
 *
 * There is no whole-document character diff at any size, and no second planning
 * path for large documents: bounds degrade one pair, or one gap, and nothing
 * else (RBD-055-5/-6).
 *
 * @param {string} baselineMd   canonical baseline markdown
 * @param {string} pushedMd     canonical pushed markdown
 * @param {Array}  baseBlocks   baseline source-map blocks (extents + node identity)
 * @param {Array}  pushedBlocks pushed block extents (research R1)
 */
function computeHunks(baselineMd, pushedMd, baseBlocks, pushedBlocks) {
  const baseMds = baseBlocks.map((b) => baselineMd.slice(b.mdStart, b.mdEnd));
  const pushedMds = pushedBlocks.map((b) => pushedMd.slice(b.mdStart, b.mdEnd));
  const alignment = alignBlocks(baseMds, pushedMds);

  const hunks = [];
  for (const pair of alignment.pairs) {
    const a = baseMds[pair.baseIdx];
    const b = pushedMds[pair.pushedIdx];
    if (a === b) continue; // paired but unchanged (a duplicate the LCS left in a gap)
    // The similarity pass already diffed this exact pair; diffing it a second
    // time would double the planner's cost for every edited block.
    const parts = pair.parts || diffChars(a, b, { maxEditLength: MAX_EDIT_LENGTH });
    if (!parts) {
      // Defensive: the similarity ladder scores a cap-tripping pair 0, so it
      // never becomes a pair. If one ever did, it degrades to a whole-block
      // replacement of itself rather than to a document-wide fallback.
      pair.degraded = true;
      continue;
    }
    for (const h of hunksFromParts(parts, baseBlocks[pair.baseIdx].mdStart, baselineMd)) hunks.push(h);
  }

  for (const h of emitForcedHunks(alignment, baseBlocks, baseMds, pushedMds)) hunks.push(h);

  hunks.sort((x, y) => (x.oldStart - y.oldStart) || (x.oldEnd - y.oldEnd));
  return hunks;
}

/** True if inserted text would introduce or split block structure. */
function newTextBreaksBlock(s) {
  if (s.includes('\n')) return true;
  return /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|```|~~~|-{3,}$|\|)/.test(s);
}

/** True if inserted text carries inline mark syntax (so it isn't literal text). */
function newTextHasInlineMarkSyntax(s) {
  return /[*_~`]|<\/?[a-zA-Z]|\]\(/.test(s);
}

/** Attributes of the character at index `off` in a delta (or {} if none). */
function marksAtChar(delta, off) {
  let pos = 0;
  for (const op of delta) {
    const t = typeof op.insert === 'string' ? op.insert : '';
    if (off >= pos && off < pos + t.length) return op.attributes || {};
    pos += t.length;
  }
  return {};
}

/**
 * Plan a push: classify hunks against the baseline source map (research R3,
 * FR-007 prefer-text) BLOCK-CENTRICALLY — hunks that fall within one block's
 * text are grouped by block, so a block whose edit involves inline-mark syntax
 * (whose delimiters diff as separate hunks) reconciles as one whole-block
 * inline update rather than conflicting per-hunk. Returns:
 *   { textBlocks:   [{ block, hunks }]                 — surgical char ops
 *     reconcileBlocks: [{ block, textNode, targetDelta }] — in-place inline
 *     structural:   [ hunk+{blocks} ]                  — fork block replacement
 *     counts: { textHunks, structuralHunks } }
 */
function planPush(hunks, sourceMap, baselineMd) {
  const groups = new Map(); // blockNode -> { block, hunks[] }
  const structural = [];
  for (const h of hunks) {
    // Forced hunks are the aligner's own whole-block decisions (055) and skip
    // classification entirely. Re-classifying one would undo it: a wholesale
    // paragraph rewrite covers a range that is all mapped text, so the
    // classifier would happily call it a character edit and splice the new
    // paragraph into the old one's CRDT text node — the exact outcome the
    // pre-pass decided against.
    if (h.forced) {
      structural.push({ ...h });
      continue;
    }
    const cls = classifyRange(sourceMap, h.oldStart, h.oldEnd);
    if (cls.kind === 'text' && cls.block) {
      const key = cls.block.blockNode;
      if (!groups.has(key)) groups.set(key, { block: cls.block, hunks: [] });
      groups.get(key).hunks.push({ ...h, segments: cls.segments });
    } else {
      structural.push({ ...h, blocks: cls.blocks || [] });
    }
  }

  const textBlocks = [];
  const reconcileBlocks = [];
  let textHunks = 0;
  for (const { block, hunks: bh } of groups.values()) {
    const allPlain = bh.every(
      (h) => !newTextBreaksBlock(h.newText) && !newTextHasInlineMarkSyntax(h.newText)
    );
    if (allPlain) {
      textBlocks.push({ block, hunks: bh });
      textHunks += bh.length;
    } else {
      const rec = reconcileBlockPlan(block, bh, baselineMd);
      if (rec) {
        reconcileBlocks.push(rec);
        textHunks += bh.length;
      } else if (isEdgeBlockInsertion(bh, block)) {
        // A pure insertion of whole blocks at this block's leading/trailing edge
        // inserts AROUND the block (preserving its CRDT identity), not a replace.
        structural.push({ ...bh[0], blocks: [] });
      } else {
        for (const h of bh) structural.push({ ...h, blocks: [block] });
      }
    }
  }
  return {
    textBlocks,
    reconcileBlocks,
    structural,
    counts: { textHunks, structuralHunks: structural.length },
  };
}

/**
 * True when a block group is a single pure insertion of complete blocks at the
 * block's leading edge (newText ends with a block separator) or trailing edge
 * (newText begins with one) — inserted around the block, not replacing it.
 */
function isEdgeBlockInsertion(blockHunks, block) {
  if (blockHunks.length !== 1) return false;
  const h = blockHunks[0];
  if (h.oldStart !== h.oldEnd) return false; // not a pure insertion
  if (h.oldStart === block.mdStart && h.newText.endsWith('\n\n')) return true;
  if (h.oldStart === block.mdEnd && h.newText.startsWith('\n\n')) return true;
  return false;
}

/**
 * Build an in-place inline reconciliation for one block whose combined edit
 * (all its hunks) keeps its type + single-text-node shape. Returns
 * { block, textNode, targetDelta } or null (→ caller falls to structural).
 */
function reconcileBlockPlan(block, blockHunks, baselineMd) {
  const blockNode = block.blockNode;
  if (!(blockNode instanceof Y.XmlElement)) return null;
  const textChildren = blockNode.toArray().filter((c) => c instanceof Y.XmlText);
  const elemChildren = blockNode.toArray().filter((c) => c instanceof Y.XmlElement);
  if (textChildren.length !== 1 || elemChildren.length !== 0) return null;

  let s = '';
  let cur = block.mdStart;
  for (const h of blockHunks.slice().sort((a, b) => a.oldStart - b.oldStart)) {
    s += baselineMd.slice(cur, h.oldStart) + h.newText;
    cur = h.oldEnd;
  }
  s += baselineMd.slice(cur, block.mdEnd);

  let pm = markdownToPm(s);
  pm = sanitizeLinkMarks(pm);
  if (!pm.content || pm.content.length !== 1) return null;
  const nb = pm.content[0];
  if (nb.type !== blockNode.nodeName) return null;
  if (blockNode.nodeName === 'heading') {
    const oldLevel = String(blockNode.getAttribute('level') || '1');
    if (String(nb.attrs && nb.attrs.level) !== oldLevel) return null;
  }
  const targetDelta = pmInlineToDelta(nb.content || []);
  if (targetDelta === null) return null;
  return { block, textNode: textChildren[0], targetDelta };
}

/** ProseMirror inline content → a Yjs delta (or null if it isn't pure text). */
function pmInlineToDelta(content) {
  const delta = [];
  for (const n of content) {
    if (n.type !== 'text' || typeof n.text !== 'string') return null;
    const attrs = {};
    for (const mk of n.marks || []) {
      if (mk.type === 'link') attrs.link = { href: (mk.attrs && mk.attrs.href) || '' };
      else if (mk.type === 'textStyle') attrs.textStyle = mk.attrs || {};
      else attrs[mk.type] = true;
    }
    delta.push(Object.keys(attrs).length ? { insert: n.text, attributes: attrs } : { insert: n.text });
  }
  return delta;
}

// ===========================================================================
// T008 — Replay hunks onto the fork (research R3)
// ===========================================================================

// All inline mark attributes, for clearing before re-applying target marks.
const CLEAR_ATTRS = {};
for (const m of INLINE_MARKS) CLEAR_ATTRS[m.yjsAttr] = null;
CLEAR_ATTRS.link = null;
CLEAR_ATTRS.textStyle = null;

// Marks the PORTABLE flavor cannot round-trip to themselves: textStyle is
// dropped entirely on portable export, and every registry mark carrying a
// `portable` degradation declaration (e.g. underline, highlight) serializes to
// ANOTHER mark's delimiters — so a pushed portable file can never re-assert
// them. In portable reconciliation these are EXCLUDED from the clear set, so a
// live span the pushed file structurally couldn't carry (a color textStyle, an
// underline) survives an in-place edit to the same block instead of being wiped
// (F2, FR-010). Derived from the registry, never hardcoded. (Squire expresses
// every mark, so it always clears the full set.)
const PORTABLE_PRESERVED_ATTRS = new Set([
  'textStyle',
  ...INLINE_MARKS.filter((m) => m.portable).map((m) => m.yjsAttr),
]);
const CLEAR_ATTRS_PORTABLE = {};
for (const [k, v] of Object.entries(CLEAR_ATTRS)) {
  if (!PORTABLE_PRESERVED_ATTRS.has(k)) CLEAR_ATTRS_PORTABLE[k] = v;
}

/** The clear-before-reformat attribute set for a file's flavor. */
function clearAttrsFor(flavor) {
  return flavor === 'portable' ? CLEAR_ATTRS_PORTABLE : CLEAR_ATTRS;
}

/** Reconcile a Y.XmlText's content to `targetDelta` with minimal text ops + reformat. */
function reconcileTextNode(textNode, targetDelta, flavor = 'squire') {
  const oldPlain = textNode.toDelta().map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('');
  const newPlain = targetDelta.map((op) => op.insert).join('');
  const parts = diffChars(oldPlain, newPlain) || [
    { removed: true, value: oldPlain }, { added: true, value: newPlain },
  ];
  let pos = 0;
  for (const part of parts) {
    if (part.added) { textNode.insert(pos, part.value); pos += part.value.length; }
    else if (part.removed) { textNode.delete(pos, part.value.length); }
    else { pos += part.value.length; }
  }
  const len = newPlain.length;
  if (len > 0) {
    textNode.format(0, len, clearAttrsFor(flavor));
    let o = 0;
    for (const op of targetDelta) {
      const t = op.insert;
      if (op.attributes && Object.keys(op.attributes).length > 0) {
        textNode.format(o, t.length, op.attributes);
      }
      o += t.length;
    }
  }
}

/** Array index of the block object whose extent contains `offset`, or -1. */
function blockArrayIndexAt(blocks, offset) {
  for (let i = 0; i < blocks.length; i++) {
    if (offset < blocks[i].mdEnd && offset >= blocks[i].mdStart) return i;
  }
  return -1;
}

/** Group structural hunks into fork-fragment operations (block-node identity). */
function structuralOps(structural, sourceMap, baselineMd) {
  const blocks = sourceMap.blocks;
  const idxOf = new Map();
  blocks.forEach((b, i) => idxOf.set(b, i));

  const items = [];
  const insertions = [];
  for (const h of structural.slice().sort((a, b) => a.oldStart - b.oldStart)) {
    const touched = (h.blocks || [])
      .map((b) => idxOf.get(b))
      .filter((i) => i !== undefined)
      .sort((a, b) => a - b);
    if (touched.length === 0) {
      // Boundary insertion between blocks. Anchor on the preceding block.
      let afterIdx = -1;
      for (let i = 0; i < blocks.length; i++) if (blocks[i].mdEnd <= h.oldStart) afterIdx = i;
      insertions.push({ afterBlock: afterIdx === -1 ? null : blocks[afterIdx], newText: h.newText });
    } else {
      items.push({ first: touched[0], last: touched[touched.length - 1], hunk: h });
    }
  }

  items.sort((a, b) => a.first - b.first);
  const replacements = [];
  for (const it of items) {
    const prev = replacements[replacements.length - 1];
    if (prev && it.first <= prev.last + 1) {
      prev.last = Math.max(prev.last, it.last);
      prev.hunks.push(it.hunk);
    } else {
      replacements.push({ first: it.first, last: it.last, hunks: [it.hunk] });
    }
  }
  return { replacements, insertions };
}

/**
 * Apply a push plan (from planPush) to the fork fragment. Caller MUST wrap this
 * in the fork's transaction (after pinning the synthetic clientID). Returns
 * operation counts. Structural replacement uses block-node identity for live
 * indices (order-stable); plain text hunks track a per-node offset shift.
 */
function applyHunks(fragment, plan, sourceMap, baselineMd, { flavor = 'squire' } = {}) {
  const { textBlocks, reconcileBlocks, structural } = plan;
  const { replacements, insertions } = structuralOps(structural, sourceMap, baselineMd);

  // Blocks replaced structurally — skip in-block edits that land inside them.
  const replacedNodes = new Set();
  for (const g of replacements) {
    for (let i = g.first; i <= g.last; i++) replacedNodes.add(sourceMap.blocks[i].blockNode);
  }

  // 1) Whole-block inline reconciliations (in place). The file's flavor governs
  //    which marks survive the clear-and-reformat (F2): portable pushes must not
  //    wipe marks the flavor couldn't express.
  for (const rec of reconcileBlocks) {
    if (replacedNodes.has(rec.block.blockNode)) continue;
    reconcileTextNode(rec.textNode, rec.targetDelta, flavor);
  }

  // 2) Plain text hunks — surgical char ops, per-node offset shift.
  for (const tb of textBlocks) {
    if (replacedNodes.has(tb.block.blockNode)) continue;
    const shift = new Map();
    for (const h of tb.hunks.slice().sort((a, b) => a.oldStart - b.oldStart)) {
      const seg0 = h.segments[0];
      const segN = h.segments[h.segments.length - 1];
      const textNode = seg0.textNode;
      const startOff = seg0.textOff;
      const oldLen = (segN.textOff + segN.length) - seg0.textOff;
      const d = shift.get(textNode) || 0;
      const at = startOff + d;
      if (oldLen > 0) textNode.delete(at, oldLen);
      if (h.newText.length > 0) {
        const delta = textNode.toDelta();
        const anchor = oldLen > 0 ? at : Math.max(at - 1, 0);
        const attrs = marksAtChar(delta, anchor);
        if (attrs && Object.keys(attrs).length > 0) textNode.insert(at, h.newText, attrs);
        else textNode.insert(at, h.newText);
      }
      shift.set(textNode, d + (h.newText.length - oldLen));
    }
  }

  // 3) Structural replacements — block-node identity for live indices.
  for (const g of replacements) {
    const firstBlock = sourceMap.blocks[g.first];
    const lastBlock = sourceMap.blocks[g.last];
    const idx = fragment.toArray().indexOf(firstBlock.blockNode);
    const idxLast = fragment.toArray().indexOf(lastBlock.blockNode);
    if (idx === -1 || idxLast === -1) continue;
    const count = idxLast - idx + 1;
    let s = '';
    let cur = firstBlock.mdStart;
    for (const hh of g.hunks.slice().sort((a, b) => a.oldStart - b.oldStart)) {
      s += baselineMd.slice(cur, hh.oldStart) + hh.newText;
      cur = hh.oldEnd;
    }
    s += baselineMd.slice(cur, lastBlock.mdEnd);
    const newNodes = mdToNodes(s);
    fragment.delete(idx, count);
    if (newNodes.length > 0) fragment.insert(idx, newNodes);
  }

  // 4) Boundary insertions between blocks.
  for (const ins of insertions) {
    const newNodes = mdToNodes(ins.newText);
    if (newNodes.length === 0) continue;
    let at = 0;
    if (ins.afterBlock) {
      const pos = fragment.toArray().indexOf(ins.afterBlock.blockNode);
      at = pos === -1 ? fragment.length : pos + 1;
    }
    fragment.insert(at, newNodes);
  }

  return { ...plan.counts };
}

// ===========================================================================
// T013 — Overlap detection (research R5, US2). Strictly advisory (FR-012):
// computed AFTER the push is applied, never gates it.
// ===========================================================================

let detectOverlaps = defaultDetectOverlaps;
/** Override the overlap detector (tests disable it to prove flags never gate). */
function setOverlapDetector(fn) { detectOverlaps = fn || (async () => []); }

function buffersEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * First ~120 chars of a block's text content, whitespace-collapsed, plain,
 * with a trailing ellipsis when it was cut (feature 054, RBD-054-6 as amended).
 *
 * ONE helper for BOTH block lists on a receipt — `overlaps[].excerpt` and
 * `blocksChanged[].excerpt`. Two block lists in one payload whose excerpts
 * truncate at different lengths is a needless inconsistency, so the widening
 * deliberately reaches the overlap flags too (research R6). The ellipsis is
 * what tells a reader the block continues; without it a truncated excerpt
 * reads as the block's whole text.
 *
 * The cap counts characters BEFORE the marker, so the returned string is at
 * most 121 characters (120 + '…') and the visible text is never more than the
 * 120 the contract promises.
 */
const EXCERPT_MAX_CHARS = 120;

function blockExcerpt(md) {
  const flat = md.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_MAX_CHARS ? `${flat.slice(0, EXCERPT_MAX_CHARS)}…` : flat;
}

/** Doc-side changed baseline blocks (array index → 'edited'|'deleted') via block LCS. */
function docSideChanges(baseMds, curMds) {
  const parts = diffArrays(baseMds, curMds);
  const changed = new Map();
  let baseIdx = 0;
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.removed) {
      const replaced = parts[k + 1] && parts[k + 1].added;
      for (let j = 0; j < p.value.length; j++) changed.set(baseIdx++, replaced ? 'edited' : 'deleted');
    } else if (p.added) {
      /* current-only block — no baseline advance */
    } else {
      baseIdx += p.value.length;
    }
  }
  return changed;
}

/** Push-touched baseline blocks (array index → 'text'|'structural'|'deleted'). */
function pushTouchedBlocks(plan, baseBlocks) {
  const idxOf = new Map();
  baseBlocks.forEach((b, i) => idxOf.set(b, i));
  const touched = new Map();
  for (const tb of plan.textBlocks) { const i = idxOf.get(tb.block); if (i !== undefined) touched.set(i, 'text'); }
  for (const rb of plan.reconcileBlocks) { const i = idxOf.get(rb.block); if (i !== undefined) touched.set(i, 'text'); }
  for (const h of plan.structural) {
    const side = h.newText === '' ? 'deleted' : 'structural';
    for (const b of h.blocks || []) { const i = idxOf.get(b); if (i !== undefined) touched.set(i, side); }
  }
  return touched;
}

/** A block's reported type — the same derivation overlap flags use. */
function blockTypeOf(block) {
  return block.blockNode instanceof Y.XmlElement ? block.blockNode.nodeName : 'text';
}

/**
 * The per-block change report carried by a sync receipt as `blocksChanged`
 * (feature 054, US2/FR-009, contract sync-receipt-v2.md).
 *
 * One entry per baseline block the push would change, plus one per boundary
 * insertion. It answers the question a pusher previously had to answer by
 * re-exporting the document and grepping it: WHICH blocks did this touch, and
 * what did it do to each.
 *
 * A sibling of `pushTouchedBlocks` rather than a replacement for it (research
 * R4). The two look similar and answer different questions. `pushTouchedBlocks`
 * feeds `overlaps[].pushSide`, which asks "did our push touch a block the
 * document also changed" — intersection semantics, where a reconcile and a
 * plain text edit behave identically, which is why it deliberately labels both
 * `text`. This asks "what did we do to each block", where that distinction is
 * the entire point. Changing the shared function to emit `reconcile` would have
 * silently re-labelled a shipped overlap contract, so `pushTouchedBlocks` is
 * left exactly as it was. The same block can therefore read `op: 'reconcile'`
 * here and `pushSide: 'text'` in `overlaps` on one receipt — intentional, and
 * documented in the contract.
 *
 * Structural operations come from `structuralOps`, the same function
 * `applyHunks` consumes, so the report cannot drift from what is applied — it
 * inherits the coalescing rule (which would otherwise over-report) and the
 * boundary-insertion anchoring for free.
 *
 * @param {object} plan       - the plan from `planPush`
 * @param {object} sourceMap  - the baseline source map
 * @param {string} baselineMd - the canonical baseline markdown
 * @returns {Array<object>} entries, ordered by block position
 */
function buildChangeReport(plan, sourceMap, baselineMd) {
  const blocks = sourceMap.blocks;
  const idxOf = new Map();
  blocks.forEach((b, i) => idxOf.set(b, i));
  const { replacements, insertions } = structuralOps(plan.structural, sourceMap, baselineMd);

  // Blocks a structural group replaces wholesale. `applyHunks` skips in-block
  // edits that land inside them, so the report must too — otherwise one block
  // would be reported twice, under two different ops, and only one of them
  // would describe what actually happened.
  const replaced = new Set();
  for (const g of replacements) {
    for (let i = g.first; i <= g.last; i++) replaced.add(i);
  }

  // `sortIndex` is the array position (what orders the list); `blockIndex` is
  // the block's document position (what the receipt reports). They coincide for
  // a whole-document push and diverge for a partial source map, so keep both.
  const entries = [];
  const push = (arrayIdx, op) => {
    const block = blocks[arrayIdx];
    if (!block) return;
    entries.push({
      sortIndex: arrayIdx,
      isInsertion: false,
      entry: {
        blockIndex: block.blockIndex,
        blockType: blockTypeOf(block),
        excerpt: blockExcerpt(baselineMd.slice(block.mdStart, block.mdEnd)),
        op,
      },
    });
  };

  for (const tb of plan.textBlocks) {
    const i = idxOf.get(tb.block);
    if (i !== undefined && !replaced.has(i)) push(i, 'text');
  }
  for (const rb of plan.reconcileBlocks) {
    const i = idxOf.get(rb.block);
    if (i !== undefined && !replaced.has(i)) push(i, 'reconcile');
  }
  for (const g of replacements) {
    for (let i = g.first; i <= g.last; i++) push(i, 'structural');
  }

  for (const ins of insertions) {
    // An inserted block has no baseline index of its own, so it is reported
    // against its anchor plus an explicit `position` — inventing a post-push
    // index the baseline source map cannot know would be a guess (research R5).
    const anchorIdx = ins.afterBlock ? idxOf.get(ins.afterBlock) : undefined;
    const anchored = anchorIdx !== undefined;
    const anchor = anchored ? blocks[anchorIdx] : null;
    entries.push({
      // A document-head insertion sorts before every block, and reports
      // `blockIndex: 0` with `position: 'start'` — the position field is what
      // says "before this block", so the index is not ambiguous.
      sortIndex: anchored ? anchorIdx : -1,
      isInsertion: true,
      entry: {
        blockIndex: anchor ? anchor.blockIndex : 0,
        blockType: anchor ? blockTypeOf(anchor) : 'text',
        excerpt: blockExcerpt(ins.newText),
        op: 'structural',
        position: anchored ? 'after' : 'start',
      },
    });
  }

  // Block order, with an insertion following the block it is anchored on.
  entries.sort((a, b) => (a.sortIndex - b.sortIndex) || (a.isInsertion - b.isInsertion));
  return entries.map((e) => e.entry);
}

/**
 * Compute advisory overlap flags: baseline blocks changed on the document side
 * (state-vector fast path + block-level canonical-md LCS vs the current live
 * snapshot) intersected with blocks the push touched (recorded during planning).
 */
async function defaultDetectOverlaps(persistence, docGuid, ctx) {
  const { baselineSV, canonicalMd, sourceMap, plan, getSharedDoc, flavor = 'squire' } = ctx;
  const baseBlocks = sourceMap.blocks;
  if (baseBlocks.length === 0) return [];

  let currentDoc = null;
  let ownsDoc = false;
  try { currentDoc = getSharedDoc && getSharedDoc(docGuid); } catch { currentDoc = null; }
  if (!currentDoc) { currentDoc = await persistence.getYDoc(docGuid); ownsDoc = true; }
  try {
    const currentSV = Y.encodeStateVector(currentDoc);
    if (buffersEqual(currentSV, baselineSV)) return []; // clock-equal push — no doc-side change

    const baseMds = baseBlocks.map((b) => canonicalMd.slice(b.mdStart, b.mdEnd));
    const cur = toMarkdownWithSourceMap(currentDoc.get('default', Y.XmlFragment).toArray(), { flavor });
    const curMds = cur.sourceMap.blocks.map((b) => cur.markdown.slice(b.mdStart, b.mdEnd));

    const docSide = docSideChanges(baseMds, curMds);
    const pushSide = pushTouchedBlocks(plan, baseBlocks);

    const flags = [];
    for (const [i, ds] of docSide) {
      if (!pushSide.has(i)) continue;
      const b = baseBlocks[i];
      flags.push({
        blockIndex: b.blockIndex,
        blockType: blockTypeOf(b),
        excerpt: blockExcerpt(baseMds[i]),
        docSide: ds,
        pushSide: pushSide.get(i),
      });
    }
    flags.sort((a, b) => a.blockIndex - b.blockIndex);
    return flags;
  } finally {
    if (ownsDoc) currentDoc.destroy();
  }
}

// ===========================================================================
// T009 — applySyncPush orchestration (research R8, store-then-apply)
// ===========================================================================

/**
 * Whether a fork update adds nothing the current document doesn't already have
 * (F5 idempotency short-circuit). A byte-identical re-push replays under the
 * same pinned synthetic clientID (FR-011), so both its inserted structs AND its
 * deletions are already applied to the live doc; storing it again would only
 * accrete a no-op version row (promotion-note #4). Compares a snapshot (state
 * vector + delete set) of a gc-free probe before and after applying the update,
 * so a re-inserted struct and a re-applied deletion BOTH read as no-change,
 * while a first-time insert or delete reads as a real change. Never a false
 * positive: a genuinely new push carries a different synthetic client's structs.
 */
async function pushIsAlreadyApplied(persistence, docGuid, pushUpdate, getSharedDoc) {
  let currentDoc = null;
  let ownsDoc = false;
  try { currentDoc = getSharedDoc && getSharedDoc(docGuid); } catch { currentDoc = null; }
  if (!currentDoc) { currentDoc = await persistence.getYDoc(docGuid); ownsDoc = true; }
  const probe = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(currentDoc));
    const before = Y.snapshot(probe);
    Y.applyUpdate(probe, pushUpdate);
    const after = Y.snapshot(probe);
    return Y.equalSnapshots(before, after);
  } finally {
    probe.destroy();
    if (ownsDoc) currentDoc.destroy();
  }
}

/** Current max clock for a doc (−0 when empty), read from the update log. */
async function readCurrentClock(persistence, docGuid) {
  const result = await persistence.pool.query(
    'SELECT MAX(clock)::int AS clock FROM yjs_updates WHERE doc_guid = $1',
    [docGuid]
  );
  return result.rows[0].clock == null ? 0 : result.rows[0].clock;
}

/** Last-modifier identity string for frontmatter (email or agent name). */
async function readLastModifiedBy(persistence, docGuid) {
  const result = await persistence.pool.query(
    `SELECT yu.agent_name, usr.email
     FROM yjs_updates yu LEFT JOIN users usr ON yu.user_id = usr.id
     WHERE yu.doc_guid = $1 ORDER BY yu.clock DESC LIMIT 1`,
    [docGuid]
  );
  const row = result.rows[0];
  return row ? (row.email || row.agent_name || '') : '';
}

/**
 * Canonical re-export of the document's state at `clock` in the pushed flavor
 * with refreshed frontmatter — the next baseline (FR-014, contract Consistency
 * rule: the embedded frontmatter clock equals the clock of the exact serialized
 * state, read atomically as getYDocAtClock(clock)). The append/replace/create
 * import receipts (design §1.2.1) reuse this with frontmatter: false, where
 * the receipt is for verification only and no baseline stamp was requested.
 */
async function reExport(persistence, docGuid, clock, flavor, { frontmatter = true } = {}) {
  const stateDoc = await persistence.getYDocAtClock(docGuid, clock);
  try {
    const fragment = stateDoc.get('default', Y.XmlFragment);
    const lossy = new Set();
    const body = toMarkdown(fragment, { flavor, lossy });
    if (!frontmatter) return body;
    const title = stateDoc.getMap('meta').get('title') || 'Untitled';
    const lastModifiedBy = await readLastModifiedBy(persistence, docGuid);
    const fm = buildFrontmatter({
      docGuid,
      title,
      clock,
      exportedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      lastModifiedBy,
      flavor,
      lossy,
    });
    return fm + '\n' + body;
  } finally {
    stateDoc.destroy();
  }
}

/**
 * Resolve and validate a sync push's baseline (research R6, FR-015/US5). Pure
 * except for the current-clock read. Validation ordering: docGuid identity →
 * baseline presence (D3 precedence: explicit param overrides frontmatter) →
 * baseline validity vs current clock → reconstructibility (D1 forward guard).
 * Returns either { error, status, currentClock? } or { baselineClock, flavor }.
 * All checks run BEFORE fork construction, so a rejected push leaves no trace.
 *
 * @param {object} persistence
 * @param {string} docGuid
 * @param {object} opts
 * @param {object|null} opts.squire      - parsed squire frontmatter block
 * @param {*} [opts.paramClock]          - explicit baselineClock request param
 * @param {Function} [opts.canReconstruct] - (persistence, docGuid, clock) → Promise<bool>
 */
async function validateSyncBaseline(persistence, docGuid, { squire, paramClock, canReconstruct } = {}) {
  // Doc identity (FR-002) — before any processing.
  if (squire && squire.docGuid != null && String(squire.docGuid) !== String(docGuid)) {
    return { error: 'sync_doc_mismatch', status: 409 };
  }
  // Baseline resolution (D3): explicit param overrides frontmatter clock.
  let baselineClock;
  if (paramClock !== undefined && paramClock !== null && paramClock !== '') {
    baselineClock = Number(paramClock);
  } else if (squire && squire.clock !== undefined) {
    baselineClock = Number(squire.clock);
  }
  if (baselineClock === undefined) return { error: 'sync_baseline_missing', status: 400 };

  const currentClock = await readCurrentClock(persistence, docGuid);
  if (!Number.isInteger(baselineClock) || baselineClock < 0 || baselineClock > currentClock) {
    return { error: 'sync_baseline_invalid', status: 400, currentClock };
  }
  if (canReconstruct && !(await canReconstruct(persistence, docGuid, baselineClock))) {
    return { error: 'sync_baseline_unavailable', status: 410, currentClock };
  }
  const flavor = (squire && squire.flavor === 'portable') ? 'portable' : 'squire';
  return { baselineClock, flavor, currentClock };
}

/**
 * Apply a validated sync push (auth/baseline validation happens upstream in the
 * route, T010/T026). Reconstructs the baseline, canonicalizes the pushed body,
 * short-circuits true no-ops (T018/D7), else replays edits as one CRDT update
 * and stores-then-applies it through the normal path (broadcast + persistence).
 *
 * @param {object} persistence
 * @param {string} docGuid
 * @param {object} opts
 * @param {string} opts.body          - pushed markdown BODY (frontmatter stripped)
 * @param {number} opts.baselineClock - validated baseline clock
 * @param {'squire'|'portable'} [opts.flavor='squire']
 * @param {string} opts.userId
 * @param {string|null} [opts.agentName] - defaults to SYNC_AGENT_NAME
 * @param {object|null} [opts.onBehalfOf] - provenance metadata (T021)
 * @param {Function} opts.getSharedDoc  - docGuid → live shared Y.Doc
 * @param {boolean} [opts.dryRun=false] - compute the whole plan, apply nothing
 *   (feature 054, US3/FR-006). See the early return below for the exact cut.
 * @returns {Promise<object>} receipt (contract sync-push.md)
 */
async function applySyncPush(persistence, docGuid, opts) {
  const {
    body,
    baselineClock,
    flavor = 'squire',
    userId,
    agentName = SYNC_AGENT_NAME,
    onBehalfOf = null,
    imageMap = null,
    getSharedDoc,
    // Feature 054 (US3): preview mode. Everything up to the first durable
    // write happens exactly as it would on a real push; nothing after it does.
    dryRun = false,
    // Injectable so suites can pass a double (the undo-service defaultRedisPubSub
    // pattern); production always takes the real module.
    redisPubSub = defaultRedisPubSub,
    // The origin this push's broadcast carries. A distinguishable per-push
    // object rather than the shared sentinel (feature 037), so a changed-range
    // observer watching for THIS push cannot pick up a concurrent one's edits.
    // Every consumer treats it exactly like the sentinel — parseOrigin returns
    // null for it (no unattributed second row) and it is deliberately NOT on
    // the Redis publish skip-list.
    pushOrigin = createSyncPushOrigin(),
  } = opts;

  // Operation-level manual span for the collaboration sync path (feature 014,
  // FR-004): one span per markdown-sync run, attributed with identifiers only.
  return withSpan('collab.operation', { 'document.guid': docGuid, 'collab.operation': 'markdown.sync' }, async () => {
  const baseline = await buildBaseline(persistence, docGuid, baselineClock, { flavor });
  const { fork, fragment, baselineSV, canonicalMd, sourceMap } = baseline;
  try {
    // Resolve ./assets/ image refs back to app URLs (bundle round-trip) before
    // diffing, so unchanged images don't register as edits. Then canonicalize
    // through the FULL staged image policy (F1) so the diff string and every
    // replayed fragment carry only vetted image srcs.
    const resolvedBody = resolveImageRefs(body, imageMap, docGuid);
    const { markdown: pushedMd, blocks: pushedBlocks, images } = await canonicalizePushedStaged(
      resolvedBody, { flavor, imageContext: { docId: docGuid, userId } });

    /**
     * The receipt both no-op short-circuits return. One builder because they
     * are the same receipt reached two ways, and 054 gave them two things to
     * agree on: an empty change report, and the dry-run marker.
     *
     * `blocksChanged: []` is empty rather than absent (FR-010) — a consumer
     * should never have to distinguish "nothing changed" from "this receipt
     * carries no report".
     *
     * Under `dryRun` the `markdown` re-export is skipped entirely, not merely
     * omitted. A dry run is never a baseline (FR-007), and a noop dry run is
     * the case most likely to be mistaken for one: it reports the document as
     * already matching, which is exactly when a client would be tempted to
     * write the receipt back over its file.
     */
    const noopReceipt = async () => {
      const currentClock = await readCurrentClock(persistence, docGuid);
      const receipt = {
        docId: docGuid, mode: 'sync', noop: true, clock: currentClock,
        overlaps: [], operations: { textHunks: 0, structuralHunks: 0 },
        blocksChanged: [],
        images,
      };
      if (dryRun) {
        receipt.dryRun = true;
        return receipt;
      }
      receipt.markdown = await reExport(persistence, docGuid, currentClock, flavor);
      return receipt;
    };

    // No-op short-circuit (FR-009/D7): re-export CURRENT state, store nothing.
    if (pushedMd === canonicalMd) return noopReceipt();

    // Pin the synthetic clientID BEFORE any op is created (FR-011).
    fork.clientID = syntheticClientId(docGuid, baselineClock, sha256(pushedMd));

    const hunks = computeHunks(canonicalMd, pushedMd, sourceMap.blocks, pushedBlocks);
    const plan = planPush(hunks, sourceMap, canonicalMd);
    // Derived from the plan, before it is applied — the report describes the
    // baseline blocks the push would change, and after `applyHunks` runs the
    // fork's block extents no longer correspond to the baseline offsets the
    // excerpts are sliced from.
    const blocksChanged = buildChangeReport(plan, sourceMap, canonicalMd);
    let operations;
    fork.transact(() => {
      operations = applyHunks(fragment, plan, sourceMap, canonicalMd, { flavor });
    });
    const pushUpdate = Y.encodeStateAsUpdate(fork, baselineSV);

    // Idempotency short-circuit (F5): a byte-identical re-push (same baseline,
    // same content → same pinned synthetic clientID → byte-identical update)
    // adds nothing the live doc doesn't already carry. Rather than store a
    // duplicate no-op version row, return the no-op receipt (re-export current).
    if (await pushIsAlreadyApplied(persistence, docGuid, pushUpdate, getSharedDoc)) {
      return noopReceipt();
    }

    // Overlap flags (advisory, FR-012): computed BEFORE our push lands, so the
    // "current" snapshot reflects only concurrent doc-side edits, not our own.
    // Strictly advisory — it must NEVER gate the push (F4). Any failure defaults
    // to no flags plus an explicit overlapsUnavailable marker on the receipt.
    let overlaps = [];
    let overlapsUnavailable = false;
    try {
      overlaps = await detectOverlaps(persistence, docGuid, {
        baselineClock, baselineSV, canonicalMd, plan, sourceMap, getSharedDoc, flavor,
      });
    } catch (err) {
      overlapsUnavailable = true;
      console.error(`[sync] overlap detection failed for ${docGuid}:`, err.message);
    }

    // ---- DRY RUN: the cut point (feature 054, US3/FR-006, research R2) -----
    //
    // Everything above this line is computation — the baseline fork, the image
    // pass, the diff, the plan, and the overlap snapshot. `storeUpdate` on the
    // next line is the first durable write. Returning here is therefore what
    // makes "nothing was applied" true: no stored update, no version entry, no
    // clock advance, no live fan-out, and no search-index dirty mark, because
    // none of those lines are reached. The fork is reclaimed by the `finally`
    // exactly as it is on every other exit.
    //
    // Two independent guards against a preview being mistaken for an applied
    // receipt: the explicit `dryRun: true` marker (absent, not false, on real
    // receipts, so `'dryRun' in receipt` is reliable), and the omitted
    // `markdown` — a client that blindly writes `receipt.markdown` back over
    // its file gets `undefined` rather than a stale baseline.
    //
    // Disclosed exception (RBD-054-11): `canonicalizePushedStaged` above ran
    // the full staged image pass, so a dry run may have rehosted an external
    // image to S3 or copied a cross-document image. That pass is what produces
    // the canonical string the plan is diffed against — skipping it would make
    // the preview predict a different plan than the real call, which is the one
    // outcome a preview must never do. The effects are storage-side and
    // reported in `images` exactly as a real push reports them; the document,
    // its clock, its history, and its viewers are untouched.
    if (dryRun) {
      const receipt = {
        docId: docGuid,
        mode: 'sync',
        dryRun: true,
        noop: false,
        // The document's CURRENT clock. Nothing advanced it; this is not a
        // receipt clock, and the absence of `markdown` is what stops it being
        // read as one.
        clock: await readCurrentClock(persistence, docGuid),
        overlaps,
        blocksChanged,
        operations,
        images,
      };
      if (overlapsUnavailable) receipt.overlapsUnavailable = true;
      return receipt;
    }

    // Store-then-apply (R8): storeUpdate yields the receipt clock AND is the ONE
    // durable row carrying attribution + on-behalf-of provenance (FR-008 single
    // stored update). The broadcast to live editors carries a sync-push origin
    // so the shared doc's persistence listener SKIPS a second (unattri-
    // buted) re-store — unlike restoreVersion, which tolerates the double write
    // because it carries no per-row metadata. Same-instance peers receive the
    // update via the y-websocket broadcast; a sync-push origin (unlike the
    // ORIGIN_DB_LOAD sync used before F3) is NOT on the Redis publish skip-list,
    // so OTHER instances holding the doc get the cross-instance fan-out too.
    // [ledger: sync single-row]
    const clock = await persistence.storeUpdate(
      docGuid, pushUpdate, userId, agentName, sanitizeOnBehalfOf(onBehalfOf));
    // One shared broadcast path (feature 037): applyLiveUpdate applies here
    // exactly as the inline call did, AND publishes when this instance holds no
    // attached Redis handler — the connection-less-instance hole. Its H1 guard
    // keeps that from double-sending when a handler IS attached (a sync-push
    // origin is deliberately off the publish skip-list, so the handler
    // publishes), and it warns rather than going silent when there is no
    // delivery path at all.
    // Non-fatal throughout — the update is already persisted.
    applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, pushUpdate, pushOrigin, 'sync');
    // The push changed document content — mark the search index dirty (the
    // listener would have, but we suppressed it via the sentinel origin).
    try { searchIndexer.markDirty(docGuid); } catch { /* uninitialized in tests */ }

    // Receipt re-export: current state atomically (may exceed the receipt clock
    // under concurrent edits — contract Consistency rule).
    const currentClock = await readCurrentClock(persistence, docGuid);
    const markdown = await reExport(persistence, docGuid, currentClock, flavor);

    // `operations` stays alongside `blocksChanged` (RBD-054-5): it counts
    // HUNKS, the report counts BLOCKS, and the two need not agree — several
    // hunks inside one block yield one entry, and one coalesced structural
    // group spans several. Removing the aggregate would break every existing
    // consumer for no gain.
    const receipt = {
      docId: docGuid, mode: 'sync', noop: false, clock, markdown,
      overlaps, blocksChanged, operations, images,
    };
    if (overlapsUnavailable) receipt.overlapsUnavailable = true;
    return receipt;
  } finally {
    fork.destroy();
  }
  });
}

module.exports = {
  SYNC_AGENT_NAME,
  sanitizeOnBehalfOf,
  setOverlapDetector,
  applySyncPush,
  validateSyncBaseline,
  reExport,
  readCurrentClock,
  // T013
  detectOverlaps: defaultDetectOverlaps,
  docSideChanges,
  pushTouchedBlocks,
  // 054 (US2)
  buildChangeReport,
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
  canonicalizePushedWithBlocks,
  canonicalizePushedStaged,
  resolveImageRefs,
  mdToNodes,
  // T007
  computeHunks,
  planPush,
  // 055 — block-alignment pre-pass
  blockSimilarity,
  alignBlocks,
  emitForcedHunks,
  SIMILARITY_THRESHOLD,
  MAX_GAP_DP_CELLS,
  MAX_EDIT_LENGTH,
  // T008
  applyHunks,
  reconcileTextNode,
};
