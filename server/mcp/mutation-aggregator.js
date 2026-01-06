/**
 * Mutation Aggregator
 *
 * Aggregates document mutations within time windows to create cohesive spanning selections
 * for visual feedback. Instead of highlighting 50 individual mutations over 8 seconds,
 * this creates 5-10 aggregated spans shown over ~800ms.
 *
 * Key features:
 * - Time-based aggregation using 200ms windows (configurable via env var)
 * - Spanning selections from first to last mutation in each contiguous block range
 * - Handles non-contiguous blocks by creating multiple spans
 * - Preserves 80-240ms delays between aggregated highlights
 */

const Y = require('yjs');
const { resolveCursorPosition, createCursorPositionFromPath } = require('./yjs/cursor-operations');

// Default aggregation window (configurable via environment variable)
const DEFAULT_WINDOW_MS = process.env.MUTATION_WINDOW_MS ? parseInt(process.env.MUTATION_WINDOW_MS, 10) : 200;

/**
 * Mutation Aggregator Class
 *
 * Buffers mutations within time windows and creates spanning selections
 * that show the "area of work" rather than individual edit points.
 */
class MutationAggregator {
  /**
   * @param {object} options - Configuration options
   * @param {string} options.sessionId - Agent presence session ID
   * @param {Y.XmlFragment} options.xmlFragment - Document fragment for position resolution
   * @param {number} [options.windowMs=200] - Time window for aggregation in milliseconds
   * @param {function} options.onFlush - Callback when spans are ready: (spans) => void
   */
  constructor({ sessionId, xmlFragment, windowMs = DEFAULT_WINDOW_MS, onFlush }) {
    if (!sessionId) {
      throw new Error('sessionId is required');
    }
    if (!xmlFragment) {
      throw new Error('xmlFragment is required');
    }
    if (typeof onFlush !== 'function') {
      throw new Error('onFlush callback is required');
    }

    this.sessionId = sessionId;
    this.xmlFragment = xmlFragment;
    this.windowMs = windowMs;
    this.onFlush = onFlush;

    // Buffered mutations
    this.mutations = [];

    // Timeout for automatic flush
    this.flushTimeoutId = null;

    // Track if we're currently flushing to prevent re-entrancy
    this.isFlushing = false;
  }

  /**
   * Add a mutation to the aggregation buffer
   *
   * @param {object} mutation - Mutation data
   * @param {object} mutation.anchor - RelativePosition (JSON) for selection start
   * @param {object} mutation.head - RelativePosition (JSON) for selection end
   * @param {number} mutation.timestamp - When the mutation occurred
   * @param {Array<number>} mutation.path - Hierarchical path [blockIndex, ...]
   */
  addMutation({ anchor, head, timestamp, path }) {
    if (!anchor || !head || !path || path.length === 0) {
      return;
    }

    // Add to buffer
    this.mutations.push({ anchor, head, timestamp, path });

    // Schedule or reschedule flush
    if (this.windowMs > 0) {
      // Clear existing timeout
      if (this.flushTimeoutId) {
        clearTimeout(this.flushTimeoutId);
        this.flushTimeoutId = null;
      }

      // Schedule new flush
      this.flushTimeoutId = setTimeout(() => {
        this.flush();
      }, this.windowMs);
    } else {
      // Window size is 0 - flush immediately (aggregation disabled)
      this.flush();
    }
  }

