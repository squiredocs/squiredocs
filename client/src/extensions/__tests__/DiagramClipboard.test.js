import { describe, it, expect } from 'vitest';
import {
  buildEnrichedClipboardOutput,
  chooseAltText,
} from '../DiagramClipboard';
import {
  PREVIEW_CLASS,
  PREVIEW_DATASET,
  altSourcePrefix,
  decodeSourceFromAlt,
} from '../diagramShared';

// Build the name→config map buildEnrichedClipboardOutput expects. Pass extras
// per type, e.g. cfgs({ mermaid: { droppedPlaceholder: 'graph TD; a-->b' } }).
function cfgs(spec) {
  const m = new Map();
  for (const [name, extra] of Object.entries(spec)) {
    m.set(name, { name, ...(extra || {}) });
  }
  return m;
}

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

describe('chooseAltText', () => {
  const big = 'graph TD\n' + 'A-->B\n'.repeat(400);

  it('returns the encoded real source when it fits the cap', () => {
    const alt = chooseAltText('mermaid', 'graph TD; A-->B', {});
    expect(decodeSourceFromAlt('mermaid', alt)).toBe('graph TD; A-->B');
  });

  it('falls back to the placeholder source when the real source is too big', () => {
    const placeholder = 'graph TD; dropped[lost]';
    const alt = chooseAltText('mermaid', big, { droppedPlaceholder: placeholder });
    expect(decodeSourceFromAlt('mermaid', alt)).toBe(placeholder);
    expect(alt.length).toBeLessThanOrEqual(1000);
  });

  it('uses a short label when too big and no placeholder is configured', () => {
    expect(chooseAltText('mermaid', big, {})).toBe('mermaid diagram');
  });
});

describe('buildEnrichedClipboardOutput pairing', () => {
  it('pairs each diagram with its OWN image (regression: no index drift)', () => {
    // Four mermaid diagrams, each with a distinct PNG. The bug replaced <pre>
    // elements with a per-iteration querySelectorAll, so removed <pre>s made the
    // positional index drift and later diagrams got the wrong (or no) image.
    const blocks = [
      { name: 'mermaid', source: 'A', png: 'data:img-A' },
      { name: 'mermaid', source: 'B', png: 'data:img-B' },
      { name: 'mermaid', source: 'C', png: 'data:img-C' },
      { name: 'mermaid', source: 'D', png: 'data:img-D' },
    ];
    const view = makeView(blocks);
    const out = buildEnrichedClipboardOutput(view, 0, 4, cfgs({ mermaid: {} }));
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
      { name: 'mermaid', source: 'A', png: 'data:img-A' },
      { name: 'mermaid', source: 'B' }, // no png, no svg → left as source
      { name: 'mermaid', source: 'C', png: 'data:img-C' },
    ];
    const view = makeView(blocks);
    const out = buildEnrichedClipboardOutput(view, 0, 3, cfgs({ mermaid: {} }));
    const seq = imagesInOrder(out.html);

    expect(seq).toEqual([
      { kind: 'img', src: 'data:img-A' },
      { kind: 'pre', source: 'B' },
      { kind: 'img', src: 'data:img-C' }, // C still gets C, not B
    ]);
  });

  it('uses a short alt for a large source when no placeholder is configured', () => {
    // Without a placeholder, an oversized source falls back to a short,
    // gdocs-sync-safe alt. data-<name>-source is still set (Google Docs strips
    // it anyway) so Squire→Squire / →Notion paste-back still works.
    const big = 'graph TD\n' + 'A-->B\n'.repeat(400);
    const blocks = [{ name: 'mermaid', source: big, png: 'data:img-big' }];
    const view = makeView(blocks);
    const out = buildEnrichedClipboardOutput(view, 0, 1, cfgs({ mermaid: {} }));

    const div = document.createElement('div');
    div.innerHTML = out.html;
    const img = div.querySelector('img');
    expect(img.getAttribute('src')).toBe('data:img-big');
    expect(img.alt).toBe('mermaid diagram'); // short, gdocs-sync-safe alt
    expect(img.getAttribute('data-mermaid-source')).toBe(big); // round-trip intact
  });

  it('embeds the placeholder source in alt for a large diagram (gdocs paste-back)', () => {
    // With a placeholder configured, an oversized source puts the *placeholder*
    // into the alt (small enough for gdocs). On paste-back from Google Docs —
    // where data-* is stripped — the alt rule decodes it into a visible
    // "source not preserved" diagram instead of a bare image. The full source
    // still rides on data-source for non-gdocs targets.
    const big = 'graph TD\n' + 'A-->B\n'.repeat(400);
    const placeholder = 'graph TD; dropped[source not preserved]';
    const blocks = [{ name: 'mermaid', source: big, png: 'data:img-big' }];
    const view = makeView(blocks);
    const out = buildEnrichedClipboardOutput(
      view,
      0,
      1,
      cfgs({ mermaid: { droppedPlaceholder: placeholder } }),
    );

    const div = document.createElement('div');
    div.innerHTML = out.html;
    const img = div.querySelector('img');
    // alt decodes (via the same [mermaid-src] rule) to the placeholder source
    expect(decodeSourceFromAlt('mermaid', img.alt)).toBe(placeholder);
    expect(img.alt.length).toBeLessThanOrEqual(1000); // safely under the gdocs cap
    expect(img.getAttribute('data-mermaid-source')).toBe(big); // full source intact
  });

  it('stamps the matching source onto each image (alt + data-attr)', () => {
    const blocks = [
      { name: 'mermaid', source: 'graph TD; A-->B', png: 'data:img-A' },
      { name: 'mermaid', source: 'graph TD; C-->D', png: 'data:img-C' },
    ];
    const view = makeView(blocks);
    const out = buildEnrichedClipboardOutput(view, 0, 2, cfgs({ mermaid: {} }));

    const div = document.createElement('div');
    div.innerHTML = out.html;
    const imgs = div.querySelectorAll('img');
    expect(imgs[0].getAttribute('data-mermaid-source')).toBe('graph TD; A-->B');
    expect(imgs[1].getAttribute('data-mermaid-source')).toBe('graph TD; C-->D');
    expect(imgs[0].alt.startsWith(altSourcePrefix('mermaid'))).toBe(true);
    expect(decodeURIComponent(imgs[1].alt.slice(altSourcePrefix('mermaid').length)))
      .toBe('graph TD; C-->D');
  });
});
