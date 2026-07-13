/**
 * fromMarkdown sandbox helper tests (feature 002, US3 / T027).
 *
 * Two layers:
 *  1. IN-ISOLATE (real bundle): drives executeSandboxed with the rebuilt
 *     isolate-bundle.js, proving fromMarkdown bundles, runs synchronously,
 *     and streams its mutations exactly like cloneBlocks output.
 *  2. BUILDER CONTRACT: exercises buildFromMarkdown directly (identical code
 *     to the in-isolate binding, just with plain Y constructors) for the
 *     fine-grained node-shape assertions — empty/malformed handling, link
 *     sanitation, data: rejection, external-image tagging.
 */
const Y = require('yjs');
const { executeSandboxed } = require('../executor');
const { buildFromMarkdown, IMPORT_ORIGIN_ATTR } = require('../from-markdown');
const { toMarkdown } = require('../../yjs/serialization');

function createSnapshot(setupFn) {
  const ydoc = new Y.Doc();
  const fragment = ydoc.get('default', Y.XmlFragment);
  if (setupFn) setupFn(fragment);
  return Y.encodeStateAsUpdate(ydoc);
}

function runScript(snapshot, jsCode, timeout = 5000) {
  const batches = [];
  const result = executeSandboxed(jsCode, snapshot, timeout, (ops, update) =>
    batches.push(new Uint8Array(update))
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(snapshot));
  for (const update of batches) Y.applyUpdate(doc, update);
  return { result, fragment: doc.get('default', Y.XmlFragment), batchCount: batches.length };
}

