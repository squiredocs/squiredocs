/**
 * Shared search-pipeline configuration surface (feature 018, FR-026).
 *
 * The ONE place that resolves search knobs: the indexer, search.js, and the
 * eval harness all call `getSearchConfig(overrides)`. The harness expresses
 * variants as `overrides`, so an evaluated variant is exactly reproducible as
 * a shipped configuration — what is measured is what ships.
 *
 * Contract: specs/018-search-chunking-and-eval/contracts/search-config.md
 * No other file may read these env vars directly.
 *
 *   SEARCH_PREAMBLES     on | off   (default on)  — contextual preambles at index time
 *   SEARCH_RERANK        on | off   (default OFF) — LLM reranker stage (FR-030: flag-only)
 *   SEARCH_CHUNK_TOKENS  integer    (default 600) — structure-aware chunk target size
 *
 * `chunking` ('structure' | 'fixed') is override-only: the live pipeline is
 * always 'structure'; 'fixed' reproduces the pre-018 window chunker solely for
 * the eval baseline variant (plan D12). headingFillRatio / overlapRatio /
 * distanceThreshold are override-only tuning knobs (RBD-1).
 */

const DEFAULTS = {
  chunking: 'structure',
  preambles: true,
  rerank: false,
  chunkTargetTokens: 600,
  headingFillRatio: 0.5,
  overlapRatio: 0.12,
  distanceThreshold: 0.5,
};

function asBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|on|yes)$/i.test(String(value));
}

function asInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve the effective search config: override → env → default, per knob.
 * @param {object} overrides - per-call knob overrides (eval variants)
 * @returns {{chunking: string, preambles: boolean, rerank: boolean,
 *   chunkTargetTokens: number, headingFillRatio: number, overlapRatio: number,
 *   distanceThreshold: number}}
 */
function getSearchConfig(overrides = {}) {
  return {
    chunking: overrides.chunking !== undefined ? overrides.chunking : DEFAULTS.chunking,
    preambles: overrides.preambles !== undefined
      ? overrides.preambles
      : asBool(process.env.SEARCH_PREAMBLES, DEFAULTS.preambles),
    rerank: overrides.rerank !== undefined
      ? overrides.rerank
      : asBool(process.env.SEARCH_RERANK, DEFAULTS.rerank),
    chunkTargetTokens: overrides.chunkTargetTokens !== undefined
      ? overrides.chunkTargetTokens
      : asInt(process.env.SEARCH_CHUNK_TOKENS, DEFAULTS.chunkTargetTokens),
    headingFillRatio: overrides.headingFillRatio !== undefined
      ? overrides.headingFillRatio
      : DEFAULTS.headingFillRatio,
    overlapRatio: overrides.overlapRatio !== undefined
      ? overrides.overlapRatio
      : DEFAULTS.overlapRatio,
    distanceThreshold: overrides.distanceThreshold !== undefined
      ? overrides.distanceThreshold
      : DEFAULTS.distanceThreshold,
  };
}

module.exports = { getSearchConfig, DEFAULTS };
