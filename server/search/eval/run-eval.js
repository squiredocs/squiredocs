#!/usr/bin/env node
/**
 * Search evaluation harness (feature 018 US3 — FR-023…FR-026, SC-008).
 *
 * One command → one per-variant metric table over the curated eval set:
 *
 *   npm run search:eval                    # minimum sweep (re-indexes per variant):
 *                                          #   fixed → structure (no preambles) → structure+preambles
 *   npm run search:eval -- --rerank        # adds the explicitly flagged reranker variant (FR-030)
 *   npm run search:eval -- --variant=NAME  # evaluate one variant against the CURRENT index (no re-index)
 *   npm run search:eval -- --limit=N       # only the first N queries (fast iteration)
 *   npm run search:eval -- --budget=8000   # token budget for recall@budget
 *   npm run search:eval -- --user=<uuid|email>  # overrides the eval set's userId
 *
 * Requirements: GOOGLE_GENERATIVE_AI_API_KEY, a populated corpus, migrated DB.
 * Operator tool — NEVER run in CI (RBD-6). Variants are getSearchConfig
 * overrides (FR-026): what is measured is exactly reproducible as a shipped
 * configuration. Per-variant re-indexing goes through the real indexer
 * (reindexAllForEval), the same code path production uses.
 *
 * Output: the printed FR-024 table AND eval-results.<timestamp>.json beside
 * this script (git-ignored) — consumed by check-eval-set.js for the
 * saturation-guard verdict (SC-009) and by promotion notes (SC-010).
 *
 * Re-ported from the reference-only rag-search-v2 branch (never merged).
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { PostgresPersistence } = require('../../postgres-persistence');
const search = require('../../search');
const searchIndexer = require('../../search-indexer');
const metrics = require('./metrics');

const FALLBACK_RESULT_TOKENS = 600; // per-result cost when no token_estimate is stored

function flag(name) { return process.argv.slice(2).includes(`--${name}`); }
function arg(name, fallback) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : fallback;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function loadEvalSet() {
  const jsonPath = path.join(__dirname, 'eval-set.json');
  if (!fs.existsSync(jsonPath)) {
    fail('server/search/eval/eval-set.json not found — the curated set must be committed (FR-027). There is no draft fallback.');
  }
  const evalSet = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  console.log(`Eval set: version ${evalSet.version} (${evalSet.date}, corpus ${evalSet.corpus}), ${evalSet.queries.length} queries`);
  return evalSet;
}

// The minimum sweep (FR-025): old fixed-window baseline → new chunking
// without preambles → new chunking with preambles. Each entry's `overrides`
// IS the shipped-configuration expression of the variant (FR-026).
const SWEEP = [
  { name: 'fixed (baseline)', reindex: true, overrides: { chunking: 'fixed', preambles: false, rerank: false } },
  { name: 'structure', reindex: true, overrides: { chunking: 'structure', preambles: false, rerank: false } },
  { name: 'structure+preambles', reindex: true, overrides: { chunking: 'structure', preambles: true, rerank: false } },
];
const RERANK_VARIANT = {
  // Explicitly flagged (FR-030): rides the structure+preambles index, adds the
  // LLM rerank stage at query time. Never part of the default sweep.
  name: 'structure+preambles+rerank', reindex: false, overrides: { chunking: 'structure', preambles: true, rerank: true },
};
const NAMED_VARIANTS = {
  fixed: SWEEP[0],
  structure: SWEEP[1],
  'structure-preambles': SWEEP[2],
  rerank: RERANK_VARIANT,
};

const CONCURRENCY = 5; // parallel queries per variant

/** Map over items with a fixed concurrency limit, preserving order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Per-result token cost: sum of the doc's stored token_estimate, else fallback. */
async function docTokenCosts(pool, docIds) {
  if (docIds.length === 0) return new Map();
  const r = await pool.query(
    `SELECT doc_id, SUM(token_estimate)::int AS toks
     FROM document_embeddings WHERE doc_id = ANY($1) GROUP BY doc_id`,
    [docIds]
  );
  const map = new Map();
  for (const row of r.rows) {
    if (row.toks != null) map.set(row.doc_id, row.toks);
  }
  return map;
}

