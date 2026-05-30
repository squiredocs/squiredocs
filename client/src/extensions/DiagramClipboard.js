import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import {
  PREVIEW_CLASS,
  PREVIEW_DATASET,
  encodeSourceForAlt,
  prepareSvgForExport,
} from './diagramShared';

// One copy/cut handler shared by every diagram block type. Registering this
// once (rather than per node) matters: ProseMirror runs handleDOMEvents.copy
// handlers until one returns true, so a per-node plugin would preventDefault on
// the first diagram type and starve the rest in a mixed selection.
//
// Default ProseMirror copy serializes a diagram block as <pre><code>source
// </code></pre>, so pasting into Google Docs/Notion gives source text, not the
// rendered diagram. For every diagram node in the selection we swap that <pre>
// for an <img> carrying the pre-rasterized PNG (falling back to inline SVG),
// and stamp the source onto the <img> (data-<name>-source for HTML-preserving
// targets, alt prefix for sanitizing ones) so a paste back reconstructs the
// node. Squire→Squire paste in the same session uses PM's slice metadata and
// bypasses parseHTML entirely.

function diagramNamesFromEditor(editor) {
  const names = new Set();
  for (const ext of editor.extensionManager.extensions) {
    if (ext.options && ext.options.diagramConfig) {
      names.add(ext.options.diagramConfig.name);
    }
  }
  return names;
}

export function buildEnrichedClipboardOutput(view, from, to, diagramNames) {
  const slice = view.state.doc.slice(from, to);
  const serialized = view.serializeForClipboard(slice);
  const root = serialized.dom;

  // Snapshot the <pre> list for each diagram type ONCE, up front. We replace
  // <pre> elements with <img>/<svg> as we walk, which detaches them from the
  // tree — re-querying inside the loop would make the positional index drift
  // as the list shrinks, pairing later diagrams with the wrong <pre> (or none).
  // A static array captured before any replacement keeps the Nth diagram node
  // of a type aligned with the Nth <pre> of that type.
  const presByName = new Map();
  for (const name of diagramNames) {
    presByName.set(
      name,
      Array.from(root.querySelectorAll(`pre[data-type="${name}"]`)),
    );
  }

  // Per-type counter so each pre[data-type=X] pairs with the Nth live node of
  // that same type — robust for selections mixing multiple diagram types.
  const counters = new Map();
  let replaced = 0;

  view.state.doc.nodesBetween(from, to, (node, pos) => {
    const name = node.type.name;
    if (!diagramNames.has(name)) return;

    const index = counters.get(name) || 0;
    counters.set(name, index + 1);

    const target = presByName.get(name)[index];
    if (!target) return;

    const dom = view.nodeDOM(pos);
    const preview =
      dom && dom.querySelector ? dom.querySelector(`.${PREVIEW_CLASS}`) : null;
    if (!preview) return;

    // Read the source from the live PM node (more reliable than the serialized
    // text content).
    const source = node.textContent || '';
    const encodedAlt = encodeSourceForAlt(name, source);

    const pngUrl = preview.dataset[PREVIEW_DATASET.pngUrl];
    if (pngUrl) {
      const img = document.createElement('img');
      img.src = pngUrl;
      // alt carries the source for round-trips through HTML sanitizers
      // (Google Docs etc.) that strip data-* attributes.
      img.alt = encodedAlt;
      img.setAttribute(`data-${name}-source`, source);
      const w = preview.dataset[PREVIEW_DATASET.svgWidth];
      const h = preview.dataset[PREVIEW_DATASET.svgHeight];
      if (w) img.setAttribute('width', w);
      if (h) img.setAttribute('height', h);
      target.replaceWith(img);
      replaced++;
      return;
    }

    const svg = preview.querySelector('svg');
    if (svg) {
      const clone = svg.cloneNode(true);
      prepareSvgForExport(clone);
      clone.setAttribute(`data-${name}-source`, source);
      clone.setAttribute('aria-label', encodedAlt);
      target.replaceWith(clone);
      replaced++;
    }
  });

  if (replaced === 0) return null;
  return { html: root.outerHTML, text: serialized.text };
}

export const DiagramClipboard = Extension.create({
  name: 'diagramClipboard',

  addProseMirrorPlugins() {
    const editor = this.editor;
    const handle = (view, event) => {
      if (!event.clipboardData) return false;
      const { from, to, empty } = view.state.selection;
      if (empty) return false;
      const diagramNames = diagramNamesFromEditor(editor);
      if (diagramNames.size === 0) return false;
      const output = buildEnrichedClipboardOutput(view, from, to, diagramNames);
      if (output === null) return false; // no diagram in selection — default behavior
      event.clipboardData.setData('text/html', output.html);
      event.clipboardData.setData('text/plain', output.text);
      event.preventDefault();
      return true;
    };

    return [
      new Plugin({
        props: {
          handleDOMEvents: { copy: handle, cut: handle },
        },
      }),
    ];
  },
});

export default DiagramClipboard;
