#!/usr/bin/env node
/**
 * Feature 029 US4 — tier-3 unattended in-pod rehearsal harness (FR-019..025,
 * SC-001/003/008). One command yields a pristine first-run environment and a
 * graded transcript, with zero human interaction.
 *
 * Steps:
 *   1. scratch CLAUDE_CONFIG_DIR (a client that has never seen the plugin/server)
 *   2. throwaway templated copy of the stub bundle with its .mcp.json endpoint
 *      rewritten to the dev server — the SOURCE bundle is never mutated (FR-020)
 *   3. fresh synthetic user minted via the faucet
 *   4. consent completed UNATTENDED via the auto-approve endpoint: the harness
 *      runs the OAuth chain (faucet session -> auto-approve -> token exchange) to
 *      obtain an agent token for the dev server and hands it to the client as a
 *      pre-authorized MCP Authorization header — the harness "completes consent
 *      through the dev auto-approve endpoint" so the whole flow is unattended
 *      (a synthetic user has no real browser)
 *   5. drive Claude Code non-interactively (`claude -p`) with the plugin loaded
 *      and the pre-authorized MCP server; capture the full transcript
 *   6. grade the transcript against the coaching-contract checklist (with the
 *      stub, most items FAIL and the one planted marker PASSes — RBD-8)
 *   7. clean up: synthetic wipe + config-dir/throwaway removal
 *
 * PLATFORM: Linux dev pod ONLY (FR-024, finding M6). On macOS, Claude Code stores
 * OAuth credentials in the system Keychain, which a scratch CLAUDE_CONFIG_DIR does
 * NOT clear — so pristine rehearsals are not achievable there. A Keychain-purge
 * step is deliberately NOT built. The pod's localhost OAuth callback naturally
 * fails; the harness sidesteps it by pre-authorizing via auto-approve.
 *
 * Usage:
 *   node test/first-run/rehearsal-harness.mjs [--server http://localhost:3001]
 *                                             [--bundle test/first-run/stub-plugin]
 *                                             [--keep] [--no-claude] [--require-claude]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gradeTranscript, formatReport } from './grade-transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const SERVER = arg('--server', process.env.DEV_SERVER || 'http://localhost:3001').replace(/\/$/, '');
const BUNDLE_SRC = path.resolve(arg('--bundle', path.join(HERE, 'stub-plugin')));
const KEEP = has('--keep');
const NO_CLAUDE = has('--no-claude'); // build the pristine env + skip the model leg
const REQUIRE_CLAUDE = has('--require-claude'); // non-zero exit unless the model leg completed
const REDIRECT_URI = 'http://localhost:8765/callback';

function log(msg) { console.log(`  • ${msg}`); }
function fail(msg) { throw new Error(msg); }
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Registered as resources are created, so a failure at ANY later step still
// releases the synthetic user and scratch dirs (029 review: fail() used to
// process.exit(1) and leak everything created before the failure).
const cleanupState = { email: null, dirs: [] };
async function bestEffortCleanup() {
  if (KEEP) return;
  if (cleanupState.email) {
    await fetch(`${SERVER}/auth/dev-wipe-user`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: cleanupState.email }),
    }).catch(() => {});
  }
  for (const dir of cleanupState.dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Minimal helper: mint a fresh synthetic user + run the OAuth chain to a token. */
