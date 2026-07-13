/**
 * Yjs Document Serialization
 *
 * Converts Yjs documents to readable formats for AI agents.
 * Provides both fragment-level (whole document) and node-level (individual elements) serialization.
 */
const Y = require('yjs');
const { getNodeTextLength } = require('./cursor-operations');
const { INLINE_MARKS, TEXTSTYLE_PORTABLE, attrsToCSS } = require('../../../shared/format-registry');
const {
  isInlineContentBlock,
  isCodeLikeBlock,
  isListContainer,
} = require('./block-types');

/**
 * Serialize a Yjs XmlFragment to plain text
 * @param {Y.XmlFragment} xmlFragment - Yjs XmlFragment
 * @returns {string} Plain text content
 */
function toPlainText(xmlFragment) {
  const parts = [];

  function processNode(node) {
    if (node instanceof Y.XmlText) {
      // Use toDelta() to get plain text without XML markup
      // toString() returns XML serialization when text has formatting marks
      const delta = node.toDelta();
      const text = delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');
      parts.push(text);
    } else if (node instanceof Y.XmlElement) {
      const tagName = node.nodeName;

      // Image is a void leaf — emit a marker (with alt text if present)
      if (tagName === 'image') {
        const alt = node.getAttribute('alt');
        parts.push(alt ? `[image: ${alt}]\n` : '[image]\n');
        return;
      }

      // Add appropriate spacing/formatting based on node type
      if (tagName === 'heading') {
        // Add newline before headings if not first
        if (parts.length > 0 && !parts[parts.length - 1].endsWith('\n\n')) {
          parts.push('\n\n');
        }
      }

      // Process children
      for (const child of node.toArray()) {
        processNode(child);
      }

      // Add appropriate ending based on node type
      if (isInlineContentBlock(tagName) || isListContainer(tagName)) {
        parts.push('\n');
      }
    }
  }

  for (const child of xmlFragment.toArray()) {
    processNode(child);
  }

  return parts.join('').trim();
}

/**
 * Serialize an array of Yjs nodes to Markdown
 * @param {Array<Y.XmlElement|Y.XmlText>} nodes - Yjs nodes (e.g. fragment blocks or xpath matches)
 * @param {object} [options] - Serialization options (backward-compatible; all
 *   existing call sites pass nothing and get today's exact output).
 * @param {'squire'|'portable'} [options.flavor='squire'] - Export flavor.
 *   'portable' degrades HTML-only marks per their registry `portable`
 *   declarations (contracts/registry-degradation.md); 'squire' is
 *   byte-identical to the pre-options output (FR-022).
 * @param {Set<string>|null} [options.lossy=null] - When provided, populated
 *   with the names of marks actually degraded during this serialization
 *   (RD-6: actual degradations only).
 * @returns {string} Markdown content
 */
