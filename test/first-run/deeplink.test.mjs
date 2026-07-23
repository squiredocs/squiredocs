/**
 * Feature 033 US4 (T015, FR-025, SC-003) — Add-to-Cursor deeplink round-trip.
 *
 * The deeplink is single-sourced from PROD_ENDPOINT via cursorDeeplink(). This
 * always-run test proves its `config` query param base64-decodes to exactly
 * {url: PROD_ENDPOINT} and its `name` param equals CURSOR_SERVER_KEY — so a drift in
 * the endpoint constant or the encoding is caught, and the surfaces (which embed this
 * string) are provably pinned to prod.
 *
 *   node --test test/first-run/deeplink.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorDeeplink, CURSOR_SERVER_KEY, PROD_ENDPOINT } from '../../distribution/publish.mjs';

// Extract a query param from the raw deeplink string. The base64 `config` is NOT
// url-encoded by the generator, so parse the raw string (URLSearchParams would
// mis-decode a `+` in some base64 outputs) to match the exact emitted bytes.
function rawParam(url, name) {
  const m = url.match(new RegExp(`[?&]${name}=([^&]*)`));
  return m ? m[1] : null;
}

test('cursorDeeplink config base64-decodes to {url: PROD_ENDPOINT} (FR-025, SC-003)', () => {
  const url = cursorDeeplink();
  assert.equal(rawParam(url, 'name'), CURSOR_SERVER_KEY, 'name param must be the server key squire-docs');
  const config = rawParam(url, 'config');
  assert.ok(config, 'config param present');
  const decoded = JSON.parse(Buffer.from(config, 'base64').toString('utf8'));
  assert.deepEqual(decoded, { url: PROD_ENDPOINT }, 'config decodes to exactly {url: PROD_ENDPOINT}');
});

test('the prod deeplink is the exact reference string (single-sourced, drift-proof)', () => {
  const url = cursorDeeplink();
  assert.equal(
    url,
    'cursor://anysphere.cursor-deeplink/mcp/install?name=squire-docs&config=eyJ1cmwiOiJodHRwczovL3NxdWlyZWRvY3MuY29tL21jcCJ9',
    'the committed surfaces embed this exact byte string',
  );
});

test('a non-prod endpoint changes the config (derivation is real, not hardcoded)', () => {
  const dev = cursorDeeplink({ endpoint: 'http://localhost:3052/mcp' });
  const config = rawParam(dev, 'config');
  assert.deepEqual(JSON.parse(Buffer.from(config, 'base64').toString('utf8')), { url: 'http://localhost:3052/mcp' });
  assert.notEqual(dev, cursorDeeplink(), 'a different endpoint must produce a different deeplink');
});
