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

    test('tracks format operations that remove formatting (bold: null)', async () => {
      // Pre-populate document with bold text
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello world');
      text.format(0, 5, { bold: true }); // Make "Hello" bold
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const script = `
        export default function edit(doc) {
          const block = doc.get(0);
          const textNode = block.get(0);
          textNode.format(0, 5, { bold: null }); // Remove bold
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.summary.format).toBe(1); // Should track the format operation

      // Verify formatting was removed
      const updatedBlock = xmlFragment.get(0);
      const updatedText = updatedBlock.get(0);
      const delta = updatedText.toDelta();
      expect(delta[0].attributes?.bold).toBeUndefined();
    });

    test('tracks format operations when iterating with forEach', async () => {
      // Pre-populate document with two paragraphs with bold text
      const para1 = new Y.XmlElement('paragraph');
      const text1 = new Y.XmlText();
      text1.insert(0, 'sunrise');
      text1.format(0, 7, { bold: true });
      para1.insert(0, [text1]);

      const para2 = new Y.XmlElement('paragraph');
      const text2 = new Y.XmlText();
      text2.insert(0, 'walk');
      text2.format(0, 4, { bold: true });
      para2.insert(0, [text2]);

      xmlFragment.insert(0, [para1, para2]);

      const script = `
        export default function edit(doc) {
          const blocks = doc.toArray();
          blocks.forEach(block => {
            const children = block.toArray();
            children.forEach(child => {
              if (child instanceof Y.XmlText) {
                const text = child.toString();
                child.format(0, text.length, { bold: null });
              }
            });
          });
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.summary.format).toBe(2); // Should track both format operations
    });

    test('tracks format operations when using helper functions', async () => {
      // Pre-populate document with bold text
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello world');
      text.format(0, 5, { bold: true });
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const script = `
        function findTextNodes(element: any): any[] {
          const results: any[] = [];
          const children = element.toArray();
          for (const child of children) {
            if (child instanceof Y.XmlText) {
              results.push(child);
            } else if (child instanceof Y.XmlElement) {
              results.push(...findTextNodes(child));
            }
          }
          return results;
        }

        export default function edit(doc) {
          const blocks = doc.toArray();
          for (const block of blocks) {
            const textNodes = findTextNodes(block);
            for (const textNode of textNodes) {
              textNode.format(0, 5, { bold: null });
            }
          }
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.summary.format).toBe(1); // Should track the format operation
    });

    test('tracks format operations when using built-in findTextNode helper', async () => {
      // Pre-populate document with bold text
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'sunrise walk');
      text.format(0, 7, { bold: true }); // Bold "sunrise"
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const script = `
        export default function edit(doc) {
          const blocks = doc.toArray();
          for (const block of blocks) {
            const textNode = findTextNode(block);
            if (textNode) {
              const content = extractText(textNode);
              textNode.format(0, content.length, { bold: null });
            }
          }
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.summary.format).toBe(1); // Should track the format operation
    });

    test('format with empty object {} does NOT remove formatting', async () => {
      // Pre-populate document with bold text
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'bold text');
      text.format(0, 4, { bold: true }); // "bold" is bold
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const script = `
        export default function edit(doc) {
          const block = doc.get(0);
          const textNode = block.get(0);
          // NOTE: Empty object {} does NOT remove formatting!
          // Use { bold: null } to remove bold.
          textNode.format(0, 4, {});
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.summary.format).toBe(1);

      // Verify formatting is STILL present (empty object doesn't remove it)
      const updatedBlock = xmlFragment.get(0);
      const updatedText = updatedBlock.get(0);
      const delta = updatedText.toDelta();
      expect(delta[0].attributes?.bold).toBe(true); // Still bold!
    });

    test('tracks removing multiple bold words in sequence', async () => {
      // Pre-populate document with multiple bold words
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'sunrise and walk are keywords');
      text.format(0, 7, { bold: true }); // "sunrise" bold
      text.format(12, 4, { bold: true }); // "walk" bold
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const script = `
        export default function edit(doc) {
          const block = doc.get(0);
          const textNode = block.get(0);
          const content = extractText(textNode);

          // Find and unbold "sunrise"
          const sunriseIdx = content.indexOf('sunrise');
          if (sunriseIdx >= 0) {
            textNode.format(sunriseIdx, 7, { bold: null });
          }

          // Find and unbold "walk"
          const walkIdx = content.indexOf('walk');
          if (walkIdx >= 0) {
            textNode.format(walkIdx, 4, { bold: null });
          }
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.summary.format).toBe(2); // Should track both format operations
    });

    test('tracks removing bold across multiple blocks', async () => {
      // Pre-populate document with bold text in multiple paragraphs
      const para1 = new Y.XmlElement('paragraph');
      const text1 = new Y.XmlText();
      text1.insert(0, 'First keyword here');
      text1.format(6, 7, { bold: true }); // "keyword" bold
      para1.insert(0, [text1]);

      const para2 = new Y.XmlElement('paragraph');
      const text2 = new Y.XmlText();
      text2.insert(0, 'Second keyword there');
      text2.format(7, 7, { bold: true }); // "keyword" bold
      para2.insert(0, [text2]);

      xmlFragment.insert(0, [para1, para2]);

      const script = `
        export default function edit(doc) {
          const blocks = doc.toArray();
          blocks.forEach(block => {
            if (block instanceof Y.XmlElement) {
              const textNode = findTextNode(block);
              if (textNode) {
                const content = extractText(textNode);
                const idx = content.indexOf('keyword');
                if (idx >= 0) {
                  textNode.format(idx, 7, { bold: null });
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
      expect(result.summary.format).toBe(2); // Should track both format operations
    });

    test('tracks removing bold using findByText helper', async () => {
      // Pre-populate document with bold keywords
      const para1 = new Y.XmlElement('paragraph');
      const text1 = new Y.XmlText();
      text1.insert(0, 'TODO: fix this');
      text1.format(0, 4, { bold: true }); // "TODO" bold
      para1.insert(0, [text1]);

      const para2 = new Y.XmlElement('paragraph');
      const text2 = new Y.XmlText();
      text2.insert(0, 'Another TODO item');
      text2.format(8, 4, { bold: true }); // "TODO" bold
      para2.insert(0, [text2]);

      xmlFragment.insert(0, [para1, para2]);

      const script = `
        export default function edit(doc) {
          // Use findByText helper to find all blocks with TODO
          const todoBlocks = findByText(doc, 'TODO');
          todoBlocks.forEach(block => {
            const textNode = findTextNode(block);
            if (textNode) {
              const content = extractText(textNode);
              const idx = content.indexOf('TODO');
              if (idx >= 0) {
                textNode.format(idx, 4, { bold: null }); // Remove bold
              }
            }
          });
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.summary.format).toBe(2); // Should track both format operations
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

    test('read/modify/write preserves formatting with getFormattedContent/setFormattedContent', async () => {
      // Pre-populate document with formatted content
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello foo and bold foo text');
      text.format(14, 4, { bold: true }); // "bold" is bold
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const script = `
        export default function edit(doc) {
          const para = doc.get(0);
          const segments = getFormattedContent(para);

          // Modify only plain text segments, preserving formatting
          const updated = segments.map(s =>
            typeof s === 'string' ? s.replace(/foo/g, 'bar') : s
          );

          setFormattedContent(para, updated);
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);

      // Verify text was replaced
      const updatedPara = xmlFragment.get(0);
      const updatedText = updatedPara.get(0);
      const delta = updatedText.toDelta();

      // Get full text - should have replaced "foo" with "bar"
      const fullText = delta.map(op => op.insert).join('');
      expect(fullText).toBe('Hello bar and bold bar text');

      // Verify "bold" is still bold
      const boldSegment = delta.find(op => op.insert === 'bold');
      expect(boldSegment).toBeDefined();
      expect(boldSegment.attributes?.bold).toBe(true);
    });

    test('read/modify/write preserves link formatting', async () => {
      // Pre-populate document with a link
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Visit Example for more');
      text.format(6, 7, { link: { href: 'https://example.com' } });
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const script = `
        export default function edit(doc) {
          const para = doc.get(0);
          const segments = getFormattedContent(para);

          // Modify plain text, preserve link
          const updated = segments.map(s =>
            typeof s === 'string' ? s.replace('more', 'info') : s
          );

          setFormattedContent(para, updated);
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);

      // Verify text was replaced
      const updatedPara = xmlFragment.get(0);
      const updatedText = updatedPara.get(0);
      const delta = updatedText.toDelta();

      const fullText = delta.map(op => op.insert).join('');
      expect(fullText).toBe('Visit Example for info');

      // Verify link is preserved
      const linkSegment = delta.find(op => op.insert === 'Example');
      expect(linkSegment).toBeDefined();
      expect(linkSegment.attributes?.link?.href).toBe('https://example.com');
    });

    test('getPlainText extracts text from segments for searching', async () => {
      // Pre-populate document with formatted TODO
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'TODO: complete task');
      text.format(0, 4, { bold: true });
      para.insert(0, [text]);
      xmlFragment.insert(0, [para]);

      const script = `
        export default function edit(doc) {
          const para = doc.get(0);
          const segments = getFormattedContent(para);

          // Use getPlainText to search
          if (getPlainText(segments).includes('TODO')) {
            // Found TODO, replace the plain text portions
            const updated = segments.map(s =>
              typeof s === 'string' ? s.replace('complete task', 'DONE') : s
            );
            setFormattedContent(para, updated);
          }
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);

      const updatedPara = xmlFragment.get(0);
      const updatedText = updatedPara.get(0);
      const delta = updatedText.toDelta();

      const fullText = delta.map(op => op.insert).join('');
      expect(fullText).toBe('TODO: DONE');

      // Verify TODO is still bold
      expect(delta[0].attributes?.bold).toBe(true);
    });

    test('getParagraphs and setParagraphs work with multi-paragraph containers', async () => {
      // Pre-populate document with list item containing multiple paragraphs
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const para1 = new Y.XmlElement('paragraph');
      const text1 = new Y.XmlText();
      text1.insert(0, 'First line');
      para1.insert(0, [text1]);
      const para2 = new Y.XmlElement('paragraph');
      const text2 = new Y.XmlText();
      text2.insert(0, 'Second line');
      para2.insert(0, [text2]);
      item.insert(0, [para1, para2]);
      list.insert(0, [item]);
      xmlFragment.insert(0, [list]);

      const script = `
        export default function edit(doc) {
          const list = doc.get(0);
          const item = list.get(0);

          // Read all paragraphs
          const paras = getParagraphs(item);

          // Modify and add new paragraphs
          const updated = [
            ...paras.map(p =>
              p.map(s => typeof s === 'string' ? s.toUpperCase() : s)
            ),
            ['Third line']
          ];

          setParagraphs(item, updated);
        }
      `;

      const result = await executeScript(script, mockSession, xmlFragment, {
        timeout: 5000,
      });

      expect(result.success).toBe(true);

      const updatedList = xmlFragment.get(0);
      const updatedItem = updatedList.get(0);

      // Should now have 3 paragraphs
      const children = updatedItem.toArray().filter(c =>
        c instanceof Y.XmlElement && c.nodeName === 'paragraph'
      );
      expect(children.length).toBe(3);

      // Verify content was uppercased
      const helpers = require('../helpers');
      expect(helpers.getTextContent(children[0])).toBe('FIRST LINE');
      expect(helpers.getTextContent(children[1])).toBe('SECOND LINE');
      expect(helpers.getTextContent(children[2])).toBe('Third line');
    });
  });
});
