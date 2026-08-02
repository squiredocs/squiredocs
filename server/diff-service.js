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

// Bumped v9 -> v10 for feature 039 (FR-007). Pre-039 entries are discarded for
// two independent reasons:
//   1. They may be TAIL-GAP-POISONED. Pre-039 the completeness check only looked
//      for gaps *within* the fetched rows; a read that simply stopped short of
//      the requested newest version looked contiguous and cached clean, freezing
//      a diff that silently omits the newest version for a full TTL.
//   2. They were shaped by the PRE-PARITY algorithms — the chat surface's
//      positional row pairing and the regex-based plain-text extractor — so
//      their word emphasis and `formattingOnly` flags no longer match what this
//      code computes.
// Old entries are never read again and expire naturally; there is no purge job.
// THIS IS THE ONLY BUMP IN FEATURE 039 — do not bump again for a later change.
const CACHE_VERSION = 'v10';

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
   * @returns {Promise<{document: object, currentDocument: object, meta: object}>}
   *   `document` is the diff-annotated ProseMirror doc (or the plain current doc
   *   when the diff failed); `currentDocument` is the plain current doc, which
   *   the preview swaps in when highlights are off; `meta` carries
   *   `{ previousClock, currentClock, textIdentical, formattingOnly, diffFailed }`.
   *   There is no `changes` array — decorations were replaced by baked-in
   *   diffInsert/diffDelete marks; the JSDoc had not caught up (042, FR-016).
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
    // through the gap-tolerant choke point.
    //
    // `expectedTailClock: currentClock` (039 FR-003) says "this read is only
    // complete if it actually reaches version `currentClock`". Without it, a
    // read that stopped SHORT of the newest version looked perfectly contiguous
    // — `_findFirstGap` only judges gaps *between* fetched rows — so a diff
    // missing the very version the user asked to see cached clean and froze for
    // an hour. `gapped` now means INCOMPLETE: an internal gap OR a short tail
    // (extends 023 FR-009 / D-2). We still SERVE the diff either way; we just
    // never freeze it.
    const { rows: updates, gapped } = await this.persistence.getUpdateRowsUpTo(
      docGuid,
      currentClock,
      { expectedTailClock: currentClock }
    );

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

    // Per-request degradation sink (039 FR-006). MUST be created here, per call:
    // module-level state would leak one request's degradation into another's
    // cacheability decision under concurrency.
    //
    // ACCUMULATING and never reset. `computeMarkdownDiff` calls `applyWordMarks`
    // once per replace region against this one shared sink, so a last-write-wins
    // field would let a later clean region erase an earlier timeout — and cache
    // a comparison FR-005(c) forbids caching.
    const report = { timedOut: false };

    // Build diff document using markdown-based approach
    let document;
    let diffFailed = false;
    try {
      document = this.computeMarkdownDiff(prevDoc, currDoc, report, currPmDoc);
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

    // ---- Cache-write gate (039 FR-005) -------------------------------------
    // Historical versions are immutable, so a comparison may be frozen for an
    // hour — but ONLY when it is provably complete, successful, and
    // deterministic. Each term below is a VETO, never a trade-off: a result
    // failing any of them is still SERVED to the requester exactly as before
    // (CD-2 — no new UI state), it is simply not written, so the next request
    // recomputes and can self-heal.
    //
    // (a) FR-005a — the row set was incomplete (internal gap OR short of the
    //     requested newest version). Caching here freezes a diff of the wrong
    //     document state. Extends 023 FR-009 / D-2.
    const rowsIncomplete = gapped;
    // (b) FR-005b — the computation threw and we fell back to the plain current
    //     document. Caching a failure froze the "Diff highlighting unavailable"
    //     notice for a full hour with no retry path, even though the failure was
    //     usually transient (audit finding F8).
    const diffFailedFlag = result.meta.diffFailed;
    // (c) FR-005c — word segmentation hit the WALL-CLOCK time budget somewhere.
    //     This is load-dependent: the same version pair yields word-level
    //     emphasis on a quieter run, so freezing the degraded render makes the
    //     downgrade permanent and arbitrary. A `size` degradation is deliberately
    //     NOT here (CW-2): MAX_SIDE_CHARS is a pure function of the inputs, so
    //     the line-level result is the correct, reproducible answer and caching
    //     it is right. Whole-result granularity (CD-4): any timed-out region
    //     makes the entire comparison uncacheable.
    const timeoutDegraded = report.timedOut;

    const cacheable = isRedisEnabled() && !rowsIncomplete && !diffFailedFlag && !timeoutDegraded;
    if (cacheable) {
      try {
        await getRedisClient().setex(cacheKey, 3600, JSON.stringify(result));
      } catch (err) {
        // CW-5: transport errors are non-fatal and never change what is served.
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
    // `gc: false` on BOTH docs is load-bearing, not stylistic (SR-2): it keeps
    // deleted structs in the document, which is what lets the seed below carry
    // the full history across and makes the single-replay output byte-identical
    // to the old double-replay. Do not "optimize" it away.
    const prevDoc = new Y.Doc({ gc: false });
    const currDoc = new Y.Doc({ gc: false });

    // Single replay (039 FR-015). Previously every row with clock <= previousClock
    // was applied TWICE — once to each doc — so a comparison deep in a long
    // history replayed almost the whole log two times. Instead: build prevDoc,
    // then SEED currDoc from prevDoc's state in one merge, then apply only the
    // rows in (previousClock, currentClock]. CRDT convergence guarantees the
    // result is identical (SR-3); each row is now applied at most once (SR-1).
    if (previousClock >= 0) {
      for (const row of updates) {
        if (row.clock <= previousClock) {
          Y.applyUpdate(prevDoc, new Uint8Array(row.update_data));
        }
      }
      // Additive CRDT merge, never a delete-and-recreate (constitution IV).
      Y.applyUpdate(currDoc, Y.encodeStateAsUpdate(prevDoc));
      for (const row of updates) {
        if (row.clock > previousClock && row.clock <= currentClock) {
          Y.applyUpdate(currDoc, new Uint8Array(row.update_data));
        }
      }
    } else {
      // SR-4: previousClock < 0 is the empty-state case — prevDoc stays empty,
      // so there is nothing to seed from and currDoc replays directly. This is
      // exactly the old behavior for this branch.
      for (const row of updates) {
        if (row.clock <= currentClock) {
          Y.applyUpdate(currDoc, new Uint8Array(row.update_data));
        }
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
   * @param {{timedOut: boolean}} [report] - optional per-request degradation
   *   sink (039 FR-006), threaded into each replace region's word segmentation.
   *   Accumulating: only ever set to true, never reset, so one region's timeout
   *   cannot be erased by a later region. Omit it and behavior is unchanged.
   *
   *   NOTE: this parameter REPLACED a declared-but-never-read `textIdentical`
   *   boolean (039 FR-017). The function derives that answer itself from
   *   `prevMd === currMd` below; the old argument was dead.
   * @returns {object} ProseMirror document JSON with diffInsert/diffDelete marks
   */
  computeMarkdownDiff(prevDoc, currDoc, report, currPmDoc) {
    const prevFragment = prevDoc.get('default', Y.XmlFragment);
    const currFragment = currDoc.get('default', Y.XmlFragment);

    const prevMd = toMarkdown(prevFragment);
    const currMd = toMarkdown(currFragment);

    // If markdown is identical, return current doc without marks. `computeDiff`
    // has already converted `currDoc` for its `currentDocument`, so feature 042
    // (FR-015) passes that conversion in rather than redoing an O(doc) Yjs ->
    // ProseMirror walk. `undefined` means "no caller-supplied conversion" (a
    // direct call in a test), which converts here exactly as before.
    if (prevMd === currMd) {
      const pmDoc = currPmDoc !== undefined ? currPmDoc : this.yDocToProseMirror(currDoc);
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
        // The SAME `report` sink is passed to every region on purpose — the cache
        // gate asks "did anything time out anywhere in this comparison?" at
        // whole-result granularity (CD-4).
        allBlocks.push(...applyWordMarks(md, parts[idx + 1].value, report));
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
