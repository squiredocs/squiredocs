/**
 * Server-side diff computation service.
 *
 * Computes document diffs by building two Y.Doc instances from scratch
 * and using markdown-based diffing to produce annotated ProseMirror documents.
 *
 * Benefits:
 * - Consistent CRDT structure (no snapshot view inconsistencies)
 * - Pre-computed diffs reduce client-side work
 * - Redis caching for repeated version views
 */

const Y = require('yjs');
const { yXmlFragmentToProseMirrorRootNode } = require('y-prosemirror');
const { diffLines } = require('diff');
const { schema } = require('../shared/prosemirror-schema');
const { getRedisClient, isRedisEnabled } = require('./redis');
const { toMarkdown } = require('./mcp/yjs/serialization');
const { markdownToPm } = require('../shared/markdown');
const { applyWordMarks } = require('./diff/apply-word-marks');
const { extractXml, extractText } = require('./yjs-utils');

// Bumped v8 -> v9 for feature 023: pre-023 entries could have been computed and
// frozen from a gap-tolerant-but-still-gapped row set; a clean cut discards them
// (post-023 entries are only ever written gap-free — see computeDiff).
const CACHE_VERSION = 'v9';

class DiffService {
  /**
   * @param {import('./postgres-persistence').PostgresPersistence} persistence -
   *   the persistence provider; the diff row fetch funnels through its
   *   gap-tolerant `getUpdateRowsUpTo` (023 FR-007/FR-009) rather than an inline
   *   pool query, so a torn read is never frozen into the cache.
   */
  constructor(persistence) {
    this.persistence = persistence;
  }

