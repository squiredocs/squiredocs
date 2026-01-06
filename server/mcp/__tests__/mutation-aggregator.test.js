/**
 * Tests for Mutation Aggregator
 */
const Y = require('yjs');
const { MutationAggregator } = require('../mutation-aggregator');

// Helper to create a test document with multiple blocks
function createTestDocument() {
  const ydoc = new Y.Doc();
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Create 5 blocks with text
  for (let i = 0; i < 5; i++) {
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, `Block ${i} content`);
    para.insert(0, [text]);
    xmlFragment.insert(i, [para]);
  }

  return { ydoc, xmlFragment };
}

// Helper to create RelativePosition at a specific block and offset
function createPosition(xmlFragment, blockIndex, offset) {
  const blocks = xmlFragment.toArray();
  if (blockIndex >= blocks.length) {
    throw new Error(`Block ${blockIndex} out of bounds`);
  }

  const block = blocks[blockIndex];
  const textNode = block.toArray()[0]; // First child is the text node

  const relPos = Y.createRelativePositionFromTypeIndex(textNode, offset);
  return Y.relativePositionToJSON(relPos);
}

describe('MutationAggregator', () => {
  let ydoc, xmlFragment;

  beforeEach(() => {
    const doc = createTestDocument();
    ydoc = doc.ydoc;
    xmlFragment = doc.xmlFragment;
  });

  afterEach(() => {
    if (ydoc) {
      ydoc.destroy();
    }
  });

  describe('constructor', () => {
    test('requires sessionId', () => {
      expect(() => {
        new MutationAggregator({
          xmlFragment,
          onFlush: () => {},
        });
      }).toThrow('sessionId is required');
    });

    test('requires xmlFragment', () => {
      expect(() => {
        new MutationAggregator({
          sessionId: 'test-session',
          onFlush: () => {},
        });
      }).toThrow('xmlFragment is required');
    });

    test('requires onFlush callback', () => {
      expect(() => {
        new MutationAggregator({
          sessionId: 'test-session',
          xmlFragment,
        });
      }).toThrow('onFlush callback is required');
    });

    test('creates aggregator with valid parameters', () => {
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: () => {},
      });

      expect(aggregator.sessionId).toBe('test-session');
      expect(aggregator.xmlFragment).toBe(xmlFragment);
      expect(aggregator.mutations).toEqual([]);
    });

    test('uses custom window size', () => {
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        windowMs: 500,
        onFlush: () => {},
      });

      expect(aggregator.windowMs).toBe(500);
    });
  });

  describe('addMutation', () => {
    test('buffers mutations', () => {
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        windowMs: 10000, // Long window to prevent auto-flush
        onFlush: () => {},
      });

      const anchor = createPosition(xmlFragment, 0, 0);
      const head = createPosition(xmlFragment, 0, 5);

      aggregator.addMutation({
        anchor,
        head,
        timestamp: Date.now(),
        path: [0],
      });

      expect(aggregator.mutations.length).toBe(1);
    });

    test('ignores mutations without anchor', () => {
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: () => {},
      });

      const head = createPosition(xmlFragment, 0, 5);

      aggregator.addMutation({
        head,
        timestamp: Date.now(),
        path: [0],
      });

      expect(aggregator.mutations.length).toBe(0);
    });

    test('ignores mutations without path', () => {
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: () => {},
      });

      const anchor = createPosition(xmlFragment, 0, 0);
      const head = createPosition(xmlFragment, 0, 5);

      aggregator.addMutation({
        anchor,
        head,
        timestamp: Date.now(),
      });

      expect(aggregator.mutations.length).toBe(0);
    });
  });

  describe('flush', () => {
    test('flushes single mutation as-is', async () => {
      const flushedSpans = [];
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: (spans) => flushedSpans.push(...spans),
      });

      const anchor = createPosition(xmlFragment, 0, 0);
      const head = createPosition(xmlFragment, 0, 5);

      aggregator.addMutation({
        anchor,
        head,
        timestamp: Date.now(),
        path: [0],
      });

      await aggregator.flush();

      expect(flushedSpans.length).toBe(1);
      expect(flushedSpans[0].anchor).toEqual(anchor);
      expect(flushedSpans[0].head).toEqual(head);
    });

    test('creates spanning selection for multiple mutations in same block', async () => {
      const flushedSpans = [];
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: (spans) => flushedSpans.push(...spans),
      });

      // Add 3 mutations in block 0
      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 0),
        head: createPosition(xmlFragment, 0, 2),
        timestamp: Date.now(),
        path: [0],
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 5),
        head: createPosition(xmlFragment, 0, 8),
        timestamp: Date.now(),
        path: [0],
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 10),
        head: createPosition(xmlFragment, 0, 12),
        timestamp: Date.now(),
        path: [0],
      });

      await aggregator.flush();

      // Should create one span covering from offset 0 to offset 12 in block 0
      expect(flushedSpans.length).toBe(1);

      // Verify the span covers the full range
      const { resolveCursorPosition } = require('../yjs/cursor-operations');
      const anchorResolved = resolveCursorPosition(xmlFragment, flushedSpans[0].anchor);
      const headResolved = resolveCursorPosition(xmlFragment, flushedSpans[0].head);

      expect(anchorResolved.blockIndex).toBe(0);
      expect(anchorResolved.offset).toBe(0);
      expect(headResolved.blockIndex).toBe(0);
      expect(headResolved.offset).toBe(12);
    });

    test('creates spanning selection for contiguous blocks', async () => {
      const flushedSpans = [];
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: (spans) => flushedSpans.push(...spans),
      });

      // Add mutations in blocks 0, 1, 2 (contiguous)
      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 5),
        head: createPosition(xmlFragment, 0, 8),
        timestamp: Date.now(),
        path: [0],
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 1, 3),
        head: createPosition(xmlFragment, 1, 6),
        timestamp: Date.now(),
        path: [1],
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 2, 1),
        head: createPosition(xmlFragment, 2, 4),
        timestamp: Date.now(),
        path: [2],
      });

      await aggregator.flush();

      // Should create one span covering blocks 0-2
      expect(flushedSpans.length).toBe(1);

      const { resolveCursorPosition } = require('../yjs/cursor-operations');
      const anchorResolved = resolveCursorPosition(xmlFragment, flushedSpans[0].anchor);
      const headResolved = resolveCursorPosition(xmlFragment, flushedSpans[0].head);

      // Span should go from block 0, offset 5 to block 2, offset 4
      expect(anchorResolved.blockIndex).toBe(0);
      expect(anchorResolved.offset).toBe(5);
      expect(headResolved.blockIndex).toBe(2);
      expect(headResolved.offset).toBe(4);
    });

    test('creates separate spans for non-contiguous blocks', async () => {
      const flushedSpans = [];
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: (spans) => flushedSpans.push(...spans),
      });

      // Add mutations in blocks 0, 1 (contiguous) and 3, 4 (contiguous but separate from 0-1)
      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 0),
        head: createPosition(xmlFragment, 0, 2),
        timestamp: Date.now(),
        path: [0],
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 1, 0),
        head: createPosition(xmlFragment, 1, 2),
        timestamp: Date.now(),
        path: [1],
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 3, 0),
        head: createPosition(xmlFragment, 3, 2),
        timestamp: Date.now(),
        path: [3],
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 4, 0),
        head: createPosition(xmlFragment, 4, 2),
        timestamp: Date.now(),
        path: [4],
      });

      await aggregator.flush();

      // Should create two spans: blocks 0-1 and blocks 3-4
      expect(flushedSpans.length).toBe(2);

      const { resolveCursorPosition } = require('../yjs/cursor-operations');

      // First span: blocks 0-1
      const span1Anchor = resolveCursorPosition(xmlFragment, flushedSpans[0].anchor);
      const span1Head = resolveCursorPosition(xmlFragment, flushedSpans[0].head);
      expect(span1Anchor.blockIndex).toBe(0);
      expect(span1Head.blockIndex).toBe(1);

      // Second span: blocks 3-4
      const span2Anchor = resolveCursorPosition(xmlFragment, flushedSpans[1].anchor);
      const span2Head = resolveCursorPosition(xmlFragment, flushedSpans[1].head);
      expect(span2Anchor.blockIndex).toBe(3);
      expect(span2Head.blockIndex).toBe(4);
    });

    test('clears buffer after flush', async () => {
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: () => {},
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 0),
        head: createPosition(xmlFragment, 0, 5),
        timestamp: Date.now(),
        path: [0],
      });

      expect(aggregator.mutations.length).toBe(1);

      await aggregator.flush();

      expect(aggregator.mutations.length).toBe(0);
    });

    test('does nothing when buffer is empty', async () => {
      let flushed = false;
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: () => { flushed = true; },
      });

      await aggregator.flush();

      expect(flushed).toBe(false);
    });
  });

  describe('time window auto-flush', () => {
    test('auto-flushes after window expires', (done) => {
      const flushedSpans = [];
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        windowMs: 50, // Short window for testing
        onFlush: (spans) => {
          flushedSpans.push(...spans);

          // Verify we got the span
          expect(flushedSpans.length).toBe(1);
          aggregator.destroy();
          done();
        },
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 0),
        head: createPosition(xmlFragment, 0, 5),
        timestamp: Date.now(),
        path: [0],
      });

      // onFlush should be called after ~50ms
    });

    test('reschedules flush when new mutations arrive', (done) => {
      const flushedSpans = [];
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        windowMs: 100,
        onFlush: (spans) => {
          flushedSpans.push(...spans);

          // Should have aggregated both mutations
          expect(aggregator.mutations.length).toBe(0); // Buffer should be cleared
          aggregator.destroy();
          done();
        },
      });

      // Add first mutation
      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 0),
        head: createPosition(xmlFragment, 0, 5),
        timestamp: Date.now(),
        path: [0],
      });

      // Add second mutation after 50ms (before first flush would occur)
      setTimeout(() => {
        aggregator.addMutation({
          anchor: createPosition(xmlFragment, 1, 0),
          head: createPosition(xmlFragment, 1, 5),
          timestamp: Date.now(),
          path: [1],
        });
        // Flush should happen ~100ms after this second mutation
      }, 50);
    });

    test('flushes immediately when windowMs is 0', async () => {
      const flushedSpans = [];
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        windowMs: 0, // Aggregation disabled
        onFlush: (spans) => flushedSpans.push(...spans),
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 0),
        head: createPosition(xmlFragment, 0, 5),
        timestamp: Date.now(),
        path: [0],
      });

      // Should flush immediately without waiting
      // Give it a tick to process
      await new Promise(resolve => setImmediate(resolve));

      expect(flushedSpans.length).toBe(1);
    });
  });

  describe('position comparison', () => {
    test('comparePositions correctly orders positions', () => {
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: () => {},
      });

      // Same block, different offsets
      const posA = { blockIndex: 0, offset: 5 };
      const posB = { blockIndex: 0, offset: 10 };
      expect(aggregator.comparePositions(posA, posB)).toBeLessThan(0);
      expect(aggregator.comparePositions(posB, posA)).toBeGreaterThan(0);

      // Different blocks
      const posC = { blockIndex: 1, offset: 0 };
      expect(aggregator.comparePositions(posA, posC)).toBeLessThan(0);
      expect(aggregator.comparePositions(posC, posA)).toBeGreaterThan(0);

      // Same position
      const posD = { blockIndex: 0, offset: 5 };
      expect(aggregator.comparePositions(posA, posD)).toBe(0);
    });

    test('findEarliestPosition finds minimum', () => {
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: () => {},
      });

      const positions = [
        { position: 'pos1', blockIndex: 2, offset: 5 },
        { position: 'pos2', blockIndex: 0, offset: 10 },
        { position: 'pos3', blockIndex: 1, offset: 0 },
      ];

      const earliest = aggregator.findEarliestPosition(positions);
      expect(earliest.position).toBe('pos2'); // Block 0, offset 10
    });

    test('findLatestPosition finds maximum', () => {
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        onFlush: () => {},
      });

      const positions = [
        { position: 'pos1', blockIndex: 2, offset: 5 },
        { position: 'pos2', blockIndex: 0, offset: 10 },
        { position: 'pos3', blockIndex: 1, offset: 0 },
      ];

      const latest = aggregator.findLatestPosition(positions);
      expect(latest.position).toBe('pos1'); // Block 2, offset 5
    });
  });

  describe('destroy', () => {
    test('clears timeout and buffer', () => {
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        windowMs: 10000,
        onFlush: () => {},
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 0),
        head: createPosition(xmlFragment, 0, 5),
        timestamp: Date.now(),
        path: [0],
      });

      expect(aggregator.mutations.length).toBe(1);
      expect(aggregator.flushTimeoutId).not.toBeNull();

      aggregator.destroy();

      expect(aggregator.mutations.length).toBe(0);
      expect(aggregator.flushTimeoutId).toBeNull();
    });

    test('prevents flush after destroy', (done) => {
      let flushed = false;
      const aggregator = new MutationAggregator({
        sessionId: 'test-session',
        xmlFragment,
        windowMs: 50,
        onFlush: () => { flushed = true; },
      });

      aggregator.addMutation({
        anchor: createPosition(xmlFragment, 0, 0),
        head: createPosition(xmlFragment, 0, 5),
        timestamp: Date.now(),
        path: [0],
      });

      // Destroy immediately
      aggregator.destroy();

      // Wait for window to expire
      setTimeout(() => {
        expect(flushed).toBe(false);
        done();
      }, 100);
    });
  });
});
