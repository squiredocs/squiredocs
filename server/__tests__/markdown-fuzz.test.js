/**
 * Fuzz / property suite for the never-lose-content invariant (feature 001,
 * T017, TR-003 / SC-003 / SC-006).
 *
 * Five generator families feed a single oracle (research R6):
 *   1. no throw
 *   2. schema.nodeFromJSON(result).check() passes (schema validity)
 *   3. ordered word-subsequence preservation (entities decoded outside code)
 *   4. non-empty text for any letter/digit-bearing input
 *
 * Deterministic: fixed seed + numRuns in the low thousands per property. Timing
 * guards are deliberately generous (they catch catastrophic blowup, not small
 * perf regressions) per the plan's note U1 — no tight wall-clock assertions.
 */

const fc = require('fast-check');
const { markdownToPm } = require('../../shared/markdown');
const { schema } = require('../../shared/prosemirror-schema');
const { decodeEntities } = require('../../shared/markdown/tolerant/entities');

const SEED = 0x5eed01;
const NUM_RUNS = 500; // × 5 families ≈ 2500 inputs/run (SC-003 "thousands")

// --- oracle ----------------------------------------------------------------

/**
 * Extract every piece of user content from the output — text nodes plus content
 * legitimately consumed into attributes (code-fence language, link href, image
 * src/alt). FR-013 preserves content; it does not require that content stay in
 * the *visible* text stream (a URL lives in href, a language in an attr).
 */
function allText(node) {
  let s = node.type === 'text' ? node.text : '';
  if (node.attrs) {
    for (const k of ['language', 'href', 'src', 'alt', 'title']) {
      if (typeof node.attrs[k] === 'string') s += ` ${node.attrs[k]}`;
    }
  }
  if (node.marks) {
    for (const m of node.marks) {
      if (m.attrs && typeof m.attrs.href === 'string') s += ` ${m.attrs.href}`;
    }
  }
  if (node.content) for (const c of node.content) s += ` ${allText(c)}`;
  return s;
}

const WORD_RE = /[\p{L}\p{N}]+/gu;
function words(s) {
  return s.match(WORD_RE) || [];
}

/** Decode entities everywhere EXCEPT inside code spans / fenced code, whose
 *  content the parser preserves verbatim (research R6). */
function decodeEntitiesOutsideCode(s) {
  const parts = s.split(/(```[\s\S]*?```|```[\s\S]*$|`[^`]*`)/g);
  let out = '';
  for (const part of parts) {
    if (part && part[0] === '`') out += part;
    else out += decodeEntities(part || '');
  }
  return out;
}

/** Assert `expected` is an ordered subsequence of `actual`. */
function isSubsequence(expected, actual) {
  let i = 0;
  for (const w of actual) {
    if (i < expected.length && expected[i] === w) i++;
  }
  return i === expected.length;
}

function checkOracle(input) {
  const s = String(input);
  let result;
  // (1) never throws
  result = markdownToPm(s); // may throw → fast-check reports
  // (2) schema validity
  schema.nodeFromJSON(result).check();
  // (3) word-subsequence preservation. HTML tags (whitelist or unknown) are
  // legitimately consumed into marks/nodes or re-emitted as literal text, so
  // strip tag syntax from the expectation (research R6: whitelist tags are
  // consumable syntax). Unknown tags that survive as literal text only ADD
  // words to `actual`, so the subsequence direction stays sound.
  const normalized = s.replace(/\r\n?/g, '\n');
  const withoutSyntax = decodeEntitiesOutsideCode(normalized)
    .replace(/<[^>]*>/g, ' ') // consumed/echoed HTML tags
    // leading block markers (heading #, bullet -/*/+, ordered N./N), quote >)
    // are legitimately consumed into structure — e.g. an ordered marker's digit
    // is metadata, not content. Stripping only shrinks `expected`, so the
    // subsequence property stays sound.
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d{1,9}[.)]|>)+[ \t]*/gm, ' ');
  const expected = words(withoutSyntax);
  const actual = words(allText(result));
  if (!isSubsequence(expected, actual)) {
    throw new Error(
      `content lost:\n  input=${JSON.stringify(s).slice(0, 200)}\n  expected=${JSON.stringify(expected).slice(0, 200)}\n  actual=${JSON.stringify(actual).slice(0, 200)}`
    );
  }
  // (4) non-empty text for letter/digit-bearing input
  if (expected.length > 0 && actual.length === 0) {
    throw new Error(`empty output for non-empty input ${JSON.stringify(s).slice(0, 120)}`);
  }
  return true;
}

// --- generator families ----------------------------------------------------

// 1. Random unicode text.
const randomUnicode = fc.string({ unit: 'binary', maxLength: 400 });

