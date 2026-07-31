/**
 * Feature 032 US5 (T030, FR-027, SC-005) — cross-surface install-string check.
 *
 * The plugin install one-liners MUST be textually identical across both
 * install surfaces (served agents.md and the documentation page), and the raw
 * `claude mcp add` one-liner MUST survive in agents.md for other MCP clients.
 * Wording drift between surfaces is a defect. agents.md lives outside the
 * doc-build terminology gate, so this is its coverage.
 *
 * The landing page is deliberately NOT an install surface anymore: 80c6a8f1
 * (2026-07-24, ratified 2026-07-31) collapsed its per-agent install block into
 * a single link to the Agents & MCP Guide, narrowing 032/033's original
 * three-surface requirement to two. The landing page's remaining obligation is
 * that link — asserted below so the funnel can't silently drift to nothing.
 *
 *   node --test test/first-run/install-surfaces.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cursorDeeplink } from '../../distribution/publish.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const SURFACES = [
  'client/public/agents.md',
  'documentation/agents-and-mcp.md',
];

// Canonical strings (research R8 / contracts) — verbatim everywhere.
const CANONICAL = ['/plugin marketplace add squiredocs/squire-plugin', '/plugin install squire'];
const RAW_ONELINER = 'claude mcp add --transport http squire https://squiredocs.com/mcp';

for (const line of CANONICAL) {
  test(`"${line}" appears verbatim on every install surface`, () => {
    for (const surface of SURFACES) {
      assert.ok(read(surface).includes(line), `missing from ${surface}`);
    }
  });
}

test('the raw `claude mcp add` one-liner survives in agents.md (other MCP clients)', () => {
  assert.ok(read('client/public/agents.md').includes(RAW_ONELINER), 'agents.md must retain the raw one-liner');
});

test('the restart-after-install caveat reaches the documentation surface (F1)', () => {
  // FR-023: the caveat must appear beyond agents.md.
  assert.match(read('documentation/agents-and-mcp.md'), /restart/i, 'documentation surface must carry the restart caveat');
});

test('the landing page funnels to the Agents & MCP Guide (replaces its install block, 80c6a8f1)', () => {
  assert.ok(
    read('client/public/landing.html').includes('href="/documentation/agents-and-mcp"'),
    'landing must link the Agents & MCP Guide — it carries no install steps of its own',
  );
});

// --- Feature 033 US4 (T017, FR-029, SC-003) — cross-surface deeplink byte-identity ---

const DEEPLINK_SURFACES = ['documentation/agents-and-mcp.md'];

test('the Add-to-Cursor deeplink is byte-identical to the generator on every surface (FR-029)', () => {
  const deeplink = cursorDeeplink();
  for (const surface of DEEPLINK_SURFACES) {
    assert.ok(
      read(surface).includes(deeplink),
      `${surface} must embed the exact cursorDeeplink() value byte-for-byte:\n  ${deeplink}`,
    );
  }
});

test('the Kiro site/doc surface links the mirror repo and gives import steps, with NO fake button (FR-027/030)', () => {
  const repo = 'https://github.com/squiredocs/squire-kiro-power';
  for (const surface of DEEPLINK_SURFACES) {
    const src = read(surface);
    assert.ok(src.includes(repo), `${surface} must link the Kiro Power repo ${repo}`);
    assert.match(src, /Add Custom Power/, `${surface} must give the Kiro import steps`);
    assert.match(src, /Import power from GitHub/, `${surface} must name the GitHub import step`);
    // No fabricated Add-to-Kiro deeplink (none exists — research-confirmed).
    assert.ok(!/kiro:\/\//.test(src), `${surface} must NOT fabricate a kiro:// deeplink`);
  }
});
