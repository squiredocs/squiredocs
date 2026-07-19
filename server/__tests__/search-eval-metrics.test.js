/**
 * Feature 018 US3 — eval-harness metric unit tests (T025).
 *
 * Pure functions, known-input fixtures, hand-computed expectations (FR-024).
 */
const {
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  recallAtTokenBudget,
  noAnswerCorrect,
  aggregate,
} = require('../search/eval/metrics');

describe('metrics (T025)', () => {
  describe('recallAtK', () => {
    test('fraction of relevant items in the top k', () => {
      expect(recallAtK(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'f'], 5)).toBe(0.5);
      expect(recallAtK(['a', 'b'], ['a', 'b'], 5)).toBe(1);
      expect(recallAtK(['x', 'y'], ['a'], 5)).toBe(0);
    });

    test('null for an empty relevant set (no-answer queries handled separately)', () => {
      expect(recallAtK(['a', 'b'], [], 5)).toBeNull();
    });
  });

  describe('reciprocalRank', () => {
    test('1/rank of the first relevant hit', () => {
      expect(reciprocalRank(['a', 'b'], ['a'])).toBe(1);
      expect(reciprocalRank(['x', 'a'], ['a'])).toBe(0.5);
      expect(reciprocalRank(['x', 'y', 'z', 'a'], ['a'])).toBe(0.25);
    });

    test('0 when never found; null for empty relevant set', () => {
      expect(reciprocalRank(['x', 'y'], ['a'])).toBe(0);
      expect(reciprocalRank(['x'], [])).toBeNull();
    });
  });

  describe('ndcgAtK', () => {
    test('hand-computed DCG/IDCG case', () => {
      // ranked: relevant at positions 1 and 3 → DCG = 1/log2(2) + 1/log2(4) = 1.5
      // 3 relevant total, k=10 → IDCG = 1 + 1/log2(3) + 1/log2(4) ≈ 2.13093
      const ndcg = ndcgAtK(['r1', 'x', 'r2'], ['r1', 'r2', 'r3'], 10);
      expect(ndcg).toBeCloseTo(1.5 / (1 + 1 / Math.log2(3) + 0.5), 10);
    });

    test('perfect ranking scores 1; empty relevant set is null', () => {
      expect(ndcgAtK(['a', 'b'], ['a', 'b'], 10)).toBeCloseTo(1, 10);
      expect(ndcgAtK(['a'], [], 10)).toBeNull();
    });
  });

  describe('recallAtTokenBudget', () => {
    test('budget cutoff mid-list: items past the budget do not count', () => {
      // spend 500 (hit a), 900 (miss b), then 1300 > 1000 → stop before c
      expect(recallAtTokenBudget(['a', 'b', 'c'], [500, 400, 400], ['a', 'c'], 1000)).toBe(0.5);
    });

    test('the first result always counts even when alone over budget', () => {
      expect(recallAtTokenBudget(['a'], [2000], ['a'], 1000)).toBe(1);
    });

    test('null for empty relevant set; missing costs treated as 0', () => {
      expect(recallAtTokenBudget(['a'], [100], [], 1000)).toBeNull();
      expect(recallAtTokenBudget(['a', 'b'], undefined, ['b'], 10)).toBe(1);
    });
  });

  describe('noAnswerCorrect', () => {
    test('1 when nothing is returned, else 0', () => {
      expect(noAnswerCorrect([])).toBe(1);
      expect(noAnswerCorrect(['anything'])).toBe(0);
    });
  });

  describe('aggregate', () => {
    const entries = [
      { ranked: ['a'], relevant: ['a'], costs: [100], type: 'keyword' }, // R@5 = 1, MRR 1
      { ranked: ['x', 'b'], relevant: ['b'], costs: [100, 100], type: 'paraphrase' }, // R@5 = 1, MRR 0.5
      { ranked: [], relevant: [], type: 'no-answer' }, // correct no-answer
      { ranked: ['spurious'], relevant: [], type: 'no-answer' }, // incorrect no-answer
    ];

    test('no-answer queries are excluded from averages and reported separately (FR-024)', () => {
      const agg = aggregate(entries, { tokenBudget: 8000 });
      expect(agg.queries).toBe(4);
      expect(agg.answerable).toBe(2);
      expect(agg.noAnswer).toBe(2);
      expect(agg.recallAt5).toBe(1); // mean over the two answerable only
      expect(agg.mrr).toBeCloseTo(0.75, 10);
      expect(agg.noAnswerAccuracy).toBe(0.5);
    });

    test('all-answerable set reports noAnswerAccuracy null', () => {
      const agg = aggregate(entries.slice(0, 2));
      expect(agg.noAnswerAccuracy).toBeNull();
      expect(agg.recallAt10).toBe(1);
      // e1 nDCG = 1; e2 has its hit at rank 2 → 1/log2(3); mean of the two
      expect(agg.ndcgAt10).toBeCloseTo((1 + 1 / Math.log2(3)) / 2, 10);
    });
  });
});

