/**
 * Markdown → ProseMirror JSON parser
 *
 * Parses the markdown subset produced by toMarkdown() back into
 * ProseMirror-compatible JSON nodes. Supports an optional diff mark
 * that is applied to every text node (for version history diffs).
 *
 * This is NOT a general markdown parser — it handles exactly the
 * output format of server/mcp/yjs/serialization.js:toMarkdown().
 */

/**
 * Parse inline markdown formatting into ProseMirror text nodes.
 *
 * Handles: **bold**, _italic_, ~~strike~~, `code`, [text](url),
 * <u>, <mark>, <sub>, <sup>, <span style="...">
 * @param {string} text - Inline markdown text
 * @param {string|null} diffMark - Optional diff mark to apply ('diffInsert' or 'diffDelete')
 * @returns {Array} Array of ProseMirror text node JSON objects
 */
function parseInline(text, diffMark) {
  if (!text) return [];

  const nodes = [];
  // HTML tags first (they may contain markdown inside), then markdown patterns
  const pattern = /<span style="([^"]+)">(.+?)<\/span>|<u>(.+?)<\/u>|<mark>(.+?)<\/mark>|<sub>(.+?)<\/sub>|<sup>(.+?)<\/sup>|`([^`]+)`|\*\*(.+?)\*\*|_(.+?)_|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    // Text before this match
    if (match.index > lastIndex) {
      nodes.push(makeTextNode(text.slice(lastIndex, match.index), [], diffMark));
    }

    if (match[1] !== undefined) {
      // <span style="...">text</span>
      nodes.push(...parseMarked(match[2], { type: 'textStyle', attrs: parseStyleAttr(match[1]) }, diffMark));
    } else if (match[3] !== undefined) {
      nodes.push(...parseMarked(match[3], { type: 'underline' }, diffMark));
    } else if (match[4] !== undefined) {
      nodes.push(...parseMarked(match[4], { type: 'highlight' }, diffMark));
    } else if (match[5] !== undefined) {
      nodes.push(...parseMarked(match[5], { type: 'subscript' }, diffMark));
    } else if (match[6] !== undefined) {
      nodes.push(...parseMarked(match[6], { type: 'superscript' }, diffMark));
    } else if (match[7] !== undefined) {
      nodes.push(makeTextNode(match[7], [{ type: 'code' }], diffMark));
    } else if (match[8] !== undefined) {
      nodes.push(...parseMarked(match[8], { type: 'bold' }, diffMark));
    } else if (match[9] !== undefined) {
      nodes.push(...parseMarked(match[9], { type: 'italic' }, diffMark));
    } else if (match[10] !== undefined) {
      nodes.push(...parseMarked(match[10], { type: 'strike' }, diffMark));
    } else if (match[11] !== undefined) {
      nodes.push(makeTextNode(match[11], [{ type: 'link', attrs: { href: match[12] } }], diffMark));
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last match
  if (lastIndex < text.length) {
    nodes.push(makeTextNode(text.slice(lastIndex), [], diffMark));
  }

  // If no matches at all, the whole string is plain text
  if (nodes.length === 0 && text.length > 0) {
    nodes.push(makeTextNode(text, [], diffMark));
  }

  return nodes;
}

/** Parse CSS style string into textStyle mark attrs */
function parseStyleAttr(style) {
  const attrs = {};
  for (const decl of style.split(';')) {
    const [prop, ...rest] = decl.split(':');
    const val = rest.join(':').trim();
    if (!prop || !val) continue;
    const p = prop.trim();
    if (p === 'color') attrs.color = val;
    else if (p === 'background-color') attrs.backgroundColor = val;
    else if (p === 'font-size') attrs.fontSize = val;
    else if (p === 'font-family') attrs.fontFamily = val;
  }
  return attrs;
}

function makeTextNode(text, marks, diffMark) {
  const node = { type: 'text', text };
  const allMarks = [...marks];
  if (diffMark) allMarks.push({ type: diffMark });
  if (allMarks.length > 0) node.marks = allMarks;
  return node;
}

function addMark(node, mark) {
  if (!node.marks) node.marks = [];
  node.marks.unshift(mark); // prepend so diff mark stays at end
}

/** Parse inner content and prepend a mark to every resulting node. */
function parseMarked(content, mark, diffMark) {
  const inner = parseInline(content, diffMark);
  for (const node of inner) addMark(node, mark);
  return inner;
}

