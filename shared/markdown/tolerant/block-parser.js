/**
 * Tolerant block parser (feature 001, T011).
 *
 * Container-stack line classifier producing ProseMirror block JSON from a
 * CommonMark + GFM subset (data-model.md §2): ATX + setext headings, thematic
 * breaks, fenced + indented code, loose/lazy/multi-paragraph/nested lists, the
 * GFM task-list seam, blockquotes, and the pipe-leading table dialect. Anything
 * it cannot classify degrades to literal-text paragraphs (FR-013 ladder).
 *
 * Inline content is handed to the registry-driven tolerant inline parser.
 * Pure module: no Node built-ins (client-safe, FR-014).
 */

const { INLINE_HTML_TAGS, INLINE_NEWLINE } = require('../../format-registry');
const { parseInlineTolerant } = require('./inline-parser');

const MAX_CONTAINER_DEPTH = 64;

// Continuation-line detection patterns (mirror the strict parser; registry-driven).
const continuationOpenRe = new RegExp(`<(?:${INLINE_HTML_TAGS.join('|')})\\b`, 'g');
const continuationCloseRe = new RegExp(`<\\/(?:${INLINE_HTML_TAGS.join('|')})>`, 'g');

/**
 * Join lines that continue the previous line because a newline fell inside an
 * inline HTML span (e.g. a `<span style>` split across lines by the serializer).
 * Real `\n` becomes the INLINE_NEWLINE placeholder, restored to `\n` in text
 * nodes by the inline parser — so the span's content keeps its literal newline
 * instead of being treated as a line break (canonical-equivalence, FR-012).
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

// --- Line classifiers -------------------------------------------------------

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const THEMATIC_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_RE = /^( {0,3})(`{3,})([^`]*)$/;
const SETEXT1_RE = /^ {0,3}=+[ \t]*$/;
const SETEXT2_RE = /^ {0,3}-+[ \t]*$/;
const BLOCKQUOTE_RE = /^ {0,3}>/;
const INDENTED_RE = /^(?: {4}|\t)/;

function tableStart(line) {
  return /^ {0,3}\|/.test(line);
}

function tryListItem(line) {
  let m = /^( {0,3})([-*+])([ \t]+)(.*)$/.exec(line);
  if (m) {
    return { ordered: false, indent: m[1].length, markerWidth: m[1].length + 1 + m[3].length, content: m[4] };
  }
  m = /^( {0,3})([-*+])[ \t]*$/.exec(line);
  if (m) {
    return { ordered: false, indent: m[1].length, markerWidth: m[1].length + 2, content: '' };
  }
  m = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/.exec(line);
  if (m) {
    return { ordered: true, indent: m[1].length, start: parseInt(m[2], 10), markerWidth: m[1].length + m[2].length + 1 + m[4].length, content: m[5] };
  }
  m = /^( {0,3})(\d{1,9})([.)])[ \t]*$/.exec(line);
  if (m) {
    return { ordered: true, indent: m[1].length, start: parseInt(m[2], 10), markerWidth: m[1].length + m[2].length + 2, content: '' };
  }
  return null;
}

function isBlockStart(line) {
  if (line.trim() === '') return true;
  return (
    ATX_RE.test(line) ||
    THEMATIC_RE.test(line) ||
    FENCE_RE.test(line) ||
    BLOCKQUOTE_RE.test(line) ||
    tableStart(line) ||
    tryListItem(line) !== null
  );
}

// --- Node builders ----------------------------------------------------------

function makeText(text, diffMark) {
  const node = { type: 'text', text };
  if (diffMark) node.marks = [{ type: diffMark }];
  return node;
}

function paragraphNode(text, diffMark) {
  const content = parseInlineTolerant(text, diffMark);
  const node = { type: 'paragraph' };
  if (content.length > 0) node.content = content;
  return node;
}

function literalParagraphs(lines, diffMark) {
  // Degradation rung 5/6: one paragraph per non-blank line, words preserved.
  const out = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    out.push(paragraphNode(line, diffMark));
  }
  return out;
}

/**
 * FEATURE 003 SEAM (flipped from feature 001's degradation).
 *
 * The single place a recognized GFM task item becomes a node. Feature 001
 * degraded to a bulletList `listItem` with the literal `[x] ` marker kept as
 * leading text; feature 003 (FR-005) emits the real schema node: `taskItem`
 * with a boolean `checked` attr and the marker stripped. No other grammar
 * logic changed. Tolerant mode only — the strict parser is frozen (001 CN-2)
 * and has no task-list recognition.
 *
 * diffMark is unused now that no marker text is synthesized (content text
 * nodes carry it from inline parsing); the parameter is kept for the seam's
 * documented signature.
 */