function toMarkdownNodes(nodes, options = {}) {
  const { flavor = 'squire', lossy = null } = options || {};
  const portable = flavor === 'portable';
  const parts = [];

  // Compute the ordered wrap pairs a delta op emits (innermost first). Every
  // decoration — mark, textStyle span, link — reduces to a {pre, post} pair,
  // so the emission plan is a list of pairs plus a stable key describing it.
  // Degradation and same-op collapse (FR-011/FR-012) are resolved here.
  function inlinePlan(a) {
    const pairs = [];
    // Portable: identical delimiter pairs collapse to one emission (FR-012).
    // Pre-seed with the pairs the op's native marks will emit so a degraded
    // mark whose target coincides never doubles delimiters within the op.
    let emittedPairs = null;
    if (portable) {
      emittedPairs = new Set();
      for (const m of INLINE_MARKS) {
        if (a[m.yjsAttr] && !m.portable && m.wrap) {
          emittedPairs.add(m.wrap[0] + '\u0000' + m.wrap[1]);
        }
      }
    }
    // Marks from registry (innermost first)
    for (const m of INLINE_MARKS) {
      if (!a[m.yjsAttr]) continue;
      if (portable && m.portable) {
        // Degradation declared in the registry (FR-011): substitute the
        // declared markdown wrap for the HTML tag. Still counts as lossy even
        // when the delimiters collapse with a native mark's.
        if (lossy) lossy.add(m.name);
        const key = m.portable.wrap[0] + '\u0000' + m.portable.wrap[1];
        if (!emittedPairs.has(key)) {
          emittedPairs.add(key);
          pairs.push({ pre: m.portable.wrap[0], post: m.portable.wrap[1] });
        }
        continue;
      }
      if (m.wrap) pairs.push({ pre: m.wrap[0], post: m.wrap[1] });
      else pairs.push({ pre: `<${m.htmlTag}>`, post: `</${m.htmlTag}>` });
    }
    // textStyle: CSS from registry-derived STYLE_PROPS
    const ts = typeof a.textStyle === 'object' && a.textStyle;
    if (ts) {
      const css = attrsToCSS(ts);
      if (css) {
        if (portable && TEXTSTYLE_PORTABLE.drop) {
          // Styling dropped, text preserved (FR-010).
          if (lossy) lossy.add('textStyle');
        } else {
          pairs.push({ pre: `<span style="${css}">`, post: '</span>' });
        }
      }
    }
    // link (custom — not a simple wrap/tag, but still a pre/post pair)
    if (a.link) {
      const href = typeof a.link === 'object' ? a.link.href : a.link;
      pairs.push({ pre: '[', post: `](${href})` });
    }
    return { pairs, key: JSON.stringify(pairs) };
  }

  function renderInline(textNode) {
    const delta = textNode.toDelta();
    // Build per-op emission plans. In portable flavor, merge adjacent ops
    // whose portable-effective wrap set is identical BEFORE wrapping: two
    // neighbours that both degrade/collapse to the same delimiter (e.g.
    // underline"foo" + italic"bar" → both `_..._`) would otherwise emit
    // `_foo__bar_`, which re-parses as italic "foo__bar" with a literal `__`
    // in the text (FR-012, content-never-lost). Squire is untouched — its
    // marks emit distinct delimiters, so per-op wrapping stays byte-identical.
    const units = [];
    for (const op of delta) {
      if (typeof op.insert !== 'string') continue;
      const plan = inlinePlan(op.attributes || {});
      const last = units[units.length - 1];
      if (portable && last && last.key === plan.key) {
        last.text += op.insert;
      } else {
        units.push({ text: op.insert, pairs: plan.pairs, key: plan.key });
      }
    }
    let out = '';
    for (const u of units) {
      let seg = u.text;
      for (const { pre, post } of u.pairs) seg = pre + seg + post;
      out += seg;
    }
    return out;
  }

  function getChildText(node) {
    let text = '';
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) {
        text += renderInline(child);
      } else if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'hardBreak') {
          // Hard breaks emit the trailing-backslash form, all flavors
          // (FR-007, RD-7). Structurally constrained containers (table
          // cells, headings) post-process this to <br> — see their renderers.
          text += '\\\n';
        } else {
          text += getChildText(child);
        }
      }
    }
    return text;
  }

  function processNode(node, indent) {
    if (node instanceof Y.XmlText) {
      parts.push(renderInline(node));
      return;
    }
    if (!(node instanceof Y.XmlElement)) return;

    const tag = node.nodeName;

    if (tag === 'paragraph') {
      parts.push(getChildText(node) + '\n');
    } else if (tag === 'heading') {
      const level = parseInt(node.getAttribute('level') || '1', 10);
      // A backslash-newline break would split the ATX heading line; <br> is
      // the only hard-break form that keeps the heading one block (FR-007).
      const text = getChildText(node).replace(/\\\n/g, '<br>');
      parts.push('#'.repeat(level) + ' ' + text + '\n');
    } else if (tag === 'codeBlock') {
      const lang = node.getAttribute('language') || '';
      parts.push('```' + lang + '\n' + getChildText(node) + '\n```\n');
    } else if (tag === 'mermaid') {
      parts.push('```mermaid\n' + getChildText(node) + '\n```\n');
    } else if (tag === 'svg') {
      parts.push('```svg\n' + getChildText(node) + '\n```\n');
    } else if (tag === 'blockquote') {
      // Render children into a temporary capture by splicing the shared
      // `parts` array so the closure-based processNode writes into it.
      const saved = parts.splice(0);    // save & clear accumulated output
      for (const child of node.toArray()) {
        processNode(child, indent);
      }
      const innerLines = parts.splice(0); // capture child output
      parts.push(...saved);              // restore previous output
      for (const line of innerLines) {
        // Hard-break continuation lines need their own '> ' prefix to stay
        // inside the blockquote (FR-007).
        parts.push('> ' + line.replace(/\\\n/g, '\\\n> '));
      }
    } else if (tag === 'bulletList') {
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlElement && child.nodeName === 'listItem') {
          renderListItem(child, indent, '- ');
        }
      }
    } else if (tag === 'orderedList') {
      let num = 1;
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlElement && child.nodeName === 'listItem') {
          renderListItem(child, indent, `${num}. `);
          num++;
        }
      }
    } else if (tag === 'taskList') {
      // GFM task list: identical in all flavors (FR-004); lowercase x (RD-8).
      // `checked` arrives as boolean true from y-prosemirror (editor edits)
      // or string 'true' from appendBlocks — accept both.
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlElement && child.nodeName === 'taskItem') {
          const checked = child.getAttribute('checked');
          const marker = (checked === true || checked === 'true') ? '- [x] ' : '- [ ] ';
          renderListItem(child, indent, marker);
        }
      }
    } else if (tag === 'horizontalRule') {
      parts.push('---\n');
    } else if (tag === 'image') {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      // Escape backslashes and brackets in alt text so a bracketed alt (e.g.
      // "chart [v2]") stays well-formed — otherwise the inner `]` closes the
      // alt span early and the bundle image scanner can't match the reference
      // (F4). Backslash first so already-escaped runs aren't double-counted.
      const escapedAlt = alt.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
      parts.push(`![${escapedAlt}](${src})\n`);
    } else if (tag === 'table') {
      renderTable(node);
    } else {
      // Fallback: recurse into children
      for (const child of node.toArray()) {
        processNode(child, indent);
      }
    }
  }

  function renderListItem(node, indent, marker) {
    const children = node.toArray();
    // CommonMark: child blocks must reach the parent's content column,
    // i.e. be indented by the full marker width ("1. " = 3, "- [ ] " = 6).
    const childIndent = indent + ' '.repeat(marker.length);
    // Task items separate sibling blocks with a blank line so multi-paragraph
    // items re-parse to the same structure (FR-006; CommonMark needs the
    // blank line to keep the paragraphs distinct). listItem keeps its
    // pre-feature form (FR-022 byte-compat).
    const isTask = node.nodeName === 'taskItem';
    const blockSep = isTask ? '\n' : '';
    let first = true;
    for (const child of children) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (isListContainer(child.nodeName)) {
        processNode(child, childIndent);
      } else if (isTask && child.nodeName !== 'paragraph') {
        // Multi-block task item (FR-006): render structural child blocks
        // (codeBlock, blockquote, table, heading, …) through processNode so
        // fences and structure survive re-parsing, then shift the whole
        // rendering to the content column. Capture the block's output by
        // splicing the shared `parts` array (same technique as blockquote).
        // Plain listItem never reaches this branch — its byte-compat form
        // (FR-022) is untouched.
        const saved = parts.splice(0);
        processNode(child, childIndent);
        const rendered = parts.splice(0).join('').replace(/\n+$/, '');
        parts.push(...saved);
        const shifted = rendered
          .split('\n')
          .map((line) => (line === '' ? '' : childIndent + line))
          .join('\n');
        if (first) {
          // A task item whose first block is not a paragraph: emit the marker
          // on its own line, then the block at the content column.
          parts.push(indent + marker.replace(/\s+$/, '') + '\n' + blockSep + shifted + '\n');
          first = false;
        } else {
          parts.push(blockSep + shifted + '\n');
        }
      } else {
        // Paragraph (or any listItem child): inline text. Hard-break
        // continuation lines must reach the content column to stay inside
        // this item (FR-007).
        const text = getChildText(child).replace(/\\\n/g, '\\\n' + childIndent);
        if (first) {
          parts.push(indent + marker + text + '\n');
          first = false;
        } else {
          parts.push(blockSep + childIndent + text + '\n');
        }
      }
    }
  }

  function renderTable(tableNode) {
    const rows = [];
    for (const child of tableNode.toArray()) {
      if (child instanceof Y.XmlElement && child.nodeName === 'tableRow') {
        const cells = [];
        for (const cell of child.toArray()) {
          if (cell instanceof Y.XmlElement) {
            // A literal newline would split the table row; <br> is the
            // GFM-conventional hard-break form inside cells (FR-007).
            cells.push(getChildText(cell).replace(/\|/g, '\\|').replace(/\\\n/g, '<br>'));
          }
        }
        rows.push(cells);
      }
    }
    if (rows.length === 0) return;
    // Header row
    parts.push('| ' + rows[0].join(' | ') + ' |\n');
    parts.push('| ' + rows[0].map(() => '---').join(' | ') + ' |\n');
    for (let i = 1; i < rows.length; i++) {
      parts.push('| ' + rows[i].join(' | ') + ' |\n');
    }
  }

  // Render each top-level node separately and join with blank lines —
  // GFM needs them (tables can't interrupt a paragraph, paragraphs merge).
  const blocks = [];
  for (const node of nodes) {
    processNode(node, '');
    const rendered = parts.splice(0).join('').replace(/\n+$/, '');
    if (rendered !== '') blocks.push(rendered);
  }

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Serialize a Yjs XmlFragment to Markdown
 * @param {Y.XmlFragment} xmlFragment - Yjs XmlFragment
 * @param {object} [options] - See toMarkdownNodes ({ flavor, lossy }).
 * @returns {string} Markdown content
 */