  /**
   * Flush buffered mutations to create aggregated spans
   *
   * Groups mutations by contiguous block ranges and creates spanning selections
   * from first to last mutation in each range.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    // Prevent re-entrant flushes
    if (this.isFlushing) {
      return;
    }

    // Clear timeout if exists
    if (this.flushTimeoutId) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }

    // Nothing to flush
    if (this.mutations.length === 0) {
      return;
    }

    this.isFlushing = true;

    try {
      // Extract mutations and clear buffer
      const mutations = this.mutations;
      this.mutations = [];

      // Sort mutations by block index so chunks follow document order (top to bottom)
      mutations.sort((a, b) => {
        const blockA = a.path[0];
        const blockB = b.path[0];
        return blockA - blockB;
      });

      // If we have very few mutations, just show them all at once
      if (mutations.length <= 5) {
        const spanningSelection = this.computeSpanningSelection(mutations);
        if (spanningSelection) {
          console.log(`[MutationAggregator] Created 1 span from ${mutations.length} mutations (too few to chunk)`);
          this.onFlush([spanningSelection]);
        }
        return;
      }

      // Group mutations by block to avoid resolution issues with deleted positions
      const uniqueBlocks = [...new Set(mutations.map(m => m.path[0]))].sort((a, b) => a - b);
      const totalBlocks = uniqueBlocks.length;

      // Create 4-5 expanding chunks based on block ranges
      const targetChunks = Math.min(5, Math.max(3, Math.ceil(totalBlocks / 4)));
      const blocksPerChunk = Math.ceil(totalBlocks / targetChunks);

      const spans = [];

      // Create cumulative expanding selections through block-based chunks
      for (let i = 1; i <= targetChunks; i++) {
        const endBlockIndex = Math.min(i * blocksPerChunk, totalBlocks);
        const blocksInChunk = uniqueBlocks.slice(0, endBlockIndex);

        // Get all mutations for blocks up to this point
        const cumulativeMutations = mutations.filter(m => blocksInChunk.includes(m.path[0]));

        const minBlock = Math.min(...blocksInChunk);
        const maxBlock = Math.max(...blocksInChunk);
        console.log(`[MutationAggregator] Chunk ${i}/${targetChunks}: ${cumulativeMutations.length} mutations, blocks ${minBlock}-${maxBlock}`);

        // Create span using current document state (block boundaries) rather than mutation positions
        // This avoids issues with deleted positions that can't be resolved
        const spanningSelection = this.computeBlockRangeSelection(minBlock, maxBlock);
        if (spanningSelection) {
          const anchorResolved = resolveCursorPosition(this.xmlFragment, spanningSelection.anchor);
          const headResolved = resolveCursorPosition(this.xmlFragment, spanningSelection.head);
          console.log(`[MutationAggregator]   ✓ Chunk ${i} span: block ${anchorResolved?.blockIndex}:${anchorResolved?.offset} -> block ${headResolved?.blockIndex}:${headResolved?.offset}`);
          spans.push(spanningSelection);
        } else {
          console.log(`[MutationAggregator]   ✗ Chunk ${i} FAILED to create span`);
        }
      }

      // Flush spans to the queue
      if (spans.length > 0) {
        console.log(`[MutationAggregator] Created ${spans.length} expanding spans from ${mutations.length} mutations across ${totalBlocks} blocks (~${blocksPerChunk} blocks per chunk)`);
        this.onFlush(spans);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Compute spanning selection from first mutation to last mutation
   *
   * @param {Array<object>} mutations - Mutations to span
   * @returns {object|null} { anchor, head } or null if positions can't be resolved
   */
  computeSpanningSelection(mutations) {
    if (mutations.length === 0) {
      return null;
    }

    // Single mutation - just return it as-is
    if (mutations.length === 1) {
      return {
        anchor: mutations[0].anchor,
        head: mutations[0].head,
      };
    }

    // Resolve all positions to { blockIndex, offset }
    const resolvedPositions = [];

    for (const mutation of mutations) {
      const anchorResolved = resolveCursorPosition(this.xmlFragment, mutation.anchor);
      const headResolved = resolveCursorPosition(this.xmlFragment, mutation.head);

      if (anchorResolved && headResolved) {
        resolvedPositions.push(
          { position: mutation.anchor, blockIndex: anchorResolved.blockIndex, offset: anchorResolved.offset },
          { position: mutation.head, blockIndex: headResolved.blockIndex, offset: headResolved.offset }
        );
      }
    }

    if (resolvedPositions.length === 0) {
      return null;
    }

    // Find earliest and latest positions
    const earliest = this.findEarliestPosition(resolvedPositions);
    const latest = this.findLatestPosition(resolvedPositions);

    if (!earliest || !latest) {
      return null;
    }

    return {
      anchor: earliest.position,
      head: latest.position,
    };
  }

