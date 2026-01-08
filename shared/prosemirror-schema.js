/**
 * Shared ProseMirror schema definition.
 *
 * This schema matches the TipTap editor configuration used in the client:
 * - StarterKit (doc, paragraph, text, heading, bulletList, orderedList, listItem,
 *   blockquote, codeBlock, code, hardBreak, horizontalRule, bold, italic, strike)
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
};

const schema = new Schema({ nodes, marks });

module.exports = {
  schema,
  nodes,
  marks,
};