function toMarkdown(xmlFragment, options) {
  return toMarkdownNodes(xmlFragment.toArray(), options);
}

/**
 * Serialize a Yjs XmlFragment to structured JSON format
 * @param {Y.XmlFragment} xmlFragment - Yjs XmlFragment
 * @returns {Array} Array of structured nodes
 */
function toStructured(xmlFragment) {
  const nodes = [];

  for (const child of xmlFragment.toArray()) {
    const processed = toStructuredNode(child);
    if (processed) {
      nodes.push(processed);
    }
  }

  return nodes;
}

/**
 * Load a Yjs document from database updates
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} docGuid - Document UUID
 * @returns {Promise<Y.Doc>} Yjs document
 */
async function loadYDoc(pool, docGuid) {
  const result = await pool.query(
    'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
    [docGuid]
  );

  const ydoc = new Y.Doc();

  if (result.rows.length > 0) {
    ydoc.transact(() => {
      for (const row of result.rows) {
        Y.applyUpdate(ydoc, new Uint8Array(row.update_data));
      }
    });
  }

  return ydoc;
}

/**
 * ============================================================================
 * NODE-LEVEL SERIALIZATION (for xpath results and individual elements)
 * ============================================================================
 */

/**
 * Extract text content with marks from a Y.XmlText node
 * Helper function used by toStructuredNode
 * @param {Y.XmlText} textNode - Yjs text node
 * @returns {Array} Array of text content items (strings and formatted objects)
 */
