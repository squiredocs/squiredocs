#!/usr/bin/env node
/**
 * Feature 030 US5 (T028–T031, FR-029/030/031/033, RBD-3/11/12) — the sign-off
 * matrix runner and M2 exit gate (half of it).
 *
 * Runs the 11 matrix cells (matrix-cells.mjs) SERIALLY in the dev pod — no
 * concurrency, backend-DB-touching activity is serial (constitution II). Each
 * cell drives the 029 harness in its mode/fixture/turns, grades the structured
 * transcript against the cell's expected-outcome PROFILE (required items pass /
 * exempt items ignored / cell-specific assertions pass), and archives the
 * transcript + grade. Exit is non-zero unless EVERY cell matches its profile
 * with its model leg completed.
 *
 * --require-claude is ALWAYS in force (RBD-3): a cell whose model leg failed or
 * was skipped fails the gate, and with ANTHROPIC_API_KEY absent the runner
 * REFUSES to run rather than skipping legs.
 *
 * Usage:
 *   node test/first-run/matrix-runner.mjs [--server http://localhost:3001]
 *        [--cells fresh-happy,shape-kiro] [--keep]
 *
 * Account-count assertion (existing-never-consented) needs DATABASE_URL pointed
 * at the dev server's DB.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runRehearsal } from './rehearsal-harness.mjs';
import { captureContainsSecret } from './capture.mjs';
import { formatReport } from './grade-transcript.mjs';
import { CELLS } from './matrix-cells.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

function arg(name, fb) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fb;
}
const has = (n) => process.argv.includes(n);

const SERVER = arg('--server', process.env.DEV_SERVER || 'http://localhost:3001').replace(/\/$/, '');
const KEEP = has('--keep');
const only = arg('--cells', null);
const selected = only ? new Set(only.split(',').map((s) => s.trim())) : null;

/** Count users rows for an email (find-or-create no-duplicate assertion, T030). */
async function countAccounts(email) {
  const conn = process.env.DATABASE_URL;
  if (!conn) return { count: null, note: 'DATABASE_URL not set — cannot verify account count' };
  const pool = new pg.Pool({ connectionString: conn });
  try {
    const r = await pool.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
    return { count: r.rows[0].n };
  } catch (e) {
    return { count: null, note: `account count query failed: ${e.message}` };
  } finally {
    await pool.end();
  }
}

function evaluateProfile(cell, ctx) {
  const { grade } = ctx;
  const itemPass = (id) => grade.items.find((x) => x.id === id)?.pass === true;
  const requiredResults = cell.profile.required.map((id) => ({ id, pass: itemPass(id) }));
  const assertionResults = cell.profile.assertions.map((a) => {
    let out;
    try { out = a.check(ctx); } catch (e) { out = { pass: false, detail: `assertion threw: ${e.message}` }; }
    return { name: a.name, pass: !!out.pass, detail: out.detail };
  });
  const requiredOk = requiredResults.every((r) => r.pass);
  const assertionsOk = assertionResults.every((r) => r.pass);
  return { requiredResults, assertionResults, requiredOk, assertionsOk, pass: requiredOk && assertionsOk };
}