describe('fromMarkdown in the real isolate (bundled)', () => {
  test('converts markdown and streams the insert like any mutation', () => {
    const snapshot = createSnapshot((fragment) => {
      const h = new Y.XmlElement('heading');
      h.setAttribute('level', 1);
      const t = new Y.XmlText();
      t.insert(0, 'Existing');
      h.insert(0, [t]);
      fragment.insert(0, [h]);
    });

    const jsCode = `
      exports.default = function(doc) {
        const nodes = fromMarkdown("## Notes\\n\\n- item **bold**");
        doc.insert(doc.length, nodes);
      };
    `;
    const { result, fragment, batchCount } = runScript(snapshot, jsCode);
    expect(result.operationCount).toBeGreaterThan(0);
    expect(batchCount).toBeGreaterThan(0); // mutations streamed

    const md = toMarkdown(fragment);
    expect(md).toContain('# Existing');
    expect(md).toContain('## Notes');
    expect(md).toContain('**bold**');
    const names = fragment.toArray().map((n) => n.nodeName);
    expect(names).toEqual(['heading', 'heading', 'bulletList']);
  });

  test('output is insertable exactly like cloneBlocks (appendBlocks positioning)', () => {
    const snapshot = createSnapshot((fragment) => {
      const h = new Y.XmlElement('heading');
      h.setAttribute('level', 2);
      const t = new Y.XmlText();
      t.insert(0, 'Anchor');
      h.insert(0, [t]);
      fragment.insert(0, [h]);
    });
    const jsCode = `
      exports.default = function(doc) {
        const nodes = fromMarkdown("Inserted paragraph.");
        const anchor = xpathFirst('//heading[@level=2]');
        const idx = doc.toArray().indexOf(anchor) + 1;
        doc.insert(idx, nodes);
      };
    `;
    const { fragment } = runScript(snapshot, jsCode);
    const md = toMarkdown(fragment);
    expect(md).toMatch(/## Anchor\s+Inserted paragraph\./);
  });

  test('empty and whitespace-only markdown insert nothing', () => {
    const snapshot = createSnapshot();
    const jsCode = `
      exports.default = function(doc) {
        const a = fromMarkdown("");
        const b = fromMarkdown("   \\n\\t ");
        if (a.length !== 0 || b.length !== 0) throw new Error('expected empty arrays');
        doc.insert(0, [...a, ...b]);
      };
    `;
    const { fragment } = runScript(snapshot, jsCode);
    expect(fragment.length).toBe(0);
  });

  test('dangerous link hrefs are dropped in the isolate; text kept', () => {
    const snapshot = createSnapshot();
    const jsCode = `
      exports.default = function(doc) {
        doc.insert(0, fromMarkdown("[x](javascript:alert(1)) and [ok](https://ok.com)"));
      };
    `;
    const { fragment } = runScript(snapshot, jsCode);
    const md = toMarkdown(fragment);
    expect(md).toContain('x and');
    expect(md).not.toContain('javascript:');
    expect(md).toContain('[ok](https://ok.com)');
  });
});

describe('buildFromMarkdown builder contract (plain constructors)', () => {
  const fromMarkdown = buildFromMarkdown({ XmlElement: Y.XmlElement, XmlText: Y.XmlText });

  // Attributes on detached nodes read back only after integration into a doc.
  function integrate(nodes) {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => fragment.insert(0, nodes));
    return fragment;
  }

  test('empty / whitespace-only / non-string ⇒ []', () => {
    expect(fromMarkdown('')).toEqual([]);
    expect(fromMarkdown('   \n\t ')).toEqual([]);
    expect(fromMarkdown(null)).toEqual([]);
    expect(fromMarkdown(undefined)).toEqual([]);
  });

  test('rich markdown becomes the corresponding blocks', () => {
    const nodes = fromMarkdown('# Title\n\npara\n\n- a\n- b');
    const fragment = integrate(nodes);
    expect(fragment.toArray().map((n) => n.nodeName)).toEqual(['heading', 'paragraph', 'bulletList']);
  });

  test('malformed / unstructurable input never throws — worst case literal paragraphs', () => {
    // Footnote syntax has no grammar; the parser keeps the text (never-lose).
    const nodes = fromMarkdown('A claim.[^1]\n\n[^1]: the note body');
    const fragment = integrate(nodes);
    const md = toMarkdown(fragment);
    expect(md).toContain('A claim.');
    expect(md).toContain('the note body');
    expect(nodes.length).toBeGreaterThan(0);
  });

  test('dangerous link hrefs dropped, text kept; allowed survive', () => {
    const nodes = fromMarkdown('[bad](vbscript:x) [good](https://g.com) [mail](mailto:a@b.c)');
    const md = toMarkdown(integrate(nodes));
    expect(md).toContain('bad');
    expect(md).not.toContain('vbscript:');
    expect(md).toContain('[good](https://g.com)');
    expect(md).toContain('[mail](mailto:a@b.c)');
  });

  test('data: images never present in the returned nodes', () => {
    const nodes = fromMarkdown('![pixel](data:image/png;base64,AAAA)\n\n![empty](data:image/gif;base64,BBBB)');
    const fragment = integrate(nodes);
    const md = toMarkdown(fragment);
    expect(md).not.toContain('data:');
    // Alt-bearing data: image degraded to its alt text.
    expect(md).toContain('pixel');
  });

  test('external image nodes survive and are tagged for the host rehost pass', () => {
    const nodes = fromMarkdown('![diagram](https://cdn.example.com/d.png)');
    const fragment = integrate(nodes);
    const img = fragment.toArray().find((n) => n.nodeName === 'image');
    expect(img).toBeDefined();
    expect(img.getAttribute('src')).toBe('https://cdn.example.com/d.png');
    expect(img.getAttribute(IMPORT_ORIGIN_ATTR)).toBe('1');
  });

  test('app-URL images are NOT tagged (host handles them via reconciliation)', () => {
    const nodes = fromMarkdown('![existing](/api/docs/d1/images/i1)');
    const fragment = integrate(nodes);
    const img = fragment.toArray().find((n) => n.nodeName === 'image');
    expect(img.getAttribute('src')).toBe('/api/docs/d1/images/i1');
    expect(img.getAttribute(IMPORT_ORIGIN_ATTR)).toBeUndefined();
  });

  test('formatting and marks survive materialization', () => {
    const nodes = fromMarkdown('text with **bold**, _italic_, `code`, and ~~strike~~');
    const md = toMarkdown(integrate(nodes));
    expect(md).toContain('**bold**');
    expect(md).toContain('_italic_');
    expect(md).toContain('`code`');
    expect(md).toContain('~~strike~~');
  });
});
