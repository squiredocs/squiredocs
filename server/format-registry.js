/**
 * Declarative format registry for the markdown ↔ ProseMirror pipeline.
 *
 * Single source of truth for all inline mark and textStyle definitions.
 * Derives HTML tags from the ProseMirror schema and textStyle CSS properties
 * from the schema's attr definitions. Both toMarkdown() and markdownToPm()
 * import from this module rather than duplicating format knowledge.
 *
 * To add a new simple mark:
 *   1. Add the mark to shared/prosemirror-schema.js
 *   2. Add one entry to INLINE_MARKS below
 *
 * To add a new textStyle property:
 *   1. Add the attr to schema.marks.textStyle.attrs
 *   → STYLE_PROPS auto-derives it (zero changes here)
 */

const { schema } = require('../shared/prosemirror-schema');

// ---------------------------------------------------------------------------
// Schema derivation helpers
// ---------------------------------------------------------------------------

/** Derive the HTML tag a ProseMirror mark renders to (from its toDOM spec). */
function deriveTag(markName) {
  const dom = schema.marks[markName].spec.toDOM();
  return dom[0]; // e.g. ['u', 0] → 'u'
}

/** Convert camelCase to kebab-case for CSS property names. */
function camelToKebab(s) {
  return s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
}

// ---------------------------------------------------------------------------
// Core definitions
// ---------------------------------------------------------------------------

/**
 * textStyle CSS ↔ ProseMirror attr mapping.
 * Auto-derived from schema.marks.textStyle.spec.attrs.
 */
const STYLE_PROPS = Object.keys(schema.marks.textStyle.spec.attrs)
  .map(attr => ({ attr, css: camelToKebab(attr) }));

/**
 * Placeholder for newlines inside inline HTML spans.
 * toMarkdown does NOT escape newlines (so chat diffs show clean markdown).
 * markdownToPm's joinContinuationLines() replaces real \n with this before
 * regex parsing, and makeTextNode() restores it to \n in the final output.
 */
const INLINE_NEWLINE = '\x00';

/**
 * Inline mark definitions in serialization order.
 *
 * - wrap: [open, close] markdown delimiters (for md-syntax marks)
 * - htmlTag: HTML tag name derived from schema (for HTML-in-markdown marks)
 * - yjsAttr: YJS delta attribute key (may differ from ProseMirror mark name)
 * - contentPattern: custom regex for content capture (default: .+?)
 */
const INLINE_MARKS = [
  { name: 'code',        yjsAttr: 'code',          wrap: ['`', '`'], contentPattern: '[^`]+' },
  { name: 'bold',        yjsAttr: 'bold',           wrap: ['**', '**'] },
  { name: 'italic',      yjsAttr: 'italic',         wrap: ['_', '_'] },
  { name: 'strike',      yjsAttr: 'strikethrough',  wrap: ['~~', '~~'] },
  { name: 'underline',   yjsAttr: 'underline',      htmlTag: deriveTag('underline') },
  { name: 'highlight',   yjsAttr: 'highlight',      htmlTag: deriveTag('highlight') },
  { name: 'subscript',   yjsAttr: 'subscript',      htmlTag: deriveTag('subscript') },
  { name: 'superscript', yjsAttr: 'superscript',    htmlTag: deriveTag('superscript') },
];

/**
 * HTML tags used for inline marks (for continuation-line detection).
 * Includes 'span' for textStyle.
 */
const INLINE_HTML_TAGS = [
  'span',
  ...INLINE_MARKS.filter(m => m.htmlTag).map(m => m.htmlTag),
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Escape regex special characters. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert textStyle attrs object → CSS string. */
function attrsToCSS(ts) {
  return STYLE_PROPS
    .filter(p => ts[p.attr])
    .map(p => `${p.css}:${ts[p.attr]}`)
    .join(';');
}

/** Parse CSS string → textStyle attrs object. */
function cssToAttrs(style) {
  const attrs = {};
  for (const decl of style.split(';')) {
    const [prop, ...rest] = decl.split(':');
    const val = rest.join(':').trim();
    if (!prop || !val) continue;
    const sp = STYLE_PROPS.find(p => p.css === prop.trim());
    if (sp) attrs[sp.attr] = val;
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Inline regex builder (for markdownToPm)
// ---------------------------------------------------------------------------

/**
 * Build the combined inline regex and dispatch table.
 *
 * Returns { regex, entries } where each entry has:
 *   - groups: number of capture groups in this alternative
 *   - dispatch(match, groupStart): → { mark, content, nested }
 *       mark: ProseMirror mark JSON ({ type, attrs? })
 *       content: captured text
 *       nested: true if content may contain further inline marks
 */
function buildInlineRegex() {
  const entries = [];

  // 1. textStyle: <span style="...">content</span>  (2 groups)
  entries.push({
    pattern: '<span style="([^"]+)">(.+?)<\\/span>',
    groups: 2,
    dispatch: (match, g) => ({
      mark: { type: 'textStyle', attrs: cssToAttrs(match[g]) },
      content: match[g + 1],
      nested: true,
    }),
  });

  // 2. HTML-tag marks derived from schema  (1 group each)
  for (const m of INLINE_MARKS.filter(m => m.htmlTag)) {
    entries.push({
      pattern: `<${m.htmlTag}>(.+?)<\\/${m.htmlTag}>`,
      groups: 1,
      dispatch: (match, g) => ({
        mark: { type: m.name },
        content: match[g],
        nested: true,
      }),
    });
  }

  // 3. Markdown-wrap marks  (1 group each)
  for (const m of INLINE_MARKS.filter(m => m.wrap)) {
    const open = escapeRegex(m.wrap[0]);
    const close = escapeRegex(m.wrap[1]);
    const cp = m.contentPattern || '.+?';
    entries.push({
      pattern: `${open}(${cp})${close}`,
      groups: 1,
      dispatch: (match, g) => ({
        mark: { type: m.name },
        content: match[g],
        nested: m.name !== 'code',
      }),
    });
  }

  // 4. Link: [text](url)  (2 groups, always last)
  entries.push({
    pattern: '\\[([^\\]]+)\\]\\(([^)]+)\\)',
    groups: 2,
    dispatch: (match, g) => ({
      mark: { type: 'link', attrs: { href: match[g + 1] } },
      content: match[g],
      nested: false,
    }),
  });

  const fullPattern = entries.map(e => e.pattern).join('|');
  return { regex: new RegExp(fullPattern, 'g'), entries };
}

module.exports = {
  INLINE_MARKS,
  STYLE_PROPS,
  INLINE_NEWLINE,
  INLINE_HTML_TAGS,
  attrsToCSS,
  cssToAttrs,
  buildInlineRegex,
};
