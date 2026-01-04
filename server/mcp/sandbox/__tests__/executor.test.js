/**
 * Tests for sandbox executor
 */
const { executeSandboxed } = require('../executor');
const Y = require('yjs');

describe('Sandbox executor', () => {
  let ydoc;
  let xmlFragment;

  beforeEach(() => {
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);
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

      const result = executeSandboxed(jsCode, xmlFragment, 5000);

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

      const result = executeSandboxed(jsCode, xmlFragment, 5000);

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
      expect(() => executeSandboxed(jsCode, xmlFragment, 5000)).not.toThrow();
    });

    test('throws error for script without default export', () => {
      const jsCode = `
        function someFunction(doc) {
          // Not exported
        }
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, 5000)).toThrow(/default function/i);
    });

    test('throws error for script that throws', () => {
      const jsCode = `
        exports.default = function(doc) {
          throw new Error('Script error');
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, 5000)).toThrow(/Script error/i);
    });

    test('respects timeout for infinite loop', () => {
      const jsCode = `
        exports.default = function(doc) {
          while (true) {
            // Infinite loop
          }
        };
      `;

      expect(() => executeSandboxed(jsCode, xmlFragment, 100)).toThrow(/timed out/i);
    }, 10000); // Give test itself more time

    test('script can access Yjs fragment methods', () => {
      const jsCode = `
        exports.default = function(doc) {
          const length = doc.length;
          const arr = doc.toArray();
        };
      `;

      const result = executeSandboxed(jsCode, xmlFragment, 5000);

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
      expect(() => executeSandboxed(jsCode, xmlFragment, 5000)).toThrow();
    });

    test('script cannot access process', () => {
      const jsCode = `
        exports.default = function(doc) {
          process.exit(1);
        };
      `;

      // Should throw because process is not available in sandbox
      expect(() => executeSandboxed(jsCode, xmlFragment, 5000)).toThrow();
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

      const result = executeSandboxed(jsCode, xmlFragment, 5000);

      expect(result.success).toBe(true);

      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(2);
    });
  });
});
