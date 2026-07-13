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
const { reconstructImages, sanitizeLinkMarks } = require('./markdown-import');
const { ORIGIN_DB_LOAD } = require('./origin');
const searchIndexer = require('./search-indexer');

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

/** Parse a markdown fragment into detached Yjs nodes (import canonicalization). */
function mdToNodes(md) {
  if (md.trim() === '') return [];
  let pm = markdownToPm(md);
  pm = reconstructImages(pm);
  pm = sanitizeLinkMarks(pm);
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

/**
 * Character-diff baseline vs pushed canonical markdown into anchored hunks
 * `{ oldStart, oldEnd, newText }` in BASELINE coordinates (adjacency-0
 * clustering), then coalesce near-adjacent hunks that stay within one block.
 */
function computeHunks(baselineMd, pushedMd) {
  let parts = null;
  if (baselineMd.length + pushedMd.length <= COARSE_INPUT_THRESHOLD) {
    parts = diffChars(baselineMd, pushedMd, { maxEditLength: MAX_EDIT_LENGTH });
  }
  if (!parts) {
    // Large input or cap exceeded (R11): coarse line-level hunking, then
    // character diff within small changed line clusters only. Bounded work.
    parts = coarseDiff(baselineMd, pushedMd);
  }
  const raw = [];
  let oldPos = 0;
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

/** Coarse fallback: diffLines, then diffChars within SMALL changed line clusters (R11). */
function coarseDiff(baselineMd, pushedMd) {
  const lineParts = diffLines(baselineMd, pushedMd);
  const out = [];
  for (let i = 0; i < lineParts.length; i++) {
    const p = lineParts[i];
    if (!p.added && !p.removed) { out.push({ value: p.value }); continue; }
    if (p.removed && lineParts[i + 1] && lineParts[i + 1].added) {
      const add = lineParts[i + 1];
      let sub = null;
      if (p.value.length <= COARSE_CLUSTER_MAX && add.value.length <= COARSE_CLUSTER_MAX) {
        sub = diffChars(p.value, add.value, { maxEditLength: MAX_EDIT_LENGTH });
      }
      if (sub) { for (const s of sub) out.push(s); }
      else { out.push({ removed: true, value: p.value }); out.push({ added: true, value: add.value }); }
      i++;
    } else {
      out.push(p);
    }
  }
  return out;
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

/** Reconcile a Y.XmlText's content to `targetDelta` with minimal text ops + reformat. */
function reconcileTextNode(textNode, targetDelta) {
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
    textNode.format(0, len, CLEAR_ATTRS);
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
function applyHunks(fragment, plan, sourceMap, baselineMd) {
  const { textBlocks, reconcileBlocks, structural } = plan;
  const { replacements, insertions } = structuralOps(structural, sourceMap, baselineMd);

  // Blocks replaced structurally — skip in-block edits that land inside them.
  const replacedNodes = new Set();
  for (const g of replacements) {
    for (let i = g.first; i <= g.last; i++) replacedNodes.add(sourceMap.blocks[i].blockNode);
  }

  // 1) Whole-block inline reconciliations (in place).
  for (const rec of reconcileBlocks) {
    if (replacedNodes.has(rec.block.blockNode)) continue;
    reconcileTextNode(rec.textNode, rec.targetDelta);
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

/** First ~80 chars of a block's text content, whitespace-collapsed, plain. */
function blockExcerpt(md) {
  return md.replace(/\s+/g, ' ').trim().slice(0, 80);
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
        blockType: b.blockNode instanceof Y.XmlElement ? b.blockNode.nodeName : 'text',
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
 * state, read atomically as getYDocAtClock(clock)).
 */
async function reExport(persistence, docGuid, clock, flavor) {
  const stateDoc = await persistence.getYDocAtClock(docGuid, clock);
  try {
    const fragment = stateDoc.get('default', Y.XmlFragment);
    const lossy = new Set();
    const body = toMarkdown(fragment, { flavor, lossy });
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
  } = opts;

  const baseline = await buildBaseline(persistence, docGuid, baselineClock, { flavor });
  const { fork, fragment, baselineSV, canonicalMd, sourceMap } = baseline;
  try {
    // Resolve ./assets/ image refs back to app URLs (bundle round-trip) before
    // diffing, so unchanged images don't register as edits.
    const resolvedBody = resolveImageRefs(body, imageMap, docGuid);
    const pushedMd = canonicalizePushed(resolvedBody, { flavor });

    // No-op short-circuit (FR-009/D7): re-export CURRENT state, store nothing.
    if (pushedMd === canonicalMd) {
      const currentClock = await readCurrentClock(persistence, docGuid);
      const markdown = await reExport(persistence, docGuid, currentClock, flavor);
      return {
        docId: docGuid, mode: 'sync', noop: true, clock: currentClock,
        markdown, overlaps: [], operations: { textHunks: 0, structuralHunks: 0 },
      };
    }

    // Pin the synthetic clientID BEFORE any op is created (FR-011).
    fork.clientID = syntheticClientId(docGuid, baselineClock, sha256(pushedMd));

    const hunks = computeHunks(canonicalMd, pushedMd);
    const plan = planPush(hunks, sourceMap, canonicalMd);
    let operations;
    fork.transact(() => {
      operations = applyHunks(fragment, plan, sourceMap, canonicalMd);
    });
    const pushUpdate = Y.encodeStateAsUpdate(fork, baselineSV);

    // Overlap flags (advisory, FR-012): computed BEFORE our push lands, so the
    // "current" snapshot reflects only concurrent doc-side edits, not our own.
    const overlaps = await detectOverlaps(persistence, docGuid, {
      baselineClock, baselineSV, canonicalMd, plan, sourceMap, getSharedDoc, flavor,
    });

    // Store-then-apply (R8): storeUpdate yields the receipt clock AND is the ONE
    // durable row carrying attribution + on-behalf-of provenance (FR-008 single
    // stored update). The broadcast to live editors uses the ORIGIN_DB_LOAD
    // sentinel so the shared doc's persistence listener SKIPS a second (unattri-
    // buted) re-store — unlike restoreVersion, which tolerates the double write
    // because it carries no per-row metadata. Peers still receive the update
    // (y-websocket broadcast is origin-independent). [ledger: sync single-row]
    const clock = await persistence.storeUpdate(
      docGuid, pushUpdate, userId, agentName, sanitizeOnBehalfOf(onBehalfOf));
    try {
      const sharedDoc = getSharedDoc(docGuid);
      if (sharedDoc) Y.applyUpdate(sharedDoc, pushUpdate, ORIGIN_DB_LOAD);
    } catch (err) {
      // Broadcast failure is non-fatal — the update is already persisted.
      console.error(`[sync] broadcast to shared doc ${docGuid} failed:`, err.message);
    }
    // The push changed document content — mark the search index dirty (the
    // listener would have, but we suppressed it via the sentinel origin).
    try { searchIndexer.markDirty(docGuid); } catch { /* uninitialized in tests */ }

    // Receipt re-export: current state atomically (may exceed the receipt clock
    // under concurrent edits — contract Consistency rule).
    const currentClock = await readCurrentClock(persistence, docGuid);
    const markdown = await reExport(persistence, docGuid, currentClock, flavor);

    return { docId: docGuid, mode: 'sync', noop: false, clock, markdown, overlaps, operations };
  } finally {
    fork.destroy();
  }
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
  resolveImageRefs,
  mdToNodes,
  // T007
  computeHunks,
  planPush,
  // T008
  applyHunks,
  reconcileTextNode,
};
