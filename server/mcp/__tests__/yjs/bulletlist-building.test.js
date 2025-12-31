/**
 * Test bulletList building with node-builder
 * Tests the exact structure the user is trying to create
 */
const Y = require('yjs');
const { buildYjsNode } = require('../../yjs/node-builder');

// Helper to integrate node into a Y.Doc for inspection
function integrateNode(nodeSpec) {
  const ydoc = new Y.Doc();
  const fragment = ydoc.get('default', Y.XmlFragment);

  const node = buildYjsNode(nodeSpec);
  fragment.insert(0, [node]);

  return fragment.get(0);
}

// Helper to inspect node structure
function inspectNode(node, depth = 0) {
  const indent = '  '.repeat(depth);
  let result = `${indent}${node.constructor.name}:${node.nodeName || 'text'}`;

  if (node instanceof Y.XmlElement) {
    result += ` (${node.length} children)\n`;
    for (let i = 0; i < node.length; i++) {
      result += inspectNode(node.get(i), depth + 1);
    }
  } else if (node instanceof Y.XmlText) {
    result += ` "${node.toString()}"\n`;
  } else {
    result += '\n';
  }

  return result;
}

describe('BulletList Building', () => {
  test('builds bulletList with simple string content (user example)', () => {
    const spec = {
      type: 'bulletList',
      children: [
        { type: 'listItem', content: 'First item' },
        { type: 'listItem', content: 'Second item' },
        { type: 'listItem', content: 'Third item' },
      ],
    };

    const bulletList = integrateNode(spec);

    console.log('Built structure:');
    console.log(inspectNode(bulletList));

    // Verify it's a bulletList
    expect(bulletList.nodeName).toBe('bulletList');

    // Should have 3 children (listItems)
    expect(bulletList.length).toBe(3);

    // Check each listItem
    for (let i = 0; i < 3; i++) {
      const listItem = bulletList.get(i);
      expect(listItem.nodeName).toBe('listItem');

      // CRITICAL: Each listItem should have exactly 1 child (the paragraph wrapper)
      expect(listItem.length).toBe(1);

      // The first child should be a PARAGRAPH (TipTap schema requirement)
      const paragraph = listItem.get(0);
      expect(paragraph.nodeName).toBe('paragraph');

      // The paragraph should contain text
      expect(paragraph.length).toBeGreaterThan(0);
      const textNode = paragraph.get(0);
      expect(textNode.constructor.name).toBe('YXmlText');

      // Verify the text content
      const expectedTexts = ['First item', 'Second item', 'Third item'];
      expect(textNode.toString()).toBe(expectedTexts[i]);
    }
  });

  test('builds bulletList with user actual example', () => {
    const spec = {
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
        {
          type: 'listItem',
          content: 'Direct input on what data formats and delivery methods actually work for your use case',
        },
        {
          type: 'listItem',
          content: 'First look at historical datasets we\'re compiling',
        },
      ],
    };

    const bulletList = integrateNode(spec);

    console.log('User example structure:');
    console.log(inspectNode(bulletList));

    expect(bulletList.nodeName).toBe('bulletList');
    expect(bulletList.length).toBe(4);

    // Verify each listItem has a paragraph wrapper with content
    for (let i = 0; i < 4; i++) {
      const listItem = bulletList.get(i);
      expect(listItem.length).toBe(1); // Should have exactly 1 paragraph

      // First child must be paragraph
      const paragraph = listItem.get(0);
      expect(paragraph.nodeName).toBe('paragraph');

      // Paragraph contains text
      expect(paragraph.length).toBeGreaterThan(0);
      const textNode = paragraph.get(0);
      expect(textNode.constructor.name).toBe('YXmlText');
      expect(textNode.toString().length).toBeGreaterThan(0);
    }
  });

  test('bulletList survives Y.Doc serialization round-trip', () => {
    const spec = {
      type: 'bulletList',
      children: [
        { type: 'listItem', content: 'Item 1' },
        { type: 'listItem', content: 'Item 2' },
      ],
    };

    // Create doc 1 and insert bulletList
    const ydoc1 = new Y.Doc();
    const fragment1 = ydoc1.get('default', Y.XmlFragment);
    const bulletList = buildYjsNode(spec);
    fragment1.insert(0, [bulletList]);

    console.log('Before serialization:');
    console.log(inspectNode(fragment1.get(0)));

    // Serialize to binary
    const update = Y.encodeStateAsUpdate(ydoc1);
    console.log(`Serialized to ${update.length} bytes`);

    // Create doc 2 and apply the update
    const ydoc2 = new Y.Doc();
    Y.applyUpdate(ydoc2, update);
    const fragment2 = ydoc2.get('default', Y.XmlFragment);

    console.log('After deserialization:');
    if (fragment2.length > 0) {
      console.log(inspectNode(fragment2.get(0)));
    } else {
      console.log('ERROR: Fragment is empty after deserialization!');
    }

    // CRITICAL: The bulletList should still be there
    expect(fragment2.length).toBe(1);

    const deserializedList = fragment2.get(0);
    expect(deserializedList.nodeName).toBe('bulletList');
    expect(deserializedList.length).toBe(2);

    // Verify listItems are intact
    const item1 = deserializedList.get(0);
    const item2 = deserializedList.get(1);

    expect(item1.nodeName).toBe('listItem');
    expect(item2.nodeName).toBe('listItem');

    expect(item1.length).toBeGreaterThan(0);
    expect(item2.length).toBeGreaterThan(0);
  });

  test('empty listItem gets paragraph with empty text node', () => {
    const spec = {
      type: 'bulletList',
      children: [
        { type: 'listItem', content: 'Has content' },
        { type: 'listItem' }, // No content - should get paragraph with empty text node
      ],
    };

    const bulletList = integrateNode(spec);

    expect(bulletList.length).toBe(2);

    const item1 = bulletList.get(0);
    const item2 = bulletList.get(1);

    // Both should have exactly one paragraph
    expect(item1.length).toBe(1);
    expect(item2.length).toBe(1);

    // Item 1 should have paragraph with content
    const para1 = item1.get(0);
    expect(para1.nodeName).toBe('paragraph');
    expect(para1.get(0).toString()).toBe('Has content');

    // Item 2 should have paragraph with empty text node
    const para2 = item2.get(0);
    expect(para2.nodeName).toBe('paragraph');
    expect(para2.length).toBeGreaterThan(0);
    const emptyTextNode = para2.get(0);
    expect(emptyTextNode.constructor.name).toBe('YXmlText');
    expect(emptyTextNode.toString()).toBe('');
  });
});
