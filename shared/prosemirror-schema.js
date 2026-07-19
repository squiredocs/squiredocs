/**
 * Shared ProseMirror schema definition.
 *
 * This schema matches the TipTap editor configuration used in the client:
 * - StarterKit (doc, paragraph, text, heading, bulletList, orderedList, listItem,
 *   blockquote, codeBlock, code, hardBreak, horizontalRule, bold, italic, strike)
 * - TaskList / TaskItem extensions (GFM task lists; taskItem carries a boolean
 *   `checked` attr, DOM contract data-type/data-checked matching TipTap)
 * - Underline extension
 * - Link extension
 *
 * Used by both server (diff computation) and client (editor) to ensure consistency.
 */

const { Schema } = require('prosemirror-model');

const nodes = {
  doc: {
    content: 'block+',
  },

  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM() {
      return ['p', 0];
    },
  },

  text: {
    group: 'inline',
  },

  heading: {
    attrs: { level: { default: 1 } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [
      { tag: 'h1', attrs: { level: 1 } },
      { tag: 'h2', attrs: { level: 2 } },
      { tag: 'h3', attrs: { level: 3 } },
      { tag: 'h4', attrs: { level: 4 } },
      { tag: 'h5', attrs: { level: 5 } },
      { tag: 'h6', attrs: { level: 6 } },
    ],
    toDOM(node) {
      return ['h' + node.attrs.level, 0];
    },
  },

  bulletList: {
    content: 'listItem+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM() {
      return ['ul', 0];
    },
  },

  orderedList: {
    attrs: { start: { default: 1 } },
    content: 'listItem+',
    group: 'block',
    parseDOM: [
      {
        tag: 'ol',
        getAttrs(dom) {
          return { start: dom.hasAttribute('start') ? +dom.getAttribute('start') : 1 };
        },
      },
    ],
    toDOM(node) {
      return node.attrs.start === 1 ? ['ol', 0] : ['ol', { start: node.attrs.start }, 0];
    },
  },

  listItem: {
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM() {
      return ['li', 0];
    },
  },

  taskList: {
    content: 'taskItem+',
    group: 'block',
    parseDOM: [{ tag: 'ul[data-type="taskList"]' }],
    toDOM() {
      return ['ul', { 'data-type': 'taskList' }, 0];
    },
  },

  taskItem: {
    attrs: { checked: { default: false } },
    content: 'paragraph block*',
    defining: true,
    parseDOM: [
      {
        tag: 'li[data-type="taskItem"]',
        getAttrs(dom) {
          return { checked: dom.getAttribute('data-checked') === 'true' };
        },
      },
    ],
    toDOM(node) {
      return ['li', { 'data-type': 'taskItem', 'data-checked': String(node.attrs.checked) }, 0];
    },
  },

  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM() {
      return ['blockquote', 0];
    },
  },

  codeBlock: {
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM() {
      return ['pre', ['code', 0]];
    },
  },

  mermaid: {
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    isolating: true,
    parseDOM: [{ tag: 'pre[data-type="mermaid"]', preserveWhitespace: 'full' }],
    toDOM() {
      return ['pre', { 'data-type': 'mermaid' }, ['code', 0]];
    },
  },

  svg: {
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    isolating: true,
    parseDOM: [{ tag: 'pre[data-type="svg"]', preserveWhitespace: 'full' }],
    toDOM() {
      return ['pre', { 'data-type': 'svg' }, ['code', 0]];
    },
  },

  hardBreak: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM() {
      return ['br'];
    },
  },

  horizontalRule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM() {
      return ['hr'];
    },
  },

  image: {
    group: 'block',
    atom: true,
    draggable: true,
    attrs: {
      src: {},
      alt: { default: null },
      title: { default: null },
      width: { default: null },
    },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs(dom) {
          return {
            src: dom.getAttribute('src'),
            alt: dom.getAttribute('alt'),
            title: dom.getAttribute('title'),
            width: dom.getAttribute('width') ? parseInt(dom.getAttribute('width'), 10) : null,
          };
        },
      },
    ],
    toDOM(node) {
      const { src, alt, title, width } = node.attrs;
      const attrs = { src };
      if (alt) attrs.alt = alt;
      if (title) attrs.title = title;
      if (width) attrs.width = width;
      return ['img', attrs];
    },
  },

  table: {
    content: 'tableRow+',
    tableRole: 'table',
    isolating: true,
    group: 'block',
    parseDOM: [{ tag: 'table' }],
    toDOM() {
      return ['table', ['tbody', 0]];
    },
  },

  tableRow: {
    content: '(tableCell | tableHeader)*',
    tableRole: 'row',
    parseDOM: [{ tag: 'tr' }],
    toDOM() {
      return ['tr', 0];
    },
  },

  tableCell: {
    content: 'block+',
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
    },
    tableRole: 'cell',
    isolating: true,
    parseDOM: [
      {
        tag: 'td',
        getAttrs(dom) {
          return {
            colspan: dom.getAttribute('colspan') ? parseInt(dom.getAttribute('colspan'), 10) : 1,
            rowspan: dom.getAttribute('rowspan') ? parseInt(dom.getAttribute('rowspan'), 10) : 1,
            colwidth: dom.getAttribute('colwidth')
              ? dom
                  .getAttribute('colwidth')
                  .split(',')
                  .map((w) => parseInt(w, 10))
              : null,
          };
        },
      },
    ],
    toDOM(node) {
      const { colspan, rowspan, colwidth } = node.attrs;
      const attrs = {};
      if (colspan !== 1) attrs.colspan = colspan;
      if (rowspan !== 1) attrs.rowspan = rowspan;
      if (colwidth) attrs.colwidth = colwidth.join(',');
      return ['td', attrs, 0];
    },
  },

  tableHeader: {
    content: 'block+',
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
    },
    tableRole: 'header_cell',
    isolating: true,
    parseDOM: [
      {
        tag: 'th',
        getAttrs(dom) {
          return {
            colspan: dom.getAttribute('colspan') ? parseInt(dom.getAttribute('colspan'), 10) : 1,
            rowspan: dom.getAttribute('rowspan') ? parseInt(dom.getAttribute('rowspan'), 10) : 1,
            colwidth: dom.getAttribute('colwidth')
              ? dom
                  .getAttribute('colwidth')
                  .split(',')
                  .map((w) => parseInt(w, 10))
              : null,
          };
        },
      },
    ],
    toDOM(node) {
      const { colspan, rowspan, colwidth } = node.attrs;
      const attrs = {};
      if (colspan !== 1) attrs.colspan = colspan;
      if (rowspan !== 1) attrs.rowspan = rowspan;
      if (colwidth) attrs.colwidth = colwidth.join(',');
      return ['th', attrs, 0];
    },
  },
};

