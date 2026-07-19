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
