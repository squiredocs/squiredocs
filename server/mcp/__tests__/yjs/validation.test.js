/**
 * Validation module tests
 */
const { validateNode, VALID_NODE_TYPES, VALID_MARKS } = require('../../yjs/validation');

describe('validateNode', () => {
  describe('basic validation', () => {
    test('accepts valid paragraph', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: 'Hello world',
        })
      ).not.toThrow();
    });

    test('accepts paragraph with empty content', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
        })
      ).not.toThrow();
    });

    test('rejects null node', () => {
      expect(() => validateNode(null)).toThrow('Node must be an object');
    });

    test('rejects non-object node', () => {
      expect(() => validateNode('string')).toThrow('Node must be an object');
    });

    test('rejects missing type', () => {
      expect(() => validateNode({ content: 'test' })).toThrow('Invalid node type');
    });

    test('rejects invalid node type', () => {
      expect(() =>
        validateNode({
          type: 'invalidType',
          content: 'test',
        })
      ).toThrow(`Invalid node type: invalidType. Valid types: ${VALID_NODE_TYPES.join(', ')}`);
    });
  });

  describe('heading validation', () => {
    test('accepts heading with level 1', () => {
      expect(() =>
        validateNode({
          type: 'heading',
          level: 1,
          content: 'Title',
        })
      ).not.toThrow();
    });

    test('accepts heading with level 2', () => {
      expect(() =>
        validateNode({
          type: 'heading',
          level: 2,
          content: 'Subtitle',
        })
      ).not.toThrow();
    });

    test('accepts heading with level 3', () => {
      expect(() =>
        validateNode({
          type: 'heading',
          level: 3,
          content: 'Section',
        })
      ).not.toThrow();
    });

    test('rejects heading with level 4', () => {
      expect(() =>
        validateNode({
          type: 'heading',
          level: 4,
          content: 'Invalid',
        })
      ).toThrow('Heading level must be 1, 2, or 3. Got: 4');
    });

    test('rejects heading with level 0', () => {
      expect(() =>
        validateNode({
          type: 'heading',
          level: 0,
          content: 'Invalid',
        })
      ).toThrow('Heading level must be 1, 2, or 3');
    });

    test('rejects heading without level', () => {
      expect(() =>
        validateNode({
          type: 'heading',
          content: 'Invalid',
        })
      ).toThrow('Heading level must be 1, 2, or 3');
    });
  });

  describe('list validation', () => {
    test('accepts bulletList with children', () => {
      expect(() =>
        validateNode({
          type: 'bulletList',
          children: [{ type: 'listItem', content: 'Item 1' }],
        })
      ).not.toThrow();
    });

    test('accepts orderedList with children', () => {
      expect(() =>
        validateNode({
          type: 'orderedList',
          children: [
            { type: 'listItem', content: 'First' },
            { type: 'listItem', content: 'Second' },
          ],
        })
      ).not.toThrow();
    });

    test('rejects bulletList with empty children', () => {
      expect(() =>
        validateNode({
          type: 'bulletList',
          children: [],
        })
      ).toThrow('bulletList must have non-empty children array');
    });

    test('rejects orderedList without children', () => {
      expect(() =>
        validateNode({
          type: 'orderedList',
        })
      ).toThrow('orderedList must have non-empty children array');
    });

    test('rejects list with non-listItem children', () => {
      expect(() =>
        validateNode({
          type: 'bulletList',
          children: [{ type: 'paragraph', content: 'Not a list item' }],
        })
      ).toThrow('bulletList child at index 0 must be a listItem');
    });
  });

  describe('code block validation', () => {
    test('accepts codeBlock with string content', () => {
      expect(() =>
        validateNode({
          type: 'codeBlock',
          content: 'const x = 42;',
        })
      ).not.toThrow();
    });

    test('accepts codeBlock with language', () => {
      expect(() =>
        validateNode({
          type: 'codeBlock',
          language: 'javascript',
          content: 'const x = 42;',
        })
      ).not.toThrow();
    });

    test('accepts codeBlock with empty content', () => {
      expect(() =>
        validateNode({
          type: 'codeBlock',
        })
      ).not.toThrow();
    });

    test('rejects codeBlock with array content', () => {
      expect(() =>
        validateNode({
          type: 'codeBlock',
          content: ['should', 'be', 'string'],
        })
      ).toThrow('codeBlock content must be a string');
    });

    test('rejects codeBlock with non-string language', () => {
      expect(() =>
        validateNode({
          type: 'codeBlock',
          language: 123,
          content: 'code',
        })
      ).toThrow('codeBlock language must be a string');
    });
  });

  describe('content validation', () => {
    test('accepts string content', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: 'Plain text',
        })
      ).not.toThrow();
    });

    test('accepts array content with strings', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: ['Part 1', 'Part 2'],
        })
      ).not.toThrow();
    });

    test('accepts array content with formatted text', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ text: 'bold', marks: ['bold'] }],
        })
      ).not.toThrow();
    });

    test('accepts mixed content array', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: ['Plain ', { text: 'bold', marks: ['bold'] }, ' more text'],
        })
      ).not.toThrow();
    });

    test('rejects invalid content type', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: 123,
        })
      ).toThrow('content must be string or array');
    });

    test('rejects content item with missing text', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ marks: ['bold'] }],
        })
      ).toThrow('Content item at index 0 must have text property (string)');
    });

    test('rejects content item with non-string text', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ text: 123, marks: ['bold'] }],
        })
      ).toThrow('Content item at index 0 must have text property (string)');
    });
  });

  describe('marks validation', () => {
    test('accepts all valid marks', () => {
      VALID_MARKS.forEach((mark) => {
        expect(() =>
          validateNode({
            type: 'paragraph',
            content: [{ text: 'test', marks: [mark] }],
          })
        ).not.toThrow();
      });
    });

    test('accepts multiple marks', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ text: 'test', marks: ['bold', 'italic'] }],
        })
      ).not.toThrow();
    });

    test('accepts link mark', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ text: 'link', marks: [{ type: 'link', href: 'https://example.com' }] }],
        })
      ).not.toThrow();
    });

    test('accepts mixed marks with link', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [
            { text: 'bold link', marks: ['bold', { type: 'link', href: 'https://example.com' }] },
          ],
        })
      ).not.toThrow();
    });

    test('rejects invalid mark string', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ text: 'test', marks: ['invalid-mark'] }],
        })
      ).toThrow(`Invalid mark "invalid-mark" at content[0].marks[0]. Valid: ${VALID_MARKS.join(', ')}`);
    });

    test('rejects link without href', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ text: 'link', marks: [{ type: 'link' }] }],
        })
      ).toThrow('Link mark at content[0].marks[0] must have href (string)');
    });

    test('rejects link with non-string href', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ text: 'link', marks: [{ type: 'link', href: 123 }] }],
        })
      ).toThrow('Link mark at content[0].marks[0] must have href (string)');
    });

    test('rejects unknown mark type', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ text: 'test', marks: [{ type: 'unknown' }] }],
        })
      ).toThrow('Unknown mark type "unknown" at content[0].marks[0]');
    });

    test('rejects marks that are not string or object', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ text: 'test', marks: [123] }],
        })
      ).toThrow('Mark at content[0].marks[0] must be string or object');
    });

    test('rejects marks that is not an array', () => {
      expect(() =>
        validateNode({
          type: 'paragraph',
          content: [{ text: 'test', marks: 'bold' }],
        })
      ).toThrow('Content item at index 0: marks must be an array');
    });
  });

  describe('listItem validation', () => {
    test('accepts listItem with content', () => {
      expect(() =>
        validateNode({
          type: 'listItem',
          content: 'Item text',
        })
      ).not.toThrow();
    });

    test('accepts listItem with formatted content', () => {
      expect(() =>
        validateNode({
          type: 'listItem',
          content: [{ text: 'bold item', marks: ['bold'] }],
        })
      ).not.toThrow();
    });
  });
});
