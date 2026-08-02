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
 *   2. Walk each side ONCE, emitting the plain text the parser produced
 *      (inline-content blocks joined by '\n') together with the start offset
 *      of every text node in it.
 *   3. computeWordSegments on the two plain texts (the SAME shared helper the
 *      chat surface uses — SC-003).
 *   4. Re-walk each side in the same order, splitting its text nodes at the
 *      segment boundaries using the offsets from step 2, stamping strong marks
 *      on changed ranges and subtle marks elsewhere, preserving each node's
 *      existing formatting marks. The inter-block '\n' belongs to no text node.
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
 * ONE walk of a parsed doc, producing both products the refinement needs:
 * the plain text the segmenter compares, and the start offset of every text
 * node in that text.
 *
 * Feature 042 (FR-011) merged this out of two hand-synchronized traversals —
 * a `plainTextOf` that built the string and a `stampSide` that re-derived the
 * same offsets while rewriting nodes. They had to walk in *identical* order
 * with *identical* arithmetic or every mark landed on the wrong characters,
 * and nothing but the pin tests enforced that. Now the offsets are computed
 * once and consumed in the same traversal order, so the two products are
 * index-consistent by construction.
 *
 * Traversal rule (unchanged): text nodes in document order, inline-content
 * blocks joined by '\n'. Inline non-text nodes (hardBreak) contribute no text
 * and no offset — which is why a hard break fuses the words either side of it
 * into one diff token (a preserved quirk, see the module header).
 *
 * @param {object} doc - strict-parsed ProseMirror JSON
 * @returns {{text: string, offsets: number[]}} `offsets[i]` is the start of the
 *   i-th text node, in the order a matching walk will encounter them
 */
function walkTextNodes(doc) {
  const parts = [];
  const offsets = [];
  let cursor = 0;
  let blockIndex = 0;

  const visit = (node) => {
    if (!node || !Array.isArray(node.content)) return;
    if (isTextBlock(node)) {
      if (blockIndex > 0) {
        parts.push('\n'); // the inter-block separator, owned by no text node
        cursor += 1;
      }
      blockIndex += 1;
      for (const child of node.content) {
        if (child.type !== 'text') continue;
        offsets.push(cursor);
        parts.push(child.text);
        cursor += child.text.length;
      }
    } else {
      for (const child of node.content) visit(child);
    }
  };

  visit(doc);
  return { text: parts.join(''), offsets };
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
 * Stamp one side's parsed doc, returning its refined top-level blocks.
 *
 * Consumes the offsets `walkTextNodes` already computed, in the same traversal
 * order, rather than re-deriving them. That is the whole point of the FR-011
 * merge: there is now exactly one place that decides where a text node starts,
 * so the marks cannot drift away from the text the segmenter measured.
 *
 * @param {object} doc - the parsed doc that produced `walk`
 * @param {{offsets: number[]}} walk - this side's `walkTextNodes` result
 */
function stampSide(doc, walk, segments, side) {
  const boundaries = segmentsToBoundaries(segments);
  const { offsets } = walk;
  let nodeIndex = 0;

  const transform = (node) => {
    if (!Array.isArray(node.content)) return node;

    if (isTextBlock(node)) {
      const newContent = [];
      for (const child of node.content) {
        if (child.type === 'text') {
          newContent.push(...splitTextNode(child, offsets[nodeIndex], boundaries, side));
          nodeIndex += 1;
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
 * @param {object} [report] - optional degradation sink (feature 039, FR-006),
 *   forwarded verbatim to the segmenter so the diff service can tell a
 *   deterministic size cap from a load-dependent timeout and decide whether the
 *   comparison may be cached. Purely out of band: omit it and behavior is
 *   unchanged, and it never affects what this function returns.
 * @returns {Array<object>} refined removed blocks followed by refined added blocks
 */
function lineLevelFallback(removedMd, addedMd) {
  const removed = markdownToPm(removedMd, 'diffDelete', STRICT);
  const added = markdownToPm(addedMd, 'diffInsert', STRICT);
  return [...(removed.content || []), ...(added.content || [])];
}

function applyWordMarks(removedMd, addedMd, report) {
  try {
    const removedDoc = markdownToPm(removedMd, null, STRICT);
    const addedDoc = markdownToPm(addedMd, null, STRICT);

    const removedWalk = walkTextNodes(removedDoc);
    const addedWalk = walkTextNodes(addedDoc);

    const segs = wordDiff.computeWordSegments(removedWalk.text, addedWalk.text, report);
    if (!segs) {
      // Oversized or slow region (size cap / diff timeout): expected
      // degradation, not an error — line-level marks, no log.
      return lineLevelFallback(removedMd, addedMd);
    }

    const removedBlocks = stampSide(removedDoc, removedWalk, segs.before, 'delete');
    const addedBlocks = stampSide(addedDoc, addedWalk, segs.after, 'insert');
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
