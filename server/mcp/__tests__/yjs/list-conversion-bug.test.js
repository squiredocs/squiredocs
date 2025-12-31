/**
 * Test for list conversion bug
 *
 * Reproduces the issue where converting a paragraph to a list causes the block to disappear
 */
const Y = require('yjs');
const { buildYjsNode } = require('../../yjs/node-builder');

describe('List conversion bug', () => {
  test('converts paragraph to ordered list with mixed content', () => {
    // Create a document with a paragraph
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('test', Y.XmlFragment);

    // Add initial paragraph
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Original paragraph text');
    para.insert(0, [text]);
    xmlFragment.insert(0, [para]);

    expect(xmlFragment.length).toBe(1);
    expect(xmlFragment.get(0).nodeName).toBe('paragraph');

    // Now replace it with an ordered list (simulating update_document_block)
    const newContent = {
      type: 'orderedList',
      children: [
        {
          type: 'listItem',
          content: [
            {
              text: 'Current workflow',
              marks: ['bold']
            },
            ': "Walk me through what you do when an earthquake happens in your monitoring area."'
          ]
        },
        {
          type: 'listItem',
          content: 'Second item'
        }
      ]
    };

    // Delete old, insert new (what update_document_block does)
    ydoc.transact(() => {
      xmlFragment.delete(0, 1);
      const newNode = buildYjsNode(newContent);
      xmlFragment.insert(0, [newNode]);
    });

    // Check the list was created
    expect(xmlFragment.length).toBe(1);
    const list = xmlFragment.get(0);
    expect(list.nodeName).toBe('orderedList');
    expect(list.length).toBe(2);

    // Check first item with mixed content
    const item1 = list.get(0);
    expect(item1.nodeName).toBe('listItem');
    console.log('Item 1 length:', item1.length);
    console.log('Item 1 contents:', Array.from({ length: item1.length }, (_, i) => {
      const child = item1.get(i);
      return { type: child.constructor.name, text: child.toString() };
    }));

    // Check that content exists
    expect(item1.length).toBeGreaterThan(0);
  });

  test('builds list with empty content', () => {
    const newContent = {
      type: 'orderedList',
      children: [
        {
          type: 'listItem',
          content: []  // Empty content array
        }
      ]
    };

    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('test', Y.XmlFragment);
    const newNode = buildYjsNode(newContent);
    xmlFragment.insert(0, [newNode]);

    const list = xmlFragment.get(0);
    expect(list.nodeName).toBe('orderedList');

    const item = list.get(0);
    expect(item.nodeName).toBe('listItem');
    console.log('Empty item length:', item.length);
  });

  test('builds list with undefined content', () => {
    const newContent = {
      type: 'orderedList',
      children: [
        {
          type: 'listItem',
          // No content field at all
        }
      ]
    };

    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('test', Y.XmlFragment);
    const newNode = buildYjsNode(newContent);
    xmlFragment.insert(0, [newNode]);

    const list = xmlFragment.get(0);
    expect(list.nodeName).toBe('orderedList');

    const item = list.get(0);
    expect(item.nodeName).toBe('listItem');
    console.log('No content item length:', item.length);
  });
});
