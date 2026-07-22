#!/usr/bin/env node
/**
 * Feature 029 US4 tier-3 rehearsal harness, EXTENDED for 030 (M2):
 *   - structured capture: the model leg runs `--output-format stream-json` and
 *     the raw JSONL is parsed through capture.mjs into { prose, events } so the
 *     grader can measure what the agent DID, not just what it said (T010, RBD-2).
 *   - the `--bundle` default is the bundle assembled from distribution/shared/
 *     per run, so a shared/ edit mid-iteration can never exercise stale content
 *     (T011, FR-019).
 *   - cell modes for the sign-off matrix: pre-authorized (029), unauthenticated
 *     (tools genuinely absent → walkthrough branch), token-fallback (sk_sqd_ in
 *     ~/.squire/token); scripted user-simulator turns; a fixture-repo cwd
 *     (T022–T025, FR-032).
 *
 * One command yields a pristine first-run environment and a graded transcript,
 * with zero human interaction.
 *
 * PLATFORM: Linux dev pod ONLY (FR-024). On macOS, Claude Code stores OAuth
 * credentials in the system Keychain, which a scratch CLAUDE_CONFIG_DIR does NOT
 * clear — so pristine rehearsals are not achievable there. The pod's localhost
 * OAuth callback naturally fails; the pre-authorized mode sidesteps it via
 * auto-approve, and the unauthenticated mode leans into it (walkthrough branch).
 *
 * Usage:
 *   node test/first-run/rehearsal-harness.mjs [--server http://localhost:3001]
 *        [--bundle <dir>] [--mode pre-authorized|unauthenticated|token-fallback]
 *        [--fixture <repo-fixture-dir>] [--keep] [--no-claude] [--require-claude]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gradeTranscript, formatReport } from './grade-transcript.mjs';
import { parseCapture } from './capture.mjs';
import { assembleBundle, PROD_ENDPOINT } from './assemble-bundle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const REDIRECT_URI = 'http://localhost:8765/callback';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Recursively copy a directory (throwaway bundle/fixture copy — never mutates source). */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Mint a fresh synthetic user via the faucet, optionally run the OAuth chain to
 * a token. Returns { email, sessionToken, agentToken? }.
 */