// eslint-disable-next-line no-unused-vars
function taskItemNode({ checked, contentNodes, diffMark }) {
  const nodes = contentNodes.length > 0 ? contentNodes : [{ type: 'paragraph' }];
  return { type: 'taskItem', attrs: { checked }, content: ensureParagraphFirst(nodes) };
}

// --- Core block parsing -----------------------------------------------------

function parseBlocks(lines, diffMark, depth) {
  if (depth > MAX_CONTAINER_DEPTH) {
    return literalParagraphs(lines, diffMark);
  }

  const blocks = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const fenceIndent = fence[1].length;
      const fenceLen = fence[2].length;
      const info = fence[3].trim();
      const codeLines = [];
      i++;
      const closeRe = new RegExp(`^ {0,3}\`{${fenceLen},}[ \\t]*$`);
      while (i < n && !closeRe.test(lines[i])) {
        // strip up to the fence's indentation
        codeLines.push(lines[i].replace(new RegExp(`^ {0,${fenceIndent}}`), ''));
        i++;
      }
      if (i < n) i++; // consume closing fence
      blocks.push(fencedCodeNode(info, codeLines.join('\n'), diffMark));
      continue;
    }

    // Thematic break (at a block boundary; setext `---` is handled in paragraphs)
    if (THEMATIC_RE.test(line)) {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    // ATX heading
    const atx = ATX_RE.exec(line);
    if (atx) {
      const level = atx[1].length;
      // Strip an optional ATX closing sequence (a run of #'s preceded by space).
      const content = (atx[2] || '').replace(/[ \t]+#+[ \t]*$/, '');
      const node = { type: 'heading', attrs: { level } };
      const inline = parseInlineTolerant(content, diffMark);
      if (inline.length > 0) node.content = inline;
      blocks.push(node);
      i++;
      continue;
    }

    // Blockquote
    if (BLOCKQUOTE_RE.test(line)) {
      const { node, next } = parseBlockquote(lines, i, diffMark, depth);
      blocks.push(node);
      i = next;
      continue;
    }

    // Table (pipe-leading dialect only, CN-8)
    if (tableStart(line)) {
      const tableLines = [];
      while (i < n && tableStart(lines[i])) {
        tableLines.push(lines[i].replace(/^ {0,3}/, ''));
        i++;
      }
      const table = parseTable(tableLines, diffMark);
      if (table) {
        blocks.push(table);
      } else {
        blocks.push(...literalParagraphs(tableLines, diffMark));
      }
      continue;
    }

    // Lists
    const li = tryListItem(line);
    if (li) {
      const { nodes, next } = parseList(lines, i, diffMark, depth);
      blocks.push(...nodes);
      i = next;
      continue;
    }

    // Indented code (only at a block boundary; cannot interrupt a paragraph)
    if (INDENTED_RE.test(line)) {
      const codeLines = [];
      while (i < n && (INDENTED_RE.test(lines[i]) || lines[i].trim() === '')) {
        // stop trailing blanks from being swallowed past the code block
        if (lines[i].trim() === '') {
          // lookahead: keep blank only if more indented code follows
          let k = i + 1;
          while (k < n && lines[k].trim() === '') k++;
          if (k < n && INDENTED_RE.test(lines[k])) {
            codeLines.push('');
            i++;
            continue;
          }
          break;
        }
        codeLines.push(lines[i].replace(/^(?: {4}|\t)/, ''));
        i++;
      }
      blocks.push(codeBlockNode(codeLines.join('\n'), null, diffMark));
      continue;
    }

    // Paragraph accumulation with setext detection
    const paraLines = [line];
    i++;
    let consumed = false;
    while (i < n) {
      const l = lines[i];
      if (l.trim() === '') break;
      // Setext underline directly under paragraph text
      if (SETEXT1_RE.test(l)) {
        blocks.push(setextHeading(paraLines, 1, diffMark));
        i++;
        consumed = true;
        break;
      }
      if (SETEXT2_RE.test(l)) {
        // A run of only `-` directly under paragraph text is a setext H2
        // underline — setext takes precedence over thematic break here, so a
        // canonical `paragraph\n\n---` (blank-separated) still becomes an HR
        // while `paragraph\n---` becomes a heading (Edge Case).
        blocks.push(setextHeading(paraLines, 2, diffMark));
        i++;
        consumed = true;
        break;
      }
      // Any other block start ends the paragraph (lazy continuation otherwise)
      if (isBlockStart(l)) break;
      paraLines.push(l);
      i++;
    }
    if (!consumed) {
      blocks.push(paragraphNode(paraLines.join('\n'), diffMark));
    }
  }

  return blocks;
}

