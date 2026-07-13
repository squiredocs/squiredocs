/**
 * Import round-trip property (feature 002, T015 — FR-023 / SC-007).
 *
 * Direction 1 (doc-first): for representative Yjs documents, export with
 * toMarkdown and import into a fresh doc — the fresh doc must re-export
 * byte-identically (canonical serializer output is a fixed point).
 *
 * Direction 2 (markdown-first, corpus): importing arbitrary markdown
 * normalizes it once; after that first normalization the cycle
 * import → export → import → export must be stable (md'' === md'), with
 * equivalent plain text and block structure between the two imports.
 *
 * Allowed normalizations (documented per T015):
 *  - Title/heading rule: titles are metadata; the body keeps its heading
 *    (no body rewriting happens at the module level at all).
 *  - Task lists `- [ ]` degrade to bullet lists until feature 003's schema
 *    work (001 CN-3); the checkbox text is preserved.
 *  - Cells containing pipes split on every pipe (pre-existing dialect quirk,
 *    001 characterization).
 *  - External images degrade to plain links when rehosting is unavailable
 *    (the baseline pass in this branch until US4 wiring; then per policy).
 *  - Frontmatter is consumed: squire keys vanish, other keys become a
 *    leading yaml code block.
 *  - Hard breaks survive import structurally but the serializer emits
 *    nothing for them (pre-existing serializer behavior).
 */
const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const { toMarkdown, toPlainText } = require('../mcp/yjs/serialization');
const { prepareImport } = require('../markdown-import');

const REAL_WORLD = path.join(__dirname, 'fixtures', 'markdown', 'real-world');
const IMPORT_FIXTURES = path.join(__dirname, 'fixtures', 'import');

// prepareImport touches the DB only for cross-doc app-image URLs; none of the
// corpus files carry app URLs, so the property runs without a database.
async function importToFreshDoc(markdown, docId = 'roundtrip-doc') {
  const { nodes } = await prepareImport(markdown, { docId, userId: 'roundtrip-user' });
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  doc.transact(() => fragment.insert(0, nodes));
  return { doc, fragment };
}

function blockStructure(fragment) {
  return fragment.toArray().map((n) => n.nodeName);
}

function normalizedText(fragment) {
  return toPlainText(fragment).replace(/\s+/g, ' ').trim();
}

