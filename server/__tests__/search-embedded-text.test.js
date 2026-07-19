/**
 * Feature 018 US1 — embedded-text composition (T009, DR-1/D3) and the
 * title-aware hash seam scope (T010, FR-015).
 *
 * Contract (contracts/chunk-record.md):
 *   header        = [title, ...headingPath].join(' > ')   // title ALWAYS leads
 *   embedded_text = header + '\n' + (preamble ? preamble + '\n\n' : '') + chunkText
 *   hash input    = title + '\n' + bodyText               // preambles NEVER included
 */
const { buildEmbeddedText } = require('../search/chunker');
const { buildEmbedHashInput, computeContentHash } = require('../search-indexer');

describe('buildEmbeddedText composition (T009, DR-1)', () => {
  test('header line leads: title > headingPath, then chunk text', () => {
    const out = buildEmbeddedText({
      title: 'Operations Runbook',
      headingPath: ['Deployment', 'Rollback Procedure'],
      preamble: '',
      chunkText: 'Run the rollback script.',
    });
    expect(out).toBe('Operations Runbook > Deployment > Rollback Procedure\nRun the rollback script.');
  });

  test('preamble is injected between header and chunk text with contract separators', () => {
    const out = buildEmbeddedText({
      title: 'Runbook',
      headingPath: ['Deploy'],
      preamble: 'This chunk covers rollback steps.',
      chunkText: 'Step one.',
    });
    expect(out).toBe('Runbook > Deploy\nThis chunk covers rollback steps.\n\nStep one.');
  });

  test('title ALWAYS leads — single-chunk and empty-trail docs too (DR-1)', () => {
    const out = buildEmbeddedText({
      title: 'Shopping List',
      headingPath: [],
      preamble: null,
      chunkText: 'milk and eggs',
    });
    expect(out).toBe('Shopping List\nmilk and eggs');
    // Empty title drops out of the header (review F5): no junk " > " prefix
    // in untitled docs' embedded text.
    const untitled = buildEmbeddedText({ title: '', headingPath: ['H1'], preamble: '', chunkText: 'body' });
    expect(untitled).toBe('H1\nbody');
    // Fully headerless (untitled, no trail): body only, no leading newline.
    const bare = buildEmbeddedText({ title: '', headingPath: [], preamble: '', chunkText: 'body' });
    expect(bare).toBe('body');
  });

  test('composition is pure and deterministic given fixed inputs (D13)', () => {
    const args = { title: 'T', headingPath: ['A', 'B'], preamble: 'P.', chunkText: 'C' };
    const a = buildEmbeddedText(args);
    const b = buildEmbeddedText({ ...args });
    expect(a).toBe(b);
    // Input object not mutated; chunkText arrives verbatim at the tail
    expect(args.chunkText).toBe('C');
    expect(a.endsWith('\n\nC')).toBe(true);
  });

  test('whitespace-only preamble is treated as absent', () => {
    const out = buildEmbeddedText({ title: 'T', headingPath: [], preamble: '   ', chunkText: 'body' });
    expect(out).toBe('T\nbody');
  });
});

describe('title-aware hash seam (T010, DR-1 corollary / FR-015)', () => {
  test('hash input is title + \\n + bodyText', () => {
    expect(buildEmbedHashInput('My Title', 'body text here')).toBe('My Title\nbody text here');
    expect(buildEmbedHashInput('', 'body only')).toBe('\nbody only');
    expect(buildEmbedHashInput('Just Title', '')).toBe('Just Title\n');
  });

  test('title-only change changes the hash (DR-1: a title change busts the gate)', () => {
    const a = computeContentHash(buildEmbedHashInput('Title One', 'same body'));
    const b = computeContentHash(buildEmbedHashInput('Title Two', 'same body'));
    expect(a).not.toBe(b);
  });

  test('body change changes the hash', () => {
    const a = computeContentHash(buildEmbedHashInput('Same Title', 'body one'));
    const b = computeContentHash(buildEmbedHashInput('Same Title', 'body two'));
    expect(a).not.toBe(b);
  });

  test('identical title+body ⇒ identical hash, on any instance', () => {
    const a = computeContentHash(buildEmbedHashInput('T', 'B'));
    const b = computeContentHash(buildEmbedHashInput('T', 'B'));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('preamble content never affects the hash (FR-015): the seam has no preamble input', () => {
    // The seam is the ONLY hash-input producer; its full input surface is
    // (title, bodyText). Same title+body must hash identically no matter what
    // preambles were generated or stored alongside.
    const withoutPreambleContext = computeContentHash(buildEmbedHashInput('T', 'B'));
    const seamArity = buildEmbedHashInput.length;
    expect(seamArity).toBe(2);
    expect(computeContentHash(buildEmbedHashInput('T', 'B'))).toBe(withoutPreambleContext);
  });

  test('title/body boundary is unambiguous (no concatenation collisions)', () => {
    // 'AB' + '' vs 'A' + 'B' must not collide thanks to the \n separator
    const a = computeContentHash(buildEmbedHashInput('AB', ''));
    const b = computeContentHash(buildEmbedHashInput('A', 'B'));
    expect(a).not.toBe(b);
  });
});