/**
 * Parse markdown string into ProseMirror document JSON.
 *
 * @param {string} markdown - Markdown content
 * @param {string|null} diffMark - Optional diff mark for all text nodes
 * @returns {object} ProseMirror document JSON { type: 'doc', content: [...] }
 */
function markdownToPm(markdown, diffMark = null) {
  const lines = markdown.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const codeText = codeLines.join('\n');
      const node = { type: 'codeBlock' };
      if (lang) node.attrs = { language: lang };
      if (codeText) {
        const textNode = { type: 'text', text: codeText };
        if (diffMark) textNode.marks = [{ type: diffMark }];
        node.content = [textNode];
      }
      blocks.push(node);
      continue;
    }

    // Horizontal rule
    if (line.trim() === '---') {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = parseInline(headingMatch[2], diffMark);
      const node = { type: 'heading', attrs: { level } };
      if (content.length > 0) node.content = content;
      blocks.push(node);
      i++;
      continue;
    }

    // Table (starts with |)
    if (line.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push(parseTable(tableLines, diffMark));
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      const innerMd = quoteLines.join('\n');
      const innerDoc = markdownToPm(innerMd, diffMark);
      blocks.push({ type: 'blockquote', content: innerDoc.content || [] });
      continue;
    }

    // Bullet list
    if (/^\s*- /.test(line)) {
      const listItems = parseListItems(lines, i, /^(\s*)- (.*)$/, diffMark);
      blocks.push({ type: 'bulletList', content: listItems.items });
      i = listItems.nextIndex;
      continue;
    }

    // Ordered list
    if (/^\s*\d+\. /.test(line)) {
      const listItems = parseListItems(lines, i, /^(\s*)\d+\. (.*)$/, diffMark);
      blocks.push({ type: 'orderedList', attrs: { start: 1 }, content: listItems.items });
      i = listItems.nextIndex;
      continue;
    }

    // Paragraph (default)
    const content = parseInline(line, diffMark);
    const node = { type: 'paragraph' };
    if (content.length > 0) node.content = content;
    blocks.push(node);
    i++;
  }

  // Ensure at least one block (ProseMirror requires non-empty doc)
  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph' });
  }

  return { type: 'doc', content: blocks };
}

/**
 * Parse list items with nesting support.
 */
function parseListItems(lines, startIndex, pattern, diffMark) {
  const items = [];
  let i = startIndex;

  while (i < lines.length) {
    const match = lines[i].match(pattern);
    if (!match) break;

    const indent = match[1].length;
    // Only consume top-level items (matching indent level of first item)
    if (items.length > 0 && indent > 0) {
      // This is a nested list item — collect nested lines
      const nestedLines = [];
      while (i < lines.length) {
        const nestedMatch = lines[i].match(/^(\s+)[-\d]/);
        if (!nestedMatch || nestedMatch[1].length < indent) break;
        // De-indent for recursive parsing
        nestedLines.push(lines[i].slice(indent));
        i++;
      }
      // Parse nested list and attach to last item
      if (nestedLines.length > 0 && items.length > 0) {
        const nestedMd = nestedLines.join('\n');
        const nestedDoc = markdownToPm(nestedMd, diffMark);
        const lastItem = items[items.length - 1];
        lastItem.content.push(...nestedDoc.content);
      }
      continue;
    }

    const text = match[2];
    const content = parseInline(text, diffMark);
    const para = { type: 'paragraph' };
    if (content.length > 0) para.content = content;
    items.push({ type: 'listItem', content: [para] });
    i++;
  }

  return { items, nextIndex: i };
}

/**
 * Parse markdown table lines into ProseMirror table JSON.
 */
function parseTable(tableLines, diffMark) {
  const rows = [];
  for (const line of tableLines) {
    // Skip separator rows (| --- | --- |)
    if (/^\|[\s-:|]+\|$/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    rows.push(cells);
  }

  const isHeader = (rowIdx) => rowIdx === 0;
  const tableRows = rows.map((cells, rowIdx) => {
    const cellNodes = cells.map(cellText => {
      const cellContent = parseInline(cellText.replace(/\\\|/g, '|'), diffMark);
      const para = { type: 'paragraph' };
      if (cellContent.length > 0) para.content = cellContent;
      return {
        type: isHeader(rowIdx) ? 'tableHeader' : 'tableCell',
        attrs: { colspan: 1, rowspan: 1, colwidth: null },
        content: [para],
      };
    });
    return { type: 'tableRow', content: cellNodes };
  });

  return { type: 'table', content: tableRows };
}

module.exports = { markdownToPm, parseInline };
