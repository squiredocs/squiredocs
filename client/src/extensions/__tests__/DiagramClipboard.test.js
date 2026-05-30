import { describe, it, expect } from 'vitest';
import { buildEnrichedClipboardOutput } from '../DiagramClipboard';
import { PREVIEW_CLASS, PREVIEW_DATASET, altSourcePrefix } from '../diagramShared';

// Build a fake ProseMirror `view` over an ordered list of blocks. Each block is
// either { text } (plain text node) or { name, source, png } (a diagram node
// whose live NodeView DOM carries a .diagram-preview with the given PNG data).
//
// The fake mirrors the slice of `view`'s surface that buildEnrichedClipboardOutput
// touches: serializeForClipboard (which renders each diagram as the same
// <pre data-type=name><code>…</code></pre> the real renderHTML emits), nodesBetween,
// and nodeDOM.
function makeView(blocks) {
  // Serialized clipboard DOM: one element per block, diagrams as <pre>.
  const root = document.createElement('div');
  const liveDom = []; // index-aligned with blocks: the "rendered" NodeView DOM
  blocks.forEach((b) => {
    if (b.name) {
      const pre = document.createElement('pre');
      pre.setAttribute('data-type', b.name);
      const code = document.createElement('code');
      code.textContent = b.source;
      pre.appendChild(code);
      root.appendChild(pre);

      // Live NodeView DOM with a preview carrying the rasterized PNG.
      const wrapper = document.createElement('div');
      const preview = document.createElement('div');
      preview.className = PREVIEW_CLASS;
      if (b.png) preview.dataset[PREVIEW_DATASET.pngUrl] = b.png;
      wrapper.appendChild(preview);
      liveDom.push(wrapper);
    } else {
      const p = document.createElement('p');
      p.textContent = b.text;
      root.appendChild(p);
      liveDom.push(null);
    }
  });

  return {
    state: {
      selection: { from: 0, to: blocks.length, empty: false },
      doc: {
        slice: () => ({}),
        nodesBetween: (_from, _to, cb) => {
          blocks.forEach((b, i) => {
            if (!b.name) return;
            cb({ type: { name: b.name }, textContent: b.source }, i);
          });
        },
      },
    },
    serializeForClipboard: () => ({ dom: root, text: 'plain' }),
    nodeDOM: (pos) => liveDom[pos],
  };
}

function imagesInOrder(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return Array.from(div.querySelectorAll('img, pre')).map((el) =>
    el.tagName === 'IMG'
      ? { kind: 'img', src: el.getAttribute('src') }
      : { kind: 'pre', source: el.textContent },
  );
}

describe('buildEnrichedClipboardOutput pairing', () => {
  it('pairs each diagram with its OWN image (regression: no index drift)', () => {
    // Four graphviz diagrams, each with a distinct PNG. The bug replaced <pre>
    // elements with a per-iteration querySelectorAll, so removed <pre>s made the
    // positional index drift and later diagrams got the wrong (or no) image.
    const blocks = [
      { name: 'graphviz', source: 'A', png: 'data:img-A' },
      { name: 'graphviz', source: 'B', png: 'data:img-B' },
      { name: 'graphviz', source: 'C', png: 'data:img-C' },
      { name: 'graphviz', source: 'D', png: 'data:img-D' },
    ];
    const view = makeView(blocks);
    const out = buildEnrichedClipboardOutput(view, 0, 4, new Set(['graphviz']));
    const seq = imagesInOrder(out.html);

    expect(seq).toEqual([
      { kind: 'img', src: 'data:img-A' },
      { kind: 'img', src: 'data:img-B' },
      { kind: 'img', src: 'data:img-C' },
      { kind: 'img', src: 'data:img-D' },
    ]);
  });

  it('keeps pairing when a middle diagram has no PNG (its <pre> stays as source)', () => {
    const blocks = [
      { name: 'graphviz', source: 'A', png: 'data:img-A' },
      { name: 'graphviz', source: 'B' }, // no png, no svg → left as source
      { name: 'graphviz', source: 'C', png: 'data:img-C' },
    ];
    const view = makeView(blocks);
    const out = buildEnrichedClipboardOutput(view, 0, 3, new Set(['graphviz']));
    const seq = imagesInOrder(out.html);

    expect(seq).toEqual([
      { kind: 'img', src: 'data:img-A' },
      { kind: 'pre', source: 'B' },
      { kind: 'img', src: 'data:img-C' }, // C still gets C, not B
    ]);
  });

  it('keeps per-type pairing for mixed mermaid + graphviz selections', () => {
    const blocks = [
      { name: 'graphviz', source: 'G0', png: 'data:gv-0' },
      { name: 'mermaid', source: 'M0', png: 'data:mm-0' },
      { name: 'graphviz', source: 'G1', png: 'data:gv-1' },
      { name: 'mermaid', source: 'M1', png: 'data:mm-1' },
    ];
    const view = makeView(blocks);
    const out = buildEnrichedClipboardOutput(
      view,
      0,
      4,
      new Set(['graphviz', 'mermaid']),
    );
    const seq = imagesInOrder(out.html);

    expect(seq).toEqual([
      { kind: 'img', src: 'data:gv-0' },
      { kind: 'img', src: 'data:mm-0' },
      { kind: 'img', src: 'data:gv-1' },
      { kind: 'img', src: 'data:mm-1' },
    ]);
  });

  it('drops the embedded source when it is too large for an alt attribute', () => {
    // Google Docs rejects the sync when an image alt is too long, so an
    // oversized source is not embedded — the image still pastes, just without
    // round-trip metadata.
    const big = 'digraph {\n' + 'A -> B;\n'.repeat(400) + '}';
    const blocks = [{ name: 'graphviz', source: big, png: 'data:img-big' }];
    const view = makeView(blocks);
    const out = buildEnrichedClipboardOutput(view, 0, 1, new Set(['graphviz']));

    const div = document.createElement('div');
    div.innerHTML = out.html;
    const img = div.querySelector('img');
    expect(img.getAttribute('src')).toBe('data:img-big');
    expect(img.getAttribute('data-graphviz-source')).toBe(null);
    expect(img.alt).toBe('graphviz diagram'); // short, sync-safe alt
  });

  it('stamps the matching source onto each image (alt + data-attr)', () => {
    const blocks = [
      { name: 'graphviz', source: 'digraph{A->B}', png: 'data:img-A' },
      { name: 'graphviz', source: 'digraph{C->D}', png: 'data:img-C' },
    ];
    const view = makeView(blocks);
    const out = buildEnrichedClipboardOutput(view, 0, 2, new Set(['graphviz']));

    const div = document.createElement('div');
    div.innerHTML = out.html;
    const imgs = div.querySelectorAll('img');
    expect(imgs[0].getAttribute('data-graphviz-source')).toBe('digraph{A->B}');
    expect(imgs[1].getAttribute('data-graphviz-source')).toBe('digraph{C->D}');
    expect(imgs[0].alt.startsWith(altSourcePrefix('graphviz'))).toBe(true);
    expect(decodeURIComponent(imgs[1].alt.slice(altSourcePrefix('graphviz').length)))
      .toBe('digraph{C->D}');
  });
});
