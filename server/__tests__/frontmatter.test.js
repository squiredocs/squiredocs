/**
 * Frontmatter strip/preserve contract tests (feature 003, T021,
 * FR-015/FR-016, SC-005 — contracts/frontmatter-squire-block.md).
 *
 * parseFrontmatter is the seam features 002 (import) and 004 (sync) build
 * against; these tests pin the recognition rules, the byte-verbatim foreign
 * preservation, the conservative squire-excision fallback, and the
 * untrusted-input posture (size cap, hostile YAML, never-throw).
 */

const { parseFrontmatter, MAX_FRONTMATTER_BYTES } = require('../../shared/markdown/frontmatter');
const { buildFrontmatter } = require('../mcp/yjs/serialization');

const SQUIRE_META = {
  docGuid: 'b6edb804-cf72-416d-9c97-063a23e669c0',
  title: 'Test Doc',
  clock: 42,
  exportedAt: '2026-07-13T18:04:11Z',
  lastModifiedBy: 'liz@example.com',
  flavor: 'squire',
};

describe('parseFrontmatter — strip (FR-015)', () => {
  test('squire block is stripped from body and surfaced as metadata', () => {
    const file = buildFrontmatter(SQUIRE_META) + '\n# Title\n\nBody text';
    const { body, squire, foreignRaw } = parseFrontmatter(file);
    expect(body).toBe('# Title\n\nBody text');
    expect(squire.docGuid).toBe(SQUIRE_META.docGuid);
    expect(squire.title).toBe('Test Doc');
    expect(squire.clock).toBe(42);
    expect(squire.exportedAt).toBe('2026-07-13T18:04:11Z');
    expect(squire.lastModifiedBy).toBe('liz@example.com');
    expect(squire.flavor).toBe('squire');
    expect(foreignRaw).toBeNull();
  });

  test('lossy and images keys parse back as list and mapping', () => {
    const file = buildFrontmatter({
      ...SQUIRE_META,
      flavor: 'portable',
      lossy: new Set(['underline', 'textStyle']),
      images: { './assets/doc/abc.png': 'abc' },
    }) + '\nBody';
    const { squire } = parseFrontmatter(file);
    expect(squire.lossy).toEqual(['textStyle', 'underline']); // sorted flow list
    expect(squire.images).toEqual({ './assets/doc/abc.png': 'abc' });
  });

  test('quoted title with YAML-hostile characters survives the round trip', () => {
    const title = 'Spec: phase #2 "final" — draft';
    const file = buildFrontmatter({ ...SQUIRE_META, title }) + '\nBody';
    const { squire } = parseFrontmatter(file);
    expect(squire.title).toBe(title);
  });
});

describe('parseFrontmatter — preserve foreign keys (RD-4, SC-005)', () => {
  const foreign = 'speckit:\n  phase: plan\n  order: 3\nlayout: post';

  test('foreign keys are byte- and order-verbatim, squire excised', () => {
    const file = `---\n${foreign}\nsquire:\n  docGuid: g1\n  clock: 7\n---\n\nBody`;
    const { body, squire, foreignRaw } = parseFrontmatter(file);
    expect(foreignRaw).toBe(foreign);
    expect(squire).toEqual({ docGuid: 'g1', clock: 7 });
    expect(body).toBe('Body');
  });

  test('squire key first: foreign lines after it are preserved verbatim', () => {
    const file = `---\nsquire:\n  docGuid: g1\n${foreign}\n---\nBody`;
    const { squire, foreignRaw } = parseFrontmatter(file);
    expect(squire).toEqual({ docGuid: 'g1' });
    expect(foreignRaw).toBe(foreign);
  });

  test('re-export: single block, foreign verbatim first, squire last (SC-005)', () => {
    const original = `---\n${foreign}\nsquire:\n  docGuid: old\n---\nBody`;
    const parsed = parseFrontmatter(original);
    const reExported = buildFrontmatter(SQUIRE_META, parsed.foreignRaw) + '\n' + parsed.body;

    // exactly one fence pair
    expect(reExported.match(/^---$/gm)).toHaveLength(2);
    // foreign lines byte-identical and ahead of squire:
    expect(reExported).toContain(foreign);
    expect(reExported.indexOf(foreign)).toBeLessThan(reExported.indexOf('squire:'));

    // and a second round trip still preserves them
    const again = parseFrontmatter(reExported);
    expect(again.foreignRaw).toBe(foreign);
    expect(again.squire.docGuid).toBe(SQUIRE_META.docGuid);
    expect(again.body).toBe('Body');
  });

  test('foreign-only block (no squire key): squire null, block preserved', () => {
    const file = `---\n${foreign}\n---\nBody`;
    const { squire, foreignRaw, body } = parseFrontmatter(file);
    expect(squire).toBeNull();
    expect(foreignRaw).toBe(foreign);
    expect(body).toBe('Body');
  });

  test('conservative fallback: quoted squire key defeats the raw line scan', () => {
    // js-yaml sees a `squire` key but no column-0 `squire:` line exists —
    // the whole block must be treated as foreign (never corrupt foreign keys).
    const file = `---\n"squire":\n  docGuid: g1\nspeckit:\n  phase: plan\n---\nBody`;
    const { squire, foreignRaw } = parseFrontmatter(file);
    expect(squire).toBeNull();
    expect(foreignRaw).toBe('"squire":\n  docGuid: g1\nspeckit:\n  phase: plan');
  });

  test('conservative fallback: anchors crossing the squire block', () => {
    // The foreign remainder references an anchor defined inside the squire
    // block; excision would corrupt it, so the whole block stays foreign.
    const file = `---\nsquire:\n  docGuid: &g g1\nspeckit:\n  ref: *g\n---\nBody`;
    const { squire, foreignRaw } = parseFrontmatter(file);
    expect(squire).toBeNull();
    expect(foreignRaw).toBe('squire:\n  docGuid: &g g1\nspeckit:\n  ref: *g');
  });
});