async function main() {
  // --require-claude always on (RBD-3): refuse to run without model access.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('✗ ANTHROPIC_API_KEY is not set — the matrix gate refuses to run rather than skipping model legs (--require-claude, RBD-3).');
    process.exit(2);
  }

  const cells = CELLS.filter((c) => !selected || selected.has(c.id));
  if (cells.length === 0) { console.error(`no matching cells for --cells ${only}`); process.exit(2); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(HERE, 'matrix-archive', `run-${stamp}`);
  fs.mkdirSync(archiveDir, { recursive: true });

  console.log(`\nSquire Docs sign-off matrix → ${SERVER}`);
  console.log(`cells: ${cells.length}/${CELLS.length}  ·  archive: ${path.relative(REPO_ROOT, archiveDir)}\n`);

  const summary = [];
  for (const cell of cells) {
    console.log(`\n━━━ cell: ${cell.id} (${cell.name}) ━━━`);
    const fixtureDir = path.join(HERE, 'repo-fixtures', cell.fixture);
    let result;
    try {
      result = await runRehearsal({
        server: SERVER, mode: cell.mode, connect: cell.connect, fixtureDir,
        userTurns: cell.userTurns, setup: cell.setup, prompt: cell.prompt,
        keep: KEEP, requireClaude: true,
      });
    } catch (e) {
      console.error(`  ✗ harness error: ${e.message}`);
      summary.push({ id: cell.id, pass: false, reason: `harness error: ${e.message}`, claudeStatus: 'error' });
      continue;
    }

    // Archive transcript first (Sam's review material), even on grade failure.
    fs.writeFileSync(path.join(archiveDir, `${cell.id}.transcript.jsonl`), result.capture.raw);

    // --require-claude (T029): an incomplete model leg is an invalid cell.
    const modelOk = result.claudeStatus === 'completed';

    // Cell-specific inputs: token-leak scan (T031), account count (T030).
    let tokenLeaked;
    if (cell.mode === 'token-fallback') {
      tokenLeaked = captureContainsSecret(result.capture.raw, result.tokenSecret || '');
    }
    let accountCount;
    if (cell.setup === 'faucet-premint' && result.email) {
      const c = await countAccounts(result.email);
      accountCount = c.count;
      if (c.note) console.log(`  • ${c.note}`);
    }

    const ctx = { grade: result.grade, capture: result.capture, serverOrigin: result.serverOrigin, accountCount, tokenLeaked };
    const evalResult = evaluateProfile(cell, ctx);
    const pass = modelOk && evalResult.pass;

    console.log(`  model leg: ${result.claudeStatus}`);
    console.log(formatReport(result.grade).split('\n').map((l) => '  ' + l).join('\n'));
    console.log(`  required [${cell.profile.required.join(',')}]: ${evalResult.requiredResults.map((r) => `${r.id}:${r.pass ? 'ok' : 'MISS'}`).join(' ')}`);
    for (const a of evalResult.assertionResults) console.log(`  assert ${a.pass ? '✓' : '✗'} ${a.name}${a.detail ? ` — ${a.detail}` : ''}`);
    console.log(`  → cell ${pass ? 'PASS' : 'FAIL'}${!modelOk ? ' (model leg incomplete)' : ''}`);

    fs.writeFileSync(path.join(archiveDir, `${cell.id}.grade.json`), JSON.stringify({
      cell: cell.id, name: cell.name, claudeStatus: result.claudeStatus, pass,
      grade: result.grade, profile: cell.profile.required, eval: evalResult, accountCount, tokenLeaked,
    }, null, 2));

    const reason = !modelOk ? `model leg ${result.claudeStatus}`
      : !evalResult.requiredOk ? `required item(s) missed: ${evalResult.requiredResults.filter((r) => !r.pass).map((r) => r.id).join(',')}`
      : !evalResult.assertionsOk ? `assertion(s) failed: ${evalResult.assertionResults.filter((r) => !r.pass).map((r) => r.name).join('; ')}`
      : 'ok';
    summary.push({ id: cell.id, pass, reason, claudeStatus: result.claudeStatus });

    if (!KEEP) await result.cleanup();
  }

  // Summary + gate.
  console.log(`\n\n══════ MATRIX SUMMARY ══════`);
  for (const s of summary) console.log(`  ${s.pass ? 'PASS' : 'FAIL'}  ${s.id.padEnd(28)} ${s.pass ? '' : '— ' + s.reason}`);
  const passed = summary.filter((s) => s.pass).length;
  fs.writeFileSync(path.join(archiveDir, 'summary.json'), JSON.stringify({ server: SERVER, when: stamp, summary, passed, total: summary.length }, null, 2));
  console.log(`\n${passed}/${summary.length} cells match their profile.`);
  console.log(`archive: ${path.relative(REPO_ROOT, archiveDir)}`);

  const clean = passed === summary.length && (!selected || selected.size === CELLS.length);
  if (passed !== summary.length) {
    console.error(`\n✗ matrix gate: ${summary.length - passed} cell(s) missed their profile.`);
    process.exit(1);
  }
  if (!clean) {
    console.log(`\n(subset run — a "clean matrix" exit artifact (SC-002) is the full ${CELLS.length}-cell run.)`);
  } else {
    console.log(`\n✓ clean full-matrix run — all ${CELLS.length} cells match their profiles (SC-002, exit gate part a).`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(`\n✗ matrix runner failed: ${e.stack || e}`); process.exit(1); });