  /**
   * Find the earliest position in a list
   *
   * @param {Array<object>} positions - Array of { position, blockIndex, offset }
   * @returns {object|null} Earliest position
   */
  findEarliestPosition(positions) {
    if (positions.length === 0) {
      return null;
    }

    return positions.reduce((earliest, current) => {
      if (this.comparePositions(current, earliest) < 0) {
        return current;
      }
      return earliest;
    });
  }

  /**
   * Find the latest position in a list
   *
   * @param {Array<object>} positions - Array of { position, blockIndex, offset }
   * @returns {object|null} Latest position
   */
  findLatestPosition(positions) {
    if (positions.length === 0) {
      return null;
    }

    return positions.reduce((latest, current) => {
      if (this.comparePositions(current, latest) > 0) {
        return current;
      }
      return latest;
    });
  }

  /**
   * Compare two positions
   *
   * @param {object} posA - { blockIndex, offset }
   * @param {object} posB - { blockIndex, offset }
   * @returns {number} -1 if A < B, 0 if A === B, 1 if A > B
   */
  comparePositions(posA, posB) {
    if (posA.blockIndex < posB.blockIndex) {
      return -1;
    } else if (posA.blockIndex > posB.blockIndex) {
      return 1;
    } else {
      // Same block - compare offsets
      if (posA.offset < posB.offset) {
        return -1;
      } else if (posA.offset > posB.offset) {
        return 1;
      } else {
        return 0;
      }
    }
  }

  /**
   * Compute spanning selection based on current document block boundaries
   *
   * This uses the current document state (block start and end positions) rather than
   * mutation positions, which avoids issues with deleted positions that can't be resolved.
   *
   * @param {number} minBlock - First block index in range
   * @param {number} maxBlock - Last block index in range
   * @returns {object|null} { anchor, head } or null if blocks don't exist
   */
  computeBlockRangeSelection(minBlock, maxBlock) {
    const blocks = this.xmlFragment.toArray();

    if (minBlock < 0 || maxBlock >= blocks.length || minBlock > maxBlock) {
      return null;
    }

    try {
      // Create anchor at start of first block (offset 0)
      const anchor = createCursorPositionFromPath(this.xmlFragment, [minBlock], 0);

      // Create head at end of last block
      const lastBlock = blocks[maxBlock];
      const lastBlockLength = this.getBlockTextLength(lastBlock);
      const head = createCursorPositionFromPath(this.xmlFragment, [maxBlock], lastBlockLength);

      return { anchor, head };
    } catch (err) {
      console.warn(`[MutationAggregator] Failed to create block range selection for blocks ${minBlock}-${maxBlock}:`, err.message);
      return null;
    }
  }

  /**
   * Get total text length of a block (including all nested text nodes)
   *
   * @param {Y.XmlElement} block - Block to measure
   * @returns {number} Total character count
   */
  getBlockTextLength(block) {
    let length = 0;

    function traverse(node) {
      if (node instanceof Y.XmlText) {
        length += node.length;
      } else if (node instanceof Y.XmlElement) {
        const children = node.toArray();
        for (const child of children) {
          traverse(child);
        }
      }
    }

    traverse(block);
    return length;
  }

  /**
   * Destroy the aggregator and clean up resources
   */
  destroy() {
    if (this.flushTimeoutId) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
    this.mutations = [];
    this.isFlushing = false;
  }
}

module.exports = { MutationAggregator };
