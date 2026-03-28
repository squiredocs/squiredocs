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
const { markdownToPm } = require('./markdown-to-pm');
const { extractXml, extractText } = require('./yjs-utils');

const CACHE_VERSION = 'v6';

class DiffService {
  constructor(pool) {
    this.pool = pool;
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

    // Fetch all updates from database
    const client = await this.pool.connect();
    let updates;
    try {
      const result = await client.query(
        'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
        [docGuid]
      );
      updates = result.rows;
    } finally {
      client.release();
    }

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
    try {
      document = this.computeMarkdownDiff(prevDoc, currDoc, textIdentical);
    } catch (err) {
      console.error('[DiffService] Markdown diff failed, using plain document:', err.message);
      document = currentDocument;
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
      },
    };

    // Cache result (historical versions are immutable)
    if (isRedisEnabled()) {
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

    // Build annotated ProseMirror document from diff parts
    const allBlocks = [];
    for (const part of parts) {
      const md = part.value;
      if (part.added) {
        const parsed = markdownToPm(md, 'diffInsert');
        allBlocks.push(...(parsed.content || []));
      } else if (part.removed) {
        const parsed = markdownToPm(md, 'diffDelete');
        allBlocks.push(...(parsed.content || []));
      } else {
        // Unchanged — parse without diff mark
        const parsed = markdownToPm(md, null);
        allBlocks.push(...(parsed.content || []));
      }
    }

    if (allBlocks.length === 0) {
      allBlocks.push({ type: 'paragraph' });
    }

    return { type: 'doc', content: allBlocks };
  }

  /**
   * Invalidate cached diffs for a document.
   * Call this when new updates are added (though historical diffs remain valid).
   *
   * @param {string} docGuid - Document GUID
   */
  async invalidateCache(docGuid) {
    if (!isRedisEnabled()) return;

    try {
      const redis = getRedisClient();
      const keys = await redis.keys(`diff*:${docGuid}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.error('[DiffService] Cache invalidation error:', err.message);
    }
  }
}

module.exports = DiffService;
module.exports.CACHE_VERSION = CACHE_VERSION;
