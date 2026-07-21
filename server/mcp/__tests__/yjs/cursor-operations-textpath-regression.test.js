/**
 * Feature 027 — Text-path regression guard (FR-005/SC-004).
 *
 * The fix changes ONLY the text-less branch of the position constructors.
 * Positions computed for TEXT-BEARING content must be byte-identical to the
 * pre-fix behavior. This test re-serializes the same corpus captured (from the
 * OLD code) in fixtures/cursor-textpath-baseline.json and asserts exact JSON
 * equality. The corpus builder is shared with the baseline-capture step
 * (fixtures/cursor-textpath-corpus.js) so construction is identical on both
 * sides — any diff here is a real text-path regression.
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