function setextHeading(paraLines, level, diffMark) {
  const node = { type: 'heading', attrs: { level } };
  const inline = parseInlineTolerant(paraLines.join('\n'), diffMark);
  if (inline.length > 0) node.content = inline;
  return node;
}

function fencedCodeNode(info, code, diffMark) {
  // Use the full (trimmed) info string as the language, exactly as the strict
  // parser does — so canonical single-word fences stay identical and a
  // multi-word info string is preserved in the language attr rather than
  // dropped (canonical equivalence + never-lose-content).
  const lang = info.trim();
  const diagramType = { mermaid: 'mermaid', svg: 'svg' }[lang.toLowerCase()];
  if (diagramType) {
    return codeBlockNode(code, null, diffMark, diagramType);
  }
  return codeBlockNode(code, lang || null, diffMark);
}

function codeBlockNode(code, language, diffMark, type = 'codeBlock') {
  const node = { type };
  if (type === 'codeBlock' && language) node.attrs = { language };
  if (code) {
    const textNode = { type: 'text', text: code };
    if (diffMark) textNode.marks = [{ type: diffMark }];
    node.content = [textNode];
  }
  return node;
}

function parseBlockquote(lines, start, diffMark, depth) {
  const inner = [];
  let i = start;
  const n = lines.length;
  while (i < n) {
    const l = lines[i];
    if (BLOCKQUOTE_RE.test(l)) {
      inner.push(l.replace(/^ {0,3}> ?/, ''));
      i++;
    } else if (l.trim() === '') {
      break;
    } else if (!isBlockStart(l)) {
      // lazy continuation
      inner.push(l);
      i++;
    } else {
      break;
    }
  }
  const content = parseBlocks(inner, diffMark, depth + 1);
  return { node: { type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] }, next: i };
}