function extractTextWithMarks(textNode) {
  const delta = textNode.toDelta();
  const result = [];

  for (const op of delta) {
    if (typeof op.insert === 'string') {
      const text = op.insert;
      const attrs = op.attributes || {};

      // Extract all marks from attributes
      const marks = [];

      for (const [key, value] of Object.entries(attrs)) {
        if (value === true) {
          // Boolean marks (bold, italic, etc.)
          marks.push(key);
        } else if (typeof value === 'object' && value !== null) {
          // Object marks (link, textStyle, etc.)
          if (key === 'link') {
            marks.push({ type: 'link', href: value.href || value });
          } else {
            marks.push({ type: key, ...value });
          }
        }
        // Skip false/null/undefined values
      }

      if (marks.length > 0) {
        result.push({ text, marks });
      } else {
        result.push(text);
      }
    }
  }

  return result;
}

/**
 * Collapse a flat content array into the simplest representation:
 * - All plain strings with no marks → joined string
 * - Single plain string → the string itself
 * - Mixed/marked content → the array as-is
 * - Empty → undefined
 *
 * @param {Array} flatContent - Array of strings and {text, marks} objects
 * @param {{ forceString?: boolean }} options - forceString: always join (e.g. codeBlock)
 * @returns {string|Array|undefined}
 */
