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

// Max length of the encoded source we'll embed in an image's alt attribute.
// Google Docs rejects the sync mutation when an image's alt/description is too
// long; keep well under that. Beyond this we use a short alt (the source still
// rides on data-<name>-source for non-Google-Docs paste-back).
const MAX_ROUNDTRIP_ALT = 1000;

// Decide what to put in a diagram image's alt attribute. The alt is the only
// round-trip channel that survives Google Docs' sanitizer (it strips data-*),
// but Google Docs also caps alt/description length and rejects the whole sync
// mutation ("Can't sync your changes…") when a large source exceeds it. So:
//   - the real encoded source if it fits the cap (full round-trip everywhere);
//   - else a small placeholder source, if the config supplies one — paste-back
//     from Google Docs then reconstructs a visible "source not preserved"
//     diagram (via the same [<name>-src] parse rule) instead of a bare image;
//   - else a short, sync-safe label with no round-trip.
// The full source still rides on data-<name>-source for HTML-preserving targets
// (Squire↔Squire, Notion), which wins by parse-rule order; so the placeholder
// only ever surfaces coming back through Google Docs.
export function chooseAltText(name, source, config) {
  const encoded = encodeSourceForAlt(name, source);
  if (encoded.length <= MAX_ROUNDTRIP_ALT) return encoded;
  const placeholder = config.droppedPlaceholder
    ? encodeSourceForAlt(name, config.droppedPlaceholder)
    : null;
  if (placeholder && placeholder.length <= MAX_ROUNDTRIP_ALT) return placeholder;
  return `${name} diagram`;
}

// Stamp the diagram source onto a clipboard element via both round-trip
// channels: data-<name>-source (HTML-preserving targets) and the alt/aria-label
// prefix (the Google-Docs-surviving channel; see chooseAltText).
function stampSource(el, { name, source, altAttr, altText }) {
  el.setAttribute(`data-${name}-source`, source);
  el.setAttribute(altAttr, altText);
}

function diagramConfigsFromEditor(editor) {
  const configs = new Map();
  for (const ext of editor.extensionManager.extensions) {
    if (ext.options && ext.options.diagramConfig) {
      configs.set(ext.options.diagramConfig.name, ext.options.diagramConfig);
    }
  }
  return configs;
}

export function buildEnrichedClipboardOutput(view, from, to, configs) {
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
  for (const name of configs.keys()) {
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
    if (!configs.has(name)) return;

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
    const altText = chooseAltText(name, source, configs.get(name));

    const pngUrl = preview.dataset[PREVIEW_DATASET.pngUrl];
    if (pngUrl) {
      const img = document.createElement('img');
      img.src = pngUrl;
      stampSource(img, { name, source, altAttr: 'alt', altText });
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
      stampSource(clone, { name, source, altAttr: 'aria-label', altText });
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
      const configs = diagramConfigsFromEditor(editor);
      if (configs.size === 0) return false;
      const output = buildEnrichedClipboardOutput(view, from, to, configs);
      if (output === null) return false; // no diagram in selection — default behavior
      event.clipboardData.setData('text/html', output.html);
      event.clipboardData.setData('text/plain', output.text);
      event.preventDefault();
      // Returning true here tells ProseMirror the event is fully handled, which
      // preempts its built-in cut handler. That built-in handler is what removes
      // the selected content after writing it to the clipboard — so for a cut we
      // must perform the deletion ourselves, or Cmd-X copies the content but
      // leaves the document untouched (the diagram-selection cut "does nothing"
      // bug). Mirror PM's own cut: deleteSelection + scrollIntoView + uiEvent.
      if (event.type === 'cut') {
        view.dispatch(
          view.state.tr
            .deleteSelection()
            .scrollIntoView()
            .setMeta('uiEvent', 'cut'),
        );
      }
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
