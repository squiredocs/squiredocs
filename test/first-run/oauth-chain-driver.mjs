#!/usr/bin/env node
/**
 * Feature 029 US2 — tier-2 headless OAuth-chain driver (FR-017/FR-018, SC-002).
 *
 * Walks the REAL agent connect chain against a dev server with zero human
 * interaction, then authenticates a real MCP tool call with the resulting token:
 *
 *   1. unauthenticated MCP call            → 401 (protected resource challenge)
 *   2. GET protected-resource metadata     → authorization_servers
 *   3. GET authorization-server metadata   → register/authorize/token endpoints
 *   4. POST dynamic client registration    → client_id
 *   5. PKCE (code_verifier / code_challenge S256)
 *   6. faucet sign-in leg                   → a synthetic session Bearer token
 *   7. auto-approve consent (synthetic)    → authorization code
 *   8. token exchange                       → agent access_token
 *   9. authenticated MCP tools/list + a real tool call with that token
 *
 * The two browser legs are driven by the faucet and the auto-approve endpoint.
 * Note: `requireAuth` reads the Authorization header (not cookies), so the HTTP
 * driver uses the faucet's JSON mode to obtain the session Bearer token — the
 * faucet's *browser* mode (cookies + 302) is what the real React client and the
 * tier-3 `claude` client exercise. Both are the same faucet, same code path.
 *
 * Usage:  node test/first-run/oauth-chain-driver.mjs --server http://localhost:3001
 * Exit 0 on full success; non-zero with a clear message on the first failure.
 */
import crypto from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SERVER = (arg('--server', process.env.DEV_SERVER || 'http://localhost:3001')).replace(/\/$/, '');
const REDIRECT_URI = arg('--redirect-uri', 'http://localhost:8765/callback');

let step = 0;
function log(msg) {
  step += 1;
  console.log(`  [${String(step).padStart(2, '0')}] ${msg}`);
}
function fail(msg) {
  console.error(`\n✗ FAILED: ${msg}`);
  process.exit(1);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

async function main() {
  console.log(`\nTier-2 headless OAuth-chain driver → ${SERVER}\n`);

  // 1. Unauthenticated MCP call → 401.
  const unauth = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  if (unauth.status !== 401) fail(`expected 401 from unauthenticated /mcp, got ${unauth.status}`);
  log(`unauthenticated /mcp → 401 (challenge)`);

  // 2. Protected-resource metadata.
  const prm = await (await fetch(`${SERVER}/.well-known/oauth-protected-resource/mcp`)).json();
  if (!prm.authorization_servers?.length) fail('protected-resource metadata missing authorization_servers');
  const asBase = prm.authorization_servers[0].replace(/\/$/, '');
  log(`protected-resource metadata → AS ${asBase}`);

  // 3. Authorization-server metadata.
  const asm = await (await fetch(`${asBase}/.well-known/oauth-authorization-server`)).json();
  for (const k of ['registration_endpoint', 'authorization_endpoint', 'token_endpoint']) {
    if (!asm[k]) fail(`AS metadata missing ${k}`);
  }
  log(`AS metadata → register/authorize/token endpoints`);

  // 4. Dynamic client registration.
  const reg = await fetch(asm.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'tier2-driver', redirect_uris: [REDIRECT_URI], scopes: ['documents:read', 'documents:write'] }),
  });
  const regBody = await reg.json();
  const clientId = regBody.client_id;
  if (!clientId) fail(`dynamic client registration returned no client_id (status ${reg.status})`);
  log(`registered client → ${clientId}`);

  // 5. PKCE.
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = crypto.randomBytes(16).toString('hex');
  const scope = 'documents:read documents:write';
  log(`PKCE code_challenge (S256) + state generated`);

  // 6. Faucet sign-in leg → synthetic session Bearer token.
  const nonce = `t2${crypto.randomBytes(4).toString('hex')}`;
  const faucet = await fetch(`${SERVER}/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true, nonce }),
  });
  const faucetBody = await faucet.json();
  if (faucet.status !== 200 || !faucetBody.accessToken) {
    fail(`faucet did not mint a session (status ${faucet.status}; is ENABLE_DEV_ENDPOINTS=1?)`);
  }
  const sessionToken = faucetBody.accessToken;
  log(`faucet minted synthetic session → ${faucetBody.email}`);

  // Sanity: the authorize endpoint accepts the request (302 to the consent page).
  const authorizeUrl = new URL(asm.authorization_endpoint);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code',
    scope, state, code_challenge: codeChallenge, code_challenge_method: 'S256',
  }).toString();
  const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
  if (![302, 303, 307].includes(authorizeRes.status)) {
    fail(`authorize did not redirect to consent (status ${authorizeRes.status})`);
  }
  log(`authorize → ${authorizeRes.status} (consent page)`);

  // 7. Auto-approve consent for the synthetic session → authorization code.
  const approve = await fetch(`${SERVER}/auth/dev-consent-approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({
      agent_client_id: clientId, redirect_uri: REDIRECT_URI, state,
      scopes: ['documents:read', 'documents:write'], code_challenge: codeChallenge, code_challenge_method: 'S256',
    }),
  });
  const approveBody = await approve.json();
  if (approve.status !== 200 || !approveBody.code) fail(`auto-approve failed (status ${approve.status}): ${JSON.stringify(approveBody)}`);
  log(`auto-approve → authorization code minted`);

  // 8. Token exchange.
  const tok = await fetch(asm.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: approveBody.code, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI }),
  });
  const tokBody = await tok.json();
  if (tok.status !== 200 || !tokBody.access_token) fail(`token exchange failed (status ${tok.status}): ${JSON.stringify(tokBody)}`);
  const agentToken = tokBody.access_token;
  log(`token exchange → agent access_token (scope: ${tokBody.scope})`);

  // 9. Authenticated MCP tool call with the agent token.
  const init = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
  });
  const initBody = await init.json();
  if (init.status !== 200 || !initBody.result) fail(`authenticated initialize failed (status ${init.status}): ${JSON.stringify(initBody)}`);

  const call = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_documents', arguments: {} } }),
  });
  const callBody = await call.json();
  if (call.status !== 200 || !callBody.result || callBody.error) {
    fail(`authenticated tool call failed (status ${call.status}): ${JSON.stringify(callBody)}`);
  }
  if (callBody.result.is_error) fail(`tool returned is_error: ${JSON.stringify(callBody.result.content)}`);
  log(`authenticated MCP tool call (list_documents) → OK`);

  console.log(`\n✓ SUCCESS — full agent connect chain completed headlessly and the token authenticates a real MCP tool call.\n`);
  process.exit(0);
}

main().catch((e) => fail(e.stack || String(e)));