describe('round-trip property: export → import (doc-first, byte-stable)', () => {
  /** Build a Yjs doc, export, import into a fresh doc, compare exports. */
  async function assertDocRoundTrips(buildFn) {
    const src = new Y.Doc();
    const srcFragment = src.getXmlFragment('default');
    src.transact(() => buildFn(srcFragment));
    const exported = toMarkdown(srcFragment);
    const { fragment } = await importToFreshDoc(exported, 'doc-a');
    expect(toMarkdown(fragment)).toBe(exported);
    expect(blockStructure(fragment)).toEqual(blockStructure(srcFragment));
    src.destroy();
  }

  test('rich mixed document (headings, marks, lists, quote, rule, code)', async () => {
    await assertDocRoundTrips((fragment) => {
      const h = new Y.XmlElement('heading');
      h.setAttribute('level', 1);
      const ht = new Y.XmlText();
      ht.insert(0, 'Design Notes');
      h.insert(0, [ht]);

      const p = new Y.XmlElement('paragraph');
      const pt = new Y.XmlText();
      pt.insert(0, 'Plain ');
      pt.insert(6, 'bold', { bold: true });
      pt.insert(10, ' and ');
      pt.insert(15, 'linked', { link: { href: 'https://example.com/x' } });
      pt.insert(21, ' and ');
      pt.insert(26, 'styled', { textStyle: { color: '#ff0000' } });
      p.insert(0, [pt]);

      const list = new Y.XmlElement('bulletList');
      for (const item of ['alpha', 'beta']) {
        const li = new Y.XmlElement('listItem');
        const lip = new Y.XmlElement('paragraph');
        const lit = new Y.XmlText();
        lit.insert(0, item);
        lip.insert(0, [lit]);
        li.insert(0, [lip]);
        list.insert(list.length, [li]);
      }

      const quote = new Y.XmlElement('blockquote');
      const qp = new Y.XmlElement('paragraph');
      const qt = new Y.XmlText();
      qt.insert(0, 'quoted');
      qp.insert(0, [qt]);
      quote.insert(0, [qp]);

      const code = new Y.XmlElement('codeBlock');
      code.setAttribute('language', 'python');
      const ct = new Y.XmlText();
      ct.insert(0, 'print("hi")');
      code.insert(0, [ct]);

      fragment.insert(0, [h, p, list, quote, new Y.XmlElement('horizontalRule'), code]);
    });
  });

  test('diagram and table document', async () => {
    await assertDocRoundTrips((fragment) => {
      const mermaid = new Y.XmlElement('mermaid');
      const mt = new Y.XmlText();
      mt.insert(0, 'graph TD\n  A --> B\n  B --> C');
      mermaid.insert(0, [mt]);

      const table = new Y.XmlElement('table');
      const mkCell = (tag, text) => {
        const cell = new Y.XmlElement(tag);
        const para = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, text);
        para.insert(0, [t]);
        cell.insert(0, [para]);
        return cell;
      };
      const header = new Y.XmlElement('tableRow');
      header.insert(0, [mkCell('tableHeader', 'Name'), mkCell('tableHeader', 'Value')]);
      const row = new Y.XmlElement('tableRow');
      row.insert(0, [mkCell('tableCell', 'threshold'), mkCell('tableCell', '42')]);
      table.insert(0, [header, row]);

      fragment.insert(0, [mermaid, table]);
    });
  });

  test('document with a same-doc app image round-trips as an image node', async () => {
    const src = new Y.Doc();
    const srcFragment = src.getXmlFragment('default');
    src.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'before');
      p.insert(0, [t]);
      const img = new Y.XmlElement('image');
      img.setAttribute('src', '/api/docs/doc-a/images/img-1');
      img.setAttribute('alt', 'diagram');
      srcFragment.insert(0, [p, img]);
    });
    const exported = toMarkdown(srcFragment);
    expect(exported).toContain('![diagram](/api/docs/doc-a/images/img-1)');

    // Import with the SAME docId — the app URL is same-doc and stays intact.
    const { fragment } = await importToFreshDoc(exported, 'doc-a');
    expect(blockStructure(fragment)).toEqual(['paragraph', 'image']);
    expect(fragment.get(1).getAttribute('src')).toBe('/api/docs/doc-a/images/img-1');
    expect(toMarkdown(fragment)).toBe(exported);
    src.destroy();
  });
});

describe('round-trip property: import → export idempotence (markdown-first corpus)', () => {
  const corpus = [
    ...fs.readdirSync(REAL_WORLD).filter((f) => f.endsWith('.md')).map((f) => ({
      name: `real-world/${f}`,
      markdown: fs.readFileSync(path.join(REAL_WORLD, f), 'utf8'),
    })),
    ...['adr-sample.md', 'frontmatter-mixed.md', 'frontmatter-malformed.md', 'dangerous-links.md', 'unsupported-footnotes.md', 'crlf-bom.md'].map((f) => ({
      name: `import/${f}`,
      markdown: fs.readFileSync(path.join(IMPORT_FIXTURES, f), 'utf8'),
    })),
  ];

  for (const { name, markdown } of corpus) {
    test(`${name}: one normalization, then a fixed point`, async () => {
      const first = await importToFreshDoc(markdown);
      const mdPrime = toMarkdown(first.fragment);

      const second = await importToFreshDoc(mdPrime);
      const mdDoublePrime = toMarkdown(second.fragment);

      // Same plain text and same supported structure between the two imports…
      expect(normalizedText(second.fragment)).toBe(normalizedText(first.fragment));
      expect(blockStructure(second.fragment)).toEqual(blockStructure(first.fragment));
      // …and the export itself is a fixed point after the first import.
      expect(mdDoublePrime).toBe(mdPrime);

      first.doc.destroy();
      second.doc.destroy();
    });
  }
});
