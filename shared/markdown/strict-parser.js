/**
 * Markdown → ProseMirror JSON parser — STRICT (frozen) mode.
 *
 * Parses the markdown subset produced by toMarkdown() back into
 * ProseMirror-compatible JSON nodes. Supports an optional diff mark
 * that is applied to every text node (for version history diffs).
 *
 * Inline mark parsing is driven by the shared format registry
 * (shared/format-registry.js), so adding a new mark requires zero
 * changes here.
 *
 * FROZEN (feature 001, CN-2): this is the byte-identical pre-feature parser,
 * used by the diff engine via `{ strict: true }`. Do NOT "improve" it — any
 * grammar work happens under shared/markdown/tolerant/. Byte-identity is pinned
 * by server/__tests__/markdown-strict-characterization.test.js.
 *
 * ONE sanctioned exception to the freeze, and it is closed: ordered-list
 * `start` preservation (feature 054, FR-013; design amendment 2026-08-11 to
 * design/markdown-import-two-way-sync.md). The freeze exists to stop grammar
 * drift between this parser and the tolerant one, and here the freeze was
 * CAUSING the drift: the serializers now emit a list's real `start`, so a
 * parser that read every list back as starting at 1 would make every
 * ordered-list item differ from itself on every version comparison. The
 * amendment requires both parser modes to round-trip `start`, so this one
 * attribute moved to keep the two in agreement. It changed no fixture in the
 * 70-case characterization snapshot. Nothing else here is open for revision.
 */

const {
  INLINE_NEWLINE,
  INLINE_HTML_TAGS,
  buildInlineRegex,
} = require('../format-registry');

// Build the inline regex once at module load from the registry
const { regex: inlineRegex, entries: inlineEntries } = buildInlineRegex();

// Precompiled patterns for joinContinuationLines (depend only on INLINE_HTML_TAGS)
const continuationOpenRe = new RegExp(`<(?:${INLINE_HTML_TAGS.join('|')})\\b`, 'g');
const continuationCloseRe = new RegExp(`<\\/(?:${INLINE_HTML_TAGS.join('|')})>`, 'g');

/**
 * Parse inline markdown formatting into ProseMirror text nodes.
 *
 * The regex and dispatch table are built from the format registry,
 * so every mark defined there is automatically supported.
 *
 * @param {string} text - Inline markdown text
 * @param {string|null} diffMark - Optional diff mark ('diffInsert' or 'diffDelete')
 * @returns {Array} Array of ProseMirror text node JSON objects
 */
function parseInline(text, diffMark) {
  if (!text) return [];

  const nodes = [];
  // Fresh regex per call — inlineRegex is global (/g) and parseInline recurses
  // via parseMarked. Sharing lastIndex across recursive calls causes infinite loops.
  const re = new RegExp(inlineRegex.source, inlineRegex.flags);
  let lastIndex = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    // Text before this match
    if (match.index > lastIndex) {
      nodes.push(makeTextNode(text.slice(lastIndex, match.index), [], diffMark));
    }

    // Find which registry entry matched by scanning capture groups
    let groupStart = 1;
    for (const entry of inlineEntries) {
      if (match[groupStart] !== undefined) {
        const { mark, content, nested } = entry.dispatch(match, groupStart);
        if (nested) {
          nodes.push(...parseMarked(content, mark, diffMark));
        } else {
          nodes.push(makeTextNode(content, [mark], diffMark));
        }
        break;
      }
      groupStart += entry.groups;
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

function makeTextNode(text, marks, diffMark) {
  // Restore newlines that were replaced with placeholders during line-joining
  const node = { type: 'text', text: text.replaceAll(INLINE_NEWLINE, '\n') };
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
 * Join lines that are continuations of the previous line due to
 * newlines inside inline HTML spans (e.g., \n in text nodes).
 * Detects unclosed HTML tags and merges the next line, replacing
 * the \n with INLINE_NEWLINE so the single-line regex still works.
 *
 * Tags to detect are derived from the format registry (INLINE_HTML_TAGS).
 */
function joinContinuationLines(lines) {
  const result = [];
  for (const line of lines) {
    if (result.length > 0) {
      const prev = result[result.length - 1];
      const opens = (prev.match(continuationOpenRe) || []).length;
      const closes = (prev.match(continuationCloseRe) || []).length;
      if (opens > closes) {
        result[result.length - 1] = prev + INLINE_NEWLINE + line;
        continue;
      }
    }
    result.push(line);
  }
  return result;
}

/**
 * Parse markdown string into ProseMirror document JSON.
 *
 * @param {string} markdown - Markdown content
 * @param {string|null} diffMark - Optional diff mark for all text nodes
 * @returns {object} ProseMirror document JSON { type: 'doc', content: [...] }
 */
function markdownToPm(markdown, diffMark = null) {
  const lines = joinContinuationLines(markdown.split('\n'));
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
      // Mermaid fences route to the dedicated diagram block node; everything
      // else is a generic codeBlock. Source of truth is DIAGRAM_FENCE_LABELS in
      // shared/format-registry.js; this literal copy is retained deliberately
      // because this parser is characterization-frozen (CN-2) and must not
      // import evolving registry state.
      const diagramType = {
        mermaid: 'mermaid',
        svg: 'svg',
      }[lang.toLowerCase()];
      const node = { type: diagramType || 'codeBlock' };
      if (!diagramType && lang) node.attrs = { language: lang };
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
    const orderedStart = line.match(/^\s*(\d+)\. /);
    if (orderedStart) {
      const listItems = parseListItems(lines, i, /^(\s*)\d+\. (.*)$/, diffMark);
      // The FIRST item's literal number becomes the list's `start` (feature
      // 054, FR-013). Later items' numbers are ignored, as CommonMark
      // specifies and as the tolerant parser already did — `3. 7. 9.` is a
      // list starting at 3, because per-item eccentricity was never
      // representable in the model. `0` and anything that would number the
      // list from below 1 clamps to 1, matching `<ol start>`.
      const start = Math.max(1, Number(orderedStart[1]));
      blocks.push({ type: 'orderedList', attrs: { start }, content: listItems.items });
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
