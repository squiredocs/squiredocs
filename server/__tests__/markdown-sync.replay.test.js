/**
 * Markdown-sync engine unit tests (feature 004).
 *
 * Phase 2 (T004/T005): offset resolver, synthetic clientID determinism,
 * canonicalization. Phase 3 (T006/T007/T008 + T017): hunk classification and
 * replay are appended in later describe blocks.
 */
const Y = require('yjs');
const { toMarkdownWithSourceMap } = require('../mcp/yjs/serialization');
const {
  resolveMd,
  classifyRange,
  syntheticClientId,
  canonicalizePushed,
} = require('../markdown-sync');

function el(tag, text, attrs) {
  const e = new Y.XmlElement(tag);
  if (text !== undefined) {
    const t = new Y.XmlText();
    t.insert(0, text, attrs);
    e.insert(0, [t]);
  }
  return e;
}
function build(fn) {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  doc.transact(() => fn(frag));
  const { markdown, sourceMap } = toMarkdownWithSourceMap(frag.toArray());
  return { doc, frag, markdown, sourceMap };
}

// ---------------------------------------------------------------------------
describe('offset resolver (T004, research R2)', () => {
  test('resolveMd: text char → node+offset; syntax char → structure', () => {
    const { doc, markdown, sourceMap } = build((f) => {
      const h = el('heading', 'Hello'); h.setAttribute('level', '2');
      f.insert(0, [h]);
    });
    expect(markdown).toBe('## Hello');
    // '#' at 0 is syntax
    expect(resolveMd(sourceMap, 0).kind).toBe('syntax');
    // 'H' at 3 is text, offset 0 into the heading text node
    const r = resolveMd(sourceMap, 3);
    expect(r.kind).toBe('text');
    expect(r.textOff).toBe(0);
    // 'e' at 4 → offset 1
    expect(resolveMd(sourceMap, 4).textOff).toBe(1);
    doc.destroy();
  });

  test('classifyRange: intra-paragraph range is a text hunk of one block', () => {
    const { doc, markdown, sourceMap } = build((f) => {
      f.insert(0, [el('paragraph', 'the quick brown fox')]);
    });
    const s = markdown.indexOf('quick');
    const cls = classifyRange(sourceMap, s, s + 5);
    expect(cls.kind).toBe('text');
    expect(cls.segments).toHaveLength(1);
    expect(cls.segments[0].textOff).toBe(s); // no syntax before it in a bare paragraph
    expect(cls.segments[0].length).toBe(5);
    doc.destroy();
  });

  test('classifyRange: range spanning a heading marker is structural', () => {
    const { doc, markdown, sourceMap } = build((f) => {
      const h = el('heading', 'Title'); h.setAttribute('level', '1');
      f.insert(0, [h]);
    });
    // range covering '# T' includes the syntax '#'
    const cls = classifyRange(sourceMap, 0, 3);
    expect(cls.kind).toBe('structural');
    doc.destroy();
  });

  test('classifyRange: range crossing two blocks is structural', () => {
    const { doc, markdown, sourceMap } = build((f) => {
      f.insert(0, [el('paragraph', 'aaa'), el('paragraph', 'bbb')]);
    });
    // whole doc "aaa\n\nbbb"
    const cls = classifyRange(sourceMap, 1, markdown.length - 1);
    expect(cls.kind).toBe('structural');
    expect(cls.blocks.length).toBe(2);
    doc.destroy();
  });

  test('classifyRange: insertion point inside a run resolves to text', () => {
    const { doc, markdown, sourceMap } = build((f) => {
      f.insert(0, [el('paragraph', 'abcdef')]);
    });
    const cls = classifyRange(sourceMap, 3, 3);
    expect(cls.kind).toBe('text');
    expect(cls.segments[0].length).toBe(0);
    expect(cls.segments[0].textOff).toBe(3);
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
describe('synthetic clientID + determinism (T005, research R4)', () => {
  test('deterministic over (doc, clock, content); 31-bit; never 0', () => {
    const a = syntheticClientId('doc-1', 5, 'hashA');
    const b = syntheticClientId('doc-1', 5, 'hashA');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(0x80000000); // bit 31 cleared
    // different content → different identity
    expect(syntheticClientId('doc-1', 5, 'hashB')).not.toBe(a);
    // different baseline → different identity
    expect(syntheticClientId('doc-1', 6, 'hashA')).not.toBe(a);
  });

  test('pinned clientID → identical pushUpdate bytes across replays (FR-011)', () => {
    // Baseline built ONCE with fixed structs (mirrors getYDocAtClock replaying
    // the same persisted updates in fixed clock order); each replay forks from
    // the identical baseline bytes, so left-origin references are stable.
    const base = new Y.Doc();
    base.transact(() => base.getXmlFragment('default').insert(0, [el('paragraph', 'seed')]));
    const baseUpdate = Y.encodeStateAsUpdate(base);
    const baselineSV = Y.encodeStateVector(base);
    base.destroy();

    function replayOnce() {
      const fork = new Y.Doc();
      Y.applyUpdate(fork, baseUpdate);
      fork.clientID = syntheticClientId('doc-1', 3, 'abc'); // pin BEFORE any new op
      fork.transact(() => {
        const p = fork.getXmlFragment('default').get(0);
        p.get(0).insert(4, ' more');
      });
      const update = Y.encodeStateAsUpdate(fork, baselineSV);
      fork.destroy();
      return Buffer.from(update).toString('hex');
    }
    expect(replayOnce()).toBe(replayOnce()); // byte-identical
  });
});

// ---------------------------------------------------------------------------
describe('canonicalizePushed (T005, FR-005/FR-009)', () => {
  test('formatting-equivalent inputs collapse to the same canonical string', () => {
    const a = canonicalizePushed('# Title\n\nHello **world**');
    // extra blank lines + trailing spaces canonicalize away
    const b = canonicalizePushed('# Title\n\n\nHello **world**   ');
    expect(a).toBe(b);
  });

  test('a genuine text change produces a different canonical string', () => {
    const a = canonicalizePushed('Hello world');
    const b = canonicalizePushed('Hello there');
    expect(a).not.toBe(b);
  });

  test('canonical form is stable under re-canonicalization (round-trip)', () => {
    const once = canonicalizePushed('- one\n- two\n\n> quote');
    expect(canonicalizePushed(once)).toBe(once);
  });
});
