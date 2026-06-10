#!/usr/bin/env node

/**
 * show-cache-savings.js
 *
 * Inspect Anthropic prompt-caching effectiveness for recent chat requests by
 * reading the ai_usage_log table. For each completed request it shows the cache
 * reads/writes, the cache hit rate, the (already-discounted) cost that was
 * recorded, and the estimated savings versus an uncached request — plus a
 * rolling summary.
 *
 * Use --watch to tail new rows live: start it, then run a chat in the app and
 * watch each turn's cache activity appear. The first turn of a conversation is
 * mostly cache WRITES (a small premium, shown as negative savings); subsequent
 * turns and agentic steps are cache READS, where the savings show up.
 *
 * Only Anthropic (claude-*) requests use caching — Gemini rows always show zero
 * cache activity, so they're hidden unless you pass --all.
 *
 * Usage:
 *   node script/show-cache-savings.js                  # last 15 min, claude-* only
 *   node script/show-cache-savings.js --watch          # tail new rows live (Ctrl-C to stop)
 *   node script/show-cache-savings.js --since 60       # widen the look-back window (minutes)
 *   node script/show-cache-savings.js --chat <chatId>  # only one chat
 *   node script/show-cache-savings.js --all            # include non-Anthropic rows
 *
 * Connects using the same env as the app and migrations (DATABASE_URL, or the
 * DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD vars).
 */

require('dotenv').config({ quiet: true });
require('./setup-db-env.js'); // builds DATABASE_URL from DB_* vars if unset

const { Pool } = require('pg');
const { MODEL_DEFS } = require('../server/api/chat-models');
const { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER } = require('../server/ai-usage');

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { watch: false, since: 15, chat: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--watch') opts.watch = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--since') opts.since = parseInt(argv[++i], 10) || 15;
    else if (a === '--chat') opts.chat = argv[++i] || null;
    else if (a === '--help' || a === '-h') opts.help = true;
    else { console.error(`Unknown argument: ${a}`); opts.help = true; }
  }
  return opts;
}

function usage() {
  console.log(`Usage: node script/show-cache-savings.js [--watch] [--since <min>] [--chat <id>] [--all]

  --watch         tail new rows live (Ctrl-C to stop)
  --since <min>   look-back window in minutes (default 15)
  --chat <id>     only show rows for one chat_id
  --all           include non-Anthropic (Gemini) rows, which never cache`);
}

// ── pricing / savings ────────────────────────────────────────────────────────
const inputRateByModel = Object.fromEntries(
  MODEL_DEFS.map((d) => [d.key, d.pricing.input]) // cents per 1M input tokens
);

// Estimated cents saved vs. an uncached request, in fractional cents.
// Uncached would price every input token at the base rate; caching prices reads
// at READ_MULT and writes at WRITE_MULT, so the per-token deltas are:
//   read  saves (1 - READ_MULT)  of the base rate
//   write costs (WRITE_MULT - 1) of the base rate (a premium, paid back by reads)
function savedCents(modelKey, cacheRead, cacheWrite) {
  const rate = inputRateByModel[modelKey];
  if (!rate) return 0;
  const readSave = cacheRead * (1 - CACHE_READ_MULTIPLIER);
  const writeCost = cacheWrite * (CACHE_WRITE_MULTIPLIER - 1);
  return (rate / 1_000_000) * (readSave - writeCost);
}

// ── formatting ───────────────────────────────────────────────────────────────
const n = (x) => Number(x).toLocaleString();
const pad = (s, w) => String(s).padStart(w);
const padr = (s, w) => String(s).padEnd(w);

function header() {
  return padr('time', 8) + ' ' + padr('model', 14) + ' ' + padr('key', 4) + ' ' +
    pad('input', 9) + ' ' + pad('output', 8) + ' ' + pad('cacheR', 9) + ' ' + pad('cacheW', 9) + ' ' +
    pad('hit%', 6) + ' ' + pad('cost¢', 7) + ' ' + pad('saved¢', 9);
}

function rowLine(r) {
  const input = r.input_tokens;
  const cR = r.cache_read_input_tokens;
  const cW = r.cache_creation_input_tokens;
  const hit = input > 0 ? ((cR / input) * 100).toFixed(0) + '%' : '-';
  const saved = savedCents(r.model_key, cR, cW);
  const time = new Date(r.created_at).toISOString().slice(11, 19);
  return padr(time, 8) + ' ' + padr(r.model_key, 14) + ' ' +
    padr(r.is_byok ? 'byok' : 'shrd', 4) + ' ' +
    pad(n(input), 9) + ' ' + pad(n(r.output_tokens), 8) + ' ' + pad(n(cR), 9) + ' ' + pad(n(cW), 9) + ' ' +
    pad(hit, 6) + ' ' + pad(n(r.cost_cents), 7) + ' ' + pad(saved.toFixed(2), 9);
}

// ── totals ───────────────────────────────────────────────────────────────────
const totals = { rows: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, saved: 0, uncached: 0 };

