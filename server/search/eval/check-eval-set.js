#!/usr/bin/env node
/**
 * Eval-set checker (feature 018 US4 — FR-027/FR-028, RBD-5, SC-009).
 *
 *   npm run search:eval:check                       # composition audit (offline, no API)
 *   npm run search:eval:check eval-results.<ts>.json  # saturation-guard verdict
 *
 * Composition minimums (RBD-5): ≥ 40 queries total, ≥ 12 paraphrase/conceptual,
 * ≥ 6 multi-doc (each with ≥ 2 relevant refs), ≥ 6 no-answer (each with 0 refs).
 *
 * Saturation guard (FR-028): the set DISCRIMINATES iff, across the minimum
 * variant sweep, (a) NOT all variants score 1.0 on all of Recall@5/10/20, AND
 * (b) at least one primary metric (Recall@10, MRR, nDCG@10) differs by ≥ 0.03
 * between some pair of variants. A failing guard is a defect in the SET —
 * fixed by adding harder queries — never evidence that the variants are equal
 * (the prior LLM-drafted set failed exactly this way: every variant scored a
 * perfect 1.0 and the reranker's harm was invisible).
 *
 * Exit codes: 0 = pass, 1 = violation (reasons printed).
 */

const fs = require('fs');
const path = require('path');

const MINIMUMS = {
  total: 40,
  paraphrase: 12,
  multiDoc: 6,
  noAnswer: 6,
};
const VALID_TYPES = ['paraphrase', 'multi-doc', 'no-answer', 'keyword'];
const PRIMARY_METRICS = ['recallAt10', 'mrr', 'ndcgAt10'];
const SATURATION_METRICS = ['recallAt5', 'recallAt10', 'recallAt20'];
const MIN_SPREAD = 0.03;

/**
 * Audit the eval set's composition (pure — FR-027/RBD-5).
 * @returns {{ ok: boolean, problems: string[] }}
 */