describe('parseFrontmatter — not-frontmatter degrades to content (FR-016)', () => {
  test('lone --- (later horizontal rule) is content', () => {
    const input = '---\njust text with no closing fence';
    expect(parseFrontmatter(input)).toEqual({ body: input, squire: null, foreignRaw: null });
  });

  test('--- --- with non-mapping YAML (list) is content', () => {
    const input = '---\n- a\n- b\n---\nbody';
    expect(parseFrontmatter(input)).toEqual({ body: input, squire: null, foreignRaw: null });
  });

  test('--- --- with scalar YAML is content', () => {
    const input = '---\nhello\n---\nbody';
    expect(parseFrontmatter(input)).toEqual({ body: input, squire: null, foreignRaw: null });
  });

  test('empty block (--- then ---) is content (parses to null, not a mapping)', () => {
    const input = '---\n---\nbody';
    expect(parseFrontmatter(input)).toEqual({ body: input, squire: null, foreignRaw: null });
  });

  test('fence not at line 1 is content', () => {
    const input = 'intro\n---\nkey: value\n---\nbody';
    expect(parseFrontmatter(input)).toEqual({ body: input, squire: null, foreignRaw: null });
  });

  test('malformed YAML is content, never a throw', () => {
    const input = '---\nkey: [unclosed\nother: }{\n---\nbody';
    expect(() => parseFrontmatter(input)).not.toThrow();
    expect(parseFrontmatter(input).body).toBe(input);
  });

  test('oversized block (> 64 KB) is content (RD-9)', () => {
    const input = `---\nk: ${'x'.repeat(MAX_FRONTMATTER_BYTES + 10)}\n---\nbody`;
    const result = parseFrontmatter(input);
    expect(result).toEqual({ body: input, squire: null, foreignRaw: null });
  });

  test('multi-byte content is measured in bytes, not code units', () => {
    // ~22K four-byte emoji = ~44K UTF-16 units but ~88K UTF-8 bytes ⇒ over cap
    const input = `---\nk: ${'🙂'.repeat(22000)}\n---\nbody`;
    const result = parseFrontmatter(input);
    expect(result.squire).toBeNull();
    expect(result.body).toBe(input);
  });

  test('empty and non-string inputs never throw', () => {
    expect(parseFrontmatter('')).toEqual({ body: '', squire: null, foreignRaw: null });
    expect(parseFrontmatter(null).body).toBe('');
    expect(parseFrontmatter(undefined).body).toBe('');
  });
});

describe('parseFrontmatter — trust boundary (FR-016, Constitution V)', () => {
  test('anchors/aliases stay inert plain data under the cap', () => {
    const file = '---\nbase: &b { a: 1 }\nuse: *b\nsquire:\n  docGuid: g\n---\nBody';
    const { squire, foreignRaw } = parseFrontmatter(file);
    // alias expansion yields plain data (no object identity tricks surfaced)
    expect(squire).toEqual({ docGuid: 'g' });
    expect(foreignRaw).toBe('base: &b { a: 1 }\nuse: *b');
  });

  test('billion-laughs-shaped input is bounded by the cap or degrades to content', () => {
    // Build nested alias amplification; keep the raw block under the cap so
    // it exercises the parser — js-yaml expands lazily and JSON_SCHEMA keeps
    // it plain data; the assertion is simply that we never hang or throw.
    let yaml = 'a0: &a0 [x, x]\n';
    for (let i = 1; i < 10; i++) {
      yaml += `a${i}: &a${i} [*a${i - 1}, *a${i - 1}]\n`;
    }
    const input = `---\n${yaml}---\nbody`;
    expect(() => parseFrontmatter(input)).not.toThrow();
  });

  test('js/undefined-type tags degrade to content (JSON_SCHEMA rejects them)', () => {
    const input = '---\nevil: !!js/function "function(){return 1}"\n---\nbody';
    const result = parseFrontmatter(input);
    expect(result.squire).toBeNull();
    expect(result.body).toBe(input);
  });

  test('squire values are returned as data only (no coercion of timestamps etc.)', () => {
    const file = '---\nsquire:\n  exportedAt: 2026-07-13T18:04:11Z\n  clock: 42\n---\nBody';
    const { squire } = parseFrontmatter(file);
    expect(typeof squire.exportedAt).toBe('string'); // JSON_SCHEMA: no Date coercion
    expect(squire.clock).toBe(42);
  });
});

describe('parseFrontmatter — body disambiguation (spec Edge Cases)', () => {
  test('body beginning with --- stays in the body (block already closed)', () => {
    const file = buildFrontmatter(SQUIRE_META) + '\n---\n\nBody after rule';
    const { body } = parseFrontmatter(file);
    expect(body).toBe('---\n\nBody after rule');
  });

  test('closing fence at EOF (no trailing newline) is recognized', () => {
    const file = '---\nsquire:\n  docGuid: g\n---';
    const { body, squire } = parseFrontmatter(file);
    expect(squire).toEqual({ docGuid: 'g' });
    expect(body).toBe('');
  });

  test('BOM before the opening fence is tolerated', () => {
    const file = '﻿---\nsquire:\n  docGuid: g\n---\nBody';
    const { squire, body } = parseFrontmatter(file);
    expect(squire).toEqual({ docGuid: 'g' });
    expect(body).toBe('Body');
  });
});
