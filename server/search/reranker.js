/**
 * LLM reranker (feature 018, plan D10 — FR-030: OFF by default, flag-only).
 *
 * Re-ported from the reference-only rag-search-v2 branch. The prior eval
 * showed it LOWERED MRR at ~5.7 s/query on this corpus — hence the flipped
 * default: `server/search.js` invokes it ONLY when `getSearchConfig().rerank`
 * is true (SEARCH_RERANK env or an eval override). It exists on main so the
 * eval harness can sweep it as an explicitly flagged variant (`--rerank`)
 * pending curated-eval evidence.
 *
 * Fails soft: on any error the first-stage order is kept.
 */

const { generateObject, jsonSchema } = require('ai');
const { getProvider } = require('../api/chat-models');

const RERANK_MODEL = 'gemini-2.5-flash';
const BATCH_SIZE = 25; // candidates scored per call
const SNIPPET_CHARS = 600; // truncate each candidate for scoring

const scoresSchema = jsonSchema({
  type: 'object',
  properties: {
    scores: { type: 'array', items: { type: 'number' } },
  },
  required: ['scores'],
  additionalProperties: false,
});

function buildPrompt(query, batch) {
  const passages = batch
    .map((c, i) => `[${i + 1}] ${(c.text || '').slice(0, SNIPPET_CHARS).replace(/\s+/g, ' ').trim()}`)
    .join('\n\n');
  return [
    'Rate how well each passage answers the search query, on a 0-10 scale',
    '(10 = directly and fully answers it, 0 = irrelevant). Judge relevance to the query only,',
    'not writing quality. Return a "scores" array with one number per passage, in order.',
    '',
    `Query: ${query}`,
    '',
    `Passages:\n${passages}`,
  ].join('\n');
}

async function scoreBatch(query, batch) {
  const model = getProvider('google')(RERANK_MODEL);
  const { object } = await generateObject({
    model,
    schema: scoresSchema,
    prompt: buildPrompt(query, batch),
  });
  const scores = Array.isArray(object && object.scores) ? object.scores : [];
  return batch.map((_, i) => (typeof scores[i] === 'number' ? scores[i] : 0));
}

/**
 * Rerank candidates by LLM-judged relevance and keep the top `keep`.
 * @param {{query: string, candidates: Array<{text:string}>, keep:number}} args
 * @returns {Promise<Array>} candidates (with `rerankScore`) sorted best-first, length <= keep
 */
async function rerank({ query, candidates, keep = 20 }) {
  if (!candidates || candidates.length === 0) return [];
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) return candidates.slice(0, keep);

  try {
    const scores = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      scores.push(...(await scoreBatch(query, batch)));
    }
    return candidates
      .map((c, i) => ({ ...c, rerankScore: scores[i] ?? 0 }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, keep);
  } catch (err) {
    console.warn(`[Reranker] failed, keeping first-stage order: ${err.message}`);
    return candidates.slice(0, keep);
  }
}

module.exports = { rerank, RERANK_MODEL };
