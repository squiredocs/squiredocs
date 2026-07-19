/**
 * Feature 018 US1 — structure-aware chunker unit tests (T007) and the
 * serialization-shape fixture pin (T008).
 *
 * chunkStructured(nodes, opts) is pure JSON-in/JSON-out: fixtures are
 * hand-built structured nodes matching toStructured()'s output shape.
 * Determinism (FR-006/SC-001) is byte-identical output on repeat runs.
 */
const Y = require('yjs');
const { toStructured } = require('../mcp/yjs/serialization');
const {
  chunkStructured,
  flattenBlocks,
  structuredText,
  splitLongText,
  trailingOverlap,
  estimateTokens,
  CHARS_PER_TOKEN,
} = require('../search/chunker');

const h = (level, text) => ({ type: 'heading', level, content: text });
const p = (text) => ({ type: 'paragraph', content: text });

/** n sentences of exactly 43 chars: "This is sentence number 01 in the section." */
function sentences(n, tag = 'section') {
  return Array.from({ length: n }, (_, i) =>
    `This is sentence number ${String(i + 1).padStart(2, '0')} in the ${tag}.`
  ).join(' ');
}

describe('chunkStructured (T007)', () => {
  test('(a) heading-boundary splits carry the h1→…→hN trail (SC-002)', () => {
    const nodes = [
      h(1, 'Operations Runbook'),
      p(sentences(4, 'runbook intro')),
      h(2, 'Deployment'),
      p(sentences(4, 'deploy body')),
      h(3, 'Rollback Procedure'),
      p(sentences(4, 'rollback body')),
    ];
    // charTarget 240: each heading+section pair fits one chunk; every heading
    // arrives with the chunk ≥ half-full, so each forces a boundary.
    const chunks = chunkStructured(nodes, { targetTokens: 60, overlapRatio: 0 });
    expect(chunks.length).toBe(3);
    expect(chunks[0].headingPath).toEqual(['Operations Runbook']);
    expect(chunks[1].headingPath).toEqual(['Operations Runbook', 'Deployment']);
    expect(chunks[2].headingPath).toEqual(['Operations Runbook', 'Deployment', 'Rollback Procedure']);
    // No chunk crosses a heading boundary: each section's body stays in its chunk
    expect(chunks[0].text).toContain('runbook intro');
    expect(chunks[0].text).not.toContain('deploy body');
    expect(chunks[1].text).toContain('deploy body');
    expect(chunks[1].text).not.toContain('rollback body');
    expect(chunks[2].text).toContain('rollback body');
    // Ordinals are 0-based positions
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
  });

  test('(a2) sibling headings pop the stack (h2 after h2, h1 resets)', () => {
    const nodes = [
      h(1, 'Root'),
      h(2, 'First'),
      p(sentences(4, 'first body')),
      h(2, 'Second'),
      p(sentences(4, 'second body')),
      h(1, 'NewRoot'),
      p(sentences(4, 'newroot body')),
    ];
    const chunks = chunkStructured(nodes, { targetTokens: 50, overlapRatio: 0 });
    const paths = chunks.map((c) => c.headingPath);
    // Chunk 1 STARTS at the h1 'Root' block (trail-at-start, FR-002); the
    // sibling h2 'Second' pops 'First'; the later h1 resets the stack.
    expect(paths).toEqual([['Root'], ['Root', 'Second'], ['NewRoot']]);
    expect(paths).not.toContainEqual(['Root', 'First', 'Second']);
  });

  test('(b) oversize single section splits at sentence boundaries, shared trail (FR-003)', () => {
    const nodes = [h(1, 'Big Section'), p(sentences(12, 'section'))];
    const chunks = chunkStructured(nodes, { targetTokens: 50, overlapRatio: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.headingPath).toEqual(['Big Section']);
      // sentence-boundary splits: every chunk ends at a sentence end
      expect(chunk.text).toMatch(/[.!?]$/);
    }
    // All 12 sentences survive, none duplicated (overlap off)
    const joined = chunks.map((c) => c.text).join(' ');
    for (let i = 1; i <= 12; i++) {
      const needle = `sentence number ${String(i).padStart(2, '0')}`;
      expect(joined.split(needle).length - 1).toBe(1);
    }
  });

  test('(c) tiny sections pack together; heading flushes only at fill ratio (FR-004)', () => {
    const tiny = [];
    for (let i = 1; i <= 6; i++) {
      tiny.push(h(2, `Tiny ${i}`));
      tiny.push(p(`Small body ${i}.`));
    }
    // Large target: everything fits well under the 50% fill line → ONE chunk
    const packed = chunkStructured(tiny, { targetTokens: 150, overlapRatio: 0 });
    expect(packed.length).toBe(1);
    expect(packed[0].headingPath).toEqual(['Tiny 1']);
    // Near-zero fill ratio: every heading (after content) forces a flush
    const fragmented = chunkStructured(tiny, { targetTokens: 150, headingFillRatio: 0.001, overlapRatio: 0 });
    expect(fragmented.length).toBe(6);
  });

  test('(d) short doc → exactly one chunk (FR-005)', () => {
    const chunks = chunkStructured([h(1, 'Note'), p('Just one small paragraph.')], { targetTokens: 600 });
    expect(chunks.length).toBe(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].headingPath).toEqual(['Note']);
    expect(chunks[0].tokenEstimate).toBe(estimateTokens(chunks[0].text));
  });

  test('(e) unheaded doc chunks by size at sentence boundaries with empty trails (US1-5)', () => {
    const nodes = [p(sentences(6, 'alpha')), p(sentences(6, 'beta'))];
    const chunks = chunkStructured(nodes, { targetTokens: 50, overlapRatio: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.headingPath).toEqual([]);
    }
  });

  test('(f) pathological unbroken text → bounded hard splits, terminates (edge case)', () => {
    const charTarget = 50 * CHARS_PER_TOKEN;
    const nodes = [p('x'.repeat(5000))];
    const chunks = chunkStructured(nodes, { targetTokens: 50, overlapRatio: 0.12 });
    expect(chunks.length).toBe(Math.ceil(5000 / charTarget));
    const overlapBudget = Math.floor(charTarget * 0.12);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(charTarget + overlapBudget + 1);
    }
  });

  test('(g) determinism: identical input + config → byte-identical chunk sets (FR-006/SC-001)', () => {
    const nodes = [
      h(1, 'Doc'),
      p(sentences(8, 'one')),
      h(2, 'Sub'),
      p(sentences(8, 'two')),
      p('x'.repeat(700)),
    ];
    const a = chunkStructured(nodes, { targetTokens: 60 });
    const b = chunkStructured(nodes, { targetTokens: 60 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('(h) overlap is deterministic trailing sentences, bounded, never materially past target (FR-007)', () => {
    const tail = 'Short tail here.';
    const para1 = `${sentences(4, 'first part')} ${tail}`;
    const para2 = sentences(4, 'second part');
    const nodes = [p(para1), p(para2)];
    const target = 60; // charTarget 240; para1 ~192 chars → its own chunk
    const charTarget = target * CHARS_PER_TOKEN;
    const overlapBudget = Math.floor(charTarget * 0.12);

    const withOverlap = chunkStructured(nodes, { targetTokens: target, overlapRatio: 0.12 });
    expect(withOverlap.length).toBe(2);
    // Chunk 1 starts with the trailing sentence(s) of chunk 0's raw text
    expect(withOverlap[1].text.startsWith(tail)).toBe(true);
    const overlapSegment = withOverlap[1].text.slice(0, withOverlap[1].text.indexOf('\n'));
    expect(overlapSegment.length).toBeLessThanOrEqual(overlapBudget);
    expect(withOverlap[1].text.length).toBeLessThanOrEqual(charTarget + overlapBudget + 1);

    // overlapRatio 0 → no prepended overlap
    const noOverlap = chunkStructured(nodes, { targetTokens: target, overlapRatio: 0 });
    expect(noOverlap.length).toBe(2);
    expect(noOverlap[1].text.startsWith(tail)).toBe(false);
    expect(noOverlap[1].text.startsWith('This is sentence number 01 in the second part.')).toBe(true);
  });

  test('(i) knob sweep: every knob combination stays deterministic and bounded (RBD-1)', () => {
    const nodes = [
      h(1, 'Sweep Doc'),
      p(sentences(10, 'body one')),
      h(2, 'Middle'),
      p(sentences(10, 'body two')),
      p('y'.repeat(1200)),
    ];
    for (const targetTokens of [50, 150, 600]) {
      for (const headingFillRatio of [0.3, 0.5, 0.9]) {
        for (const overlapRatio of [0, 0.12, 0.2]) {
          const opts = { targetTokens, headingFillRatio, overlapRatio };
          const a = chunkStructured(nodes, opts);
          const b = chunkStructured(nodes, opts);
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
          const charTarget = targetTokens * CHARS_PER_TOKEN;
          const budget = Math.floor(charTarget * overlapRatio);
          for (const chunk of a) {
            expect(chunk.text.length).toBeLessThanOrEqual(charTarget + budget + 1);
            expect(chunk.tokenEstimate).toBe(Math.ceil(chunk.text.length / CHARS_PER_TOKEN));
          }
        }
      }
    }
  });

  test('empty and text-free inputs produce zero chunks', () => {
    expect(chunkStructured([], {})).toEqual([]);
    expect(chunkStructured(null, {})).toEqual([]);
    expect(chunkStructured([{ type: 'horizontalRule' }], {})).toEqual([]);
  });

  test('helper: splitLongText hard-splits only sentence-less runs', () => {
    expect(splitLongText('short one. short two.', 200)).toEqual(['short one. short two.']);
    const pieces = splitLongText('z'.repeat(450), 200);
    expect(pieces).toEqual(['z'.repeat(200), 'z'.repeat(200), 'z'.repeat(50)]);
  });

  test('helper: trailingOverlap never exceeds its budget', () => {
    expect(trailingOverlap('First one. Second two.', 12).length).toBeLessThanOrEqual(12);
    expect(trailingOverlap('nopunctuation'.repeat(10), 20).length).toBe(20);
    expect(trailingOverlap('anything', 0)).toBe('');
  });
});

// ————————————————————————————————————————————————————————————————————————
// T008 — serialization-shape pin: a real Yjs doc through toStructured() →
// chunkStructured() (plan D11). Serializer drift must break loudly here.
// ————————————————————————————————————————————————————————————————————————
describe('toStructured → chunkStructured fixture (T008)', () => {
  function buildDoc() {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => {
      const el = (tag, text) => {
        const e = new Y.XmlElement(tag);
        const t = new Y.XmlText();
        t.insert(0, text);
        e.insert(0, [t]);
        return e;
      };
      const h1 = el('heading', 'Field Guide');
      h1.setAttribute('level', '1');
      const h2 = el('heading', 'Habitats');
      h2.setAttribute('level', '2');

      const list = new Y.XmlElement('bulletList');
      const li = (text) => {
        const item = new Y.XmlElement('listItem');
        item.insert(0, [el('paragraph', text)]);
        return item;
      };
      list.insert(0, [li('coastal dunes'), li('inland scrub')]);

      const table = new Y.XmlElement('table');
      const rowEl = (...cells) => {
        const r = new Y.XmlElement('tableRow');
        r.insert(0, cells.map((text) => {
          const c = new Y.XmlElement('tableCell');
          c.insert(0, [el('paragraph', text)]);
          return c;
        }));
        return r;
      };
      table.insert(0, [rowEl('region', 'count'), rowEl('rottnest', 'many')]);

      const code = el('codeBlock', 'const marsupial = true;');
      code.setAttribute('language', 'js');

      const image = new Y.XmlElement('image');
      image.setAttribute('src', 'https://example.com/quokka.png');
      image.setAttribute('alt', 'a quokka');

      fragment.insert(0, [
        h1,
        el('paragraph', 'An overview of quokka field observations.'),
        h2,
        el('paragraph', 'Quokkas favour dense vegetation.'),
        list,
        table,
        code,
        image,
      ]);
    });
    return fragment;
  }

  test('pins the consumed node shape and chunks a real document', () => {
    const nodes = toStructured(buildDoc());

    // Shape pin (plan D11): headings expose a NUMERIC level and string content
    expect(nodes[0].type).toBe('heading');
    expect(nodes[0].level).toBe(1);
    expect(typeof nodes[0].content).toBe('string');
    expect(nodes[0].content).toBe('Field Guide');
    expect(nodes[2].type).toBe('heading');
    expect(nodes[2].level).toBe(2);

    const chunks = chunkStructured(nodes, { targetTokens: 600 });
    expect(chunks.length).toBe(1);
    const text = chunks[0].text;
    expect(chunks[0].headingPath).toEqual(['Field Guide']);
    expect(text).toContain('An overview of quokka field observations.');
    expect(text).toContain('Quokkas favour dense vegetation.');
    expect(text).toContain('coastal dunes'); // list items
    expect(text).toContain('inland scrub');
    expect(text).toContain('rottnest'); // table cell content
    expect(text).toContain('const marsupial = true;'); // code block

    // Heading trail applies once sections force splits
    const small = chunkStructured(nodes, { targetTokens: 20, overlapRatio: 0 });
    expect(small.length).toBeGreaterThan(1);
    const lastPaths = small[small.length - 1].headingPath;
    expect(lastPaths).toEqual(['Field Guide', 'Habitats']);
  });

  test('flattenBlocks/structuredText handle table-cell simplified content and void nodes', () => {
    const nodes = toStructured(buildDoc());
    const blocks = flattenBlocks(nodes);
    // The image is a void node with no text → contributes no block
    expect(blocks.some((b) => (b.text || '').includes('example.com/quokka.png'))).toBe(false);
    // structuredText joins nested children with newlines
    const tableNode = nodes.find((n) => n.type === 'table');
    const tableText = structuredText(tableNode);
    expect(tableText).toContain('region');
    expect(tableText).toContain('many');
  });
});