function parseList(lines, start, diffMark, depth) {
  const first = tryListItem(lines[start]);
  const ordered = first.ordered;
  const listIndent = first.indent;
  const items = [];
  let i = start;
  const n = lines.length;

  while (i < n) {
    const li = tryListItem(lines[i]);
    if (!li || li.ordered !== ordered || li.indent !== listIndent) break;

    const contentLines = [li.content];
    const contentIndent = li.markerWidth;
    i++;

    while (i < n) {
      const l = lines[i];
      if (l.trim() === '') {
        // provisional blank — keep only if item content continues after it
        let k = i + 1;
        while (k < n && lines[k].trim() === '') k++;
        if (k < n && (lines[k].match(/^ */)[0].length >= contentIndent)) {
          contentLines.push('');
          i++;
          continue;
        }
        break;
      }
      const leading = l.match(/^ */)[0].length;
      if (leading >= contentIndent) {
        contentLines.push(l.slice(contentIndent));
        i++;
        continue;
      }
      const nli = tryListItem(l);
      if (nli && nli.ordered === ordered && nli.indent === listIndent) break;
      if (nli) break; // a differently-indented item ends this run at this level
      // lazy continuation of the item's paragraph
      if (!isBlockStart(l) && contentLines.length > 0 && contentLines[contentLines.length - 1].trim() !== '') {
        contentLines.push(l.trim());
        i++;
        continue;
      }
      break;
    }

    while (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') contentLines.pop();
    items.push(buildListItem(contentLines, ordered, diffMark, depth));

    // Bridge blank lines (loose list): a following same-type/-indent item stays
    // in this list; anything else ends it. Leave i on the blank so the caller
    // skips it (FR-005: loose and tight lists share one structure).
    let j = i;
    while (j < n && lines[j].trim() === '') j++;
    const bridge = j < n ? tryListItem(lines[j]) : null;
    if (bridge && bridge.ordered === ordered && bridge.indent === listIndent) {
      i = j;
    } else {
      break;
    }
  }

  if (ordered) {
    return { nodes: [{ type: 'orderedList', attrs: { start: first.start }, content: items }], next: i };
  }
  // Unordered items are taskItem or listItem per line (FR-005). The schema
  // requires homogeneous containers (taskList: taskItem+, bulletList:
  // listItem+), so a mixed run splits into consecutive same-kind lists —
  // checkbox syntax always yields a task item, never literal `[x]` text
  // (spec Edge Cases).
  const groups = [];
  for (const item of items) {
    const kind = item.type === 'taskItem' ? 'taskList' : 'bulletList';
    const last = groups[groups.length - 1];
    if (last && last.type === kind) {
      last.content.push(item);
    } else {
      groups.push({ type: kind, content: [item] });
    }
  }
  return { nodes: groups, next: i };
}

function buildListItem(contentLines, ordered, diffMark, depth) {
  // GFM task item: only bullet items become task items (CN-3);
  // ordered-list checkbox syntax stays literal item text.
  // Marker must be followed by whitespace or end the line (empty task item —
  // spec Edge Cases); `[x]text` with no space stays literal bullet text.
  const taskMatch = !ordered && contentLines.length > 0 ? /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(contentLines[0]) : null;
  if (taskMatch) {
    const checked = taskMatch[1].toLowerCase() === 'x';
    // The `[x] ` marker occupies 4 columns beyond the bullet's marker width,
    // so the item's real content column sits 4 further right (the serializer
    // indents continuation blocks to the full `- [ ] ` width of 6). Shift
    // continuation lines back by up to those 4 columns so nested blocks
    // classify correctly; unindented lazy continuations pass through as-is.
    const rest = [taskMatch[2] || '', ...contentLines.slice(1).map((l) => l.replace(/^ {1,4}/, ''))];
    const contentNodes = parseBlocks(rest, diffMark, depth + 1);
    return taskItemNode({ checked, contentNodes, diffMark });
  }
  const content = parseBlocks(contentLines, diffMark, depth + 1);
  return { type: 'listItem', content: ensureParagraphFirst(content) };
}

/**
 * The schema requires `listItem` content to be `paragraph block*` (paragraph
 * first). Tolerant parsing can yield an item whose first block is a heading,
 * sub-list, or code block (e.g. an item that is only a nested list); prepend an
 * empty paragraph so the document stays schema-valid without losing content.
 */
function ensureParagraphFirst(blocks) {
  if (blocks.length === 0) return [{ type: 'paragraph' }];
  if (blocks[0].type !== 'paragraph') return [{ type: 'paragraph' }, ...blocks];
  return blocks;
}

function parseTable(tableLines, diffMark) {
  const rows = [];
  for (const line of tableLines) {
    if (/^\|[\s\-:|]+\|$/.test(line)) continue; // separator row
    // Split on pipes and drop the empty segment before the leading pipe; drop a
    // trailing empty segment only if the row ended with a pipe. This keeps
    // canonical `| a | b |` identical to the old slice(1,-1) while NOT dropping
    // the last cell of a pipe-leading row that omits the trailing pipe
    // (never-lose-content, FR-013).
    const parts = line.split('|').slice(1);
    if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
    const cells = parts.map((c) => c.trim());
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return null;

  const tableRows = rows.map((cells, rowIdx) => {
    const cellNodes = cells.map((cellText) => {
      const cellContent = parseInlineTolerant(cellText.replace(/\\\|/g, '|'), diffMark);
      const para = { type: 'paragraph' };
      if (cellContent.length > 0) para.content = cellContent;
      return {
        type: rowIdx === 0 ? 'tableHeader' : 'tableCell',
        attrs: { colspan: 1, rowspan: 1, colwidth: null },
        content: [para],
      };
    });
    return { type: 'tableRow', content: cellNodes };
  });

  return { type: 'table', content: tableRows };
}

// --- Public entry -----------------------------------------------------------

/**
 * Parse a markdown string into ProseMirror document JSON (tolerant grammar).
 *
 * @param {string} markdown
 * @param {string|null} diffMark
 * @returns {object} { type: 'doc', content: Block[] } (always ≥ 1 block)
 */
function markdownToPm(markdown, diffMark = null) {
  const normalized = String(markdown).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = joinContinuationLines(normalized.split('\n'));
  let blocks = parseBlocks(lines, diffMark, 0);
  if (blocks.length === 0) blocks = [{ type: 'paragraph' }];
  return { type: 'doc', content: blocks };
}

module.exports = { markdownToPm, taskItemNode };
