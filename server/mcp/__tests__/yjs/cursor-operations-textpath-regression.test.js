/**
 * Feature 027 — Text-path regression guard (FR-005/SC-004).
 *
 * Positions computed for TEXT-BEARING content must be byte-identical to the
 * pinned baseline. This test re-serializes the same corpus captured in
 * fixtures/cursor-textpath-baseline.json and asserts exact JSON equality. The
 * corpus builder is shared with the baseline-capture step
 * (fixtures/cursor-textpath-corpus.js) so construction is identical on both
 * sides — any diff here is a real text-path regression.
 *
 * Baseline history: originally captured from the pre-027 code (027 changed
 * only the text-less branch). Regenerated 2026-08-01 for the read-highlight
 * fix: offset-0 text positions now serialize as the left-associated boundary
 * form ({ type, assoc: -1 }, no item) so @tiptap/y-tiptap's
 * isMisresolvedTextPosition guard cannot veto doc-start highlights; non-zero
 * offsets are unchanged. See serializeTextPosition in yjs/cursor-operations.js
 * and cursor-operations-docstart-render.test.js.
 */

const fs = require('fs');
const path = require('path');
const { computeCorpus } = require('../fixtures/cursor-textpath-corpus');

const BASELINE_PATH = path.join(__dirname, '../fixtures/cursor-textpath-baseline.json');

describe('027 text-path regression — text-bearing positions are byte-identical', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const current = computeCorpus();

  test('the corpus key set is unchanged', () => {
    expect(Object.keys(current).sort()).toEqual(Object.keys(baseline).sort());
  });

  for (const key of Object.keys(baseline)) {
    test(`${key}: serialized position is byte-identical to baseline`, () => {
      expect(JSON.stringify(current[key])).toBe(JSON.stringify(baseline[key]));
    });
  }
});
