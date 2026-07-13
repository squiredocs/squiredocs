/**
 * Unit tests for defensive frontmatter consumption (feature 002, T003/T004).
 *
 * FR-006: squire fields consumed, unknown squire keys ignored.
 * FR-007: non-squire keys preserved as a leading yaml code block; malformed
 *         YAML treated as ordinary content. Never throws.
 */
const fs = require('fs');
const path = require('path');
const { consumeFrontmatter, normalizeMarkdown } = require('../markdown-import-frontmatter');

const FIXTURES = path.join(__dirname, 'fixtures', 'import');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

describe('normalizeMarkdown', () => {
  test('strips BOM and normalizes CRLF and lone CR', () => {
    expect(normalizeMarkdown('﻿a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  test('coerces non-strings without throwing', () => {
    expect(normalizeMarkdown(null)).toBe('');
    expect(normalizeMarkdown(undefined)).toBe('');
    expect(normalizeMarkdown(42)).toBe('42');
  });
});

describe('consumeFrontmatter', () => {
  test('extracts squire title and strips the block (fixture: squire-only)', () => {
    const result = consumeFrontmatter(read('frontmatter-squire-only.md'));
    expect(result.hadFrontmatter).toBe(true);
    expect(result.malformed).toBe(false);
    expect(result.squire.title).toBe('Payments Redesign');
    expect(result.content).toMatch(/^# Payments Redesign/);
    expect(result.content).not.toContain('---');
    expect(result.content).not.toContain('squire:');
  });

  test('ignores unknown squire fields without error', () => {
    const result = consumeFrontmatter(read('frontmatter-squire-only.md'));
    expect(result.squire).toEqual({ title: 'Payments Redesign' });
    expect(result.content).not.toContain('unknownField');
    expect(result.residue).toBeNull();
  });

  test('squire-only frontmatter leaves no residue block', () => {
    const result = consumeFrontmatter('---\nsquire:\n  title: T\n---\nBody.\n');
    expect(result.residue).toBeNull();
    expect(result.content).toBe('Body.\n');
  });

  test('non-squire keys re-emitted as a leading fenced yaml block (fixture: mixed)', () => {
    const result = consumeFrontmatter(read('frontmatter-mixed.md'));
    expect(result.hadFrontmatter).toBe(true);
    expect(result.squire.title).toBe('Mixed Frontmatter Doc');
    expect(result.residue).toContain('layout: post');
    expect(result.residue).toContain('tags:');
    expect(result.residue).toContain('  - one');
    expect(result.residue).toContain('draft: true');
    expect(result.residue).not.toContain('squire');
    expect(result.content.startsWith('```yaml\n')).toBe(true);
    expect(result.content).toContain('```\n\n# Mixed Frontmatter Doc');
  });

  test('frontmatter with no squire key preserves everything as residue', () => {
    const result = consumeFrontmatter(read('frontmatter-non-squire.md'));
    expect(result.hadFrontmatter).toBe(true);
    expect(result.squire).toEqual({});
    expect(result.residue).toContain('title: Not A Squire Title');
    expect(result.content).toContain('# Non-Squire Frontmatter');
  });

  test('malformed YAML is treated as ordinary content (fixture: malformed)', () => {
    const input = read('frontmatter-malformed.md');
    const result = consumeFrontmatter(input);
    expect(result.malformed).toBe(true);
    expect(result.hadFrontmatter).toBe(false);
    // Whole input (normalized) is content — nothing consumed or lost.
    expect(result.content).toBe(normalizeMarkdown(input));
    expect(result.squire).toEqual({});
  });

  test('frontmatter-only input yields empty body but a derived title', () => {
    const result = consumeFrontmatter(read('frontmatter-only.md'));
    expect(result.hadFrontmatter).toBe(true);
    expect(result.squire.title).toBe('Frontmatter Only Document');
    expect(result.body.trim()).toBe('');
    expect(result.content.trim()).toBe('');
  });

  test('CRLF + BOM input still detects frontmatter (fixture: crlf-bom)', () => {
    const raw = read('crlf-bom.md');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw).toContain('\r\n');
    const result = consumeFrontmatter(raw);
    expect(result.hadFrontmatter).toBe(true);
    expect(result.squire.title).toBe('CRLF Document');
    expect(result.content).toContain('# CRLF Document');
    expect(result.content).not.toContain('\r');
  });

  test('no frontmatter: input passes through normalized and unchanged', () => {
    const result = consumeFrontmatter('# Just a doc\n\nBody.\n');
    expect(result.hadFrontmatter).toBe(false);
    expect(result.content).toBe('# Just a doc\n\nBody.\n');
    expect(result.raw).toBeNull();
  });

  test('frontmatter must start at the absolute document start', () => {
    const result = consumeFrontmatter('\n---\ntitle: x\n---\nBody.\n');
    expect(result.hadFrontmatter).toBe(false);
    expect(result.content).toContain('title: x');
  });

  test('unclosed frontmatter block is not frontmatter', () => {
    const result = consumeFrontmatter('---\ntitle: x\nBody without closing fence.\n');
    expect(result.hadFrontmatter).toBe(false);
    expect(result.malformed).toBe(false);
    expect(result.content).toContain('Body without closing fence.');
  });

  test('quoted squire titles are unquoted', () => {
    expect(consumeFrontmatter('---\nsquire:\n  title: "Quoted"\n---\nx\n').squire.title).toBe('Quoted');
    expect(consumeFrontmatter("---\nsquire:\n  title: 'Single'\n---\nx\n").squire.title).toBe('Single');
  });

  test('hostile residue containing backtick fences cannot break out of the yaml block', () => {
    const result = consumeFrontmatter('---\nevil: "``` <script>alert(1)</script>"\n---\nBody.\n');
    expect(result.hadFrontmatter).toBe(true);
    // Fence must be longer than the longest backtick run in the residue.
    expect(result.content.startsWith('````yaml\n')).toBe(true);
    expect(result.content).toContain('````\n\nBody.');
  });

  test('never throws on pathological input', () => {
    const inputs = ['', '---', '---\n', '---\n---', '---\n---\n', '﻿', '--\nx\n--', 42, null, undefined,
      '---\n[]: bad\n---\nx', '---\n- lead list\n---\nx', '---\nsquire: {open\n---\nx'];
    for (const input of inputs) {
      expect(() => consumeFrontmatter(input)).not.toThrow();
    }
  });

  test('flow-unbalanced squire value classifies the block malformed', () => {
    const result = consumeFrontmatter('---\nsquire: [unclosed\n---\nBody.\n');
    expect(result.malformed).toBe(true);
    expect(result.content).toContain('squire: [unclosed');
  });
});
