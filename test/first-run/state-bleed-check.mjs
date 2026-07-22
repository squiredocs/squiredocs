#!/usr/bin/env node
/**
 * Feature 029 US4 — state-bleed validation (SC-003, Acc 4.6, T025).
 *
 * Runs the rehearsal harness twice and asserts run 2 gets a genuinely new
 * synthetic user and pristine client state — no leftover synthetic rows, no
 * shared scratch config dir. Uses --no-claude so the check is fast and
 * deterministic (the bleed concern is users/config/tokens, not the model leg).
 *
 * Usage: node test/first-run/state-bleed-check.mjs [--server http://localhost:3001]
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = (() => {
  const i = process.argv.indexOf('--server');
  return (i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'http://localhost:3001').replace(/\/$/, '');
})();

function runHarness() {
  const res = spawnSync('node', [path.join(HERE, 'rehearsal-harness.mjs'), '--server', SERVER, '--no-claude'], {
    encoding: 'utf8', timeout: 120000,
  });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (res.status !== 0) {
    console.error(out);
    throw new Error(`harness run exited ${res.status}`);
  }
  const email = (out.match(/synthetic user \+ consent \(auto-approve\) → (\S+)/) || [])[1];
  const scratch = (out.match(/scratch CLAUDE_CONFIG_DIR: (\S+)/) || [])[1];
  return { email, scratch };
}

function fail(msg) { console.error(`\n✗ STATE-BLEED CHECK FAILED: ${msg}`); process.exit(1); }

async function main() {
  console.log(`\nState-bleed validation (two consecutive runs) → ${SERVER}\n`);

  // Start from a clean namespace.
  await fetch(`${SERVER}/auth/dev-wipe-user`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }),
  }).catch(() => {});

  const run1 = runHarness();
  console.log(`  run 1 → user ${run1.email}, config ${run1.scratch}`);
  const run2 = runHarness();
  console.log(`  run 2 → user ${run2.email}, config ${run2.scratch}`);

  if (!run1.email || !run2.email) fail('could not parse synthetic emails from harness output');
  if (run1.email === run2.email) fail(`run 2 reused run 1's synthetic user (${run2.email}) — state bleed`);
  if (!run1.scratch || run1.scratch === run2.scratch) fail('run 2 reused run 1 scratch config dir — state bleed');

  // No synthetic residue survives: each run wiped its user, so a namespace-wide
  // wipe now must find nothing.
  const wipe = await (await fetch(`${SERVER}/auth/dev-wipe-user`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }),
  })).json();
  if (wipe.wiped !== 0) fail(`${wipe.wiped} synthetic row(s) survived the runs — residue/state bleed`);

  console.log(`\n✓ No state bleed: distinct users, distinct scratch configs, zero residual synthetic rows.\n`);
}

main().catch((e) => fail(e.stack || String(e)));