  /**
   * Compute diff between two clock positions.
   *
   * @param {string} docGuid - Document GUID
   * @param {number} previousClock - Clock of previous state (-1 for empty)
   * @param {number} currentClock - Clock of current state
   * @returns {Promise<{document: object, changes: Array, meta: object}>}
   */
  async computeDiff(docGuid, previousClock, currentClock) {
    // Check cache first
    const cacheKey = `diff${CACHE_VERSION}:${docGuid}:${previousClock}:${currentClock}`;
    if (isRedisEnabled()) {
      try {
        const cached = await getRedisClient().get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch (err) {
        console.error('[DiffService] Redis cache read error:', err.message);
      }
    }

    // Fetch updates up to the later clock (no need to load future updates)
    // through the gap-tolerant choke point. `gapped` tells us the row set was
    // torn even after the retry budget — we still serve the diff, but must not
    // freeze it into the cache (023 FR-009, D-2).
    const { rows: updates, gapped } = await this.persistence.getUpdateRowsUpTo(docGuid, currentClock);

    // Build two Y.Docs from scratch
    const { prevDoc, currDoc, prevText, currText } = this.buildDocsAtClocks(
      updates,
      previousClock,
      currentClock
    );

    // Check if text is identical (no visible changes)
    const textIdentical = prevText === currText;

    // Detect formatting-only changes (text identical but XML differs)
    const formattingOnly = textIdentical && extractXml(prevDoc) !== extractXml(currDoc);

    // Plain current document (no diff marks) for non-diff viewing
    const currPmDoc = this.yDocToProseMirror(currDoc);
    const currentDocument = currPmDoc ? currPmDoc.toJSON() : { type: 'doc', content: [] };

    // Build diff document using markdown-based approach
    let document;
    let diffFailed = false;
    try {
      document = this.computeMarkdownDiff(prevDoc, currDoc, textIdentical);
    } catch (err) {
      console.error('[DiffService] Markdown diff failed, using plain document:', err.message);
      document = currentDocument;
      diffFailed = true;
    }

    // Cleanup Yjs docs
    prevDoc.destroy();
    currDoc.destroy();

    const result = {
      document,
      currentDocument,
      meta: {
        previousClock,
        currentClock,
        textIdentical,
        formattingOnly,
        diffFailed,
      },
    };

    // Cache result (historical versions are immutable) — UNLESS the row set was
    // still gapped after the retry budget: a diff computed from a torn read must
    // never be frozen as truth. The next request recomputes from a healed log
    // (023 FR-009, D-2). Gap-free requests cache exactly as before.
    if (isRedisEnabled() && !gapped) {
      try {
        await getRedisClient().setex(cacheKey, 3600, JSON.stringify(result));
      } catch (err) {
        console.error('[DiffService] Redis cache write error:', err.message);
      }
    }

    return result;
  }

  /**
   * Build two Y.Doc instances by applying updates sequentially.
   *
   * @param {Array<{clock: number, update_data: Buffer}>} updates - Updates from DB
   * @param {number} previousClock - Clock for previous state
   * @param {number} currentClock - Clock for current state
   * @returns {{prevDoc: Y.Doc, currDoc: Y.Doc, prevText: string, currText: string}}
   */
  buildDocsAtClocks(updates, previousClock, currentClock) {
    const prevDoc = new Y.Doc({ gc: false });
    const currDoc = new Y.Doc({ gc: false });

    for (const row of updates) {
      const updateData = new Uint8Array(row.update_data);

      // Apply to prevDoc if clock <= previousClock
      if (previousClock >= 0 && row.clock <= previousClock) {
        Y.applyUpdate(prevDoc, updateData);
      }

      // Apply to currDoc if clock <= currentClock
      if (row.clock <= currentClock) {
        Y.applyUpdate(currDoc, updateData);
      }
    }

    return {
      prevDoc,
      currDoc,
      prevText: extractText(prevDoc),
      currText: extractText(currDoc),
    };
  }

  /**
   * Convert Y.Doc to ProseMirror document.
   *
   * @param {Y.Doc} yDoc - Yjs document
   * @returns {import('prosemirror-model').Node|null} ProseMirror document
   */
  yDocToProseMirror(yDoc) {
    try {
      const fragment = yDoc.get('default', Y.XmlFragment);
      if (!fragment || fragment.length === 0) {
        return schema.topNodeType.createAndFill();
      }
      return yXmlFragmentToProseMirrorRootNode(fragment, schema);
    } catch (error) {
      console.error('[DiffService] Error converting Yjs to ProseMirror:', error);
      return null;
    }
  }

  /**
   * Compute a ProseMirror document JSON with diff marks by diffing markdown.
   *
   * @param {Y.Doc} prevDoc - Previous Y.Doc
   * @param {Y.Doc} currDoc - Current Y.Doc
   * @param {boolean} textIdentical - Whether plain text is identical
   * @returns {object} ProseMirror document JSON with diffInsert/diffDelete marks
   */
  computeMarkdownDiff(prevDoc, currDoc, textIdentical) {
    const prevFragment = prevDoc.get('default', Y.XmlFragment);
    const currFragment = currDoc.get('default', Y.XmlFragment);

    const prevMd = toMarkdown(prevFragment);
    const currMd = toMarkdown(currFragment);

    // If markdown is identical, return current doc without marks
    if (prevMd === currMd) {
      const pmDoc = this.yDocToProseMirror(currDoc);
      return pmDoc ? pmDoc.toJSON() : { type: 'doc', content: [{ type: 'paragraph' }] };
    }

    // Diff the markdown line by line
    const parts = diffLines(prevMd, currMd);

    // Build annotated ProseMirror document from diff parts. A replace region
    // (a `removed` part immediately followed by an `added` part) is refined to
    // word-level two-tier marks (feature 022); lone added/removed and unchanged
    // parts stay exactly as before.
    const allBlocks = [];
    for (let idx = 0; idx < parts.length; idx++) {
      const part = parts[idx];
      const md = part.value;
      if (part.removed && idx + 1 < parts.length && parts[idx + 1].added) {
        // Replace region → word-level refinement (fail-open inside applyWordMarks).
        allBlocks.push(...applyWordMarks(md, parts[idx + 1].value));
        idx += 1; // consume the paired added part
      } else if (part.added) {
        const parsed = markdownToPm(md, 'diffInsert', { strict: true });
        allBlocks.push(...(parsed.content || []));
      } else if (part.removed) {
        const parsed = markdownToPm(md, 'diffDelete', { strict: true });
        allBlocks.push(...(parsed.content || []));
      } else {
        // Unchanged — parse without diff mark
        const parsed = markdownToPm(md, null, { strict: true });
        allBlocks.push(...(parsed.content || []));
      }
    }

    if (allBlocks.length === 0) {
      allBlocks.push({ type: 'paragraph' });
    }

    return { type: 'doc', content: allBlocks };
  }
}

module.exports = DiffService;
module.exports.CACHE_VERSION = CACHE_VERSION;
