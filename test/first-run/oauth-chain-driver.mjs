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
 * Feature 060 (FR-026, FR-027, contracts/oauth-driver-signin-link.md):
 * --signin-link <url> replaces steps 6 and 7 with what a production image
 * supports, since it serves no development endpoints: redeem the sign-in link
 * in JSON mode, exchange the refresh cookie for the session Bearer token at
 * POST /auth/refresh (as the SPA does), check GET /auth/providers reports an
 * owner, and approve consent at POST /mcp/auth/approve. --expect-name and
 * --expect-email assert the redeemed user; --script-check adds one `modify`
 * call that runs an agent script in the isolate. The release workflow's agent
 * job runs this leg against the freshly built image.
 *
 * Usage:  node test/first-run/oauth-chain-driver.mjs --server http://localhost:3001
 *         node test/first-run/oauth-chain-driver.mjs --server URL --first-run
 *         node test/first-run/oauth-chain-driver.mjs --server URL --signin-link URL
 *              [--expect-name NAME] [--expect-email EMAIL] [--script-check]
 * Exit 0 on full success; 1 with a clear message on the first failure; 2 on a usage error.
 */
import crypto from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function usage(msg) {
  console.error(`usage error: ${msg}`);
  process.exit(2);
}

const SERVER = (arg('--server', process.env.DEV_SERVER || 'http://localhost:3001')).replace(/\/$/, '');
const REDIRECT_URI = arg('--redirect-uri', 'http://localhost:8765/callback');
// Feature 031 (T008): --first-run drives the COLLAPSED flow — faucet BROWSER mode
// with an /authorize returnTo, so a brand-new account's sign-in auto-issues the
// code inline and 302s to the agent callback with ZERO consent POSTs. The default
// (returning-user) path still exercises the explicit dev-consent-approve step.
const FIRST_RUN = process.argv.includes('--first-run');
// Feature 060: the production sign-in-link leg.
const SIGNIN_LINK = process.argv.includes('--signin-link') ? arg('--signin-link', '') : null;
const EXPECT_NAME = process.argv.includes('--expect-name') ? arg('--expect-name', '') : null;
const EXPECT_EMAIL = process.argv.includes('--expect-email') ? arg('--expect-email', '') : null;
const SCRIPT_CHECK = process.argv.includes('--script-check');

