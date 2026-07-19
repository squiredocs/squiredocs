/**
 * Retrieval evaluation metrics (pure functions).
 *
 * These score a single ranked result list against a set of relevant IDs, and
 * aggregate across a query set. They operate at the document level (search
 * returns documents), with an optional per-result token-cost array for the
 * "recall at a fixed token budget" framing Harvey prefers.
 *
 * No I/O here — easy to unit-test with known inputs.
 */

function toSet(relevant) {
  return relevant instanceof Set ? relevant : new Set(relevant || []);
}

/**
 * Recall@k: fraction of relevant items appearing in the top-k of `ranked`.
 * Returns null when there are no relevant items (e.g. a "no-answer" query) —
 * callers should handle those separately rather than averaging them in.
 */
function recallAtK(ranked, relevant, k) {
  const rel = toSet(relevant);
  if (rel.size === 0) return null;
  const topK = ranked.slice(0, k);
  let hits = 0;
  for (const id of topK) if (rel.has(id)) hits++;
  return hits / rel.size;
}

/** Mean Reciprocal Rank contribution for one query: 1/rank of first relevant hit, else 0. */
function reciprocalRank(ranked, relevant) {
  const rel = toSet(relevant);
  if (rel.size === 0) return null;
  for (let i = 0; i < ranked.length; i++) {
    if (rel.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Binary-relevance nDCG@k. */
function ndcgAtK(ranked, relevant, k) {
  const rel = toSet(relevant);
  if (rel.size === 0) return null;
  let dcg = 0;
  const topK = ranked.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (rel.has(topK[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const ideal = Math.min(k, rel.size);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Recall reachable within a fixed token budget.
 * Walks `ranked` accumulating `costs[i]` tokens until the budget is exhausted,
 * then reports the fraction of relevant items covered. Models "how much of the
 * answer fits in the context window we're willing to spend."
 */
function recallAtTokenBudget(ranked, costs, relevant, budgetTokens) {
  const rel = toSet(relevant);
  if (rel.size === 0) return null;
  let spent = 0;
  let hits = 0;
  for (let i = 0; i < ranked.length; i++) {
    const cost = (costs && costs[i]) || 0;
    if (spent + cost > budgetTokens && i > 0) break;
    spent += cost;
    if (rel.has(ranked[i])) hits++;
  }
  return hits / rel.size;
}

/**
 * For "no-answer" queries (relevant set is empty), the right behaviour is to
 * return nothing — or nothing above a relevance floor. Scores 1 if the top
 * result list is empty, else 0.
 */
function noAnswerCorrect(ranked) {
  return ranked.length === 0 ? 1 : 0;
}

/**
 * Aggregate per-query results into mean metrics.
 * Each entry: { ranked: string[], relevant: string[], costs?: number[], type?: string }
 * Returns averaged Recall@5/10/20, MRR, nDCG@10, recall@budget, and no-answer accuracy.
 */
function aggregate(entries, { tokenBudget = 8000 } = {}) {
  const answerable = entries.filter((e) => (e.relevant || []).length > 0);
  const noAnswer = entries.filter((e) => (e.relevant || []).length === 0);

  const mean = (fn) => {
    const vals = answerable.map(fn).filter((v) => v !== null && v !== undefined);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  return {
    queries: entries.length,
    answerable: answerable.length,
    noAnswer: noAnswer.length,
    recallAt5: mean((e) => recallAtK(e.ranked, e.relevant, 5)),
    recallAt10: mean((e) => recallAtK(e.ranked, e.relevant, 10)),
    recallAt20: mean((e) => recallAtK(e.ranked, e.relevant, 20)),
    mrr: mean((e) => reciprocalRank(e.ranked, e.relevant)),
    ndcgAt10: mean((e) => ndcgAtK(e.ranked, e.relevant, 10)),
    recallAtBudget: mean((e) => recallAtTokenBudget(e.ranked, e.costs, e.relevant, tokenBudget)),
    noAnswerAccuracy: noAnswer.length
      ? noAnswer.reduce((a, e) => a + noAnswerCorrect(e.ranked), 0) / noAnswer.length
      : null,
  };
}

module.exports = {
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  recallAtTokenBudget,
  noAnswerCorrect,
  aggregate,
};
