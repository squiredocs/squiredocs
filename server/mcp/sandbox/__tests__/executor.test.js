/**
 * Tests for sandbox executor (isolated-vm)
 */
const { executeSandboxed } = require('../executor');
const Y = require('yjs');

// Helper: create a Y.Doc snapshot, optionally pre-populated
function createSnapshot(setupFn) {
  const ydoc = new Y.Doc();
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  if (setupFn) setupFn(xmlFragment);
  return Y.encodeStateAsUpdate(ydoc);
}

// Helper: run a script and collect batches/highlights
function collectBatches(snapshot, jsCode, timeout = 5000) {
  const batches = [];
  const highlights = [];
  const result = executeSandboxed(
    jsCode,
    snapshot,
    timeout,
    (ops, update) => batches.push({ ops, update: new Uint8Array(update) }),
    (positions) => highlights.push(positions)
  );
  return { result, batches, highlights };
}

// Helper: apply batches to reconstruct the document
function reconstructDoc(snapshot, batches) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(snapshot));
  for (const batch of batches) {
    Y.applyUpdate(doc, batch.update);
  }
  return doc.get('default', Y.XmlFragment);
}

describe('Sandbox executor (isolated-vm)', () => {
  describe('basic execution', () => {
    test('executes simple script with default export', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, 'Hello world');
          paragraph.insert(0, [text]);
          doc.insert(0, [paragraph]);
        };
      `;

      const { result, batches } = collectBatches(snapshot, jsCode);
      expect(result.operationCount).toBeGreaterThan(0);

      const xmlFragment = reconstructDoc(snapshot, batches);
      expect(xmlFragment.length).toBe(1);
      expect(xmlFragment.get(0).nodeName).toBe('paragraph');
    });

    test('executes script with module.exports', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        module.exports = function(doc) {
          const paragraph = new Y.XmlElement('paragraph');
          doc.insert(0, [paragraph]);
        };
      `;

      const { result, batches } = collectBatches(snapshot, jsCode);
      expect(result.operationCount).toBeGreaterThan(0);

      const xmlFragment = reconstructDoc(snapshot, batches);
      expect(xmlFragment.length).toBe(1);
    });

    test('provides access to console.log', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          console.log('test message');
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).not.toThrow();
    });

    test('throws error for script without default export', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        function someFunction(doc) {
          // Not exported
        }
      `;

      expect(() => collectBatches(snapshot, jsCode)).toThrow(/default function/i);
    });

    test('throws error for script that throws', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          throw new Error('Script error');
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).toThrow(/Script error/i);
    });
  });

  describe('operation tracking', () => {
    test('tracks all operations on new objects', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, 'Hello world');
          paragraph.insert(0, [text]);
          doc.insert(0, [paragraph]);
        };
      `;

      const { result } = collectBatches(snapshot, jsCode);
      expect(result.operationCount).toBeGreaterThan(0);
      expect(result.summary.insert).toBeGreaterThan(0);
    });
  });

  describe('timeout', () => {
    test('respects timeout for infinite loop', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          while (true) {
            // Infinite loop
          }
        };
      `;

      expect(() => collectBatches(snapshot, jsCode, 100)).toThrow(/timed out/i);
    }, 10000);
  });

  describe('security', () => {
    test('script cannot access require', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const fs = require('fs');
          fs.writeFileSync('/tmp/test', 'bad');
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).toThrow();
    });

    test('script cannot access process', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          process.exit(1);
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).toThrow();
    });
  });

  describe('helpers', () => {
    test('all documented helper functions are available in sandbox', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const helpers = {
            findTextNode: typeof findTextNode,
            extractText: typeof extractText,
            getTextContent: typeof getTextContent,
            findElements: typeof findElements,
            findByNodeName: typeof findByNodeName,
            findByText: typeof findByText,
            createFormattedText: typeof createFormattedText,
            appendBlocks: typeof appendBlocks,
            xpath: typeof xpath,
            xpathFirst: typeof xpathFirst,
            getFormattedContent: typeof getFormattedContent,
            setFormattedContent: typeof setFormattedContent,
            getPlainText: typeof getPlainText,
            getParagraphs: typeof getParagraphs,
            setParagraphs: typeof setParagraphs,
          };

          for (const [name, type] of Object.entries(helpers)) {
            if (type !== 'function') {
              throw new Error(name + ' is not available (got ' + type + ')');
            }
          }

          if (typeof Y.XmlElement !== 'function') throw new Error('Y.XmlElement not available');
          if (typeof Y.XmlText !== 'function') throw new Error('Y.XmlText not available');
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).not.toThrow();
    });

    test('createFormattedText works correctly', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const paragraph = new Y.XmlElement('paragraph');
          const text = createFormattedText([
            'Visit ',
            { text: 'Example Site', attrs: { link: { href: 'https://example.com' } } },
            ' for more info'
          ]);
          paragraph.insert(0, [text]);
          doc.insert(0, [paragraph]);
        };
      `;

      const { result, batches } = collectBatches(snapshot, jsCode);
      expect(result.operationCount).toBeGreaterThan(0);

      const xmlFragment = reconstructDoc(snapshot, batches);
      expect(xmlFragment.length).toBe(1);

      const textNode = xmlFragment.get(0).get(0);
      const delta = textNode.toDelta();
      expect(delta.length).toBe(3);
      expect(delta[0].insert).toBe('Visit ');
      expect(delta[1].insert).toBe('Example Site');
      expect(delta[1].attributes).toEqual({ link: { href: 'https://example.com' } });
      expect(delta[2].insert).toBe(' for more info');
    });

    test('createFormattedText tracks operations', () => {
      const snapshot = createSnapshot();
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

      const { result } = collectBatches(snapshot, jsCode);
      expect(result.operationCount).toBeGreaterThan(0);
      expect(result.summary.format).toBeGreaterThanOrEqual(1);
    });

    test('createFormattedText throws for invalid input', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          createFormattedText([]);
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).toThrow('non-empty array');
    });

    test('appendBlocks creates blocks and tracks operations', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          appendBlocks(doc, [
            { type: 'heading', level: 2, content: 'Title' },
            { type: 'paragraph', content: 'Content here.' }
          ]);
        };
      `;

      const { result, batches } = collectBatches(snapshot, jsCode);
      expect(result.operationCount).toBeGreaterThan(0);

      const xmlFragment = reconstructDoc(snapshot, batches);
      expect(xmlFragment.length).toBe(2);
      expect(xmlFragment.get(0).nodeName).toBe('heading');
      expect(xmlFragment.get(0).getAttribute('level')).toBe(2);
      expect(xmlFragment.get(1).nodeName).toBe('paragraph');
    });

    test('appendBlocks creates formatted content', () => {
      const snapshot = createSnapshot();
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

      const { result, batches } = collectBatches(snapshot, jsCode);
      expect(result.operationCount).toBeGreaterThan(0);

      const xmlFragment = reconstructDoc(snapshot, batches);
      const para = xmlFragment.get(0);
      const text = para.get(0);
      const delta = text.toDelta();
      expect(delta.length).toBe(3);
      expect(delta[1].attributes).toEqual({ bold: true });
    });

    test('appendBlocks creates lists', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          appendBlocks(doc, [
            { type: 'bulletList', items: ['Item 1', 'Item 2'] },
            { type: 'orderedList', items: ['First', 'Second'] }
          ]);
        };
      `;

      const { result, batches } = collectBatches(snapshot, jsCode);
      expect(result.operationCount).toBeGreaterThan(0);

      const xmlFragment = reconstructDoc(snapshot, batches);
      expect(xmlFragment.length).toBe(2);
      expect(xmlFragment.get(0).nodeName).toBe('bulletList');
      expect(xmlFragment.get(1).nodeName).toBe('orderedList');
    });

    test('appendBlocks returns created elements', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const elements = appendBlocks(doc, [
            { type: 'heading', level: 2, content: 'Test' },
            { type: 'paragraph', content: 'Content' }
          ]);

          if (elements.length !== 2) {
            throw new Error('Expected 2 elements, got ' + elements.length);
          }
          if (elements[0].nodeName !== 'heading') {
            throw new Error('First element should be heading');
          }
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).not.toThrow();
    });

    test('script can access Yjs fragment methods', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const length = doc.length;
          const arr = doc.toArray();
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).not.toThrow();
    });

    test('handles complex script with helper functions', () => {
      const snapshot = createSnapshot();
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

      const { result, batches } = collectBatches(snapshot, jsCode);
      expect(result.operationCount).toBeGreaterThan(0);

      const xmlFragment = reconstructDoc(snapshot, batches);
      expect(xmlFragment.length).toBe(2);
    });
  });

  describe('detailed error messages', () => {
    test('undefined property access includes hint about findByText/findElements returning empty array', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const results = [];
          const item = results[0];
          item.insert(0, 'text');
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).toThrow(
        /findByText\(\), findElements\(\), or xpath\(\) returned an empty array/
      );
    });

    test('null property access includes hint about findTextNode/xpathFirst returning null', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const result = null;
          result.toDelta();
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).toThrow(
        /findTextNode\(\) returned null|xpathFirst\(\) returned null/
      );
    });

    test('undefined variable includes hint about sandbox availability', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const data = someUndefinedVariable;
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).toThrow(
        /is not available in the sandbox/
      );
    });

    test('is not a function error includes hint about Yjs object types', () => {
      const snapshot = createSnapshot();
      const jsCode = `
        exports.default = function(doc) {
          const text = new Y.XmlText();
          text.notAMethod();
        };
      `;

      expect(() => collectBatches(snapshot, jsCode)).toThrow(
        /Check that you're calling methods on the correct Yjs object types/
      );
    });
  });
});
