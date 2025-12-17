/**
 * Node builder module tests
 */
const Y = require('yjs');
const { buildYjsNode, buildTextContent } = require('../../yjs/node-builder');

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

/**
 * Helper to integrate text content into a Y.Doc so we can read its contents
 */
function integrateTextContent(content) {
  const ydoc = new Y.Doc();
  const xmlFragment = ydoc.get('test', Y.XmlFragment);
  const textNodes = buildTextContent(content);
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, textNodes);
  xmlFragment.insert(0, [paragraph]);
  const integratedParagraph = xmlFragment.get(0);
  return Array.from({ length: integratedParagraph.length }, (_, i) => integratedParagraph.get(i));
}

describe('buildYjsNode', () => {
  describe('paragraph', () => {
    test('builds paragraph with plain text', () => {
      const node = { type: 'paragraph', content: 'Hello world' };
      const yjsNode = integrateNode(node);

      expect(yjsNode.nodeName).toBe('paragraph');
      expect(yjsNode.length).toBe(1);

      const text = yjsNode.get(0);
      expect(text.toString()).toBe('Hello world');
    });

    test('builds empty paragraph', () => {
      const node = { type: 'paragraph' };
      const yjsNode = integrateNode(node);

      expect(yjsNode.nodeName).toBe('paragraph');
      expect(yjsNode.length).toBe(0);
    });
  });

  describe('heading', () => {
    test('builds heading with level', () => {
      const node = { type: 'heading', level: 2, content: 'Title' };
      const yjsNode = integrateNode(node);

      expect(yjsNode.nodeName).toBe('heading');
      expect(yjsNode.getAttribute('level')).toBe('2');

      const text = yjsNode.get(0);
      expect(text.toString()).toBe('Title');
    });

    test('builds heading level 1', () => {
      const node = { type: 'heading', level: 1, content: 'Main Title' };
      const yjsNode = integrateNode(node);

      expect(yjsNode.getAttribute('level')).toBe('1');
    });

    test('builds heading level 3', () => {
      const node = { type: 'heading', level: 3, content: 'Section' };
      const yjsNode = integrateNode(node);

      expect(yjsNode.getAttribute('level')).toBe('3');
    });
  });

  describe('lists', () => {
    test('builds bulletList with children', () => {
      const node = {
        type: 'bulletList',
        children: [
          { type: 'listItem', content: 'First' },
          { type: 'listItem', content: 'Second' },
        ],
      };
      const yjsNode = integrateNode(node);

      expect(yjsNode.nodeName).toBe('bulletList');
      expect(yjsNode.length).toBe(2);

      const firstItem = yjsNode.get(0);
      expect(firstItem.nodeName).toBe('listItem');
      expect(firstItem.get(0).toString()).toBe('First');

      const secondItem = yjsNode.get(1);
      expect(secondItem.nodeName).toBe('listItem');
      expect(secondItem.get(0).toString()).toBe('Second');
    });

    test('builds orderedList with children', () => {
      const node = {
        type: 'orderedList',
        children: [
          { type: 'listItem', content: 'Step 1' },
          { type: 'listItem', content: 'Step 2' },
          { type: 'listItem', content: 'Step 3' },
        ],
      };
      const yjsNode = integrateNode(node);

      expect(yjsNode.nodeName).toBe('orderedList');
      expect(yjsNode.length).toBe(3);
    });
  });

  describe('codeBlock', () => {
    test('builds codeBlock with content', () => {
      const node = {
        type: 'codeBlock',
        content: 'const x = 42;',
      };
      const yjsNode = integrateNode(node);

      expect(yjsNode.nodeName).toBe('codeBlock');
      expect(yjsNode.get(0).toString()).toBe('const x = 42;');
    });

    test('builds codeBlock with language', () => {
      const node = {
        type: 'codeBlock',
        language: 'javascript',
        content: 'console.log("hello");',
      };
      const yjsNode = integrateNode(node);

      expect(yjsNode.nodeName).toBe('codeBlock');
      expect(yjsNode.getAttribute('language')).toBe('javascript');
    });

    test('builds empty codeBlock', () => {
      const node = {
        type: 'codeBlock',
        language: 'python',
      };
      const yjsNode = integrateNode(node);

      expect(yjsNode.nodeName).toBe('codeBlock');
      expect(yjsNode.getAttribute('language')).toBe('python');
      expect(yjsNode.get(0).toString()).toBe('');
    });

    test('builds codeBlock with multiline content', () => {
      const node = {
        type: 'codeBlock',
        language: 'javascript',
        content: 'function foo() {\n  return 42;\n}',
      };
      const yjsNode = integrateNode(node);

      expect(yjsNode.get(0).toString()).toBe('function foo() {\n  return 42;\n}');
    });
  });
});

