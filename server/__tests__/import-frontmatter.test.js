/**
 * Import-surface frontmatter consumption (feature 002) — converged onto the
 * canonical shared parser (shared/markdown/frontmatter.js, js-yaml JSON_SCHEMA).
 *
 * These cases migrated from the deleted server/__tests__/markdown-import-
 * frontmatter.test.js when the bespoke line-based parser was removed. The
 * recognition rules (cap, malformed-as-content, foreign-key strip, never-throw)
 * are pinned by server/__tests__/frontmatter.test.js against the shared module;
 * here we pin the IMPORT surface's presentation on top of it:
 *   - squire.title extraction (FR-006/FR-008),
 *   - non-squire residue re-emitted as a leading fenced yaml block (FR-007),
 *   - the F2 JSON-escaped-title round trip (no export→import corruption),
 *   - malformed/oversized/frontmatter-only degradation,
 * plus the cross-path agreement test: the import surface and the sync surface
 * both consume parseFrontmatter, so they must agree on squire + stripped body
 * for every fixture.
 */
const fs = require('fs');
const path = require('path');
const { importFrontmatter } = require('../markdown-import');
const { parseFrontmatter, scalarTitle, MAX_FRONTMATTER_BYTES } = require('../../shared/markdown/frontmatter');
const { buildFrontmatter } = require('../mcp/yjs/serialization');

const FIXTURES = path.join(__dirname, 'fixtures', 'import');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

describe('importFrontmatter — squire consumption (FR-006)', () => {
  test('extracts squire title and strips the block (fixture: squire-only)', () => {
    const result = importFrontmatter(read('frontmatter-squire-only.md'));
    expect(result.title).toBe('Payments Redesign');
    expect(result.content).toMatch(/^# Payments Redesign/);
    expect(result.content).not.toContain('---');
    expect(result.content).not.toContain('squire:');
    // Unknown squire fields are ignored without error and never leak into body.
    expect(result.content).not.toContain('unknownField');
  });

  test('squire-only frontmatter leaves no residue block', () => {
    const result = importFrontmatter('---\nsquire:\n  title: T\n---\nBody.\n');
    expect(result.title).toBe('T');
    expect(result.content).toBe('Body.\n');
  });

  test('quoted squire titles are unquoted', () => {
    expect(importFrontmatter('---\nsquire:\n  title: "Quoted"\n---\nx\n').title).toBe('Quoted');
    expect(importFrontmatter("---\nsquire:\n  title: 'Single'\n---\nx\n").title).toBe('Single');
  });

  test('frontmatter-only input yields empty body but a derived title', () => {
    const result = importFrontmatter(read('frontmatter-only.md'));
    expect(result.title).toBe('Frontmatter Only Document');
    expect(result.body.trim()).toBe('');
    expect(result.content.trim()).toBe('');
  });

  test('CRLF + BOM input still detects frontmatter (fixture: crlf-bom)', () => {
    const raw = read('crlf-bom.md');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw).toContain('\r\n');
    const result = importFrontmatter(raw);
    expect(result.title).toBe('CRLF Document');
    expect(result.content).toContain('# CRLF Document');
  });
});

describe('importFrontmatter — non-squire residue as a yaml block (FR-007)', () => {
  test('non-squire keys re-emitted as a leading fenced yaml block (fixture: mixed)', () => {
    const result = importFrontmatter(read('frontmatter-mixed.md'));
    expect(result.title).toBe('Mixed Frontmatter Doc');
    expect(result.content.startsWith('```yaml\n')).toBe(true);
    expect(result.content).toContain('layout: post');
    expect(result.content).toContain('  - one');
    expect(result.content).toContain('draft: true');
    expect(result.content).not.toContain('squire');
    expect(result.content).toContain('```\n\n# Mixed Frontmatter Doc');
  });

  test('frontmatter with no squire key preserves everything as residue', () => {
    const result = importFrontmatter(read('frontmatter-non-squire.md'));
    expect(result.title).toBeNull();
    expect(result.content).toContain('title: Not A Squire Title');
    expect(result.content).toContain('# Non-Squire Frontmatter');
  });

  test('hostile residue containing backtick fences cannot break out of the yaml block', () => {
    const result = importFrontmatter('---\nevil: "``` <script>alert(1)</script>"\n---\nBody.\n');
    // Fence must be longer than the longest backtick run in the residue.
    expect(result.content.startsWith('````yaml\n')).toBe(true);
    expect(result.content).toContain('````\n\nBody.');
  });
});

