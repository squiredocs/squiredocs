/**
 * Feature 032 US5 (T030, FR-027, SC-005) — cross-surface install-string check.
 *
 * The plugin install one-liners MUST be textually identical across all three
 * public surfaces (served agents.md, the documentation page, the landing page),
 * and the raw `claude mcp add` one-liner MUST survive in agents.md for other MCP
 * clients. Wording drift between surfaces is a defect. agents.md and landing.html
 * live outside the doc-build terminology gate, so this is their coverage.
 *
 *   node --test test/first-run/install-surfaces.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const SURFACES = [
  'client/public/agents.md',
  'documentation/agents-and-mcp.md',
  'client/public/landing.html',
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

test('the restart-after-install caveat reaches the documentation + landing surfaces (F1)', () => {
  // FR-023: the caveat must appear beyond agents.md.
  assert.match(read('documentation/agents-and-mcp.md'), /restart/i, 'documentation surface must carry the restart caveat');
  assert.match(read('client/public/landing.html'), /restart/i, 'landing block must carry the restart caveat (light form)');
});