// 2. Mutated canonical markdown.
const MD_POOL = [
  '# Heading\n\nA **bold** and *italic* paragraph.',
  '- item one\n- item two\n  - nested\n\n1. first\n2. second',
  '> a quote\n> continues\n\n---\n\n`code` and [link](https://x.com)',
  '```js\nconst x = 1;\n```\n\n    indented code',
  '| a | b |\n| --- | --- |\n| c | d |',
  'Setext\n======\n\n- [ ] todo\n- [x] done',
  '<u>u</u> <mark>m</mark> <span style="color:#333">s</span> a<br>b',
  'entities &amp; &#65; &nbsp; &copy; autolink <https://e.com> www.e.com',
  'escapes \\*x\\* and hard break  \n next line',
];
const mutatedMarkdown = fc
  .tuple(
    fc.constantFrom(...MD_POOL),
    fc.array(fc.tuple(fc.nat(), fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })), { maxLength: 12 })
  )
  .map(([base, edits]) => {
    let chars = [...base];
    for (const [pos, ch] of edits) {
      const idx = chars.length ? pos % (chars.length + 1) : 0;
      if (idx % 2 === 0) chars.splice(idx, 0, ch);
      else chars.splice(idx % Math.max(chars.length, 1), 1);
    }
    return chars.join('');
  });

// 3. Truncated constructs.
const TRUNC_POOL = [
  '```js\nconst x = 1;\nmore code without a close',
  '<span style="color:#333">unterminated span content',
  '<u>open <mark>nested still open',
  '| a | b | c |\n| --- | ---',
  '> quote\n> more\n> ',
  '- item\n  - nested\n    - deeper\n      - deepest',
  '[link text without a url](',
  '**bold *italic without',
];
const truncated = fc
  .tuple(fc.constantFrom(...TRUNC_POOL), fc.nat())
  .map(([base, cut]) => base.slice(0, base.length ? cut % (base.length + 1) : 0));

// 4. Adversarial HTML.
const htmlTag = fc.constantFrom(
  '<script>alert(1)</script>', '<div>', '</div>', '<img src=x onerror=y>',
  '<!-- comment -->', '<custom-tag attr="v">', '<span style="x">', '</span>',
  '<u>', '</u>', '<br>', '<svg><rect/></svg>', '<a href="javascript:void(0)">x</a>',
  '<STYLE>body{}</STYLE>', '<iframe src="//evil">', '<'
);
const adversarialHtml = fc
  .array(fc.oneof(htmlTag, fc.constantFrom('text ', 'more\n', '**x** ', 'word ')), { maxLength: 30 })
  .map((parts) => parts.join(''));

// 5. Pathological nesting / delimiter floods.
const floodChar = fc.constantFrom('*', '_', '~', '`', '[', ']', '>', '#', '-', '<u>');
const pathological = fc
  .tuple(floodChar, fc.integer({ min: 1, max: 2000 }), fc.constantFrom('', 'word', ' '))
  .map(([ch, k, tail]) => ch.repeat(k) + tail);

// --- property tests --------------------------------------------------------

describe('fuzz: never-lose-content (FR-013, TR-003)', () => {
  const families = {
    'random unicode': randomUnicode,
    'mutated canonical markdown': mutatedMarkdown,
    'truncated constructs': truncated,
    'adversarial HTML': adversarialHtml,
    'pathological nesting / delimiter floods': pathological,
  };

  for (const [name, arb] of Object.entries(families)) {
    test(`${name} — oracle holds across ${NUM_RUNS} inputs`, () => {
      fc.assert(
        fc.property(arb, (s) => checkOracle(s)),
        { numRuns: NUM_RUNS, seed: SEED }
      );
    });
  }
});

// --- performance guards (SC-006, generous per U1) --------------------------

describe('performance guards (SC-006)', () => {
  test('~100 KB representative document parses well under the budget', () => {
    const block = '# Section\n\nA paragraph with **bold**, *italic*, `code`, and a [link](https://example.com).\n\n- one\n- two\n  - nested\n\n> a quote\n\n```js\nconst x = 1;\n```\n\n| a | b |\n| --- | --- |\n| c | d |\n\n';
    let doc = '';
    while (doc.length < 100 * 1024) doc += block;
    const t0 = Date.now();
    const result = markdownToPm(doc);
    const ms = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[SC-006] 100 KB parse: ${ms} ms (${doc.length} bytes)`);
    expect(result.type).toBe('doc');
    expect(ms).toBeLessThan(5000); // generous; SC-006 target is < 1 s
  });

  test('64 KB pathological inputs each finish well under 5 s', () => {
    const floods = [
      '*'.repeat(64 * 1024),
      '_'.repeat(64 * 1024),
      '`'.repeat(64 * 1024),
      '['.repeat(64 * 1024),
      '<u>'.repeat(20000),
      ('- '.repeat(1) + 'x\n').repeat(2000),
      '#'.repeat(64 * 1024),
    ];
    let worst = 0;
    for (const f of floods) {
      const t0 = Date.now();
      const result = markdownToPm(f);
      const ms = Date.now() - t0;
      worst = Math.max(worst, ms);
      expect(result.type).toBe('doc');
      expect(ms).toBeLessThan(5000);
    }
    // eslint-disable-next-line no-console
    console.log(`[SC-006] worst pathological 64 KB case: ${worst} ms`);
  });
});