describe('importFrontmatter — F2 export→import round trip (no corruption)', () => {
  test('JSON-escaped double-quoted title decodes its escapes', () => {
    // 003's buildFrontmatter JSON.stringify-s YAML-hostile scalars, so a title
    // with embedded quotes is written `"Say \"hi\" loud"`; js-yaml decodes it.
    const raw = '---\nsquire:\n  title: "Say \\"hi\\" loud"\n---\nBody.\n';
    expect(importFrontmatter(raw).title).toBe('Say "hi" loud');
  });

  test('export→import preserves a title with embedded quotes (F2 round trip)', () => {
    const title = 'Say "hi" loud';
    const file = buildFrontmatter({
      docGuid: 'd1', title, clock: 1, exportedAt: '2026-07-13T00:00:00Z',
      lastModifiedBy: '', flavor: 'squire',
    }) + '\nBody.\n';
    expect(importFrontmatter(file).title).toBe(title);
  });
});

describe('importFrontmatter — degradation & robustness (FR-006/FR-007)', () => {
  test('malformed YAML is treated as ordinary content (fixture: malformed)', () => {
    const input = read('frontmatter-malformed.md');
    const result = importFrontmatter(input);
    // Whole input is content — nothing consumed or lost.
    expect(result.content).toBe(input);
    expect(result.title).toBeNull();
  });

  test('flow-unbalanced squire value classifies the block malformed (→ content)', () => {
    const result = importFrontmatter('---\nsquire: [unclosed\n---\nBody.\n');
    expect(result.content).toContain('squire: [unclosed');
    expect(result.title).toBeNull();
  });

  test('oversized frontmatter (> 64 KB) degrades to content (RD-9)', () => {
    const input = `---\nsquire:\n  title: ${'x'.repeat(MAX_FRONTMATTER_BYTES + 10)}\n---\nBody.\n`;
    const result = importFrontmatter(input);
    expect(result.content).toBe(input);
    expect(result.title).toBeNull();
  });

  test('no frontmatter: input passes through unchanged', () => {
    const result = importFrontmatter('# Just a doc\n\nBody.\n');
    expect(result.content).toBe('# Just a doc\n\nBody.\n');
    expect(result.title).toBeNull();
  });

  test('frontmatter must start at the absolute document start', () => {
    const result = importFrontmatter('\n---\ntitle: x\n---\nBody.\n');
    expect(result.content).toContain('title: x');
  });

  test('unclosed frontmatter block is not frontmatter', () => {
    const result = importFrontmatter('---\ntitle: x\nBody without closing fence.\n');
    expect(result.content).toContain('Body without closing fence.');
  });

  test('never throws on pathological input', () => {
    const inputs = ['', '---', '---\n', '---\n---', '---\n---\n', '﻿', '--\nx\n--', 42, null, undefined,
      '---\n[]: bad\n---\nx', '---\n- lead list\n---\nx', '---\nsquire: {open\n---\nx'];
    for (const input of inputs) {
      expect(() => importFrontmatter(input)).not.toThrow();
    }
  });
});

describe('cross-path agreement: import surface vs sync surface', () => {
  // The import path (importFrontmatter) and the sync path (docs-import's
  // parseFrontmatter → applySyncPush) now consume the SAME canonical parser.
  // For every fixture they must agree on the recognized squire title and the
  // frontmatter-stripped body — recognition is identical; only the residue
  // PRESENTATION differs (import preserves it as a yaml block, sync drops it).
  const corpus = {
    'squire block, unknown field': '---\nsquire:\n  title: Alpha\n  extra: nope\n---\n# Alpha\n\nBody.\n',
    'foreign keys + squire': '---\nlayout: post\ntags:\n  - a\n  - b\nsquire:\n  title: Beta\n---\nBody.\n',
    'quoted foreign key': '---\n"quoted key": value\nsquire:\n  title: Gamma\n---\nBody.\n',
    'JSON-escaped title': '---\nsquire:\n  title: "Say \\"hi\\" loud"\n---\nBody.\n',
    'foreign only, no squire': '---\nlayout: post\ntitle: Not A Title\n---\n# Heading\n\nBody.\n',
    'hostile YAML (malformed)': '---\nsquire: [unclosed\n  : : :\n---\n# After\n\nBody.\n',
    'oversized block': `---\nsquire:\n  title: ${'z'.repeat(MAX_FRONTMATTER_BYTES + 5)}\n---\nBody.\n`,
    'no frontmatter': '# Plain\n\nJust body.\n',
    'frontmatter only': '---\nsquire:\n  title: Only\n---\n',
    'CRLF + BOM': read('crlf-bom.md'),
  };

  for (const [name, md] of Object.entries(corpus)) {
    test(`agree on squire + body: ${name}`, () => {
      const sync = parseFrontmatter(md);          // the sync surface's view
      const imp = importFrontmatter(md);          // the import surface's view
      expect(imp.body).toBe(sync.body);           // identical stripped body
      expect(imp.title).toBe(scalarTitle(sync.squire)); // identical title
    });
  }
});
