/**
 * Feature 039 US5 (FR-012) — `stripUiOnlyDiffFields`.
 *
 * `diff.inlineSegments` is word-emphasis data the BROWSER renders. It is pure
 * noise to a model (arrays of {text, changed} that restate the diff lines it
 * already has) and it is the largest part of a `modify` result. Every
 * model-bound serialization strips it; storage and the browser keep it.
 *
 * Contract: specs/039-diff-cache-integrity/contracts/model-bound-serialization.md
 */

const { stripUiOnlyDiffFields } = require('../diff-utils');

/** A representative `modify` tool result carrying a chat diff. */
function resultWithDiff() {
  return {
    ok: true,
    docGuid: 'doc-1',
    clock: 12,
    diff: {
      lines: ['-the quick fox', '+the slow fox'],
      hunkStarts: [{ index: 0, oldStart: 1, newStart: 1 }],
      formatAnnotations: { 1: 'bold → italic' },
      truncatedByServer: false,
      inlineSegments: {
        0: [{ text: 'the ', changed: false }, { text: 'quick', changed: true }],
        1: [{ text: 'the ', changed: false }, { text: 'slow', changed: true }],
      },
    },
  };
}

describe('stripUiOnlyDiffFields (039 US5)', () => {
  // MS-1
  test('removes diff.inlineSegments and retains every model-useful diff field', () => {
    const stripped = stripUiOnlyDiffFields(resultWithDiff());

    expect(stripped.diff).not.toHaveProperty('inlineSegments');
    // ST-4: the model still gets the diff itself and its positioning metadata.
    expect(stripped.diff.lines).toEqual(['-the quick fox', '+the slow fox']);
    expect(stripped.diff.hunkStarts).toEqual([{ index: 0, oldStart: 1, newStart: 1 }]);
    expect(stripped.diff.formatAnnotations).toEqual({ 1: 'bold → italic' });
    expect(stripped.diff).toHaveProperty('truncatedByServer', false);
    // Non-diff fields survive untouched.
    expect(stripped.ok).toBe(true);
    expect(stripped.docGuid).toBe('doc-1');
    expect(stripped.clock).toBe(12);
  });

  // MS-2 — ST-1 (pure) and ST-2 (identity)
  test('never mutates its input', () => {
    const input = resultWithDiff();
    const before = JSON.stringify(input);
    stripUiOnlyDiffFields(input);
    expect(JSON.stringify(input)).toBe(before);
    // Load-bearing: at two of the three seams this same object is the
    // persisted / browser-bound copy (FR-013).
    expect(input.diff.inlineSegments).toBeDefined();
  });

  test('returns the argument by identity when there is nothing to strip', () => {
    const noDiff = { ok: true, content: 'hello' };
    expect(stripUiOnlyDiffFields(noDiff)).toBe(noDiff);

    const diffWithoutSegments = { ok: true, diff: { lines: ['-a', '+b'] } };
    expect(stripUiOnlyDiffFields(diffWithoutSegments)).toBe(diffWithoutSegments);

    // ST-2: non-objects pass straight through.
    expect(stripUiOnlyDiffFields(null)).toBe(null);
    expect(stripUiOnlyDiffFields(undefined)).toBe(undefined);
    expect(stripUiOnlyDiffFields('a string')).toBe('a string');
    expect(stripUiOnlyDiffFields(42)).toBe(42);
  });

  test('ST-5: it is targeted at result.diff, not a deep key walk', () => {
    // A nested `inlineSegments` that is NOT at result.diff is left alone — all
    // three producers (modify, undo, redo) attach the diff at result.diff, and a
    // generic deep removal would be over-broad and slow.
    const nested = {
      diff: { lines: ['-a'], inlineSegments: { 0: [] } },
      unrelated: { inlineSegments: { 0: [{ text: 'keep', changed: true }] } },
    };
    const stripped = stripUiOnlyDiffFields(nested);
    expect(stripped.diff).not.toHaveProperty('inlineSegments');
    expect(stripped.unrelated.inlineSegments).toEqual({ 0: [{ text: 'keep', changed: true }] });
    // `diff` is shallow-cloned; sibling subtrees are shared by reference.
    expect(stripped.unrelated).toBe(nested.unrelated);
  });

  // MS-3 — the MCP serialization seam (seam (a))
  test('MS-3: MCP tool-result serialization carries no inlineSegments, indentation unchanged', () => {
    const { toToolResultContent } = require('../index');
    const content = toToolResultContent(resultWithDiff());

    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    expect(content[0].text).not.toContain('inlineSegments');
    // MA-1: still pretty-printed at 2 spaces (explicit spec non-goal to change).
    expect(content[0].text.split('\n')[1]).toMatch(/^ {2}"/);
    // The diff itself still reaches the model.
    expect(JSON.parse(content[0].text).diff.lines).toEqual(['-the quick fox', '+the slow fox']);
  });

  test('MA-2: MCP results without a diff are passed through unchanged', () => {
    const { toToolResultContent } = require('../index');
    const plain = { ok: true, documents: [{ id: 'a' }] };
    expect(JSON.parse(toToolResultContent(plain)[0].text)).toEqual(plain);
  });

  test('MCP __mcpContent passthrough (image blocks) is unaffected', () => {
    const { toToolResultContent } = require('../index');
    const blocks = [{ type: 'image', data: 'xxx', mimeType: 'image/png' }];
    expect(toToolResultContent({ __mcpContent: blocks })).toBe(blocks);
  });
});