async function connectAgent(server, { withToken = true, nonce: fixedNonce } = {}) {
  const nonce = fixedNonce || `t3${crypto.randomBytes(4).toString('hex')}`;
  const faucet = await fetch(`${server}/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true, nonce }),
  });
  const fb = await faucet.json();
  if (faucet.status !== 200 || !fb.accessToken) {
    throw new Error(`faucet failed (${faucet.status}); is ENABLE_DEV_ENDPOINTS=1 on ${server}?`);
  }
  const email = fb.email;
  const sessionToken = fb.accessToken;
  if (!withToken) return { email, sessionToken };

  const asm = await (await fetch(`${server}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(asm.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'tier3-harness', redirect_uris: [REDIRECT_URI], scopes: ['documents:read', 'documents:write'] }),
  })).json();
  const clientId = reg.client_id;
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = crypto.randomBytes(16).toString('hex');

  const approve = await (await fetch(`${server}/auth/dev-consent-approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ agent_client_id: clientId, redirect_uri: REDIRECT_URI, state, scopes: ['documents:read', 'documents:write'], code_challenge: codeChallenge, code_challenge_method: 'S256' }),
  })).json();
  if (!approve.code) throw new Error(`auto-approve failed: ${JSON.stringify(approve)}`);

  const tok = await (await fetch(asm.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: approve.code, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI }),
  })).json();
  if (!tok.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);

  return { email, sessionToken, agentToken: tok.access_token };
}

/**
 * Run one rehearsal. Returns a rich result the CLI and the matrix runner consume.
 *
 * @param {object} opts
 * @param {string}  opts.server        dev server origin (default http://localhost:3001)
 * @param {string} [opts.bundleSrc]    bundle dir; default = assembled fresh from shared/
 * @param {'pre-authorized'|'unauthenticated'|'token-fallback'} [opts.mode]
 * @param {string} [opts.fixtureDir]   repo fixture used as the client's cwd
 * @param {string[]} [opts.userTurns]  scripted follow-up user turns (multi-turn cells)
 * @param {'faucet-premint'} [opts.setup]  optional server-side pre-setup
 * @param {string} [opts.prompt]       first user turn (default: run /squire:onboard)
 * @param {boolean}[opts.keep] [opts.noClaude] [opts.requireClaude]
 * @param {(m:string)=>void} [opts.log]
 */
export async function runRehearsal(opts = {}) {
  const server = (opts.server || process.env.DEV_SERVER || 'http://localhost:3001').replace(/\/$/, '');
  const mode = opts.mode || 'pre-authorized';
  const keep = !!opts.keep;
  const noClaude = !!opts.noClaude;
  const requireClaude = !!opts.requireClaude;
  const log = opts.log || ((m) => console.log(`  • ${m}`));

  // Resources registered as created, so a failure at any step still releases
  // the synthetic user and scratch dirs (029 review).
  const cleanupState = { email: null, dirs: [], server };
  const result = { server, mode, cleanupState };

  async function cleanup() {
    if (keep) return;
    if (cleanupState.email) {
      await fetch(`${server}/auth/dev-wipe-user`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: cleanupState.email }),
      }).catch(() => {});
    }
    for (const dir of cleanupState.dirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  result.cleanup = cleanup;

  // Reachability preflight.
  try {
    const h = await fetch(`${server}/health`);
    if (!h.ok) throw new Error(`dev server ${server}/health returned ${h.status}`);
  } catch (e) {
    throw new Error(`dev server ${server} unreachable: ${e.message}`);
  }

  // Bundle: default = assembled fresh from distribution/shared/ per run (FR-019),
  // so mid-iteration shared/ edits can never exercise stale content. --bundle
  // <path> overrides (029 RBD-9).
  let bundleSrc = opts.bundleSrc;
  if (!bundleSrc) {
    const asmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-rehearsal-assembled-'));
    cleanupState.dirs.push(asmDir);
    assembleBundle({ outDir: asmDir, endpoint: PROD_ENDPOINT });
    bundleSrc = asmDir;
    log(`assembled bundle from distribution/shared/ → ${asmDir}`);
  }
  bundleSrc = path.resolve(bundleSrc);
  if (!fs.existsSync(path.join(bundleSrc, '.claude-plugin', 'plugin.json'))) {
    throw new Error(`bundle not found at ${bundleSrc}`);
  }

  // Scratch config dir (a client that has never seen the plugin/server).
  const scratchConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-rehearsal-cfg-'));
  cleanupState.dirs.push(scratchConfig);
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-rehearsal-home-'));
  cleanupState.dirs.push(scratchHome);
  log(`scratch CLAUDE_CONFIG_DIR: ${scratchConfig}`);

  // Throwaway templated bundle copy with the endpoint rewritten to the dev
  // server — the SOURCE bundle is never mutated (029 FR-020).
  const throwaway = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-rehearsal-bundle-'));
  cleanupState.dirs.push(throwaway);
  copyDir(bundleSrc, throwaway);
  const mcpJsonPath = path.join(throwaway, '.mcp.json');
  const srcMcpBefore = fs.readFileSync(path.join(bundleSrc, '.mcp.json'), 'utf8');
  const mcp = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
  mcp.mcpServers['squire-docs'].url = `${server}/mcp`;
  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcp, null, 2));
  if (fs.readFileSync(path.join(bundleSrc, '.mcp.json'), 'utf8') !== srcMcpBefore) {
    throw new Error('source bundle .mcp.json was mutated — FR-020 violated');
  }
  log(`throwaway bundle copy with endpoint → ${server}/mcp (source untouched)`);

  // --- Mode-specific auth staging ---------------------------------------------
  // The MCP config handed to the client. pre-authorized carries a Bearer header
  // so tools are present; unauthenticated carries none so tools are genuinely
  // absent (walkthrough branch); token-fallback carries an sk_sqd_ token loaded
  // from the scratch ~/.squire/token.
  let tokenSecret = null; // for the token-bytes scan (token-fallback)
  let configCounter = 0;
  // Write an MCP config for the squire-docs server, optionally with a Bearer
  // header. Returns its path. Distinct filenames so a --continue turn can point
  // at a different (now-authed) config.
  const writeMcpConfig = (headers) => {
    const p = path.join(throwaway, `harness-mcp-config-${configCounter++}.json`);
    fs.writeFileSync(p, JSON.stringify({
      mcpServers: {
        'squire-docs': { type: 'http', url: `${server}/mcp`, ...(headers ? { headers } : {}) },
      },
    }, null, 2));
    return p;
  };

  const unauthConfig = writeMcpConfig(null); // no header → tools absent (walkthrough)
  const firstPrompt = opts.prompt || 'Run the /squire:onboard command to onboard me to Squire Docs, then stop.';
  const userTurns = Array.isArray(opts.userTurns) ? opts.userTurns : [];

  // Pre-mint (existing-account-never-consented): create the account BEFORE the
  // client starts; reuse its identity (fixed nonce) when consent completes so
  // find-or-create yields no duplicate (FR-033/RBD-12).
  let identityNonce;
  if (opts.setup === 'faucet-premint') {
    identityNonce = `t3${crypto.randomBytes(4).toString('hex')}`;
    const pre = await connectAgent(server, { withToken: false, nonce: identityNonce });
    cleanupState.email = pre.email;
    result.email = pre.email;
    log(`faucet-premint: account ${pre.email} exists, no consent yet`);
  }

  // Build the ordered turn plan: [{ prompt, config }]. The connect flow starts
  // unauthenticated (walkthrough) then RESUMES on an authed config after consent.
  const turns = [];
  if (mode === 'pre-authorized' || mode === 'token-fallback') {
    let headers;
    if (mode === 'pre-authorized') {
      const { email, agentToken } = await connectAgent(server, { withToken: true });
      cleanupState.email = email; result.email = email;
      headers = { Authorization: `Bearer ${agentToken}` };
      log(`pre-authorized: consent via auto-approve → ${email} (tools present at start)`);
    } else {
      const staged = await stageTokenFallback(server, scratchHome, log);
      cleanupState.email = staged.email; result.email = staged.email;
      headers = { Authorization: `Bearer ${staged.token}` };
      tokenSecret = staged.token;
    }
    const authed = writeMcpConfig(headers);
    turns.push({ prompt: firstPrompt, config: authed });
    for (const t of userTurns) turns.push({ prompt: t, config: authed, continue: true });
  } else if (mode === 'unauthenticated' && opts.connect) {
    // Phase A: the walkthrough with tools ABSENT (unauth config) — the coaching
    // is graded here (items 1,3 + the connect steps).
    turns.push({ prompt: firstPrompt, config: unauthConfig });
    // The harness completes consent out-of-band (auto-approve) for this identity.
    const { email, agentToken } = await connectAgent(server, { withToken: true, nonce: identityNonce });
    cleanupState.email = email; result.email = email;
    const authed = writeMcpConfig({ Authorization: `Bearer ${agentToken}` });
    // Phase B: a FRESH authed session (NOT --continue). Verified: Claude Code
    // binds MCP server state at session start; a --continue turn reuses the
    // session's unauthorized server and never surfaces the now-authorized tools.
    // So Phase B re-runs /squire:onboard with the authorized config — exactly the
    // content's own "reconnect, then re-run onboard" instruction (design step 4) —
    // and the tools ARE present, so find-spec + sync + payoff (items 4,5,6,7) run.
    // Phase B runs in a FRESH config dir (a "restarted client"): a shared dir
    // caches phase A's unauthorized OAuth state and the authed header is ignored.
    const scratchConfigB = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-rehearsal-cfgB-'));
    cleanupState.dirs.push(scratchConfigB);
    log(`connect flow: consent completed for ${email}; phase B re-runs onboard in a fresh client with tools present`);
    turns.push({ prompt: firstPrompt, config: authed, continue: false, configDir: scratchConfigB });
    // The content OFFERS the best candidate and awaits confirmation (Move 2 —
    // "let the user confirm", never silently pick). A real user then says yes, so
    // the flow proceeds into the byte-channel sync + payoff. Without this turn the
    // model correctly stops at the offer, so items 5/6/7 fire only intermittently
    // (RBD-11: intermittent = defect). The confirmation turn makes the sync
    // deterministic; for candidate-selection cells whose sync items are exempt it
    // is harmless (their offer was already graded on the prior turn).
    turns.push({ prompt: 'Yes, that candidate is the right one — go ahead and sync it, then stop.', config: authed, continue: true, configDir: scratchConfigB });
    for (const t of userTurns) turns.push({ prompt: t, config: authed, continue: true, configDir: scratchConfigB });
  } else if (mode === 'unauthenticated') {
    // Walkthrough-only cells (declined / abandoned / paste-back / shape-*): tools
    // stay absent; the coaching is what's graded (R3, spec gap 4).
    log(`unauthenticated: no Authorization header — tools absent, walkthrough branch`);
    turns.push({ prompt: firstPrompt, config: unauthConfig });
    for (const t of userTurns) turns.push({ prompt: t, config: unauthConfig, continue: true });
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }

  // Working directory: a pristine copy of the cell's repo fixture, else the app
  // repo root (fixtures stay pristine — RBD-7).
  let cwd = REPO_ROOT;
  if (opts.fixtureDir) {
    const fixtureCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-rehearsal-repo-'));
    cleanupState.dirs.push(fixtureCopy);
    copyDir(path.resolve(opts.fixtureDir), fixtureCopy);
    cwd = fixtureCopy;
    log(`fixture repo cwd: ${path.basename(opts.fixtureDir)} → ${fixtureCopy}`);
  }

  // --- Model leg --------------------------------------------------------------
  let rawCapture = '';
  let claudeStatus = 'skipped (--no-claude)';

  if (!noClaude) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      claudeStatus = 'skipped (ANTHROPIC_API_KEY not set)';
      log('ANTHROPIC_API_KEY not set — skipping the claude -p leg (env still built + graded empty)');
    } else {
      const { raw, status } = driveClaude({ turns, throwaway, scratchConfig, scratchHome, cwd, apiKey, log });
      rawCapture = raw;
      claudeStatus = status;
    }
  }

  // --- Grade ------------------------------------------------------------------
  const capture = parseCapture(rawCapture);
  const serverOrigin = server;
  const grade = gradeTranscript(capture, { serverOrigin });
  const transcriptPath = path.join(throwaway, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, rawCapture);

  Object.assign(result, {
    capture, grade, claudeStatus, serverOrigin, transcriptPath,
    scratchConfig, scratchHome, throwaway, tokenSecret,
  });

  if (requireClaude && claudeStatus !== 'completed') {
    result.requireClaudeFailed = true;
  }
  return result;
}

/**
 * Mint a real sk_sqd_ token for a fresh synthetic user and stage it at the scratch
 * HOME's ~/.squire/token (0600). Uses only existing token machinery (008/009
 * lesson — no bespoke auth). Returns { email, token }.
 */
async function stageTokenFallback(server, scratchHome, log) {
  const { email, sessionToken } = await connectAgent(server, { withToken: false });
  // Mint an sk_sqd_ token via the same authenticated endpoint Settings → AI Agent
  // Access uses (POST /mcp/auth/api-tokens, session-Bearer authed).
  const res = await fetch(`${server}/mcp/auth/api-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ name: 'rehearsal-token-fallback', scopes: ['documents:read', 'documents:write'] }),
  });
  const body = await res.json().catch(() => ({}));
  const token = body.token;
  if (res.status >= 300 || !token || !String(token).startsWith('sk_sqd_')) {
    throw new Error(`token mint failed (status ${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  const squireDir = path.join(scratchHome, '.squire');
  fs.mkdirSync(squireDir, { recursive: true });
  const tokenPath = path.join(squireDir, 'token');
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
  log(`token-fallback: sk_sqd_ token minted for ${email} → ${tokenPath} (0600)`);
  return { email, token };
}

/**
 * Drive Claude Code non-interactively over an ordered turn plan. Each turn is
 * { prompt, config, continue? }: the first turn starts the session; `continue`
 * turns resume it via --continue (verified to preserve the conversation across
 * separate -p processes sharing CLAUDE_CONFIG_DIR) and may point at a DIFFERENT
 * (now-authed) --mcp-config so tools appear mid-flow. Returns { raw, status }
 * where raw is the concatenated stream-json JSONL of every turn.
 */
function driveClaude({ turns, throwaway, scratchConfig, scratchHome, cwd, apiKey, log }) {
  const chunks = [];
  let status = 'completed';

  turns.forEach((turn, i) => {
    if (status !== 'completed') return;
    // A turn may use its own config dir (the connect flow's phase B is a fresh
    // "restarted client" so the now-authorized server loads cleanly — a shared
    // config dir caches phase A's unauthorized OAuth state).
    const env = { ...process.env, CLAUDE_CONFIG_DIR: turn.configDir || scratchConfig, HOME: scratchHome, ANTHROPIC_API_KEY: apiKey };
    const args = [
      '-p', turn.prompt,
      ...(turn.continue ? ['--continue'] : []),
      '--output-format', 'stream-json', '--verbose',
      '--plugin-dir', throwaway,
      '--mcp-config', turn.config,
      '--dangerously-skip-permissions',
    ];
    log(`driving turn ${i + 1}/${turns.length}${turn.continue ? ' (--continue)' : ''}`);
    const res = spawnSync('claude', args, { cwd, env, encoding: 'utf8', timeout: 180000 });
    chunks.push(res.stdout || '');
    if (res.status !== 0) status = `exited ${res.status}${res.error ? ` (${res.error.message})` : ''}`;
    if (res.stderr) chunks.push(`\n<!-- stderr:\n${res.stderr}\n-->\n`);
  });

  return { raw: chunks.join('\n'), status };
}

// --- CLI --------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = arg('--server', process.env.DEV_SERVER || 'http://localhost:3001');
  const bundleSrc = arg('--bundle', undefined);
  const mode = arg('--mode', 'pre-authorized');
  const fixtureDir = arg('--fixture', undefined);
  const t0 = Date.now();

  console.log(`\nTier-3 unattended first-run rehearsal → ${server} (mode: ${mode})`);
  console.log(`(Linux dev pod only — macOS Keychain caveat, FR-024)\n`);

  let res;
  try {
    res = await runRehearsal({
      server, bundleSrc, mode, fixtureDir,
      keep: has('--keep'), noClaude: has('--no-claude'), requireClaude: has('--require-claude'),
    });
  } catch (e) {
    console.error(`\n✗ REHEARSAL FAILED: ${e.message || e}`);
    process.exit(1);
  }

  console.log(`\n--- claude -p status: ${res.claudeStatus} ---`);
  console.log(formatReport(res.grade));
  console.log(`\n(transcript saved: ${res.transcriptPath})`);

  const requireFailed = res.requireClaudeFailed;
  if (!has('--keep')) {
    await res.cleanup();
    console.log(`  • cleaned up synthetic user + scratch dirs`);
  } else {
    console.log(`  • --keep: left scratch config ${res.scratchConfig} and bundle ${res.throwaway} in place`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✓ Rehearsal built + graded in ${secs}s (target < 180s, SC-001).`);

  if (requireFailed) {
    console.error(`\n✗ --require-claude: claude -p leg did not complete (status: ${res.claudeStatus})`);
    process.exit(1);
  }
}
