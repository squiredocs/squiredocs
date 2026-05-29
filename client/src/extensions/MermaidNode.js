import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import { DOMSerializer } from '@tiptap/pm/model';
import MermaidNodeView from '../components/MermaidNodeView.jsx';

const PLACEHOLDER = 'graph TD\n  A[Start] --> B[End]';

// Replace each mermaid <pre> in PM's default clipboard HTML with the live
// rendered diagram (PNG from the node view's dataset, or inline SVG as a
// fallback), so pasting into Google Docs / Notion / etc. yields an image
// instead of source code.
function buildEnrichedClipboardHtml(view, from, to) {
  const { state } = view;
  const slice = state.doc.slice(from, to);
  const serializer = DOMSerializer.fromSchema(state.schema);
  const root = document.createElement('div');
  root.appendChild(serializer.serializeFragment(slice.content, { document }));

  const pres = root.querySelectorAll('pre[data-type="mermaid"]');
  if (pres.length === 0) return null;

  let i = 0;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== 'mermaid') return;
    const target = pres[i++];
    if (!target) return;
    const dom = view.nodeDOM(pos);
    const preview = dom && dom.querySelector ? dom.querySelector('.mermaid-preview') : null;
    if (!preview) return;
    const pngUrl = preview.dataset.pngUrl;
    if (pngUrl) {
      const img = document.createElement('img');
      img.src = pngUrl;
      img.alt = 'Mermaid diagram';
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
      target.replaceWith(clone);
    }
  });

  return root.innerHTML;
}

function handleClipboardEvent(view, event) {
  if (!event.clipboardData) return false;
  const { from, to, empty } = view.state.selection;
  if (empty) return false;
  const html = buildEnrichedClipboardHtml(view, from, to);
  if (html === null) return false; // no mermaid in selection — default behavior
  const text = view.state.doc.textBetween(from, to, '\n\n', '\n');
  event.clipboardData.setData('text/html', html);
  event.clipboardData.setData('text/plain', text);
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
    return [
      { tag: 'pre[data-type="mermaid"]', preserveWhitespace: 'full' },
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