const marks = {
  bold: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (node) => node.style.fontWeight !== 'normal' && null },
      { style: 'font-weight', getAttrs: (value) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null },
    ],
    toDOM() {
      return ['strong', 0];
    },
  },

  italic: {
    parseDOM: [
      { tag: 'em' },
      { tag: 'i', getAttrs: (node) => node.style.fontStyle !== 'normal' && null },
      { style: 'font-style=italic' },
    ],
    toDOM() {
      return ['em', 0];
    },
  },

  strike: {
    parseDOM: [
      { tag: 's' },
      { tag: 'del' },
      { tag: 'strike' },
      { style: 'text-decoration', getAttrs: (value) => value === 'line-through' && null },
    ],
    toDOM() {
      return ['s', 0];
    },
  },

  underline: {
    parseDOM: [
      { tag: 'u' },
      { style: 'text-decoration', getAttrs: (value) => value === 'underline' && null },
    ],
    toDOM() {
      return ['u', 0];
    },
  },

  code: {
    parseDOM: [{ tag: 'code' }],
    toDOM() {
      return ['code', 0];
    },
  },

  link: {
    attrs: {
      href: {},
      target: { default: null },
      rel: { default: null },
      class: { default: null },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs(dom) {
          return {
            href: dom.getAttribute('href'),
            target: dom.getAttribute('target'),
            rel: dom.getAttribute('rel'),
            class: dom.getAttribute('class'),
          };
        },
      },
    ],
    toDOM(node) {
      const { href, target, rel, class: className } = node.attrs;
      const attrs = { href };
      if (target) attrs.target = target;
      if (rel) attrs.rel = rel;
      if (className) attrs.class = className;
      return ['a', attrs, 0];
    },
  },

  highlight: {
    parseDOM: [{ tag: 'mark' }],
    toDOM() {
      return ['mark', 0];
    },
  },

  subscript: {
    excludes: 'superscript',
    parseDOM: [{ tag: 'sub' }],
    toDOM() {
      return ['sub', 0];
    },
  },

  superscript: {
    excludes: 'subscript',
    parseDOM: [{ tag: 'sup' }],
    toDOM() {
      return ['sup', 0];
    },
  },

  diffInsert: {
    parseDOM: [{ tag: 'ins' }],
    toDOM() {
      return ['ins', 0];
    },
  },

  diffDelete: {
    parseDOM: [{ tag: 'del' }],
    toDOM() {
      return ['del', 0];
    },
  },

  // Word-level (Tier 2) diff marks — produced ONLY by the diff service
  // (server/diff/apply-word-marks.js). No input rule or editing path creates
  // them (feature 022, FR-009); their presence must not alter live-document
  // behavior. Rendered/parsed as <ins class="diff-word"> / <del class="diff-word">.
  diffInsertWord: {
    parseDOM: [{ tag: 'ins.diff-word' }],
    toDOM() {
      return ['ins', { class: 'diff-word' }, 0];
    },
  },

  diffDeleteWord: {
    parseDOM: [{ tag: 'del.diff-word' }],
    toDOM() {
      return ['del', { class: 'diff-word' }, 0];
    },
  },

  textStyle: {
    attrs: {
      color: { default: null },
      backgroundColor: { default: null },
      fontSize: { default: null },
      fontFamily: { default: null },
      lineHeight: { default: null },
    },
    parseDOM: [
      {
        tag: 'span',
        getAttrs(dom) {
          return {
            color: dom.style.color || null,
            backgroundColor: dom.style.backgroundColor || null,
            fontSize: dom.style.fontSize || null,
            fontFamily: dom.style.fontFamily || null,
            lineHeight: dom.style.lineHeight || null,
          };
        },
      },
    ],
    toDOM(node) {
      const { color, backgroundColor, fontSize, fontFamily, lineHeight } = node.attrs;
      const style = {};
      if (color) style.color = color;
      if (backgroundColor) style.backgroundColor = backgroundColor;
      if (fontSize) style.fontSize = fontSize;
      if (fontFamily) style.fontFamily = fontFamily;
      if (lineHeight) style.lineHeight = lineHeight;

      return ['span', { style: Object.keys(style).length ? style : null }, 0];
    },
  },
};

const schema = new Schema({ nodes, marks });

module.exports = {
  schema,
  nodes,
  marks,
};
