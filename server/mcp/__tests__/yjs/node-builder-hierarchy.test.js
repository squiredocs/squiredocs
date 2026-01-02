/**
 * Node builder hierarchy tests
 *
 * Tests enhanced node builder with multi-item lists and nested structures.
 */
const Y = require('yjs');
const { buildYjsNode, createNodeSpec } = require('../../yjs/node-builder');

/**
 * Helper to integrate a built node into a Y.Doc so we can read its contents
 */
function integrateNode(node) {
  const ydoc = new Y.Doc();
  const xmlFragment = ydoc.get('test', Y.XmlFragment);
  const yjsNode = buildYjsNode(node);
  xmlFragment.insert(0, [yjsNode]);
  return xmlFragment.get(0);
}

describe('Enhanced node builder with hierarchy support', () => {
  describe('createNodeSpec with children parameter', () => {
    test('creates single-item list (backward compatibility)', () => {
      const spec = createNodeSpec('bulletList', {}, 'List item');
      const node = integrateNode(spec);

      expect(node.nodeName).toBe('bulletList');
      expect(node.length).toBe(1);

      const listItem = node.get(0);
      expect(listItem.nodeName).toBe('listItem');
      expect(listItem.length).toBe(1);

      const paragraph = listItem.get(0);
      expect(paragraph.nodeName).toBe('paragraph');
      expect(paragraph.get(0).toString()).toBe('List item');
    });

    test('creates multi-item list with children parameter', () => {
      const children = [
        { type: 'listItem', content: 'First item' },
        { type: 'listItem', content: 'Second item' },
        { type: 'listItem', content: 'Third item' },
      ];

      const spec = createNodeSpec('bulletList', {}, '', children);
      const node = integrateNode(spec);

      expect(node.nodeName).toBe('bulletList');
      expect(node.length).toBe(3);

      const expectedContent = ['First item', 'Second item', 'Third item'];
      for (let i = 0; i < 3; i++) {
        const listItem = node.get(i);
        expect(listItem.nodeName).toBe('listItem');
        const paragraph = listItem.get(0);
        expect(paragraph.nodeName).toBe('paragraph');
        expect(paragraph.get(0).toString()).toBe(expectedContent[i]);
      }
    });

    test('creates nested list structure', () => {
      const nestedChildren = [
        { type: 'listItem', content: 'Parent item 1' },
        {
          type: 'listItem',
          content: 'Parent item 2',
          children: [
            { type: 'paragraph', content: 'Child paragraph' },
            {
              type: 'bulletList',
              children: [
                { type: 'listItem', content: 'Nested item 1' },
                { type: 'listItem', content: 'Nested item 2' },
              ]
            }
          ]
        },
      ];

      const spec = createNodeSpec('orderedList', {}, '', nestedChildren);
      const node = integrateNode(spec);

      expect(node.nodeName).toBe('orderedList');
      expect(node.length).toBe(2);

      // First item - simple
      const item1 = node.get(0);
      expect(item1.nodeName).toBe('listItem');
      expect(item1.get(0).get(0).toString()).toBe('Parent item 1');

      // Second item - complex with nested content
      const item2 = node.get(1);
      expect(item2.nodeName).toBe('listItem');
      expect(item2.length).toBe(3); // paragraph (content) + paragraph (child) + bulletList (child)

      const contentPara = item2.get(0);
      expect(contentPara.nodeName).toBe('paragraph');
      expect(contentPara.get(0).toString()).toBe('Parent item 2');

      const childPara = item2.get(1);
      expect(childPara.nodeName).toBe('paragraph');
      expect(childPara.get(0).toString()).toBe('Child paragraph');

      const nestedList = item2.get(2);
      expect(nestedList.nodeName).toBe('bulletList');
      expect(nestedList.length).toBe(2);

      const nestedItem1 = nestedList.get(0);
      expect(nestedItem1.get(0).get(0).toString()).toBe('Nested item 1');
    });

    test('creates listItem with nested children', () => {
      const children = [
        { type: 'paragraph', content: 'Main content' },
        { type: 'bulletList', children: [
          { type: 'listItem', content: 'Sub item 1' },
          { type: 'listItem', content: 'Sub item 2' },
        ]}
      ];

      const spec = createNodeSpec('listItem', {}, '', children);
      const node = integrateNode(spec);

      expect(node.nodeName).toBe('listItem');
      expect(node.length).toBe(3); // content paragraph (empty) + child paragraph + child bulletList

      const contentPara = node.get(0);
      expect(contentPara.nodeName).toBe('paragraph');
      expect(contentPara.get(0).toString()).toBe(''); // empty content

      const childPara = node.get(1);
      expect(childPara.nodeName).toBe('paragraph');
      expect(childPara.get(0).toString()).toBe('Main content');

      const subList = node.get(2);
      expect(subList.nodeName).toBe('bulletList');
      expect(subList.length).toBe(2);
    });
  });

  describe('buildYjsNode with complex children', () => {
    test('handles deeply nested structures', () => {
      const complexNode = {
        type: 'bulletList',
        children: [
          {
            type: 'listItem',
            children: [
              { type: 'paragraph', content: 'Level 1' },
              {
                type: 'orderedList',
                children: [
                  {
                    type: 'listItem',
                    children: [
                      { type: 'paragraph', content: 'Level 2' },
                      {
                        type: 'bulletList',
                        children: [
                          { type: 'listItem', content: 'Level 3' }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      };

      const node = integrateNode(complexNode);

      // Verify the structure
      expect(node.nodeName).toBe('bulletList');
      const level1Item = node.get(0);
      expect(level1Item.nodeName).toBe('listItem');

      const contentPara = level1Item.get(0);
      expect(contentPara.get(0).toString()).toBe(''); // empty content paragraph

      const level1Para = level1Item.get(1);
      expect(level1Para.get(0).toString()).toBe('Level 1');

      const level2List = level1Item.get(2);
      expect(level2List.nodeName).toBe('orderedList');

      const level2Item = level2List.get(0);
      expect(level2Item.nodeName).toBe('listItem');

      const level2ContentPara = level2Item.get(0);
      expect(level2ContentPara.get(0).toString()).toBe(''); // empty content

      const level2Para = level2Item.get(1);
      expect(level2Para.get(0).toString()).toBe('Level 2');

      const level3List = level2Item.get(2);
      expect(level3List.nodeName).toBe('bulletList');

      const level3Item = level3List.get(0);
      expect(level3Item.get(0).get(0).toString()).toBe('Level 3');
    });

    test('handles mixed content types in children', () => {
      const mixedNode = {
        type: 'listItem',
        children: [
          { type: 'paragraph', content: 'Text paragraph' },
          { type: 'heading', level: 2, content: 'Heading' },
          {
            type: 'codeBlock',
            language: 'javascript',
            content: 'console.log("code");'
          },
          {
            type: 'bulletList',
            children: [
              { type: 'listItem', content: 'List item' }
            ]
          }
        ]
      };

      const node = integrateNode(mixedNode);

      expect(node.nodeName).toBe('listItem');
      expect(node.length).toBe(5); // content paragraph + 4 children

      expect(node.get(0).nodeName).toBe('paragraph');
      expect(node.get(0).get(0).toString()).toBe(''); // empty content paragraph

      expect(node.get(1).nodeName).toBe('paragraph');
      expect(node.get(1).get(0).toString()).toBe('Text paragraph');

      expect(node.get(2).nodeName).toBe('heading');
      expect(node.get(2).getAttribute('level')).toBe(2);
      expect(node.get(2).get(0).toString()).toBe('Heading');

      expect(node.get(3).nodeName).toBe('codeBlock');
      expect(node.get(3).getAttribute('language')).toBe('javascript');
      expect(node.get(3).get(0).toString()).toBe('console.log("code");');

      expect(node.get(4).nodeName).toBe('bulletList');
      expect(node.get(4).length).toBe(1);
    });
  });
});