function accumulate(r) {
  totals.rows += 1;
  totals.input += r.input_tokens;
  totals.output += r.output_tokens;
  totals.cacheRead += r.cache_read_input_tokens;
  totals.cacheWrite += r.cache_creation_input_tokens;
  totals.cost += r.cost_cents;
  totals.saved += savedCents(r.model_key, r.cache_read_input_tokens, r.cache_creation_input_tokens);
  const rate = inputRateByModel[r.model_key] || 0;
  totals.uncached += (rate / 1_000_000) * r.input_tokens; // input-only, fractional cents
}

function printSummary() {
  if (totals.rows === 0) {
    console.log('\nNo completed chat requests in range yet.');
    return;
  }
  const hit = totals.input > 0 ? ((totals.cacheRead / totals.input) * 100).toFixed(1) : '0';
  const pctSaved = totals.uncached > 0 ? ((totals.saved / totals.uncached) * 100).toFixed(1) : '0';
  const dollars = (cents) => '$' + (cents / 100).toFixed(2);
  console.log('\n' + '─'.repeat(72));
  console.log(`requests: ${totals.rows}   input: ${n(totals.input)}   output: ${n(totals.output)}   ` +
    `cache reads: ${n(totals.cacheRead)}   writes: ${n(totals.cacheWrite)}`);
  console.log(`overall cache hit rate: ${hit}% of input tokens`);
  console.log(`total recorded cost: ${totals.cost}¢ (${dollars(totals.cost)})   ` +
    `est. uncached input cost: ${totals.uncached.toFixed(2)}¢   ` +
    `est. saved: ${totals.saved.toFixed(2)}¢ (${dollars(totals.saved)}, ${pctSaved}% of input cost)`);
  console.log('note: savings are estimates from MODEL_DEFS rates; for BYOK rows the dollars are the user\'s own Anthropic bill.');
}

// ── queries ──────────────────────────────────────────────────────────────────
function buildWhere(opts, idClause) {
  const where = [`model_key <> 'reserved'`];
  const params = [];
  if (idClause) { params.push(idClause); where.push(`id > $${params.length}`); }
  else { params.push(opts.since); where.push(`created_at >= now() - make_interval(mins => $${params.length}::int)`); }
  if (!opts.all) where.push(`model_key LIKE 'claude-%'`);
  if (opts.chat) { params.push(opts.chat); where.push(`chat_id = $${params.length}`); }
  return { where: where.join(' AND '), params };
}

const COLS = `id, created_at, model_key, is_byok, input_tokens, output_tokens,
              cost_cents, cache_read_input_tokens, cache_creation_input_tokens, chat_id`;

// Human-readable connection target (host:port/db, no credentials) so it's
// obvious which database you're actually looking at.
function describeTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return process.env.DATABASE_URL || '(DATABASE_URL unset)';
  }
}

// Verify the cache columns exist before querying, so a missing migration gives
// an actionable message instead of a raw "column does not exist" stack trace.
async function ensureColumns(pool) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'ai_usage_log' AND column_name = 'cache_read_input_tokens'`
  );
  if (rows.length === 0) {
    console.error(
      `\nThis database is missing the prompt-cache columns on ai_usage_log — the\n` +
      `migration 1780000000000_add-cache-token-columns has not been applied here.\n\n` +
      `  Connected to: ${describeTarget()}\n\n` +
      `Either run \`npm run migrate\` against this database, or point DATABASE_URL /\n` +
      `the DB_* vars at the database your chats actually write to (e.g. production).`
    );
    return false;
  }
  return true;
}

async function fetchRows(pool, opts, afterId) {
  const { where, params } = buildWhere(opts, afterId);
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM ai_usage_log WHERE ${where} ORDER BY id ASC`, params
  );
  return rows;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return; }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`DB: ${describeTarget()}`);

  if (!(await ensureColumns(pool))) { await pool.end(); process.exitCode = 1; return; }

  const initial = await fetchRows(pool, opts);
  console.log(header());
  initial.forEach((r) => { console.log(rowLine(r)); accumulate(r); });

  if (!opts.watch) {
    printSummary();
    await pool.end();
    return;
  }

  // Watch mode: poll for newer rows and print them as they land.
  let lastId = initial.length ? initial[initial.length - 1].id : 0;
  console.log(`\n👀 watching for new requests (--since ${opts.since}m baseline above)... Ctrl-C to stop\n`);

  const tick = async () => {
    try {
      const fresh = await fetchRows(pool, opts, lastId);
      for (const r of fresh) { console.log(rowLine(r)); accumulate(r); lastId = r.id; }
    } catch (err) {
      console.error('[show-cache-savings] poll error:', err.message);
    }
  };
  const interval = setInterval(tick, 2000);

  await new Promise((resolve) => {
    process.on('SIGINT', () => { clearInterval(interval); resolve(); });
  });
  printSummary();
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
