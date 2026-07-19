/**
 * Contextual preambles for search chunks (feature 018 US2, plan D6/RBD-4).
 *
 * For each chunk of a MULTI-chunk document (the indexer enforces that gate —
 * FR-012), generate 1–3 sentences situating the chunk within its parent
 * document. The preamble is embedded AND keyword-indexed with the chunk
 * (composed into embedded_text by the indexer), so a query can match on
 * context the bare chunk text never contained.
 *
 * Cost lever (FR-017): the document is sent ONCE per batch of ≤25 chunks —
 * document tokens amortize across all its chunks — and the document input is
 * capped at 120K chars.
 *
 * Model comes from the chat-models registry (getContextualizerModel —
 * Constitution: provider behavior lives in one place). Fails soft (FR-016):
 * on any error the affected chunks get empty preambles; nothing ever blocks
 * indexing or search.
 *
 * Re-ported from the reference-only rag-search-v2 branch (never merged).
 */

const { generateObject, jsonSchema } = require('ai');
const { getContextualizerModel } = require('../api/chat-models');

const MAX_CHUNKS_PER_CALL = 25; // bound a single structured response
const MAX_DOC_CHARS = 120_000; // defensive cap on the document we send

const contextsSchema = jsonSchema({
  type: 'object',
  properties: {
    contexts: { type: 'array', items: { type: 'string' } },
  },
  required: ['contexts'],
  additionalProperties: false,
});

function buildPrompt(docTitle, fullText, batch) {
  const doc = fullText.length > MAX_DOC_CHARS ? fullText.slice(0, MAX_DOC_CHARS) : fullText;
  const chunkList = batch
    .map((c, i) => {
      const section = (c.headingPath && c.headingPath.length) ? c.headingPath.join(' > ') : '(no section)';
      return `[${i + 1}] section: ${section}\n${c.text}`;
    })
    .join('\n\n');

  return [
    'You improve search retrieval by writing contextual preambles for document chunks.',
    `Below is a full document (title: ${docTitle || 'Untitled'}), then ${batch.length} chunk(s) taken from it.`,
    'For EACH chunk, write a concise 1-3 sentence context that situates it within the whole document',
    '(its section, the entities / time period / subject it refers to) so the chunk is self-contained for search.',
    'Do not summarize the whole document; add only context the chunk itself lacks. If a chunk is already',
    'self-contained, return a short empty-ish note. Return a "contexts" array of exactly',
    `${batch.length} string(s), in the same order as the chunks.`,
    '',
    `<document>\n${doc}\n</document>`,
    '',
    `Chunks:\n${chunkList}`,
  ].join('\n');
}

async function contextualizeBatch(docTitle, fullText, batch) {
  const model = getContextualizerModel();
  const { object } = await generateObject({
    model,
    schema: contextsSchema,
    prompt: buildPrompt(docTitle, fullText, batch),
  });
  const contexts = Array.isArray(object && object.contexts) ? object.contexts : [];
  // Align length defensively: same order and count as the batch.
  return batch.map((_, i) => (typeof contexts[i] === 'string' ? contexts[i].trim() : ''));
}

/**
 * Generate situating context for each chunk of a document.
 * @param {{docTitle: string, fullText: string, chunks: Array<{text, headingPath}>}} args
 * @returns {Promise<string[]>} context per chunk (same order; '' where unavailable)
 */
async function contextualizeChunks({ docTitle, fullText, chunks }) {
  if (!chunks || chunks.length === 0) return [];
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) return chunks.map(() => '');

  const out = [];
  for (let i = 0; i < chunks.length; i += MAX_CHUNKS_PER_CALL) {
    const batch = chunks.slice(i, i + MAX_CHUNKS_PER_CALL);
    try {
      out.push(...(await contextualizeBatch(docTitle, fullText, batch)));
    } catch (err) {
      // Per-batch fail-soft: never the doc title or content in logs.
      console.warn(`[Contextualizer] batch failed (${batch.length} chunks): ${err.message}`);
      out.push(...batch.map(() => ''));
    }
  }
  return out;
}

module.exports = { contextualizeChunks, MAX_CHUNKS_PER_CALL, MAX_DOC_CHARS };