function simplifyContent(flatContent, { forceString = false } = {}) {
  if (flatContent.length === 0) return undefined;
  const hasMarks = flatContent.some(item => typeof item === 'object' && item.marks);
  if (forceString || (!hasMarks && flatContent.every(c => typeof c === 'string'))) {
    return flatContent.join('');
  }
  if (flatContent.length === 1 && typeof flatContent[0] === 'string') {
    return flatContent[0];
  }
  return flatContent;
}

/**
 * Recursively collect text content from structured node children.
 * Walks into content, children, and nested structures so that
 * container elements like tableCell always get a content string
 * even when their children are paragraphs, lists, etc.
 */
function collectContent(nodes, out, setHasMarks) {
  for (const child of nodes) {
    // Direct content (string or array of text/mark items)
    const content = child.content;
    if (content) {
      if (Array.isArray(content)) {
        out.push(...content);
        if (content.some((item) => typeof item === 'object' && item.marks)) {
          setHasMarks(true);
        }
      } else if (typeof content === 'string') {
        out.push(content);
      }
    }
    // Recurse into children (lists, blockquotes, nested structures)
    if (child.children) {
      collectContent(child.children, out, setHasMarks);
    }
  }
}

/**
 * Convert a single Yjs node to structured format (ProseMirror-like JSON)
 * Used for serializing xpath query results
 * @param {Y.XmlElement|Y.XmlText} node - Single Yjs node to serialize
 * @returns {Object|null} Structured representation
 */
function toStructuredNode(node) {
  if (node instanceof Y.XmlText) {
    return { type: 'text', content: extractTextWithMarks(node) };
  }

  if (!(node instanceof Y.XmlElement)) {
    return null;
  }

  const tagName = node.nodeName;
  const result = { type: tagName };

  // Extract all attributes generically
  const allAttrs = node.getAttributes();
  for (const [key, value] of Object.entries(allAttrs)) {
    if (value !== undefined && value !== null) {
      // Parse numeric attributes
      if (['colspan', 'rowspan', 'level'].includes(key)) {
        result[key] = parseInt(value, 10);
      } else if (key === 'checked') {
        // taskItem checked state (FR-005): boolean from y-prosemirror,
        // string from appendBlocks — structured output exposes the boolean.
        result[key] = value === true || value === 'true';
      } else {
        result[key] = value;
      }
    }
  }

  // Process children
  const children = [];
  for (const child of node.toArray()) {
    const processed = toStructuredNode(child);
    if (processed) children.push(processed);
  }

  // Void elements (self-closing, no content) - filter out any children.
  // Their attributes (e.g. image src/alt/title/width) are already captured above.
  if (tagName === 'horizontalRule' || tagName === 'image') {
    return result;
  }

  // Simplify content for table cells — collect recursively from nested children
  if (['tableCell', 'tableHeader'].includes(tagName)) {
    const flatContent = [];
    if (children.length > 0) {
      collectContent(children, flatContent, () => {});
    }
    result.content = simplifyContent(flatContent) ?? '';

  } else if (isInlineContentBlock(tagName)) {
    // Simplify content for leaf blocks
    const allText = children.every((c) => c.type === 'text');
    if (allText && children.length > 0) {
      const flatContent = [];
      for (const child of children) {
        if (Array.isArray(child.content)) flatContent.push(...child.content);
      }
      const simplified = simplifyContent(flatContent, {
        forceString: isCodeLikeBlock(tagName),
      });
      if (simplified !== undefined) result.content = simplified;
    } else if (children.length > 0) {
      result.children = children;
    }
  } else if (children.length > 0) {
    result.children = children;
  }

  return result;
}

