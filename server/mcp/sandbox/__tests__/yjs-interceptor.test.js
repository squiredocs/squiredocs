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

      const mutations = tracker.getOperations().filter(op => op.category === 'mutation');
      expect(mutations.length).toBe(1);
      expect(mutations[0].type).toBe('insert');
      expect(mutations[0].target).toBe('XmlText');
      expect(mutations[0].args[0]).toBe(0);
      expect(mutations[0].args[1]).toBe('Hello');
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

      const mutations = tracker.getOperations().filter(op => op.category === 'mutation');
      expect(mutations.length).toBe(1);
      expect(mutations[0].type).toBe('format');
      expect(mutations[0].args[2]).toEqual({ bold: true });
    });

    test('tracks XmlElement setAttribute operations', () => {
      const heading = new Y.XmlElement('heading');
      xmlFragment.insert(0, [heading]);

      tracker.reset();

      const wrapped = wrapForTracking(xmlFragment, tracker);
      const wrappedBlocks = wrapped.toArray();
      const wrappedHeading = wrappedBlocks[0];

      wrappedHeading.setAttribute('level', 1);

      const mutations = tracker.getOperations().filter(op => op.category === 'mutation');
      expect(mutations.length).toBe(1);
      expect(mutations[0].type).toBe('setAttribute');
      expect(mutations[0].args).toEqual(['level', 1]);
    });

    test('tracks read operations with category read', () => {
      const paragraph = new Y.XmlElement('paragraph');
      xmlFragment.insert(0, [paragraph]);

      tracker.reset();

      const wrapped = wrapForTracking(xmlFragment, tracker);

      // Read operations
      wrapped.toArray();
      wrapped.get(0);

      // Should track read operations with category 'read'
      const reads = tracker.getOperations().filter(op => op.category === 'read');
      expect(reads.length).toBe(2);
      expect(reads[0].type).toBe('toArray');
      expect(reads[1].type).toBe('get');

      // Should not have any mutations
      const mutations = tracker.getOperations().filter(op => op.category === 'mutation');
      expect(mutations.length).toBe(0);
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

    test('updates path correctly for get(index) calls', () => {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello');
      paragraph.insert(0, [text]);
      xmlFragment.insert(0, [paragraph]);

      tracker.reset();

      const wrapped = wrapForTracking(xmlFragment, tracker);
      const wrappedBlock = wrapped.get(0); // Should add [0] to path
      const wrappedText = wrappedBlock.get(0); // Should add [0, 0] to path

      wrappedText.format(0, 5, { bold: true });

      const mutations = tracker.getOperations().filter(op => op.category === 'mutation');
      expect(mutations.length).toBe(1);
      expect(mutations[0].type).toBe('format');
      // Path should be [0, 0] - first block, first child
      expect(mutations[0].path).toEqual([0, 0]);
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

    test('calls onOperation callback when provided', () => {
      const callbackOps = [];
      const onOperation = (op, target) => {
        callbackOps.push({ op, target });
      };

      const wrapped = wrapForTracking(xmlFragment, tracker, [], onOperation);

      // Mutation
      const paragraph = new Y.XmlElement('paragraph');
      wrapped.insert(0, [paragraph]);

      // Read
      wrapped.toArray();

      expect(callbackOps.length).toBe(2);
      expect(callbackOps[0].op.category).toBe('mutation');
      expect(callbackOps[0].op.type).toBe('insert');
      expect(callbackOps[1].op.category).toBe('read');
      expect(callbackOps[1].op.type).toBe('toArray');
    });

    test('correctly distinguishes XmlElement target from XmlFragment', () => {
      // This test verifies the fix for the bug where XmlElement.insert() was
      // incorrectly reported as target='XmlFragment' because XmlElement extends
      // XmlFragment (so `element instanceof Y.XmlFragment` was true).
      // The fix requires checking XmlElement BEFORE XmlFragment in getTargetType().

      const callbackOps = [];
      const onOperation = (op) => {
        callbackOps.push(op);
      };

      const wrapped = wrapForTracking(xmlFragment, tracker, [], onOperation);

      // Insert a paragraph into the fragment (should be XmlFragment)
      const paragraph = new Y.XmlElement('paragraph');
      wrapped.insert(0, [paragraph]);

      // Get the wrapped paragraph and insert text into it
      const wrappedParagraph = wrapped.get(0);
      const text = new Y.XmlText();
      wrappedParagraph.insert(0, [text]);

      // Filter to just mutation operations
      const mutations = callbackOps.filter(op => op.category === 'mutation');

      // First mutation: doc.insert() should have target='XmlFragment'
      expect(mutations[0].type).toBe('insert');
      expect(mutations[0].target).toBe('XmlFragment');

      // Second mutation: paragraph.insert() should have target='paragraph' (the nodeName)
      // NOT 'XmlFragment' - this was the bug!
      expect(mutations[1].type).toBe('insert');
      expect(mutations[1].target).toBe('paragraph');
    });

    test('reports XmlText target correctly for text operations', () => {
      const callbackOps = [];
      const onOperation = (op) => {
        callbackOps.push(op);
      };

      // Setup: create paragraph with text node
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      xmlFragment.insert(0, [paragraph]);

      tracker.reset();

      const wrapped = wrapForTracking(xmlFragment, tracker, [], onOperation);
      const wrappedParagraph = wrapped.get(0);
      const wrappedText = wrappedParagraph.get(0);

      // Insert text - should have target='XmlText'
      wrappedText.insert(0, 'Hello');

      const mutations = callbackOps.filter(op => op.category === 'mutation');
      expect(mutations.length).toBe(1);
      expect(mutations[0].type).toBe('insert');
      expect(mutations[0].target).toBe('XmlText');
    });

    test('passes onOperation to nested wrapped objects', () => {
      const callbackOps = [];
      const onOperation = (op) => {
        callbackOps.push(op);
      };

      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      xmlFragment.insert(0, [paragraph]);

      tracker.reset();
      callbackOps.length = 0;

      const wrapped = wrapForTracking(xmlFragment, tracker, [], onOperation);
      const wrappedBlocks = wrapped.toArray();
      const wrappedParagraph = wrappedBlocks[0];
      const wrappedText = wrappedParagraph.get(0);

      wrappedText.insert(0, 'Hello');

      // Should have: toArray (read), get (read), insert (mutation)
      const mutations = callbackOps.filter(op => op.category === 'mutation');
      const reads = callbackOps.filter(op => op.category === 'read');

      expect(mutations.length).toBe(1);
      expect(mutations[0].type).toBe('insert');
      expect(reads.length).toBe(2);
    });
  });

  describe('sandbox context compatibility', () => {
    test('converts array attributes from sandbox context to host context', () => {
      const vm = require('vm');

      // Simulate sandbox environment
      const createWrappedConstructor = (Constructor) => {
        const WrappedConstructor = function(...args) {
          const instance = new Constructor(...args);
          return wrapForTracking(instance, tracker, []);
        };
        Object.setPrototypeOf(WrappedConstructor, Constructor);
        WrappedConstructor.prototype = Constructor.prototype;
        return WrappedConstructor;
      };

      const wrappedFragment = wrapForTracking(xmlFragment, tracker, []);
      const sandbox = {
        _doc: wrappedFragment,
        Y: {
          XmlElement: createWrappedConstructor(Y.XmlElement),
          XmlText: createWrappedConstructor(Y.XmlText),
        },
      };

      // Script creates array in sandbox context and uses it with setAttribute
      const script = new vm.Script(`
        const table = new Y.XmlElement('table');
        const row = new Y.XmlElement('tableRow');
        const cell = new Y.XmlElement('tableCell');

        const para = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, 'Test');
        para.insert(0, [text]);
        cell.insert(0, [para]);
        row.insert(0, [cell]);
        table.insert(0, [row]);
        _doc.insert(0, [table]);

        // This array is created in sandbox context
        // Without conversion, Yjs would fail with "Unexpected content type"
        cell.setAttribute('colwidth', [150]);

        // Test multiple widths
        cell.setAttribute('colwidth', [100, 150, 200]);
      `);

      // Should not throw
      expect(() => {
        script.runInNewContext(sandbox);
      }).not.toThrow();

      // Verify the attribute was set correctly
      const table = xmlFragment.get(0);
      const row = table.get(0);
      const cell = row.get(0);
      expect(cell.getAttribute('colwidth')).toEqual([100, 150, 200]);
    });
  });
});
