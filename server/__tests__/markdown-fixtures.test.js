/**
 * CommonMark / GFM fixture conformance + real-world corpus (feature 001,
 * T014 + T015, TR-001 / SC-001 / SC-002).
 *
 * - Curated spec examples: parse → deep-equal the checked-in expected PM JSON.
 * - Real-world docs: assert the ordered block-type sequence + key attrs, and
 *   assert zero literal-text-paragraph degradations for in-grammar constructs.
 */

const fs = require('fs');
const path = require('path');
const { markdownToPm } = require('../../shared/markdown');
const { schema } = require('../../shared/prosemirror-schema');

const FIX = path.join(__dirname, 'fixtures/markdown');

// ---------------------------------------------------------------------------
// Curated CommonMark / GFM examples (SC-001)
// ---------------------------------------------------------------------------

function loadDir(rel) {
  const dir = path.join(FIX, rel);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const e of arr) out.push({ file: `${rel}/${f}`, ...e });
  }
  return out;
}

describe('curated CommonMark/GFM fixtures (SC-001)', () => {
  const examples = [...loadDir('commonmark'), ...loadDir('gfm')];

  test('fixture corpus is non-empty', () => {
    expect(examples.length).toBeGreaterThan(20);
  });

  for (const e of examples) {
    test(`${e.file} :: ${e.id}`, () => {
      const actual = markdownToPm(e.markdown);
      expect(actual).toEqual(e.expected);
      expect(() => schema.nodeFromJSON(actual).check()).not.toThrow();
    });
  }

  test('every covered-area exclusion carries a written reason (SC-001)', () => {
    const md = fs.readFileSync(path.join(FIX, 'EXCLUSIONS.md'), 'utf8');
    const rows = md.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-+/.test(l) && !/Area \|/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cols = row.split('|').map((c) => c.trim()).filter(Boolean);
      expect(cols.length).toBe(3); // Area | Excluded | Reason
      expect(cols[2].length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Real-world corpus (SC-002)
// ---------------------------------------------------------------------------

describe('real-world corpus (SC-002)', () => {
  const dir = path.join(FIX, 'real-world');
  const docs = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));

  test('at least 10 real-world documents present', () => {
    expect(docs.length).toBeGreaterThanOrEqual(10);
  });

  for (const doc of docs) {
    const name = doc.replace(/\.md$/, '');
    test(`${name} parses to the expected block structure`, () => {
      const md = fs.readFileSync(path.join(dir, doc), 'utf8');
      const expected = JSON.parse(fs.readFileSync(path.join(dir, `${name}.expected.json`), 'utf8'));
      const result = markdownToPm(md);

      // Structurally valid
      expect(() => schema.nodeFromJSON(result).check()).not.toThrow();

      // Ordered top-level block-type sequence matches
      const types = result.content.map((b) => b.type);
      expect(types).toEqual(expected.blocks.map((b) => (typeof b === 'string' ? b : b.type)));

      // Key attrs, where the expectation specifies them
      expected.blocks.forEach((b, idx) => {
        if (typeof b === 'object' && b.attrs) {
          expect(result.content[idx].attrs).toMatchObject(b.attrs);
        }
      });

      // No in-grammar construct silently degraded: the document deliberately
      // contains headings/lists/code/tables, so it must NOT be a flat pile of
      // paragraphs.
      const nonParagraph = types.filter((t) => t !== 'paragraph').length;
      expect(nonParagraph).toBeGreaterThan(0);
    });
  }
});
