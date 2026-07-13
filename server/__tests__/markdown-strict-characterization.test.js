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