describe('buildTextContent', () => {
  test('builds text from string', () => {
    const result = integrateTextContent('Hello');

    expect(result).toHaveLength(1);
    expect(result[0].toString()).toBe('Hello');
  });

  test('builds text from array of strings', () => {
    const result = integrateTextContent(['Hello', ' world']);

    expect(result).toHaveLength(2);
    expect(result[0].toString()).toBe('Hello');
    expect(result[1].toString()).toBe(' world');
  });

  test('builds text with bold mark', () => {
    const result = integrateTextContent([{ text: 'bold', marks: ['bold'] }]);

    expect(result).toHaveLength(1);
    expect(result[0].toString()).toContain('bold');
    // Verify marks via delta
    const delta = result[0].toDelta();
    expect(delta[0].attributes.bold).toBe(true);
  });

  test('builds text with italic mark', () => {
    const result = integrateTextContent([{ text: 'italic', marks: ['italic'] }]);

    expect(result).toHaveLength(1);
    const delta = result[0].toDelta();
    expect(delta[0].attributes.italic).toBe(true);
  });

  test('builds text with multiple marks', () => {
    const result = integrateTextContent([{ text: 'formatted', marks: ['bold', 'italic'] }]);

    expect(result).toHaveLength(1);
    const delta = result[0].toDelta();
    expect(delta[0].attributes.bold).toBe(true);
    expect(delta[0].attributes.italic).toBe(true);
  });

  test('builds text with link mark', () => {
    const result = integrateTextContent([
      { text: 'link text', marks: [{ type: 'link', href: 'https://example.com' }] },
    ]);

    expect(result).toHaveLength(1);
    const delta = result[0].toDelta();
    expect(delta[0].attributes.link).toEqual({ href: 'https://example.com' });
  });

  test('builds mixed content', () => {
    const result = integrateTextContent([
      'Plain ',
      { text: 'bold', marks: ['bold'] },
      ' and ',
      { text: 'italic', marks: ['italic'] },
    ]);

    expect(result).toHaveLength(4);
    expect(result[0].toString()).toBe('Plain ');
    expect(result[1].toString()).toContain('bold');
    expect(result[2].toString()).toBe(' and ');
    expect(result[3].toString()).toContain('italic');

    // Verify marks via delta
    const boldDelta = result[1].toDelta();
    expect(boldDelta[0].attributes.bold).toBe(true);

    const italicDelta = result[3].toDelta();
    expect(italicDelta[0].attributes.italic).toBe(true);
  });

  test('builds text with underline mark', () => {
    const result = integrateTextContent([{ text: 'underlined', marks: ['underline'] }]);

    const delta = result[0].toDelta();
    expect(delta[0].attributes.underline).toBe(true);
  });

  test('builds text with strike mark', () => {
    const result = integrateTextContent([{ text: 'strikethrough', marks: ['strike'] }]);

    const delta = result[0].toDelta();
    expect(delta[0].attributes.strike).toBe(true);
  });

  test('returns empty array for non-array, non-string content', () => {
    const result = buildTextContent(null);
    expect(result).toEqual([]);
  });

  test('returns empty array for undefined content', () => {
    const result = buildTextContent(undefined);
    expect(result).toEqual([]);
  });

  test('builds text without marks when marks array is empty', () => {
    const result = integrateTextContent([{ text: 'plain', marks: [] }]);

    expect(result).toHaveLength(1);
    const delta = result[0].toDelta();
    expect(delta[0].attributes).toBeUndefined();
  });
});

describe('integration: buildYjsNode with formatted content', () => {
  test('builds paragraph with formatted text', () => {
    const node = {
      type: 'paragraph',
      content: ['This is ', { text: 'important', marks: ['bold', 'italic'] }, ' text.'],
    };
    const yjsNode = integrateNode(node);

    expect(yjsNode.nodeName).toBe('paragraph');
    expect(yjsNode.length).toBe(3);

    // Check each text element (formatted ones contain XML tags)
    expect(yjsNode.get(0).toString()).toBe('This is ');
    expect(yjsNode.get(1).toString()).toContain('important');
    expect(yjsNode.get(2).toString()).toBe(' text.');

    // Verify marks via delta
    const boldItalicDelta = yjsNode.get(1).toDelta();
    expect(boldItalicDelta[0].attributes.bold).toBe(true);
    expect(boldItalicDelta[0].attributes.italic).toBe(true);
  });

  test('builds listItem with formatted content', () => {
    const node = {
      type: 'listItem',
      content: [{ text: 'Action item', marks: ['bold'] }, ': Complete by Friday'],
    };
    const yjsNode = integrateNode(node);

    expect(yjsNode.nodeName).toBe('listItem');
    expect(yjsNode.length).toBe(2);
    expect(yjsNode.get(0).toString()).toContain('Action item');
    expect(yjsNode.get(1).toString()).toBe(': Complete by Friday');

    // Verify marks via delta
    const boldDelta = yjsNode.get(0).toDelta();
    expect(boldDelta[0].attributes.bold).toBe(true);
  });

  test('builds heading with link', () => {
    const node = {
      type: 'heading',
      level: 2,
      content: [
        'See our ',
        { text: 'documentation', marks: [{ type: 'link', href: 'https://docs.example.com' }] },
      ],
    };
    const yjsNode = integrateNode(node);

    expect(yjsNode.nodeName).toBe('heading');
    expect(yjsNode.getAttribute('level')).toBe('2');
    expect(yjsNode.length).toBe(2);

    const linkDelta = yjsNode.get(1).toDelta();
    expect(linkDelta[0].attributes.link).toEqual({ href: 'https://docs.example.com' });
  });
});
