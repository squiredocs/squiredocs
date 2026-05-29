import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import { Fragment } from '@tiptap/pm/model';
import MermaidNodeView from '../components/MermaidNodeView.jsx';

const PLACEHOLDER = 'graph TD\n  A[Start] --> B[End]';

// Prefix used on the <img alt> attribute to encode the mermaid source so it
// can survive a paste round-trip through targets (Google Docs etc.) that
// sanitize unknown attributes. The marker is unlikely to collide with real
// alt text, and the suffix is URL-encoded so newlines/special chars survive
// HTML-attribute serialization.
const ALT_SOURCE_PREFIX = '[mermaid-src]';

function encodeMermaidSourceForAlt(source) {
  return `${ALT_SOURCE_PREFIX}${encodeURIComponent(source)}`;
}

function decodeMermaidSourceFromAlt(altText) {
  if (!altText || !altText.startsWith(ALT_SOURCE_PREFIX)) return null;
  try {
    return decodeURIComponent(altText.slice(ALT_SOURCE_PREFIX.length));
  } catch {
    return null;
  }
}

// Replace each mermaid <pre> in PM's clipboard HTML with the rendered
// diagram (PNG when ready, inline SVG fallback). The mermaid source is
// stamped onto the <img> as data-mermaid-source so pasting back into a
// Squire doc can reconstruct the node even if PM's slice metadata is
// stripped by a hop through Google Docs etc. For Squire→Squire paste in
// the same session, PM's slice metadata (carried on the wrapper that
// view.serializeForClipboard adds) takes priority and bypasses parseHTML
// entirely.
function buildEnrichedClipboardOutput(view, from, to) {
  const slice = view.state.doc.slice(from, to);
  const serialized = view.serializeForClipboard(slice);
  const root = serialized.dom;

  const pres = root.querySelectorAll('pre[data-type="mermaid"]');
  if (pres.length === 0) return null;

  let i = 0;
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== 'mermaid') return;
    const target = pres[i++];
    if (!target) return;
    const dom = view.nodeDOM(pos);
    const preview = dom && dom.querySelector ? dom.querySelector('.mermaid-preview') : null;
    if (!preview) return;

    // Extract the source from the live node (target's text content matches,
    // but reading directly from the PM node is more reliable).
    const source = node.textContent || '';

    const encodedAlt = encodeMermaidSourceForAlt(source);
    const pngUrl = preview.dataset.pngUrl;
    if (pngUrl) {
      const img = document.createElement('img');
      img.src = pngUrl;
      // alt carries the source for round-trips through HTML sanitizers
      // (Google Docs etc.) that strip data-* attributes.
      img.alt = encodedAlt;
      img.setAttribute('data-mermaid-source', source);
      const w = preview.dataset.svgWidth;
      const h = preview.dataset.svgHeight;
      if (w) img.setAttribute('width', w);
      if (h) img.setAttribute('height', h);
      target.replaceWith(img);
      return;
    }
    const svg = preview.querySelector('svg');
    if (svg) {
      const clone = svg.cloneNode(true);
      const vb = clone.viewBox && clone.viewBox.baseVal;
      if (vb && vb.width && !clone.getAttribute('width')) {
        clone.setAttribute('width', String(vb.width));
        clone.setAttribute('height', String(vb.height));
      }
      clone.removeAttribute('style');
      clone.setAttribute('data-mermaid-source', source);
      clone.setAttribute('aria-label', encodedAlt);
      target.replaceWith(clone);
    }
  });

  return { html: root.outerHTML, text: serialized.text };
}

function handleClipboardEvent(view, event) {
  if (!event.clipboardData) return false;
  const { from, to, empty } = view.state.selection;
  if (empty) return false;
  const output = buildEnrichedClipboardOutput(view, from, to);
  if (output === null) return false; // no mermaid in selection — default behavior
  event.clipboardData.setData('text/html', output.html);
  event.clipboardData.setData('text/plain', output.text);
  event.preventDefault();
  return true;
}

export const MermaidNode = Node.create({
  name: 'mermaid',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  isolating: true,

  parseHTML() {
    const fragmentFromSource = (schema, source) => {
      const trimmed = (source || '').trim();
      if (!trimmed) return null;
      return Fragment.from(schema.text(trimmed));
    };
    const fromDataAttr = (domNode, schema) =>
      fragmentFromSource(schema, domNode.getAttribute('data-mermaid-source'));
    const fromAltAttr = (domNode, schema) =>
      fragmentFromSource(
        schema,
        decodeMermaidSourceFromAlt(
          domNode.getAttribute('alt') || domNode.getAttribute('aria-label'),
        ),
      );

    return [
      { tag: 'pre[data-type="mermaid"]', preserveWhitespace: 'full' },
      // Round-trip fallbacks for pasted clipboard HTML.
      // Same-session/Squire-to-Squire: PM's slice metadata bypasses parseHTML.
      // Through HTML-preserving targets (Notion, etc.): data-mermaid-source.
      // Through HTML-sanitizing targets (Google Docs): the alt prefix.
      {
        tag: 'img[data-mermaid-source]',
        getContent: fromDataAttr,
      },
      {
        tag: 'svg[data-mermaid-source]',
        getContent: fromDataAttr,
      },
      {
        tag: `img[alt^="${ALT_SOURCE_PREFIX}"]`,
        getContent: fromAltAttr,
      },
    ];
  },

  renderHTML() {
    return ['pre', { 'data-type': 'mermaid' }, ['code', 0]];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidNodeView);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            copy: handleClipboardEvent,
            cut: handleClipboardEvent,
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      insertMermaid:
        (source = PLACEHOLDER) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContent({
              type: this.name,
              content: source ? [{ type: 'text', text: source }] : [],
            })
            .run(),
    };
  },
});

export default MermaidNode;
