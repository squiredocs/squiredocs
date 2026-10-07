/**
 * Feature 060 (T026, FR-027, contracts/oauth-driver-signin-link.md): the
 * driver's --signin-link flags are validated before any request, and the
 * sign-in-link leg never touches a development endpoint (the production image
 * serves none).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oauth-chain-driver.mjs');
// A port nothing listens on: if the driver ever got as far as a request, it
// would fail with exit 1, not the usage exit 2 these cases expect.
const SERVER = 'http://127.0.0.1:9';

function drive(args) {
  return spawnSync(process.execPath, [DRIVER, '--server', SERVER, ...args], { encoding: 'utf8', timeout: 20000 });
}

test('--signin-link with --first-run is a usage error (exit 2)', () => {
  const r = drive(['--first-run', '--signin-link', `${SERVER}/claim#abcdefghijklmnopqrstuvwxyz`]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /exclusive/);
});

test('a --signin-link whose origin differs from --server exits 2 before any request', () => {
  const r = drive(['--signin-link', 'http://localhost:3910/claim#abcdefghijklmnopqrstuvwxyz']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /differs from --server/);
  assert.doesNotMatch(r.stdout, /driver →/, 'no request was attempted');
});

test('other --signin-link usage errors exit 2', () => {
  for (const [args, re] of [
    [['--signin-link', 'not a url'], /not a URL/],
    [['--signin-link', `${SERVER}/claim`], /no #<token> fragment/],
    [['--signin-link'], /needs the claim or sign-in link URL/],
    [['--script-check'], /need --signin-link/],
    [['--expect-email', 'a@b.c'], /need --signin-link/],
  ]) {
    const r = drive(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re);
  }
});

test('the --signin-link branch references no development endpoint', () => {
  const src = fs.readFileSync(DRIVER, 'utf8');
  const start = src.indexOf('// --- signin-link leg start');
  const end = src.indexOf('// --- signin-link leg end');
  assert.ok(start > 0 && end > start, 'leg markers present');
  const leg = src.slice(start, end);
  assert.ok(leg.includes('/auth/signin-link'));
  assert.ok(leg.includes('/auth/refresh'));
  assert.ok(leg.includes('/mcp/auth/approve'));
  assert.ok(!leg.includes('/auth/dev-login'), 'no /auth/dev-login');
  assert.ok(!leg.includes('dev-consent-approve'), 'no dev-consent-approve');
  // The dispatch sends --signin-link to that leg before either faucet branch.
  const dispatch = src.indexOf('if (SIGNIN_LINK !== null) {\n    ({ authCode, welcomeDocId } = await signinLinkLeg(');
  assert.ok(dispatch > 0 && dispatch < src.indexOf("fetch(`${SERVER}/auth/dev-login`"));
});