async function connectAgentToken() {
  const nonce = `t3${crypto.randomBytes(4).toString('hex')}`;
  const faucet = await fetch(`${SERVER}/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true, nonce }),
  });
  const fb = await faucet.json();
  if (faucet.status !== 200 || !fb.accessToken) fail(`faucet failed (${faucet.status}); is ENABLE_DEV_ENDPOINTS=1 on ${SERVER}?`);
  const email = fb.email;
  const sessionToken = fb.accessToken;

  const asm = await (await fetch(`${SERVER}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(asm.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'tier3-harness', redirect_uris: [REDIRECT_URI], scopes: ['documents:read', 'documents:write'] }),
  })).json();
  const clientId = reg.client_id;
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = crypto.randomBytes(16).toString('hex');

  const approve = await (await fetch(`${SERVER}/auth/dev-consent-approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ agent_client_id: clientId, redirect_uri: REDIRECT_URI, state, scopes: ['documents:read', 'documents:write'], code_challenge: codeChallenge, code_challenge_method: 'S256' }),
  })).json();
  if (!approve.code) fail(`auto-approve failed: ${JSON.stringify(approve)}`);

  const tok = await (await fetch(asm.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: approve.code, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI }),
  })).json();
  if (!tok.access_token) fail(`token exchange failed: ${JSON.stringify(tok)}`);

  return { email, agentToken: tok.access_token };
}

/** Recursively copy a directory (throwaway bundle copy — never mutates source). */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  const t0 = Date.now();
  console.log(`\nTier-3 unattended first-run rehearsal → ${SERVER}`);
  console.log(`(Linux dev pod only — macOS Keychain caveat, FR-024)\n`);

  if (!fs.existsSync(path.join(BUNDLE_SRC, '.claude-plugin', 'plugin.json'))) {
    fail(`stub bundle not found at ${BUNDLE_SRC}`);
  }

  // Reachability preflight.
  try {
    const h = await fetch(`${SERVER}/health`);
    if (!h.ok) fail(`dev server ${SERVER}/health returned ${h.status}`);
  } catch (e) {
    fail(`dev server ${SERVER} unreachable: ${e.message}`);
  }

  // 1. Scratch config dir (pristine client).
  const scratchConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-rehearsal-cfg-'));
  cleanupState.dirs.push(scratchConfig);
  log(`scratch CLAUDE_CONFIG_DIR: ${scratchConfig}`);

  // 2. Throwaway templated bundle copy with the endpoint rewritten to the dev
  //    server — the source bundle is never touched (FR-020, R8 fallback).
  const throwaway = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-rehearsal-bundle-'));
  cleanupState.dirs.push(throwaway);
  copyDir(BUNDLE_SRC, throwaway);
  const mcpJsonPath = path.join(throwaway, '.mcp.json');
  const srcMcpBefore = fs.readFileSync(path.join(BUNDLE_SRC, '.mcp.json'), 'utf8');
  const mcp = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
  mcp.mcpServers['squire-docs'].url = `${SERVER}/mcp`;
  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcp, null, 2));
  // Invariant: the SOURCE bundle .mcp.json is unchanged.
  if (fs.readFileSync(path.join(BUNDLE_SRC, '.mcp.json'), 'utf8') !== srcMcpBefore) {
    fail('source bundle .mcp.json was mutated — FR-020 violated');
  }
  log(`throwaway bundle copy with endpoint → ${SERVER}/mcp (source untouched)`);

  // 3 + 4. Fresh synthetic user + unattended consent via auto-approve → agent token.
  const { email, agentToken } = await connectAgentToken();
  cleanupState.email = email;
  log(`fresh synthetic user + consent (auto-approve) → ${email}`);

  // Pre-authorized MCP config for the client (bypasses interactive OAuth; the
  // harness has already completed consent out-of-band via auto-approve).
  const mcpConfigPath = path.join(throwaway, 'harness-mcp-config.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      'squire-docs': { type: 'http', url: `${SERVER}/mcp`, headers: { Authorization: `Bearer ${agentToken}` } },
    },
  }, null, 2));

  let transcript = '';
  let claudeStatus = 'skipped (--no-claude)';

  if (!NO_CLAUDE) {
    // 5. Drive Claude Code non-interactively with the plugin + pre-authorized MCP.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      claudeStatus = 'skipped (ANTHROPIC_API_KEY not set)';
      log('ANTHROPIC_API_KEY not set — skipping the claude -p leg (env still built + graded empty)');
    } else {
      const prompt = 'Run the /squire:onboard command to onboard me to Squire Docs, then stop.';
      const claudeArgs = [
        '-p', prompt,
        '--output-format', 'text',
        '--plugin-dir', throwaway,
        '--mcp-config', mcpConfigPath,
        '--dangerously-skip-permissions',
      ];
      log(`driving: claude -p (plugin-dir + pre-authorized squire-docs MCP)`);
      const res = spawnSync('claude', claudeArgs, {
        cwd: REPO_ROOT,
        env: { ...process.env, CLAUDE_CONFIG_DIR: scratchConfig, ANTHROPIC_API_KEY: apiKey },
        encoding: 'utf8',
        timeout: 180000,
      });
      transcript = `${res.stdout || ''}\n${res.stderr || ''}`;
      claudeStatus = res.status === 0 ? 'completed' : `exited ${res.status}${res.error ? ` (${res.error.message})` : ''}`;
    }
  }

  // 6. Grade the transcript.
  const grade = gradeTranscript(transcript);
  const transcriptPath = path.join(throwaway, 'transcript.txt');
  fs.writeFileSync(transcriptPath, transcript);

  console.log(`\n--- claude -p status: ${claudeStatus} ---`);
  console.log(formatReport(grade));
  console.log(`\n(transcript saved: ${transcriptPath})`);

  // A CI wrapper keying on exit code must not read a broken model leg as
  // success (029 review) — opt in via --require-claude before wiring into a gate.
  if (REQUIRE_CLAUDE && claudeStatus !== 'completed') {
    fail(`--require-claude: claude -p leg did not complete (status: ${claudeStatus})`);
  }

  // 7. Cleanup (synthetic wipe + dirs) unless --keep.
  if (!KEEP) {
    await bestEffortCleanup();
    log(`cleaned up synthetic user + scratch dirs`);
  } else {
    log(`--keep: left scratch config ${scratchConfig} and bundle ${throwaway} in place`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✓ Rehearsal environment built + graded in ${secs}s (target < 180s, SC-001).`);
  console.log(`  M1 outcome: pristine env + accurate grade report (clean passes are M2, RBD-8).`);
}

main().catch(async (e) => {
  console.error(`\n✗ REHEARSAL FAILED: ${e.message || e}`);
  await bestEffortCleanup();
  process.exit(1);
});
