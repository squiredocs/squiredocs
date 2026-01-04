/**
 * Tests for Yjs operation interceptor
 */
const Y = require('yjs');
const { wrapForTracking } = require('../yjs-interceptor');
const { OperationTracker } = require('../operation-tracker');

describe('Yjs operation interceptor', () => {
  let ydoc;
  let xmlFragment;
  let tracker;

  beforeEach(() => {
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);
    tracker = new OperationTracker();
  });

  describe('wrapForTracking', () => {
    test('wraps XmlFragment and tracks insert operations', () => {
      const wrapped = wrapForTracking(xmlFragment, tracker);

      const paragraph = new Y.XmlElement('paragraph');
      wrapped.insert(0, [paragraph]);

      expect(tracker.getOperationCount()).toBe(1);
      const ops = tracker.getOperations();
      expect(ops[0].type).toBe('insert');
      expect(ops[0].target).toBe('XmlFragment');
    });

    test('wraps XmlFragment and tracks delete operations', () => {
      const paragraph = new Y.XmlElement('paragraph');
      xmlFragment.insert(0, [paragraph]);

      tracker.reset(); // Clear operations from setup

      const wrapped = wrapForTracking(xmlFragment, tracker);
      wrapped.delete(0, 1);

      expect(tracker.getOperationCount()).toBe(1);
      const ops = tracker.getOperations();
      expect(ops[0].type).toBe('delete');
      expect(ops[0].args).toEqual([0, 1]);
    });

    test('wraps nested XmlElement operations', () => {
      const wrapped = wrapForTracking(xmlFragment, tracker);

      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();

      paragraph.insert(0, [text]);
      wrapped.insert(0, [paragraph]);

      // Should track both the paragraph insert and XmlElement insert
      expect(tracker.getOperationCount()).toBeGreaterThanOrEqual(1);
    });

    test('tracks XmlText insert operations', () => {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      xmlFragment.insert(0, [paragraph]);

      tracker.reset();

      const wrapped = wrapForTracking(xmlFragment, tracker);
      const wrappedBlocks = wrapped.toArray();
      const wrappedParagraph = wrappedBlocks[0];
      const wrappedText = wrappedParagraph.get(0);

      wrappedText.insert(0, 'Hello');

      expect(tracker.getOperationCount()).toBe(1);
      const ops = tracker.getOperations();
      expect(ops[0].type).toBe('insert');
      expect(ops[0].target).toBe('XmlText');
      expect(ops[0].args[0]).toBe(0);
      expect(ops[0].args[1]).toBe('Hello');
    });

    test('tracks XmlText format operations', () => {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello');
      paragraph.insert(0, [text]);
      xmlFragment.insert(0, [paragraph]);

      tracker.reset();

      const wrapped = wrapForTracking(xmlFragment, tracker);
      const wrappedBlocks = wrapped.toArray();
      const wrappedParagraph = wrappedBlocks[0];
      const wrappedText = wrappedParagraph.get(0);

      wrappedText.format(0, 5, { bold: true });

      expect(tracker.getOperationCount()).toBe(1);
      const ops = tracker.getOperations();
      expect(ops[0].type).toBe('format');
      expect(ops[0].args[2]).toEqual({ bold: true });
    });

    test('tracks XmlElement setAttribute operations', () => {
      const heading = new Y.XmlElement('heading');
      xmlFragment.insert(0, [heading]);

      tracker.reset();

      const wrapped = wrapForTracking(xmlFragment, tracker);
      const wrappedBlocks = wrapped.toArray();
      const wrappedHeading = wrappedBlocks[0];

      wrappedHeading.setAttribute('level', 1);

      expect(tracker.getOperationCount()).toBe(1);
      const ops = tracker.getOperations();
      expect(ops[0].type).toBe('setAttribute');
      expect(ops[0].args).toEqual(['level', 1]);
    });

    test('does not track read operations', () => {
      const paragraph = new Y.XmlElement('paragraph');
      xmlFragment.insert(0, [paragraph]);

      tracker.reset();

      const wrapped = wrapForTracking(xmlFragment, tracker);

      // Read operations
      wrapped.toArray();
      wrapped.get(0);
      const length = wrapped.length;

      // Should not track any operations
      expect(tracker.getOperationCount()).toBe(0);
    });

    test('tracks path in nested operations', () => {
      const wrapped = wrapForTracking(xmlFragment, tracker);

      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const paragraph = new Y.XmlElement('paragraph');

      list.insert(0, [item]);
      item.insert(0, [paragraph]);
      wrapped.insert(0, [list]);

      // Should have path information
      const ops = tracker.getOperations();
      expect(ops.length).toBeGreaterThan(0);
      expect(ops[0].path).toBeDefined();
      expect(Array.isArray(ops[0].path)).toBe(true);
    });

    test('avoids double-wrapping', () => {
      const wrapped1 = wrapForTracking(xmlFragment, tracker);
      const wrapped2 = wrapForTracking(wrapped1, tracker);

      const paragraph = new Y.XmlElement('paragraph');
      wrapped2.insert(0, [paragraph]);

      // Should only track once, not twice
      expect(tracker.getOperationCount()).toBe(1);
    });

    test('preserves original functionality', () => {
      const wrapped = wrapForTracking(xmlFragment, tracker);

      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello world');
      paragraph.insert(0, [text]);
      wrapped.insert(0, [paragraph]);

      // Verify document structure is correct
      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(1);
      expect(blocks[0].nodeName).toBe('paragraph');

      const textNode = blocks[0].get(0);
      expect(textNode.toString()).toBe('Hello world');
    });

    test('tracks multiple sequential operations', () => {
      const wrapped = wrapForTracking(xmlFragment, tracker);

      const p1 = new Y.XmlElement('paragraph');
      const p2 = new Y.XmlElement('paragraph');
      const p3 = new Y.XmlElement('paragraph');

      wrapped.insert(0, [p1]);
      wrapped.insert(1, [p2]);
      wrapped.insert(2, [p3]);

      expect(tracker.getOperationCount()).toBe(3);

      const ops = tracker.getOperations();
      expect(ops[0].args[0]).toBe(0);
      expect(ops[1].args[0]).toBe(1);
      expect(ops[2].args[0]).toBe(2);
    });
  });
});