/**
 * Convert a single Yjs node to plain text
 * Used for serializing xpath query results
 * @param {Y.XmlElement|Y.XmlText} node - Single Yjs node to serialize
 * @returns {string} Plain text representation
 */
function toTextNode(node) {
  if (node instanceof Y.XmlText) {
    const delta = node.toDelta();
    return delta.map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('');
  }

  if (!(node instanceof Y.XmlElement)) {
    return '';
  }

  const tagName = node.nodeName;

  // Image is a void leaf — emit a marker (with alt text if present)
  if (tagName === 'image') {
    const alt = node.getAttribute('alt');
    return alt ? `[image: ${alt}]\n` : '[image]\n';
  }

  let text = '';

  for (const child of node.toArray()) {
    text += toTextNode(child);
  }

  // Add appropriate newlines
  if (isInlineContentBlock(tagName) || isListContainer(tagName)) {
    text += '\n';
  }

  return text;
}

/**
 * ============================================================================
 * FRONTMATTER EMISSION (feature 003, FR-014 / RD-4)
 * ============================================================================
 */

/**
 * Whether a string needs quoting to survive as a YAML scalar. Deliberately
 * conservative; quoted strings are emitted as JSON strings (valid YAML
 * double-quoted scalars) so control characters and quotes are always safe.
 */
function yamlNeedsQuoting(str) {
  if (str === '') return true;
  if (/^\s|\s$/.test(str)) return true;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u2028\u2029]/.test(str)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(str)) return true; // leading indicator chars
  if (/: /.test(str) || /:$/.test(str)) return true;
  if (/ #/.test(str)) return true;
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(str)) return true;
  if (/^[+-]?(\.?\d[\d_]*(\.[\d_]*)?([eE][+-]?\d+)?|\.inf|\.nan)$/i.test(str)) return true;
  return false;
}

/** Emit a value as a deterministic YAML scalar. */
function yamlScalar(value) {
  const str = String(value);
  return yamlNeedsQuoting(str) ? JSON.stringify(str) : str;
}

/**
 * Strip any top-level `squire:` key (bare, "squire" or 'squire' quoted) and
 * its indented/blank continuation lines from preserved foreign frontmatter.
 *
 * parseFrontmatter's conservative fallbacks (a quoted squire key, or an
 * anchor crossing the squire block) return the WHOLE inner block — squire
 * lines included — as foreignRaw so foreign keys are never corrupted. A
 * consumer re-emitting buildFrontmatter(meta, foreignRaw) would then write a
 * SECOND `squire:` key; js-yaml rejects duplicate keys, so the next parse
 * throws and the entire block degrades to body content (F5). Excising the
 * stale squire block here keeps re-emission to exactly one squire key.
 */
