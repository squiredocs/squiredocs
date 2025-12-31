/**
 * Integration test for bulletList persistence
 * Verifies that bulletLists with paragraph-wrapped content persist correctly
 * This test reproduces the user's bug report and validates the fix
 */
const Y = require('yjs');
const { buildYjsNode } = require('../../yjs/node-builder');
const { formatDocumentStructure } = require('../../yjs/block-structure');

describe('BulletList Integration (Bug Fix Verification)', () => {
  test('bulletList persists in Y.Doc and appears in formatted structure', () => {
    // Create a Y.Doc (simulating a document)
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);

    // Add some initial content
    const para1 = buildYjsNode({
      type: 'paragraph',
      content: 'Introduction paragraph',
    });

    // THE BUG: This bulletList would disappear because listItems had bare text
    // THE FIX: ListItems now have paragraph wrappers
    const bulletList = buildYjsNode({
      type: 'bulletList',
      children: [
        { type: 'listItem', content: 'Free access to the platform' },
        { type: 'listItem', content: 'Early access to API features' },
        { type: 'listItem', content: 'Direct input on data formats' },
      ],
    });

    const para2 = buildYjsNode({
      type: 'paragraph',
      content: 'Conclusion paragraph',
    });

    // Insert all blocks
    xmlFragment.insert(0, [para1, bulletList, para2]);

    // Verify the document has all 3 blocks
    expect(xmlFragment.length).toBe(3);

    // Verify block 1 (index 1) is the bulletList
    const block1 = xmlFragment.get(1);
    expect(block1.nodeName).toBe('bulletList');
    expect(block1.length).toBe(3); // 3 list items

    // Verify each listItem has proper structure
    for (let i = 0; i < 3; i++) {
      const listItem = block1.get(i);
      expect(listItem.nodeName).toBe('listItem');
      expect(listItem.length).toBe(1); // Should have 1 paragraph

      const paragraph = listItem.get(0);
      expect(paragraph.nodeName).toBe('paragraph');
      expect(paragraph.length).toBeGreaterThan(0); // Paragraph has text
    }

    // Get formatted structure (what MCP tools return)
    const structure = formatDocumentStructure(xmlFragment);

    // Verify the bulletList appears in the structure output
    expect(structure).toContain('bulletList');
    expect(structure).toContain('listItem');
    expect(structure).toContain('Free access');
    expect(structure).toContain('Early access');
    expect(structure).toContain('Direct input');

    console.log('\nFormatted structure (what users see):');
    console.log(structure);
  });

  test('bulletList survives serialization/deserialization (persistence)', () => {
    // Create doc 1 with bulletList
    const ydoc1 = new Y.Doc();
    const fragment1 = ydoc1.get('default', Y.XmlFragment);

    const bulletList = buildYjsNode({
      type: 'bulletList',
      children: [
        {
          type: 'listItem',
          content: 'Free access to the platform (normally $X/month when it launches)',
        },
        {
          type: 'listItem',
          content: 'Early access to API/export features as we build them',
        },
      ],
    });

    fragment1.insert(0, [bulletList]);

    // Serialize (simulates saving to database)
    const update = Y.encodeStateAsUpdate(ydoc1);

    // Create doc 2 and apply update (simulates loading from database)
    const ydoc2 = new Y.Doc();
    Y.applyUpdate(ydoc2, update);
    const fragment2 = ydoc2.get('default', Y.XmlFragment);

    // THE BUG: BulletList would disappear after deserialization
    // THE FIX: It now persists correctly
    expect(fragment2.length).toBe(1);

    const deserializedList = fragment2.get(0);
    expect(deserializedList.nodeName).toBe('bulletList');
    expect(deserializedList.length).toBe(2);

    // Verify structure is intact
    const item1 = deserializedList.get(0);
    const item2 = deserializedList.get(1);

    expect(item1.nodeName).toBe('listItem');
    expect(item2.nodeName).toBe('listItem');

    // Both items should have paragraph wrappers
    expect(item1.get(0).nodeName).toBe('paragraph');
    expect(item2.get(0).nodeName).toBe('paragraph');

    // Verify content is preserved
    const text1 = item1.get(0).get(0).toString();
    const text2 = item2.get(0).get(0).toString();

    expect(text1).toContain('Free access');
    expect(text2).toContain('Early access');
  });

  test('mixed content (paragraphs + bulletList + paragraphs) all persist', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.get('default', Y.XmlFragment);

    // Build a complex document structure
    const blocks = [
      buildYjsNode({ type: 'heading', level: 1, content: 'Document Title' }),
      buildYjsNode({ type: 'paragraph', content: 'First paragraph' }),
      buildYjsNode({
        type: 'bulletList',
        children: [
          { type: 'listItem', content: 'Item 1' },
          { type: 'listItem', content: 'Item 2' },
          { type: 'listItem', content: 'Item 3' },
        ],
      }),
      buildYjsNode({ type: 'paragraph', content: 'Second paragraph' }),
      buildYjsNode({
        type: 'orderedList',
        children: [
          { type: 'listItem', content: 'Step 1' },
          { type: 'listItem', content: 'Step 2' },
        ],
      }),
      buildYjsNode({ type: 'paragraph', content: 'Conclusion' }),
    ];

    fragment.insert(0, blocks);

    // Verify all blocks are present
    expect(fragment.length).toBe(6);

    // Verify block types
    expect(fragment.get(0).nodeName).toBe('heading');
    expect(fragment.get(1).nodeName).toBe('paragraph');
    expect(fragment.get(2).nodeName).toBe('bulletList'); // THE BUG: This would be missing
    expect(fragment.get(3).nodeName).toBe('paragraph');
    expect(fragment.get(4).nodeName).toBe('orderedList'); // Should also work
    expect(fragment.get(5).nodeName).toBe('paragraph');

    // Serialize and deserialize
    const update = Y.encodeStateAsUpdate(ydoc);
    const ydoc2 = new Y.Doc();
    Y.applyUpdate(ydoc2, update);
    const fragment2 = ydoc2.get('default', Y.XmlFragment);

    // After deserialization, all blocks should still be there
    expect(fragment2.length).toBe(6);
    expect(fragment2.get(2).nodeName).toBe('bulletList');
    expect(fragment2.get(4).nodeName).toBe('orderedList');
  });
});