async function evaluateVariant(pool, label, userId, queries, overrides, budget) {
  const t0 = Date.now();
  const entries = await mapLimit(queries, CONCURRENCY, async (q) => {
    const { rows } = await search.searchDocuments(userId, q.query, {
      mode: 'hybrid',
      limit: 20,
      configOverrides: overrides,
    });
    const ranked = rows.map((r) => r.doc_id);
    const costMap = await docTokenCosts(pool, ranked);
    return {
      ranked,
      relevant: q.relevantDocIds || [],
      costs: ranked.map((id) => costMap.get(id) || FALLBACK_RESULT_TOKENS),
      type: q.type,
    };
  });
  process.stderr.write(`  ${label}: ${queries.length} queries in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  return metrics.aggregate(entries, { tokenBudget: budget });
}

const METRIC_COLS = [
  ['recallAt5', 'R@5'],
  ['recallAt10', 'R@10'],
  ['recallAt20', 'R@20'],
  ['mrr', 'MRR'],
  ['ndcgAt10', 'nDCG@10'],
  ['recallAtBudget', 'R@budget'],
];

function printTable(results) {
  const labelWidth = Math.max(...results.map((r) => r.name.length), 12);
  const header = 'variant'.padEnd(labelWidth) + ' | ' + METRIC_COLS.map(([, h]) => h.padStart(8)).join(' | ') + ' | ' + 'noAns'.padStart(6);
  console.log('\n' + header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    const cells = METRIC_COLS.map(([key]) => (r.metrics[key] ?? 0).toFixed(3).padStart(8)).join(' | ');
    const noAns = r.metrics.noAnswerAccuracy == null ? '—'.padStart(6) : r.metrics.noAnswerAccuracy.toFixed(3).padStart(6);
    console.log(r.name.padEnd(labelWidth) + ' | ' + cells + ' | ' + noAns);
  }
  const m0 = results[0].metrics;
  console.log(`\nanswerable queries: ${m0.answerable} / ${m0.queries} (no-answer: ${m0.noAnswer}, scored separately)`);
}

async function resolveUserId(pool, evalSet) {
  const requested = arg('user', evalSet.userId);
  if (!requested) {
    fail('no user to search as — set "userId" in eval-set.json or pass --user=<uuid|email>');
  }
  const byId = await pool.query('SELECT id FROM users WHERE id::text = $1 OR email = $1', [requested]);
  if (byId.rows.length === 0) fail(`user not found in this database: ${requested}`);
  return byId.rows[0].id;
}

/**
 * Deleted expected docs are reported, not scored as misses (spec edge case):
 * a query whose refs ALL vanished is skipped; one with some refs missing is
 * degraded (scored against the surviving refs).
 */
async function auditQueryRefs(pool, queries) {
  const allRefs = [...new Set(queries.flatMap((q) => q.relevantDocIds || []))];
  const existing = new Set();
  if (allRefs.length > 0) {
    const r = await pool.query('SELECT id FROM documents WHERE id = ANY($1)', [allRefs]);
    for (const row of r.rows) existing.add(row.id);
  }
  const kept = [];
  const skipped = [];
  const degraded = [];
  for (const q of queries) {
    const refs = q.relevantDocIds || [];
    const alive = refs.filter((id) => existing.has(id));
    if (refs.length > 0 && alive.length === 0) {
      skipped.push({ id: q.id, query: q.query, missing: refs });
    } else if (alive.length < refs.length) {
      degraded.push({ id: q.id, missing: refs.filter((id) => !existing.has(id)) });
      kept.push({ ...q, relevantDocIds: alive });
    } else {
      kept.push(q);
    }
  }
  return { kept, skipped, degraded };
}

async function main() {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    fail('GOOGLE_GENERATIVE_AI_API_KEY is required — the harness never silently measures fulltext-only.');
  }

  const evalSet = loadEvalSet();
  let queries = evalSet.queries || [];
  const limit = arg('limit', null);
  if (limit) queries = queries.slice(0, parseInt(limit, 10));
  const budget = parseInt(arg('budget', '8000'), 10);

  const dbConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'collab_db',
      user: process.env.DB_USER || process.env.USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
    };
  const pool = new Pool(dbConfig);
  const persistence = new PostgresPersistence(dbConfig, { statementTimeout: false });
  search.init(pool);
  searchIndexer.init(persistence);

  const results = [];
  try {
    const userId = await resolveUserId(pool, evalSet);
    const { kept, skipped, degraded } = await auditQueryRefs(pool, queries);
    if (skipped.length > 0) {
      console.warn(`SKIPPED ${skipped.length} query(ies) whose expected documents were deleted:`);
      for (const s of skipped) console.warn(`  - ${s.id}: all of [${s.missing.join(', ')}] missing`);
    }
    if (degraded.length > 0) {
      console.warn(`DEGRADED ${degraded.length} query(ies) (some expected documents deleted):`);
      for (const d of degraded) console.warn(`  - ${d.id}: missing [${d.missing.join(', ')}]`);
    }
    console.log(`Evaluating ${kept.length} queries (budget ${budget} tokens)\n`);

    const singleVariant = arg('variant', null);
    let plan;
    if (singleVariant) {
      const v = NAMED_VARIANTS[singleVariant];
      if (!v) fail(`unknown --variant=${singleVariant} (known: ${Object.keys(NAMED_VARIANTS).join(', ')})`);
      // Fast iteration: evaluate against the CURRENT index, no re-indexing.
      plan = [{ ...v, reindex: false }];
    } else {
      plan = [...SWEEP];
      if (flag('rerank')) plan.push(RERANK_VARIANT);
    }

    // Post-merge review F1: if the sweep dies after a non-shipped re-index
    // (Ctrl-C, crash, usage-limit kill), the corpus must not stay on a
    // degraded variant. Fixed-baseline rows are now written as legacy-marker
    // rows (self-healing via reindexStale), but restore the shipped config
    // immediately anyway rather than waiting for the next boot/edit.
    let corpusOnNonShippedVariant = false;
    try {
    for (const variant of plan) {
      if (variant.reindex) {
        process.stdout.write(`Re-indexing corpus for variant '${variant.name}'... `);
        const summary = await searchIndexer.reindexAllForEval(variant.overrides);
        console.log(`${summary.done}/${summary.total} docs (${summary.failed} failed)`);
        corpusOnNonShippedVariant =
          variant.overrides.chunking !== 'structure' || variant.overrides.preambles !== true;
      }
      // Fail fast if semantic search is unavailable (spec edge case): with no
      // embedding rows the engine would silently fall back to fulltext and
      // mislabel the measurement.
      const has = await pool.query('SELECT EXISTS(SELECT 1 FROM document_embeddings) AS ok');
      if (!has.rows[0].ok) {
        fail('no embeddings exist — semantic search unavailable; refusing to measure fulltext-only. Populate the corpus / check the API key.');
      }
      search._resetCache();
      results.push({
        name: variant.name,
        config: variant.overrides,
        metrics: await evaluateVariant(pool, variant.name, userId, kept, variant.overrides, budget),
      });
    }
    } finally {
      // Restore the shipped config no matter how the sweep ended (F1).
      if (corpusOnNonShippedVariant) {
        process.stdout.write('Restoring shipped index config... ');
        const summary = await searchIndexer.reindexAllForEval(undefined).catch((e) => {
          console.error(`RESTORE FAILED (${e.message}) — corpus rows carry the legacy marker and self-heal via reindexStale on next boot.`);
          return null;
        });
        if (summary) console.log(`${summary.done}/${summary.total} docs restored`);
      }
    }

    printTable(results);

    const outPath = path.join(__dirname, `eval-results.${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      evalSetVersion: evalSet.version,
      corpus: evalSet.corpus,
      budget,
      queryCount: kept.length,
      skipped,
      degraded,
      variants: results.map((r) => ({ name: r.name, config: r.config, metrics: r.metrics })),
    }, null, 2));
    console.log(`\nResults written to ${outPath}`);
    console.log('Saturation-guard verdict: npm run search:eval:check ' + path.basename(outPath));
  } finally {
    await persistence.destroy().catch(() => {});
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