// ————————————————————————————————————————————————————————————————————————
// Feature 018 US4 (T030): eval-set composition audit + saturation guard
// (RBD-5) — pure functions over fixture JSON, exercised offline.
// ————————————————————————————————————————————————————————————————————————
describe('check-eval-set (T030, RBD-5)', () => {
  const { auditComposition, checkSaturationGuard } = require('../search/eval/check-eval-set');

  function makeSet({ paraphrase = 12, multiDoc = 6, noAnswer = 6, keyword = 16, mutate } = {}) {
    const queries = [];
    let n = 0;
    const push = (type, refs) => queries.push({ id: `q${String(++n).padStart(3, '0')}`, query: `query ${n}`, type, relevantDocIds: refs });
    for (let i = 0; i < paraphrase; i++) push('paraphrase', [`doc-${i}`]);
    for (let i = 0; i < multiDoc; i++) push('multi-doc', [`doc-a${i}`, `doc-b${i}`]);
    for (let i = 0; i < noAnswer; i++) push('no-answer', []);
    for (let i = 0; i < keyword; i++) push('keyword', [`doc-k${i}`]);
    const set = { version: '1', date: '2026-07-19', corpus: 'test', queries };
    if (mutate) mutate(set);
    return set;
  }

  describe('auditComposition', () => {
    test('passes at the RBD-5 minimums (≥40 / ≥12 / ≥6 / ≥6)', () => {
      const verdict = auditComposition(makeSet());
      expect(verdict.ok).toBe(true);
      expect(verdict.problems).toEqual([]);
    });

    test('fails below any minimum, with reasons', () => {
      expect(auditComposition(makeSet({ keyword: 10 })).ok).toBe(false); // 34 total
      const fewParaphrase = auditComposition(makeSet({ paraphrase: 11, keyword: 17 }));
      expect(fewParaphrase.ok).toBe(false);
      expect(fewParaphrase.problems.join(' ')).toMatch(/paraphrase/);
      expect(auditComposition(makeSet({ multiDoc: 5, keyword: 17 })).ok).toBe(false);
      expect(auditComposition(makeSet({ noAnswer: 5, keyword: 17 })).ok).toBe(false);
    });

    test('fails when a multi-doc query has fewer than 2 refs', () => {
      const verdict = auditComposition(makeSet({
        mutate: (set) => {
          const md = set.queries.find((q) => q.type === 'multi-doc');
          md.relevantDocIds = ['only-one'];
        },
      }));
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(/multi-doc/);
    });

    test('fails when a no-answer query carries refs, or a record is malformed', () => {
      const withRefs = auditComposition(makeSet({
        mutate: (set) => {
          const na = set.queries.find((q) => q.type === 'no-answer');
          na.relevantDocIds = ['sneaky-doc'];
        },
      }));
      expect(withRefs.ok).toBe(false);
      expect(withRefs.problems.join(' ')).toMatch(/no-answer/);

      const malformed = auditComposition(makeSet({
        mutate: (set) => { delete set.queries[0].type; },
      }));
      expect(malformed.ok).toBe(false);
    });
  });

  describe('checkSaturationGuard', () => {
    const mk = (r5, r10, r20, mrr, ndcg) => ({
      recallAt5: r5, recallAt10: r10, recallAt20: r20, mrr, ndcgAt10: ndcg,
    });
    const wrap = (metricsList) => ({
      variants: metricsList.map((m, i) => ({ name: `v${i}`, metrics: m })),
    });

    test('fails on the documented saturation failure mode: all variants 1.0 on R@5/10/20', () => {
      // Even with MRR spread — the prior draft set's exact failure signature
      const verdict = checkSaturationGuard(wrap([
        mk(1, 1, 1, 0.9, 0.95),
        mk(1, 1, 1, 0.8, 0.9),
        mk(1, 1, 1, 0.7, 0.85),
      ]));
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(/harder queries/);
      expect(verdict.problems.join(' ')).not.toMatch(/variants are equal/);
    });

    test('fails when no primary-metric pair differs by ≥ 0.03 (set cannot discriminate)', () => {
      const verdict = checkSaturationGuard(wrap([
        mk(0.8, 0.85, 0.9, 0.7, 0.75),
        mk(0.8, 0.86, 0.9, 0.71, 0.76),
        mk(0.8, 0.87, 0.9, 0.72, 0.77),
      ]));
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(/set defect|harder queries/);
    });

    test('passes when not saturated AND a primary metric spreads ≥ 0.03', () => {
      const verdict = checkSaturationGuard(wrap([
        mk(0.7, 0.75, 0.85, 0.6, 0.65),
        mk(0.8, 0.85, 0.9, 0.72, 0.78),
        mk(0.85, 0.9, 0.95, 0.8, 0.84),
      ]));
      expect(verdict.ok).toBe(true);
      expect(verdict.problems).toEqual([]);
    });

    test('boundary: spread of exactly 0.03 on one primary metric passes', () => {
      const verdict = checkSaturationGuard(wrap([
        mk(0.9, 0.9, 0.9, 0.7, 0.8),
        mk(0.9, 0.93, 0.9, 0.7, 0.8),
      ]));
      expect(verdict.ok).toBe(true);
    });
  });
});
