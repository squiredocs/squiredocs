/**
 * Strict-mode characterization snapshot (feature 001, CN-2 / TR-004).
 *
 * Pins the strict parser to a byte-identical baseline captured from the
 * pre-move parser by `fixtures/markdown/generate-strict-characterization.js`.
 * If any case here fails, strict mode has drifted — the diff engine's shipped
 * behavior (and the Redis diff cache keyed by CACHE_VERSION) would regress.
 *
 * Strict mode is selected via `{ strict: true }` against the relocated
 * shared entry `shared/markdown/index.js`.
 */

const cases = require('./fixtures/markdown/strict-characterization.json');
const { markdownToPm } = require('../../shared/markdown');

describe('strict-mode characterization snapshot (CN-2 byte-identity)', () => {
  for (const c of cases) {
    test(c.name, () => {
      const actual = markdownToPm(c.input, c.diffMark, { strict: true });
      expect(actual).toEqual(c.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// --- / fragment regression pins (TR-004, US3 AS-2) — T018
// ---------------------------------------------------------------------------

describe('--- and hunk-fragment disambiguation pins', () => {
  const blockTypes = (doc) => doc.content.map((b) => b.type);

  test('fragment ending in `paragraph\\n---`: HR in strict, setext H2 in tolerant', () => {
    const md = 'paragraph line\n---';
    // Strict (diff-engine fragment behavior): paragraph + horizontalRule.
    expect(blockTypes(markdownToPm(md, null, { strict: true }))).toEqual(['paragraph', 'horizontalRule']);
    // Tolerant (documented divergence): a `---` directly under a paragraph is a
    // setext H2 underline.
    const tolerant = markdownToPm(md, null);
    expect(tolerant.content).toHaveLength(1);
    expect(tolerant.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
  });

  test('canonical `paragraph\\n\\n---\\n`: paragraph + HR in BOTH modes', () => {
    const md = 'paragraph\n\n---\n';
    expect(blockTypes(markdownToPm(md, null, { strict: true }))).toEqual(['paragraph', 'horizontalRule']);
    expect(blockTypes(markdownToPm(md, null))).toEqual(['paragraph', 'horizontalRule']);
  });

  test('partial-list fragment keeps today\'s strict structure', () => {
    const strict = markdownToPm('- alpha\n- beta', null, { strict: true });
    expect(strict).toEqual({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'beta' }] }] },
        ],
      }],
    });
  });

  test('unclosed-fence fragment produces today\'s strict code block', () => {
    const strict = markdownToPm('```js\nconst x = 1;', null, { strict: true });
    expect(strict.content[0]).toMatchObject({ type: 'codeBlock', attrs: { language: 'js' } });
  });

  test('diff-service CACHE_VERSION is v8 — bumped for word-level diffs (feature 022)', () => {
    expect(require('../diff-service').CACHE_VERSION).toBe('v8');
  });
});
