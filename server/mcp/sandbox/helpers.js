/**
 * Helper Functions for Sandbox Scripts
 *
 * Minimal set of utilities that eliminate common boilerplate patterns.
 * Only includes helpers for operations that would otherwise require
 * users to copy-paste code in every script.
 */

const Y = require('yjs');

/**
 * Find the first Y.XmlText node within an element (traverses recursively)
 *
 * Without this helper, users must copy this traversal logic into every script.
 * This is the most commonly needed helper based on example usage patterns.
 *
 * @param {Y.XmlElement} element - Element to search
 * @returns {Y.XmlText|null} First text node found, or null
 *
 * @example
 *   const text = findTextNode(paragraph);
 *   if (text) {
 *     const content = extractText(text);
 *   }
 */
function findTextNode(element) {
  if (!(element instanceof Y.XmlElement)) {
    return null;
  }

  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) {
      return child;
    }
    if (child instanceof Y.XmlElement) {
      const found = findTextNode(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extract plain text from a Y.XmlText node using toDelta()
 *
 * CRITICAL: Always use this instead of toString() when text may have formatting.
 * toString() returns XML markup like "<bold>text</bold>" which breaks text operations.
 *
 * Without this helper, users must remember the toDelta pattern in every script.
 *
 * @param {Y.XmlText} xmlText - Text node to extract from
 * @returns {string} Plain text content
 *
 * @example
 *   const text = findTextNode(block);
 *   const plainText = extractText(text);
 *   const index = plainText.indexOf('TODO');
 */
function extractText(xmlText) {
  if (!(xmlText instanceof Y.XmlText)) {
    throw new Error('extractText expects a Y.XmlText instance');
  }

  const delta = xmlText.toDelta();
  return delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');
}

/**
 * Get all text content from an element recursively
 *
 * Combines findTextNode + extractText for all text nodes in a tree.
 * Useful for getting the full text of complex nested structures.
 *
 * @param {Y.XmlElement|Y.XmlText} node - Node to extract from
 * @returns {string} All text content
 *
 * @example
 *   const listText = getTextContent(bulletList);
 *   if (listText.includes('TODO')) { ... }
 */
function getTextContent(node) {
  if (node instanceof Y.XmlText) {
    return extractText(node);
  } else if (node instanceof Y.XmlElement) {
    let text = '';
    for (let i = 0; i < node.length; i++) {
      const child = node.get(i);
      text += getTextContent(child);
    }
    return text;
  }
  return '';
}

/**
 * Find all elements matching a predicate function
 *
 * Eliminates the boilerplate of recursive tree traversal for searching.
 * Base function for other find helpers.
 *
 * @param {Y.XmlFragment|Y.XmlElement} container - Container to search
 * @param {Function} predicate - Function(element) that returns true for matches
 * @returns {Y.XmlElement[]} Array of matching elements
 *
 * @example
 *   // Find all headings with level 1
 *   const h1s = findElements(doc, el =>
 *     el.nodeName === 'heading' && el.getAttribute('level') === 1
 *   );
 */
function findElements(container, predicate) {
  const matches = [];
  const items = container.toArray();

  for (const item of items) {
    if (item instanceof Y.XmlElement) {
      if (predicate(item)) {
        matches.push(item);
      }
      // Recursively search children
      matches.push(...findElements(item, predicate));
    }
  }

  return matches;
}

/**
 * Find elements by node name (e.g., 'heading', 'paragraph')
 *
 * Common operation that would otherwise require findElements boilerplate.
 *
 * @param {Y.XmlFragment|Y.XmlElement} container - Container to search
 * @param {string} nodeName - Node name to match
 * @returns {Y.XmlElement[]} Array of matching elements
 *
 * @example
 *   const headings = findByNodeName(doc, 'heading');
 *   headings.forEach(h => h.setAttribute('level', 2));
 */
function findByNodeName(container, nodeName) {
  return findElements(container, el => el.nodeName === nodeName);
}

/**
 * Find elements containing specific text
 *
 * Common search operation that would require combining multiple boilerplate patterns.
 *
 * @param {Y.XmlFragment|Y.XmlElement} container - Container to search
 * @param {string} searchText - Text to search for
 * @param {boolean} caseSensitive - Case sensitive search (default: false)
 * @returns {Y.XmlElement[]} Array of matching elements
 *
 * @example
 *   const todos = findByText(doc, 'TODO');
 *   todos.forEach(block => {
 *     const text = findTextNode(block);
 *     if (text) {
 *       const content = extractText(text);
 *       const idx = content.indexOf('TODO');
 *       text.format(idx, 4, { bold: true });
 *     }
 *   });
 */
function findByText(container, searchText, caseSensitive = false) {
  const search = caseSensitive ? searchText : searchText.toLowerCase();

  return findElements(container, el => {
    const text = getTextContent(el);
    const content = caseSensitive ? text : text.toLowerCase();
    return content.includes(search);
  });
}

/**
 * Create a Y.XmlText from text segments with optional formatting
 *
 * ⭐ PREFERRED METHOD for mixed formatting - eliminates two classes of errors:
 *   1. No position counting needed — just list segments in order
 *   2. Avoids text reversal bug on unattached XmlText nodes
 *
 * Compare:
 *   ❌ Insert-then-format (error-prone):
 *      text.insert(0, 'Visit Example Site for info');
 *      text.format(6, 12, { link: { href: '...' } });  // Manual position counting!
 *
 *   ✅ createFormattedText (self-documenting):
 *      createFormattedText([
 *        'Visit ',
 *        { text: 'Example Site', attrs: { link: { href: '...' } } },
 *        ' for info'
 *      ]);
 *
 * See PITFALL 5 in the modify tool documentation for more details.
 *
 * @param {Array<string|{text: string, attrs?: object}>} segments - Array of text segments
 *   Each segment is either:
 *   - A plain string (no formatting)
 *   - An object with { text: string, attrs?: object } for formatted text
 * @returns {Y.XmlText} A new XmlText with the specified formatting
 *
 * @example
 *   // Create text with a link (no position counting needed!)
 *   const text = createFormattedText([
 *     'Visit ',
 *     { text: 'Example Site', attrs: { link: { href: 'https://example.com' } } },
 *     ' for more info'
 *   ]);
 *
 * @example
 *   // Create text with multiple formats
 *   const text = createFormattedText([
 *     { text: 'Important:', attrs: { bold: true } },
 *     ' This is ',
 *     { text: 'italic', attrs: { italic: true } },
 *     ' text'
 *   ]);
 *
 * @example
 *   // Plain text only (no formatting)
 *   const text = createFormattedText(['Hello world']);
 */
function createFormattedText(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('createFormattedText requires a non-empty array of segments');
  }

  const xmlText = new Y.XmlText();

  // First pass: collect all text and track format ranges
  const formatRanges = [];
  let fullText = '';

  for (const segment of segments) {
    if (typeof segment === 'string') {
      fullText += segment;
    } else if (segment && typeof segment.text === 'string') {
      const start = fullText.length;
      fullText += segment.text;
      if (segment.attrs && Object.keys(segment.attrs).length > 0) {
        formatRanges.push({
          start,
          length: segment.text.length,
          attrs: segment.attrs,
        });
      }
    }
  }

  // Insert all text at once (avoids the reversal bug)
  xmlText.insert(0, fullText);

  // Apply formatting to each range
  for (const range of formatRanges) {
    xmlText.format(range.start, range.length, range.attrs);
  }

  return xmlText;
}

/**
 * Append block elements to a document using a declarative format
 *
 * Eliminates the boilerplate of creating paragraphs, headings, and lists.
 * Instead of 5+ lines per block, use a simple object structure.
 *
 * @param {Y.XmlFragment|Y.XmlElement} container - Container to insert blocks into
 * @param {Array<BlockDef>} blocks - Array of block definitions
 * @param {object} [position] - Where to insert: { at: 'start'|'end' } or { before: element|xpath } or { after: element|xpath }
 * @param {object} [options] - Options for sandbox integration
 * @param {Function} [options.XmlElement] - Constructor for XmlElement (for sandbox wrapping)
 * @param {Function} [options.XmlText] - Constructor for XmlText (for sandbox wrapping)
 * @param {Function} [options.xpathFirst] - XPath function for string-based positioning
 * @returns {Y.XmlElement[]} Array of created block elements
 *
 * Block types:
 *   { type: 'paragraph', content: Content }
 *   { type: 'heading', level: 1-5, content: Content }
 *   { type: 'bulletList', items: Item[] }
 *   { type: 'orderedList', items: Item[] }
 *   { type: 'codeBlock', content: string }
 *
 * Content format:
 *   string - plain text
 *   Array<string | { text: string, attrs: object }> - mixed formatting
 *
 * Item format (for lists):
 *   string - simple text item
 *   Content - formatted text item
 *   { content: Content, items: Item[] } - item with nested list (inherits parent type)
 *   { content: Content, items: Item[], type: 'bulletList'|'orderedList' } - explicit nested type
 *
 * @example
 *   // Create heading and paragraphs
 *   appendBlocks(doc, [
 *     { type: 'heading', level: 2, content: 'Introduction' },
 *     { type: 'paragraph', content: 'First paragraph.' },
 *     { type: 'paragraph', content: [
 *       'Text with ',
 *       { text: 'bold', attrs: { bold: true } },
 *       ' formatting.'
 *     ]}
 *   ]);
 *
 * @example
 *   // Create simple lists
 *   appendBlocks(doc, [
 *     { type: 'bulletList', items: ['Item one', 'Item two', 'Item three'] },
 *     { type: 'orderedList', items: [
 *       'First step',
 *       ['Second step with ', { text: 'emphasis', attrs: { italic: true } }]
 *     ]}
 *   ]);
 *
 * @example
 *   // Create nested lists (items use same 'items' property as top-level)
 *   appendBlocks(doc, [
 *     { type: 'bulletList', items: [
 *       { content: 'Item A', items: [
 *         { content: 'Item A.1', items: ['A.1.a', 'A.1.b'] },
 *         'Item A.2'
 *       ]},
 *       { content: 'Item B', items: ['B.1', 'B.2'] },
 *       'Item C'
 *     ]}
 *   ]);
 *
 * @example
 *   // Insert at specific position
 *   appendBlocks(doc, blocks, { at: 'start' });
 *   appendBlocks(doc, blocks, { after: '//heading[contains(., "Introduction")]' });
 */
function appendBlocks(container, blocks, position = null, options = {}) {
  // Use provided constructors or default to Y
  const XmlElement = options.XmlElement || Y.XmlElement;
  const XmlText = options.XmlText || Y.XmlText;
  const xpathFirst = options.xpathFirst || null;

  if (!container || typeof container.insert !== 'function') {
    throw new Error('appendBlocks: container must be a Y.XmlFragment or Y.XmlElement');
  }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('appendBlocks: blocks must be a non-empty array');
  }

  /**
   * Create XmlText from content (string or array of segments)
   */
  function createTextFromContent(content) {
    const xmlText = new XmlText();

    // Handle simple string content
    if (typeof content === 'string') {
      xmlText.insert(0, content);
      return xmlText;
    }

    // Handle array of segments (mixed formatting)
    if (!Array.isArray(content)) {
      throw new Error('appendBlocks: content must be a string or array of segments');
    }

    // First pass: collect all text and track format ranges
    const formatRanges = [];
    let fullText = '';

    for (const segment of content) {
      if (typeof segment === 'string') {
        fullText += segment;
      } else if (segment && typeof segment.text === 'string') {
        const start = fullText.length;
        fullText += segment.text;
        if (segment.attrs && Object.keys(segment.attrs).length > 0) {
          formatRanges.push({
            start,
            length: segment.text.length,
            attrs: segment.attrs,
          });
        }
      } else {
        throw new Error('appendBlocks: invalid content segment - must be string or { text, attrs }');
      }
    }

    // Insert all text at once (avoids the reversal bug)
    xmlText.insert(0, fullText);

    // Apply formatting to each range
    for (const range of formatRanges) {
      xmlText.format(range.start, range.length, range.attrs);
    }

    return xmlText;
  }

  /**
   * Create a paragraph element with content
   */
  function createParagraph(content) {
    const para = new XmlElement('paragraph');
    const text = createTextFromContent(content);
    para.insert(0, [text]);
    return para;
  }

  /**
   * Create a heading element with level and content
   */
  function createHeading(level, content) {
    if (typeof level !== 'number' || level < 1 || level > 5) {
      throw new Error('appendBlocks: heading level must be 1-5');
    }
    const heading = new XmlElement('heading');
    heading.setAttribute('level', level);
    const text = createTextFromContent(content);
    heading.insert(0, [text]);
    return heading;
  }

  /**
   * Create a code block element with content
   */
  function createCodeBlock(content) {
    if (typeof content !== 'string') {
      throw new Error('appendBlocks: codeBlock content must be a string');
    }
    const codeBlock = new XmlElement('codeBlock');
    const text = new XmlText();
    text.insert(0, content);
    codeBlock.insert(0, [text]);
    return codeBlock;
  }

  /**
   * Create a list item element with content
   * @param {string|Array|Object} itemDef - Item content or nested item definition
   * @param {string} parentListType - Parent list type ('bulletList' or 'orderedList')
   *
   * Item formats:
   *   "text"                                      - simple text item
   *   ["text", { text: "bold", attrs: {...} }]   - formatted text item
   *   { content: "text", items: [...] }          - item with nested list (inherits parent type)
   *   { content: "text", items: [...], type: 'orderedList' }  - item with explicit nested type
   */
  function createListItem(itemDef, parentListType) {
    const listItem = new XmlElement('listItem');

    // Check if itemDef is a nested item definition (object with 'content' property)
    if (itemDef && typeof itemDef === 'object' && !Array.isArray(itemDef) && 'content' in itemDef) {
      const para = createParagraph(itemDef.content);
      listItem.insert(0, [para]);

      // Add nested list if items are specified
      if (itemDef.items && Array.isArray(itemDef.items) && itemDef.items.length > 0) {
        const nestedType = itemDef.type || parentListType || 'bulletList';
        const nestedList = nestedType === 'orderedList'
          ? createOrderedList(itemDef.items)
          : createBulletList(itemDef.items);
        listItem.insert(1, [nestedList]);
      }
    } else {
      // Simple item: string or FormattedContent array
      const para = createParagraph(itemDef);
      listItem.insert(0, [para]);
    }

    return listItem;
  }

  /**
   * Create a bullet list element with items
   */
  function createBulletList(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('appendBlocks: bulletList items must be a non-empty array');
    }
    const list = new XmlElement('bulletList');
    const listItems = items.map(item => createListItem(item, 'bulletList'));
    list.insert(0, listItems);
    return list;
  }

  /**
   * Create an ordered list element with items
   */
  function createOrderedList(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('appendBlocks: orderedList items must be a non-empty array');
    }
    const list = new XmlElement('orderedList');
    const listItems = items.map(item => createListItem(item, 'orderedList'));
    list.insert(0, listItems);
    return list;
  }

  /**
   * Create a block element from a block definition
   */
  function createBlock(blockDef) {
    if (!blockDef || typeof blockDef.type !== 'string') {
      throw new Error('appendBlocks: each block must have a type property');
    }

    switch (blockDef.type) {
      case 'paragraph':
        if (blockDef.content === undefined) {
          throw new Error('appendBlocks: paragraph requires content');
        }
        return createParagraph(blockDef.content);

      case 'heading':
        if (blockDef.content === undefined) {
          throw new Error('appendBlocks: heading requires content');
        }
        return createHeading(blockDef.level, blockDef.content);

      case 'codeBlock':
        if (blockDef.content === undefined) {
          throw new Error('appendBlocks: codeBlock requires content');
        }
        return createCodeBlock(blockDef.content);

      case 'bulletList':
        if (!blockDef.items) {
          throw new Error('appendBlocks: bulletList requires items');
        }
        return createBulletList(blockDef.items);

      case 'orderedList':
        if (!blockDef.items) {
          throw new Error('appendBlocks: orderedList requires items');
        }
        return createOrderedList(blockDef.items);

      default:
        throw new Error(`appendBlocks: unknown block type "${blockDef.type}". Supported: paragraph, heading, bulletList, orderedList, codeBlock`);
    }
  }

  // Create all block elements
  const elements = blocks.map(createBlock);

  // Determine insertion index
  let insertIndex;

  if (!position || (position.at && position.at === 'end')) {
    // Default: append at end
    insertIndex = container.length;
  } else if (position.at === 'start') {
    // Insert at beginning
    insertIndex = 0;
  } else if (position.before !== undefined) {
    // Insert before a specific element
    let targetElement = position.before;

    // If before is a string, treat it as xpath expression
    if (typeof targetElement === 'string') {
      if (!xpathFirst) {
        throw new Error('appendBlocks: xpath positioning requires xpathFirst function in options');
      }
      targetElement = xpathFirst(targetElement, container);
      if (!targetElement) {
        throw new Error(`appendBlocks: no element found matching xpath "${position.before}"`);
      }
    }

    // Find the index of the target element in container
    insertIndex = findElementIndex(container, targetElement);
    if (insertIndex === -1) {
      throw new Error('appendBlocks: target element not found in container');
    }
  } else if (position.after !== undefined) {
    // Insert after a specific element
    let targetElement = position.after;

    // If after is a string, treat it as xpath expression
    if (typeof targetElement === 'string') {
      if (!xpathFirst) {
        throw new Error('appendBlocks: xpath positioning requires xpathFirst function in options');
      }
      targetElement = xpathFirst(targetElement, container);
      if (!targetElement) {
        throw new Error(`appendBlocks: no element found matching xpath "${position.after}"`);
      }
    }

    // Find the index of the target element in container
    insertIndex = findElementIndex(container, targetElement);
    if (insertIndex === -1) {
      throw new Error('appendBlocks: target element not found in container');
    }
    insertIndex += 1; // Insert after the target
  } else {
    throw new Error('appendBlocks: invalid position. Use { at: "start"|"end" }, { before: element|xpath }, or { after: element|xpath }');
  }

  // Insert all elements at the determined index
  container.insert(insertIndex, elements);

  return elements;
}

/**
 * Find the index of an element within a container
 * @param {Y.XmlFragment|Y.XmlElement} container
 * @param {Y.XmlElement} element
 * @returns {number} Index or -1 if not found
 */
function findElementIndex(container, element) {
  const items = container.toArray();
  for (let i = 0; i < items.length; i++) {
    if (items[i] === element) {
      return i;
    }
  }
  return -1;
}

module.exports = {
  findTextNode,
  extractText,
  getTextContent,
  findElements,
  findByNodeName,
  findByText,
  createFormattedText,
  appendBlocks,
};
