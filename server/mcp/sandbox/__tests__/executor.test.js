/**
 * Tests for sandbox executor
 */
const { executeSandboxed } = require('../executor');
const { OperationTracker } = require('../operation-tracker');
const { wrapForTracking } = require('../yjs-interceptor');
const Y = require('yjs');

describe('Sandbox executor', () => {
  let ydoc;
  let xmlFragment;
  let tracker;

  beforeEach(() => {
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);
    tracker = new OperationTracker();
  });

  describe('executeSandboxed', () => {
    test('executes simple script with default export', () => {
      const jsCode = `
        exports.default = function(doc) {
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, 'Hello world');
          paragraph.insert(0, [text]);
          doc.insert(0, [paragraph]);
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);

      expect(result.success).toBe(true);

      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(1);
      expect(blocks[0].nodeName).toBe('paragraph');
    });

    test('executes script with module.exports', () => {
      const jsCode = `
        module.exports = function(doc) {
          const paragraph = new Y.XmlElement('paragraph');
          doc.insert(0, [paragraph]);
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);

      expect(result.success).toBe(true);

      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(1);
    });

    test('provides access to console.log', () => {
      const jsCode = `
        exports.default = function(doc) {
          console.log('test message');
        };
      `;

      // Should not throw
      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).not.toThrow();
    });

    test('throws error for script without default export', () => {
      const jsCode = `
        function someFunction(doc) {
          // Not exported
        }
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow(/default function/i);
    });

    test('throws error for script that throws', () => {
      const jsCode = `
        exports.default = function(doc) {
          throw new Error('Script error');
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow(/Script error/i);
    });

    test('wrapped constructors track all operations on new objects', () => {
      const jsCode = `
        exports.default = function(doc) {
          // Create new elements - these should be wrapped and tracked
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, 'Hello world'); // Should be tracked
          paragraph.insert(0, [text]); // Should be tracked
          doc.insert(0, [paragraph]); // Should be tracked
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);

      expect(result.success).toBe(true);

      // Wrapped constructors should track operations on new objects
      // At minimum, inserting into the doc should be tracked
      expect(tracker.getOperationCount()).toBeGreaterThan(0);

      const summary = tracker.getOperationSummary();
      expect(summary.insert).toBeGreaterThan(0);
    });

    test('respects timeout for infinite loop', () => {
      const jsCode = `
        exports.default = function(doc) {
          while (true) {
            // Infinite loop
          }
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 100)).toThrow(/timed out/i);
    }, 10000); // Give test itself more time

    test('script can access Yjs fragment methods', () => {
      const jsCode = `
        exports.default = function(doc) {
          const length = doc.length;
          const arr = doc.toArray();
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);

      expect(result.success).toBe(true);
    });

    test('script cannot access require (Node.js APIs)', () => {
      const jsCode = `
        exports.default = function(doc) {
          const fs = require('fs');
          fs.writeFileSync('/tmp/test', 'bad');
        };
      `;

      // Should throw because require is not available in sandbox
      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow();
    });

    test('script cannot access process', () => {
      const jsCode = `
        exports.default = function(doc) {
          process.exit(1);
        };
      `;

      // Should throw because process is not available in sandbox
      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow();
    });

    test('handles complex script with helper functions', () => {
      const jsCode = `
        function createParagraph(text) {
          const paragraph = new Y.XmlElement('paragraph');
          const textNode = new Y.XmlText();
          textNode.insert(0, text);
          paragraph.insert(0, [textNode]);
          return paragraph;
        }

        exports.default = function(doc) {
          const p1 = createParagraph('First');
          const p2 = createParagraph('Second');
          doc.insert(0, [p1, p2]);
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);

      expect(result.success).toBe(true);

      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(2);
    });

    test('createFormattedText helper is available and works correctly', () => {
      const jsCode = `
        exports.default = function(doc) {
          const paragraph = new Y.XmlElement('paragraph');

          // Use the createFormattedText helper with segment-based API
          const text = createFormattedText([
            'Visit ',
            { text: 'Example Site', attrs: { link: { href: 'https://example.com' } } },
            ' for more info'
          ]);

          paragraph.insert(0, [text]);
          doc.insert(0, [paragraph]);
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);

      expect(result.success).toBe(true);

      // Verify the text was created with correct order (not reversed)
      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(1);

      const textNode = blocks[0].get(0);
      const delta = textNode.toDelta();

      // Should have 3 segments in correct order
      expect(delta.length).toBe(3);
      expect(delta[0].insert).toBe('Visit ');
      expect(delta[1].insert).toBe('Example Site');
      expect(delta[1].attributes).toEqual({ link: { href: 'https://example.com' } });
      expect(delta[2].insert).toBe(' for more info');
    });

    test('createFormattedText tracks operations', () => {
      const jsCode = `
        exports.default = function(doc) {
          const paragraph = new Y.XmlElement('paragraph');
          const text = createFormattedText([
            { text: 'Bold', attrs: { bold: true } },
            ' and normal'
          ]);
          paragraph.insert(0, [text]);
          doc.insert(0, [paragraph]);
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);

      expect(result.success).toBe(true);

      // Verify operations were tracked
      const operations = tracker.getOperations();
      const mutations = operations.filter(op => op.category === 'mutation');

      // Should have: insert (text), format (bold), insert (paragraph into doc)
      expect(mutations.length).toBeGreaterThanOrEqual(2);

      // Should have at least one format operation
      const formatOps = mutations.filter(op => op.type === 'format');
      expect(formatOps.length).toBeGreaterThanOrEqual(1);
    });

    test('createFormattedText throws for invalid input', () => {
      const jsCode = `
        exports.default = function(doc) {
          // Should throw - empty array
          createFormattedText([]);
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000))
        .toThrow('non-empty array');
    });

    test('all documented helper functions are available in sandbox', () => {
      // This test ensures all helpers documented in modify.js are actually available
      // If you add a new helper, add it here to ensure it's exposed to scripts
      const jsCode = `
        exports.default = function(doc) {
          // Check each helper is defined and is a function
          const helpers = {
            findTextNode: typeof findTextNode,
            extractText: typeof extractText,
            getTextContent: typeof getTextContent,
            findElements: typeof findElements,
            findByNodeName: typeof findByNodeName,
            findByText: typeof findByText,
            createFormattedText: typeof createFormattedText,
            appendBlocks: typeof appendBlocks,
          };

          // Verify all are functions
          for (const [name, type] of Object.entries(helpers)) {
            if (type !== 'function') {
              throw new Error(name + ' is not available (got ' + type + ')');
            }
          }

          // Also verify Y namespace has expected constructors
          if (typeof Y.XmlElement !== 'function') throw new Error('Y.XmlElement not available');
          if (typeof Y.XmlText !== 'function') throw new Error('Y.XmlText not available');
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);
      expect(result.success).toBe(true);
    });

    test('appendBlocks creates blocks and tracks operations', () => {
      const jsCode = `
        exports.default = function(doc) {
          appendBlocks(doc, [
            { type: 'heading', level: 2, content: 'Title' },
            { type: 'paragraph', content: 'Content here.' }
          ]);
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);

      expect(result.success).toBe(true);

      // Verify blocks were created
      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(2);
      expect(blocks[0].nodeName).toBe('heading');
      expect(blocks[0].getAttribute('level')).toBe(2);
      expect(blocks[1].nodeName).toBe('paragraph');

      // Verify operations were tracked
      const operations = tracker.getOperations();
      const mutations = operations.filter(op => op.category === 'mutation');
      expect(mutations.length).toBeGreaterThan(0);
    });

    test('appendBlocks creates formatted content', () => {
      const jsCode = `
        exports.default = function(doc) {
          appendBlocks(doc, [
            { type: 'paragraph', content: [
              'Text with ',
              { text: 'bold', attrs: { bold: true } },
              ' formatting.'
            ]}
          ]);
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);

      expect(result.success).toBe(true);

      const para = xmlFragment.get(0);
      const text = para.get(0);
      const delta = text.toDelta();

      expect(delta.length).toBe(3);
      expect(delta[1].attributes).toEqual({ bold: true });
    });

    test('appendBlocks creates lists', () => {
      const jsCode = `
        exports.default = function(doc) {
          appendBlocks(doc, [
            { type: 'bulletList', items: ['Item 1', 'Item 2'] },
            { type: 'orderedList', items: ['First', 'Second'] }
          ]);
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);

      expect(result.success).toBe(true);

      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(2);
      expect(blocks[0].nodeName).toBe('bulletList');
      expect(blocks[1].nodeName).toBe('orderedList');
    });

    test('appendBlocks with xpath positioning', () => {
      // First, create some initial content
      const h1 = new Y.XmlElement('heading');
      h1.setAttribute('level', 1);
      const h1Text = new Y.XmlText();
      h1Text.insert(0, 'Introduction');
      h1.insert(0, [h1Text]);

      const h2 = new Y.XmlElement('heading');
      h2.setAttribute('level', 2);
      const h2Text = new Y.XmlText();
      h2Text.insert(0, 'Conclusion');
      h2.insert(0, [h2Text]);

      xmlFragment.insert(0, [h1, h2]);

      const jsCode = `
        exports.default = function(doc) {
          // Insert content after Introduction heading using xpath
          appendBlocks(doc, [
            { type: 'paragraph', content: 'This goes after intro.' }
          ], { after: '//heading[contains(., "Introduction")]' });
        };
      `;

      // Wrap the fragment like production code does (index.js wraps before calling executeSandboxed)
      const wrappedFragment = wrapForTracking(xmlFragment, tracker, []);
      const result = executeSandboxed(jsCode, wrappedFragment, tracker, 5000);

      expect(result.success).toBe(true);

      // Should have: Introduction, new paragraph, Conclusion
      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(3);
      expect(blocks[0].nodeName).toBe('heading');
      expect(blocks[1].nodeName).toBe('paragraph');
      expect(blocks[2].nodeName).toBe('heading');

      // Verify the new content is in the right place
      const textNode = blocks[1].get(0);
      const delta = textNode.toDelta();
      expect(delta[0].insert).toBe('This goes after intro.');
    });

    test('appendBlocks with element reference positioning', () => {
      // First, create some initial content
      const h1 = new Y.XmlElement('heading');
      h1.setAttribute('level', 1);
      const h1Text = new Y.XmlText();
      h1Text.insert(0, 'Title');
      h1.insert(0, [h1Text]);

      const para = new Y.XmlElement('paragraph');
      const paraText = new Y.XmlText();
      paraText.insert(0, 'Content');
      para.insert(0, [paraText]);

      xmlFragment.insert(0, [h1, para]);

      const jsCode = `
        exports.default = function(doc) {
          // Get a reference to the first element and insert before it
          const firstElement = doc.get(0);
          appendBlocks(doc, [
            { type: 'paragraph', content: 'Before title' }
          ], { before: firstElement });
        };
      `;

      // Wrap the fragment like production code does
      const wrappedFragment = wrapForTracking(xmlFragment, tracker, []);
      const result = executeSandboxed(jsCode, wrappedFragment, tracker, 5000);

      expect(result.success).toBe(true);

      // Should have: new paragraph, Title, Content
      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(3);
      expect(blocks[0].nodeName).toBe('paragraph');
      expect(blocks[1].nodeName).toBe('heading');

      const textNode = blocks[0].get(0);
      const delta = textNode.toDelta();
      expect(delta[0].insert).toBe('Before title');
    });

    test('appendBlocks returns created elements', () => {
      const jsCode = `
        exports.default = function(doc) {
          const elements = appendBlocks(doc, [
            { type: 'heading', level: 2, content: 'Test' },
            { type: 'paragraph', content: 'Content' }
          ]);

          // Verify return value
          if (elements.length !== 2) {
            throw new Error('Expected 2 elements, got ' + elements.length);
          }
          if (elements[0].nodeName !== 'heading') {
            throw new Error('First element should be heading');
          }
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, tracker, 5000);
      expect(result.success).toBe(true);
    });
  });

  describe('detailed error messages', () => {
    test('undefined property access includes hint about findByText/findElements returning empty array', () => {
      const jsCode = `
        exports.default = function(doc) {
          // Simulate the common bug: findByText returns empty array, accessing [0] gives undefined
          const results = [];
          const item = results[0];
          item.insert(0, 'text'); // Cannot read properties of undefined
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow(
        /findByText\(\), findElements\(\), or xpath\(\) returned an empty array/
      );
    });

    test('undefined property access error includes line number', () => {
      const jsCode = `
        exports.default = function(doc) {
          const results = [];
          const item = results[0];
          item.insert(0, 'text');
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow(
        /at line \d+, column \d+/
      );
    });

    test('null property access includes hint about findTextNode/xpathFirst returning null', () => {
      const jsCode = `
        exports.default = function(doc) {
          // Simulate the common bug: findTextNode returns null on empty element
          const result = null;
          result.toDelta(); // Cannot read properties of null
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow(
        /findTextNode\(\) returned null|xpathFirst\(\) returned null/
      );
    });

    test('undefined variable includes hint about sandbox availability', () => {
      const jsCode = `
        exports.default = function(doc) {
          const data = someUndefinedVariable;
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow(
        /is not available in the sandbox/
      );
    });

    test('is not a function error includes hint about Yjs object types', () => {
      const jsCode = `
        exports.default = function(doc) {
          const text = new Y.XmlText();
          text.notAMethod(); // This method doesn't exist
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow(
        /Check that you're calling methods on the correct Yjs object types/
      );
    });

    test('error message includes stack trace', () => {
      const jsCode = `
        exports.default = function(doc) {
          throw new Error('Test error');
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow(
        /Stack trace:/
      );
    });

    test('error from accessing undefined after findByText includes solution example', () => {
      const jsCode = `
        exports.default = function(doc) {
          const items = findByText(doc, 'nonexistent');
          items[0].setAttribute('level', 1); // Will fail - items is empty
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, tracker, 5000)).toThrow(
        /if \(results\.length > 0\)/
      );
    });
  });
});