let SIGNIN_TOKEN = null;
if (SIGNIN_LINK !== null) {
  if (FIRST_RUN) usage('--signin-link and --first-run are exclusive');
  if (!SIGNIN_LINK) usage('--signin-link needs the claim or sign-in link URL');
  let link;
  try { link = new URL(SIGNIN_LINK); } catch { usage(`--signin-link is not a URL: ${SIGNIN_LINK}`); }
  let serverOrigin;
  try { serverOrigin = new URL(SERVER).origin; } catch { usage(`--server is not a URL: ${SERVER}`); }
  if (link.origin !== serverOrigin) usage(`--signin-link origin ${link.origin} differs from --server ${serverOrigin}`);
  SIGNIN_TOKEN = link.hash.replace(/^#/, '');
  if (!SIGNIN_TOKEN) usage('--signin-link has no #<token> fragment');
} else if (EXPECT_NAME !== null || EXPECT_EMAIL !== null || SCRIPT_CHECK) {
  usage('--expect-name, --expect-email, and --script-check need --signin-link');
}
if (EXPECT_NAME === '' || EXPECT_EMAIL === '') usage('--expect-name and --expect-email need a value');

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

  const nonce = `t2${crypto.randomBytes(4).toString('hex')}`;
  let authCode;
  let welcomeDocId = null;

  if (SIGNIN_LINK !== null) {
    ({ authCode, welcomeDocId } = await signinLinkLeg({ asm, clientId, codeChallenge, state, scope }));
  } else if (FIRST_RUN) {
    // Feature 031 first-run COLLAPSE: faucet BROWSER mode carrying an /authorize
    // returnTo. The brand-new account is created in this round-trip (isNew), so
    // completePostAuth auto-issues the code inline and 302s STRAIGHT to the agent
    // callback — WITHOUT any consent POST. Extract the code from that redirect.
    const returnTo = '/authorize?' + new URLSearchParams({
      agent_client_id: clientId,
      agent_instance_id: '',
      scope, redirect_uri: REDIRECT_URI, state,
      code_challenge: codeChallenge, code_challenge_method: 'S256',
      existing_delegation: 'false',
    }).toString();

    const browserRes = await fetch(`${SERVER}/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fresh: true, browser: true, nonce, returnTo }),
      redirect: 'manual',
    });
    if (![302, 303, 307].includes(browserRes.status)) {
      fail(`first-run browser sign-in did not redirect (status ${browserRes.status}; is ENABLE_DEV_ENDPOINTS=1?)`);
    }
    const location = browserRes.headers.get('location');
    let loc;
    try { loc = new URL(location); } catch { fail(`first-run redirect had no parseable Location: ${location}`); }
    // The COLLAPSE assertion: the 302 goes to the AGENT callback, not the consent page.
    if (loc.origin + loc.pathname !== REDIRECT_URI) {
      fail(`first-run did NOT auto-issue — redirected to ${loc.origin}${loc.pathname} (expected the agent callback ${REDIRECT_URI}; consent was NOT collapsed)`);
    }
    if (loc.searchParams.get('state') !== state) fail(`first-run callback state mismatch`);
    authCode = loc.searchParams.get('code');
    if (!authCode) fail(`first-run callback carried no code: ${location}`);
    log(`first-run faucet BROWSER sign-in → auto-issued code inline (ZERO consent POSTs)`);
  } else {
    // Returning-user path: faucet JSON session + the EXPLICIT dev-consent-approve.
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

    // Auto-approve consent for the synthetic session → authorization code.
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
    authCode = approveBody.code;
    log(`auto-approve → authorization code minted`);
  }

  // 8. Token exchange.
  const tok = await fetch(asm.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: authCode, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI }),
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

  if (SCRIPT_CHECK) {
    await scriptCheck({ agentToken, welcomeDocId, listResult: callBody.result });
  }

  console.log(`\n✓ SUCCESS — full agent connect chain completed headlessly and the token authenticates a real MCP tool call.\n`);
  process.exit(0);
}

// --- signin-link leg start (feature 060; must never use a development endpoint) ---

/** Pull `name=value` for each cookie name out of a response's Set-Cookie headers. */
function cookiesFrom(res, names) {
  const out = {};
  const headers = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const h of headers) {
    const [pair] = h.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    if (names.includes(name)) out[name] = pair.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Steps 6 and 7 for a production image: redeem the sign-in link (JSON mode),
 * exchange the refresh cookie for the session Bearer token, confirm the
 * instance has an owner, and approve consent through the production route.
 */
async function signinLinkLeg({ asm, clientId, codeChallenge, state, scope }) {
  // 6a. Peek (read-only, as the claim page does), then redeem with the
  // prefilled name and email, which a claim requires in the body (RBD-060-34).
  const peek = await fetch(`${SERVER}/auth/signin-link/peek`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token: SIGNIN_TOKEN }),
  });
  let peekBody = {};
  try { peekBody = await peek.json(); } catch { /* reported below */ }
  if (peek.status !== 200 || !peekBody.valid) fail(`sign-in link is not valid (peek status ${peek.status}): ${JSON.stringify(peekBody)}`);
  const prefill = peekBody.prefill || {};
  log(`sign-in link peeked → ${peekBody.kind} link${prefill.email ? ` for ${prefill.email}` : ''}`);
  const redeemFields = peekBody.kind === 'claim' ? { name: prefill.name, email: prefill.email } : {};
  const redeem = await fetch(`${SERVER}/auth/signin-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token: SIGNIN_TOKEN, ...redeemFields }),
  });
  let redeemBody = {};
  try { redeemBody = await redeem.json(); } catch { /* reported below */ }
  if (redeem.status !== 200 || !redeemBody.ok || !redeemBody.user) {
    fail(`sign-in link redemption failed (status ${redeem.status}): ${JSON.stringify(redeemBody)}`);
  }
  const { user } = redeemBody;
  if (EXPECT_NAME !== null && user.name !== EXPECT_NAME) fail(`redeemed user name is ${JSON.stringify(user.name)}, expected ${JSON.stringify(EXPECT_NAME)}`);
  if (EXPECT_EMAIL !== null && user.email !== EXPECT_EMAIL) fail(`redeemed user email is ${JSON.stringify(user.email)}, expected ${JSON.stringify(EXPECT_EMAIL)}`);
  log(`sign-in link redeemed (JSON) → ${user.email}${user.isAdmin ? ' (admin)' : ''}`);

  // 6b. The session cookies, then the refresh exchange the SPA performs.
  const cookies = cookiesFrom(redeem, ['accessToken', 'refreshToken']);
  if (!cookies.accessToken || !cookies.refreshToken) fail(`redemption set no session cookies (got: ${Object.keys(cookies).join(', ') || 'none'})`);
  const refresh = await fetch(`${SERVER}/auth/refresh`, {
    method: 'POST',
    headers: { cookie: `refreshToken=${cookies.refreshToken}` },
  });
  let refreshBody = {};
  try { refreshBody = await refresh.json(); } catch { /* reported below */ }
  if (refresh.status !== 200 || !refreshBody.accessToken) fail(`refresh exchange failed (status ${refresh.status}): ${JSON.stringify(refreshBody)}`);
  const sessionToken = refreshBody.accessToken;
  log(`refresh cookie → session Bearer token`);

  // 6c. The instance reports an owner.
  const providers = await fetch(`${SERVER}/auth/providers`);
  let providersBody = {};
  try { providersBody = await providers.json(); } catch { /* reported below */ }
  if (providers.status !== 200 || providersBody.hasOwner !== true) fail(`/auth/providers does not report an owner (status ${providers.status}): ${JSON.stringify(providersBody)}`);
  log(`/auth/providers → hasOwner: true (mode ${providersBody.mode || 'unknown'})`);

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

  // 7. Approve consent with the owner session through the production route.
  const approve = await fetch(`${SERVER}/mcp/auth/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({
      agent_client_id: clientId,
      scopes: ['documents:read', 'documents:write'],
      redirect_uri: REDIRECT_URI,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      approved: true,
    }),
  });
  let approveBody = {};
  try { approveBody = await approve.json(); } catch { /* reported below */ }
  if (approve.status !== 200 || !approveBody.redirectUrl) fail(`consent approval failed (status ${approve.status}): ${JSON.stringify(approveBody)}`);
  let redirect;
  try { redirect = new URL(approveBody.redirectUrl); } catch { fail(`approval returned an unparseable redirectUrl: ${approveBody.redirectUrl}`); }
  if (redirect.searchParams.get('state') !== state) fail(`approval redirect state mismatch`);
  const authCode = redirect.searchParams.get('code');
  if (!authCode) fail(`approval redirect carried no code: ${approveBody.redirectUrl}`);
  log(`consent approved (POST /mcp/auth/approve) → authorization code`);

  return { authCode, welcomeDocId: user.welcomeDocId || null };
}

/** --script-check: one `modify` call that runs an agent script in the isolate. */
async function scriptCheck({ agentToken, welcomeDocId, listResult }) {
  let docGuid = welcomeDocId;
  if (!docGuid) {
    // A returning owner may have no fresh welcome document: use any listed document.
    const text = (listResult.content || []).map((c) => c.text || '').join('\n');
    const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text);
    if (!m) fail('script check: no welcome document id and no document in list_documents');
    docGuid = m[0];
  }
  // The modify contract: a default-exported edit(doc) (get_tool_documentation({ tool: 'modify' })).
  const script = "export default function edit(doc) { appendBlocks(doc, [{ type: 'paragraph', content: 'Connected by the oauth-chain-driver script check.' }]); }";
  const res = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'modify', arguments: { docGuid, script } } }),
  });
  let body = {};
  try { body = await res.json(); } catch { /* reported below */ }
  if (res.status !== 200 || !body.result || body.error) fail(`modify call failed (status ${res.status}): ${JSON.stringify(body)}`);
  if (body.result.is_error || body.result.isError) fail(`modify returned an error: ${JSON.stringify(body.result.content)}`);
  log(`agent script ran in the isolate (modify on ${docGuid}) → OK`);
}

// --- signin-link leg end ---

main().catch((e) => fail(e.stack || String(e)));