function auditComposition(evalSet) {
  const problems = [];
  const queries = (evalSet && evalSet.queries) || [];

  if (!evalSet || !evalSet.version) problems.push('eval set must carry a version');
  for (const q of queries) {
    if (!q || typeof q.query !== 'string' || !q.query.trim()) {
      problems.push(`query record ${q && q.id ? q.id : '(unidentified)'} lacks query text`);
    }
    if (!q || !VALID_TYPES.includes(q.type)) {
      problems.push(`query record ${q && q.id ? q.id : '(unidentified)'} has invalid type: ${q && q.type}`);
    }
    if (!q || !Array.isArray(q.relevantDocIds)) {
      problems.push(`query record ${q && q.id ? q.id : '(unidentified)'} lacks a relevantDocIds array`);
    }
  }

  const ofType = (t) => queries.filter((q) => q && q.type === t);
  if (queries.length < MINIMUMS.total) {
    problems.push(`only ${queries.length} queries — minimum is ${MINIMUMS.total}`);
  }
  if (ofType('paraphrase').length < MINIMUMS.paraphrase) {
    problems.push(`only ${ofType('paraphrase').length} paraphrase/conceptual queries — minimum is ${MINIMUMS.paraphrase}`);
  }
  if (ofType('multi-doc').length < MINIMUMS.multiDoc) {
    problems.push(`only ${ofType('multi-doc').length} multi-doc queries — minimum is ${MINIMUMS.multiDoc}`);
  }
  if (ofType('no-answer').length < MINIMUMS.noAnswer) {
    problems.push(`only ${ofType('no-answer').length} no-answer queries — minimum is ${MINIMUMS.noAnswer}`);
  }
  for (const q of ofType('multi-doc')) {
    if (!Array.isArray(q.relevantDocIds) || q.relevantDocIds.length < 2) {
      problems.push(`multi-doc query ${q.id} must reference ≥ 2 relevant documents`);
    }
  }
  for (const q of ofType('no-answer')) {
    if (Array.isArray(q.relevantDocIds) && q.relevantDocIds.length > 0) {
      problems.push(`no-answer query ${q.id} must have an EMPTY relevantDocIds array`);
    }
  }
  for (const q of queries) {
    if (q && q.type && q.type !== 'no-answer' && Array.isArray(q.relevantDocIds) && q.relevantDocIds.length === 0) {
      problems.push(`answerable query ${q.id} has no relevant references`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Evaluate the saturation guard over run-eval results (pure — FR-028/SC-009).
 * Verdicts are phrased as SET defects, never as variant equality.
 * @param {{ variants: Array<{ name: string, metrics: object }> }} results
 * @returns {{ ok: boolean, problems: string[] }}
 */
function checkSaturationGuard(results) {
  const problems = [];
  // Post-merge review F3: the guard evaluates ONLY the minimum sweep. A
  // deliberately-bad variant (e.g. the reranker, known to hurt) would
  // manufacture spread and let a saturated set "pass" artificially.
  const variants = ((results && results.variants) || []).filter(
    (v) => !(v.config && v.config.rerank) && !/rerank/i.test(v.name || '')
  );
  if (variants.length < 2) {
    return { ok: false, problems: ['need at least two minimum-sweep variants (rerank variants are excluded from the guard) — run the minimum sweep'] };
  }

  // (a) the documented failure mode: every variant perfect on all Recall@k
  const allSaturated = variants.every((v) =>
    SATURATION_METRICS.every((m) => (v.metrics && v.metrics[m]) === 1)
  );
  if (allSaturated) {
    problems.push(
      'SET DEFECT: every variant scores a perfect 1.0 on Recall@5/10/20 — the set cannot detect improvement or regression. Add harder queries (paraphrase/conceptual, multi-doc, no-answer) and bump the set version.'
    );
  }

  // (b) some primary-metric pair must spread by ≥ MIN_SPREAD
  let maxSpread = 0;
  for (const metric of PRIMARY_METRICS) {
    const vals = variants.map((v) => (v.metrics && v.metrics[metric]) || 0);
    const spread = Math.max(...vals) - Math.min(...vals);
    if (spread > maxSpread) maxSpread = spread;
  }
  // Guard against float noise at the boundary (0.93 - 0.9 must count as 0.03)
  if (maxSpread < MIN_SPREAD - 1e-9) {
    problems.push(
      `SET DEFECT: no primary metric (Recall@10, MRR, nDCG@10) differs by ≥ ${MIN_SPREAD} between any pair of variants (max spread ${maxSpread.toFixed(4)}). The set cannot discriminate — add harder queries and bump the set version.`
    );
  }

  return { ok: problems.length === 0, problems };
}

function main() {
  const resultsArg = process.argv[2];

  if (!resultsArg) {
    const setPath = path.join(__dirname, 'eval-set.json');
    if (!fs.existsSync(setPath)) {
      console.error('server/search/eval/eval-set.json not found — the curated set must be committed (FR-027).');
      process.exit(1);
    }
    const evalSet = JSON.parse(fs.readFileSync(setPath, 'utf8'));
    const verdict = auditComposition(evalSet);
    const counts = {};
    for (const q of evalSet.queries || []) counts[q.type] = (counts[q.type] || 0) + 1;
    console.log(`Eval set version ${evalSet.version} (${evalSet.date}, corpus ${evalSet.corpus}): ${(evalSet.queries || []).length} queries`);
    console.log(`  by type: ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(', ')}`);
    if (!verdict.ok) {
      console.error('\nComposition audit FAILED:');
      for (const p of verdict.problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log('Composition audit PASSED (RBD-5 minimums met).');
    return;
  }

  const resultsPath = path.isAbsolute(resultsArg) ? resultsArg : path.resolve(process.cwd(), resultsArg);
  const fallbackPath = path.join(__dirname, path.basename(resultsArg));
  const usePath = fs.existsSync(resultsPath) ? resultsPath : fallbackPath;
  if (!fs.existsSync(usePath)) {
    console.error(`results file not found: ${resultsArg}`);
    process.exit(1);
  }
  const results = JSON.parse(fs.readFileSync(usePath, 'utf8'));
  const verdict = checkSaturationGuard(results);
  console.log(`Saturation guard over ${path.basename(usePath)} (eval-set version ${results.evalSetVersion}):`);
  if (!verdict.ok) {
    for (const p of verdict.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('  PASSED — the set discriminates (SC-009).');
}

if (require.main === module) main();

module.exports = { auditComposition, checkSaturationGuard, MINIMUMS, MIN_SPREAD };