function stripForeignSquire(foreignRaw) {
  const lines = foreignRaw.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^(?:squire|"squire"|'squire')\s*:(\s|$)/.test(lines[i])) {
      // Drop the key line and every following indented or blank line.
      let j = i + 1;
      while (j < lines.length && (/^[ \t]/.test(lines[j]) || lines[j].trim() === '')) j++;
      i = j - 1;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * Build the single leading YAML frontmatter block for an export
 * (contracts/frontmatter-squire-block.md §1). Hand-rolled, deterministic:
 * fixed key order under `squire:`, foreign raw lines re-emitted verbatim
 * FIRST (RD-4), one fence pair, stable bytes for identical inputs.
 *
 * @param {object} meta
 * @param {string} meta.docGuid
 * @param {string} meta.title
 * @param {number} meta.clock - Document version counter at export.
 * @param {string} meta.exportedAt - ISO-8601 UTC timestamp.
 * @param {string} meta.lastModifiedBy - Last modifier identity ('' if unknown).
 * @param {'squire'|'portable'} meta.flavor - Effective flavor of this export.
 * @param {Iterable<string>} [meta.lossy] - Marks actually degraded; the key
 *   is omitted when empty (RD-6). Emitted as a sorted flow list.
 * @param {Object<string,string>} [meta.images] - relativePath → imageId,
 *   bundle exports only; emitted as a block map sorted by key.
 * @param {string|null} [foreignRaw] - Preserved foreign frontmatter lines,
 *   re-emitted byte-verbatim ahead of the squire key.
 * @returns {string} The block, opening `---` through closing `---\n`.
 */
function buildFrontmatter(meta, foreignRaw = null) {
  const lines = ['---'];
  if (foreignRaw != null && foreignRaw !== '') {
    // Never let a stale squire block from a conservative-fallback foreignRaw
    // collide with the squire key we emit below (F5).
    const foreign = stripForeignSquire(foreignRaw);
    if (foreign.trim() !== '') lines.push(foreign);
  }
  lines.push('squire:');
  lines.push(`  docGuid: ${yamlScalar(meta.docGuid)}`);
  lines.push(`  title: ${yamlScalar(meta.title)}`);
  lines.push(`  clock: ${Number.isFinite(meta.clock) ? Math.trunc(meta.clock) : 0}`);
  lines.push(`  exportedAt: ${yamlScalar(meta.exportedAt)}`);
  lines.push(`  lastModifiedBy: ${yamlScalar(meta.lastModifiedBy == null ? '' : meta.lastModifiedBy)}`);
  lines.push(`  flavor: ${yamlScalar(meta.flavor)}`);
  const lossy = meta.lossy ? [...meta.lossy].sort() : [];
  if (lossy.length > 0) {
    lines.push(`  lossy: [${lossy.map(yamlScalar).join(', ')}]`);
  }
  const imageKeys = meta.images ? Object.keys(meta.images).sort() : [];
  if (imageKeys.length > 0) {
    lines.push('  images:');
    for (const key of imageKeys) {
      lines.push(`    ${yamlScalar(key)}: ${yamlScalar(meta.images[key])}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

/**
 * ============================================================================
 * HELPER FUNCTIONS
 * ============================================================================
 */

/**
 * Count total characters in an array of Yjs nodes
 * @param {Array<Y.XmlElement|Y.XmlText>} nodes - Array of Yjs nodes
 * @returns {number} Total character count
 */
function countCharacters(nodes) {
  return nodes.reduce((sum, node) => sum + getNodeTextLength(node), 0);
}

/**
 * Count total blocks in a Yjs XmlFragment
 * @param {Y.XmlFragment} xmlFragment - Yjs fragment
 * @returns {number} Total block count
 */
function countBlocks(xmlFragment) {
  return xmlFragment.toArray().length;
}


module.exports = {
  // Fragment-level serialization (existing)
  toPlainText,
  toMarkdown,
  toStructured,
  loadYDoc,
  // Node-level serialization (new)
  toMarkdownNodes,
  toStructuredNode,
  toTextNode,
  extractTextWithMarks,
  // Frontmatter emission (feature 003)
  buildFrontmatter,
  // Helper functions (new)
  countCharacters,
  countBlocks,
};
