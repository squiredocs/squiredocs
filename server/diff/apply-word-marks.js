/**
 * Word-level refinement for the version-history diff (feature 022, US2).
 *
 * Refines a single replace region (a removed markdown chunk immediately
 * followed by an added chunk) into two-tier diff-marked ProseMirror blocks:
 * unchanged words keep the subtle whole-line marks (diffDelete/diffInsert),
 * changed words get the strong word marks (diffDeleteWord/diffInsertWord).
 *
 * The characterization-frozen strict parser (CN-2 / FR-008) is NOT modified —
 * we post-process its ProseMirror JSON output:
 *   1. Parse both sides UNMARKED (strict).
 *   2. Concatenate each side's text-node text, inline-content blocks joined by
 *      '\n', to get the plain text the parser emitted.
 *   3. computeWordSegments on the two plain texts (the SAME shared helper the
 *      chat surface uses — SC-003).
 *   4. Walk each side's text nodes tracking a char offset, split them at
 *      segment boundaries, stamp strong marks on changed ranges and subtle
 *      marks elsewhere, preserving each node's existing formatting marks.
 *      The inter-block '\n' belongs to no text node and is skipped by the walk.
 *
 * Fail-open (RBD-3 / FR-012): any error degrades the WHOLE region to today's
 * line-level marking. It never throws out of computeMarkdownDiff and never
 * caches a broken diff.
 *
 * CommonJS to match the diff service and shared/markdown/*.
 */

const { markdownToPm } = require('../../shared/markdown');
// Namespace import on purpose: the refinement calls wordDiff.computeWordSegments
// via the module namespace so tests can inject failures via jest.spyOn (same
// pattern as undo-service ↔ diff-utils).
const wordDiff = require('../../shared/diff/word-diff');

const STRICT = { strict: true };

let loggedOnce = false;

/**
 * A node has inline content (is a "textblock") when it directly contains one or
 * more text nodes. In the shared schema, textblocks (paragraph, heading,
 * codeBlock) hold only inline content, and container blocks (lists, blockquote,
 * table…) hold only block content, so this cleanly distinguishes the two.
 */
function isTextBlock(node) {
  return Array.isArray(node.content) && node.content.some((c) => c.type === 'text');
}

/**
 * Concatenate a doc's plain text exactly as the offset walk will consume it:
 * text nodes in document order, inline-content blocks joined by '\n'.
 */
function plainTextOf(doc) {
  const blocks = [];
  const collect = (node) => {
    if (!node || !Array.isArray(node.content)) return;
    if (isTextBlock(node)) {
      blocks.push(node.content.filter((c) => c.type === 'text').map((c) => c.text).join(''));
    } else {
      for (const child of node.content) collect(child);
    }
  };
  collect(doc);
  return blocks.join('\n');
}

/** Convert coalesced segments into contiguous [start, end, changed) ranges. */
function segmentsToBoundaries(segments) {
  const boundaries = [];
  let cursor = 0;
  for (const seg of segments) {
    const len = seg.text.length;
    if (len > 0) boundaries.push({ start: cursor, end: cursor + len, changed: seg.changed });
    cursor += len;
  }
  return boundaries;
}

/**
 * Split one text node (covering [nodeStart, nodeStart+len)) into pieces along
 * the boundary ranges, stamping the appropriate diff mark on each piece and
 * preserving the node's existing formatting marks (diff mark applied LAST,
 * matching the strict parser's diff-mark placement).
 */
function splitTextNode(node, nodeStart, boundaries, side) {
  const text = node.text;
  const nodeEnd = nodeStart + text.length;
  const existing = Array.isArray(node.marks) ? node.marks : [];
  const strongMark = side === 'delete' ? 'diffDeleteWord' : 'diffInsertWord';
  const subtleMark = side === 'delete' ? 'diffDelete' : 'diffInsert';
  const pieces = [];
  for (const b of boundaries) {
    const s = Math.max(b.start, nodeStart);
    const e = Math.min(b.end, nodeEnd);
    if (s >= e) continue;
    const markName = b.changed ? strongMark : subtleMark;
    pieces.push({
      type: 'text',
      text: text.slice(s - nodeStart, e - nodeStart),
      marks: [...existing, { type: markName }],
    });
  }
  return pieces;
}

/**
 * Stamp one side's parsed doc, returning its refined top-level blocks. Walks in
 * the identical order used by plainTextOf so char offsets align by construction.
 */
function stampSide(doc, segments, side) {
  const boundaries = segmentsToBoundaries(segments);
  let offset = 0;
  let blockIndex = 0;

  const transform = (node) => {
    if (!Array.isArray(node.content)) return node;

    if (isTextBlock(node)) {
      if (blockIndex > 0) offset += 1; // the inter-block '\n'
      blockIndex += 1;
      const newContent = [];
      for (const child of node.content) {
        if (child.type === 'text') {
          newContent.push(...splitTextNode(child, offset, boundaries, side));
          offset += child.text.length;
        } else {
          newContent.push(child); // inline non-text (e.g. hardBreak): no offset
        }
      }
      return { ...node, content: newContent };
    }

    return { ...node, content: node.content.map(transform) };
  };

  return (doc.content || []).map(transform);
}

/**
 * Refine a replace region into two-tier diff-marked blocks.
 *
 * @param {string} removedMd - the removed side of the region (prev markdown)
 * @param {string} addedMd - the added side of the region (curr markdown)
 * @returns {Array<object>} refined removed blocks followed by refined added blocks
 */
function lineLevelFallback(removedMd, addedMd) {
  const removed = markdownToPm(removedMd, 'diffDelete', STRICT);
  const added = markdownToPm(addedMd, 'diffInsert', STRICT);
  return [...(removed.content || []), ...(added.content || [])];
}

function applyWordMarks(removedMd, addedMd) {
  try {
    const removedDoc = markdownToPm(removedMd, null, STRICT);
    const addedDoc = markdownToPm(addedMd, null, STRICT);

    const plainRemoved = plainTextOf(removedDoc);
    const plainAdded = plainTextOf(addedDoc);

    const segs = wordDiff.computeWordSegments(plainRemoved, plainAdded);
    if (!segs) {
      // Oversized or slow region (size cap / diff timeout): expected
      // degradation, not an error — line-level marks, no log.
      return lineLevelFallback(removedMd, addedMd);
    }

    const removedBlocks = stampSide(removedDoc, segs.before, 'delete');
    const addedBlocks = stampSide(addedDoc, segs.after, 'insert');
    return [...removedBlocks, ...addedBlocks];
  } catch (err) {
    // Fail-open: degrade the region to today's line-level marks (RBD-3/FR-012).
    if (!loggedOnce) {
      loggedOnce = true;
      console.error('[apply-word-marks] refinement failed, using line-level marks:', err.message);
    }
    return lineLevelFallback(removedMd, addedMd);
  }
}

module.exports = { applyWordMarks };
