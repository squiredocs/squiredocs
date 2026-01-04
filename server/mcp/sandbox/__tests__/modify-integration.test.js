/**
 * Integration test for modify tool sandbox
 * Tests end-to-end TypeScript execution with Yjs documents
 */
const Y = require('yjs');
const { executeScript } = require('../index');

describe('modify Integration', () => {
  let ydoc;
  let xmlFragment;
  let mockSession;

  beforeEach(() => {
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);

    // Mock session object
    mockSession = {
      provider: {
        doc: ydoc,
      },
      undoManager: new Y.UndoManager(xmlFragment),
      sessionId: 'test-session-123',
    };
  });

  describe('executeScript', () => {
    test('executes simple text insertion script', async () => {
      const script = `
        export default function edit(doc) {
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, 'Hello world');
          paragraph.insert(0, [text]);
          doc.insert(0, [paragraph]);
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.operationCount).toBeGreaterThan(0);

      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(1);
      expect(blocks[0].nodeName).toBe('paragraph');
    });

    test('tracks operations correctly', async () => {
      const script = `
        export default function edit(doc) {
          const p1 = new Y.XmlElement('paragraph');
          const p2 = new Y.XmlElement('paragraph');
          doc.insert(0, [p1, p2]);
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.operationCount).toBeGreaterThan(0);
      expect(result.summary).toBeDefined();
      expect(result.summary.insert).toBeGreaterThan(0);
    });

    test('supports TypeScript syntax and features', async () => {
      const script = `
        interface BlockData {
          type: string;
          content: string;
        }

        export default function edit(doc: any) {
          const blocks: BlockData[] = [
            { type: 'paragraph', content: 'First' },
            { type: 'paragraph', content: 'Second' },
          ];

          blocks.forEach((data) => {
            const para = new Y.XmlElement(data.type);
            const text = new Y.XmlText();
            text.insert(0, data.content);
            para.insert(0, [text]);
            doc.insert(doc.length, [para]);
          });
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);

      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(2);
    });

    test('handles formatting operations', async () => {
      // Pre-populate document
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello world');
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const script = `
        export default function edit(doc) {
          const block = doc.get(0);
          const textNode = block.get(0);
          textNode.format(0, 5, { bold: true });
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.summary.format).toBe(1);

      // Verify formatting was applied
      const updatedBlock = xmlFragment.get(0);
      const updatedText = updatedBlock.get(0);
      const delta = updatedText.toDelta();
      expect(delta[0].attributes?.bold).toBe(true);
    });

    test('supports complex nested structures', async () => {
      const script = `
        export default function edit(doc) {
          // Create nested bullet list
          const list = new Y.XmlElement('bulletList');

          const item1 = new Y.XmlElement('listItem');
          const p1 = new Y.XmlElement('paragraph');
          const t1 = new Y.XmlText();
          t1.insert(0, 'Main item');
          p1.insert(0, [t1]);
          item1.insert(0, [p1]);

          // Nested list
          const nestedList = new Y.XmlElement('bulletList');
          const nestedItem = new Y.XmlElement('listItem');
          const np = new Y.XmlElement('paragraph');
          const nt = new Y.XmlText();
          nt.insert(0, 'Sub item');
          np.insert(0, [nt]);
          nestedItem.insert(0, [np]);
          nestedList.insert(0, [nestedItem]);

          item1.insert(1, [nestedList]);
          list.insert(0, [item1]);

          doc.insert(0, [list]);
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);

      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(1);
      expect(blocks[0].nodeName).toBe('bulletList');

      // Verify nested structure
      const listItem = blocks[0].get(0);
      expect(listItem.length).toBe(2); // paragraph + nested list
      expect(listItem.get(1).nodeName).toBe('bulletList');
    });

    test('script errors are caught and reported', async () => {
      const script = `
        export default function edit(doc) {
          throw new Error('Intentional error');
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Intentional error');
    });

    test('compilation errors are caught and reported', async () => {
      const script = `
        export default function edit(doc: any) {
          const x = ;
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('compilation');
    });

    test('changes are atomic (undo manager)', async () => {
      const script = `
        export default function edit(doc) {
          const p1 = new Y.XmlElement('paragraph');
          const p2 = new Y.XmlElement('paragraph');
          const p3 = new Y.XmlElement('paragraph');
          doc.insert(0, [p1, p2, p3]);
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(xmlFragment.length).toBe(3);

      // Undo should revert all changes
      mockSession.undoManager.undo();
      expect(xmlFragment.length).toBe(0);

      // Redo should restore all changes
      mockSession.undoManager.redo();
      expect(xmlFragment.length).toBe(3);
    });

    test('error causes rollback (no partial changes)', async () => {
      const script = `
        export default function edit(doc) {
          const p1 = new Y.XmlElement('paragraph');
          doc.insert(0, [p1]);

          // This will cause an error
          throw new Error('Fail after insert');
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(false);

      // Document should be unchanged (rollback)
      expect(xmlFragment.length).toBe(0);
    });

    test('find and replace pattern', async () => {
      // Pre-populate with multiple paragraphs
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'TODO: fix this');
      p1.insert(0, [t1]);

      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.insert(0, 'TODO: also fix this');
      p2.insert(0, [t2]);

      xmlFragment.insert(0, [p1, p2]);

      const script = `
        export default function edit(doc) {
          function extractText(xmlText) {
            const delta = xmlText.toDelta();
            return delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');
          }

          function findTextNode(element) {
            for (const child of element.toArray()) {
              if (child instanceof Y.XmlText) return child;
              if (child instanceof Y.XmlElement) {
                const found = findTextNode(child);
                if (found) return found;
              }
            }
            return null;
          }

          const blocks = doc.toArray();
          blocks.forEach(block => {
            if (block instanceof Y.XmlElement) {
              const text = findTextNode(block);
              if (text) {
                const content = extractText(text);
                const index = content.indexOf('TODO');
                if (index >= 0) {
                  text.format(index, 4, { bold: true });
                }
              }
            }
          });
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);

      // Verify both TODO items were formatted
      const block1 = xmlFragment.get(0);
      const text1 = block1.get(0);
      const delta1 = text1.toDelta();
      expect(delta1[0].attributes?.bold).toBe(true);

      const block2 = xmlFragment.get(1);
      const text2 = block2.get(0);
      const delta2 = text2.toDelta();
      expect(delta2[0].attributes?.bold).toBe(true);
    });

    test('respects timeout', async () => {
      const script = `
        export default function edit(doc) {
          while (true) {
            // Infinite loop
          }
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 100,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    }, 10000);

    test('works with attributes', async () => {
      const script = `
        export default function edit(doc) {
          const heading = new Y.XmlElement('heading');
          heading.setAttribute('level', 2);
          const text = new Y.XmlText();
          text.insert(0, 'My Heading');
          heading.insert(0, [text]);
          doc.insert(0, [heading]);
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);

      const heading = xmlFragment.get(0);
      expect(heading.getAttribute('level')).toBe(2);
    });
  });
});
