/**
 * Strict-mode characterization snapshot (feature 001, CN-2 / TR-004).
 *
 * Pins the strict parser to a byte-identical baseline captured from the
 * pre-move parser by `fixtures/markdown/generate-strict-characterization.js`.
 * If any case here fails, strict mode has drifted — the diff engine's shipped
 * behavior (and the Redis diff cache keyed by CACHE_VERSION) would regress.
 *
 * NOTE: until Phase 2 (T006) this requires the pre-move `../markdown-to-pm`
 * and calls the 2-arg signature; T006 repoints it to `../../shared/markdown`
 * with `{ strict: true }`.
 */

const cases = require('./fixtures/markdown/strict-characterization.json');
const { markdownToPm } = require('../markdown-to-pm');

describe('strict-mode characterization snapshot (CN-2 byte-identity)', () => {
  for (const c of cases) {
    test(c.name, () => {
      const actual = markdownToPm(c.input, c.diffMark);
      expect(actual).toEqual(c.expected);
    });
  }
});
