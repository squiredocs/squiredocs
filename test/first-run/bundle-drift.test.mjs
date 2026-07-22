/**
 * Feature 032 US3 (T017-T021, FR-014..017, contracts INV-2/INV-3) — bundle drift guard.
 *
 * The generated-copies rule, enforced in the always-run suite. Every committed file
 * under distribution/claude-plugin/ and distribution/mcp-registry/ must byte-equal a
 * FRESH regeneration from distribution/shared/. A one-byte hand-edit fails CI.
 *
 * CRITICAL WIRING (INV-3, analyze U1): the expected bytes come from publish.mjs's
 * PURE, in-memory expectedFiles() / expectedRegistryServer() — this test NEVER runs
 * the disk-writing generator against the committed tree first (that would make the
 * guard vacuous by definition), and CI must not regenerate before this check. The
 * comparison is committed-on-disk-bytes vs in-memory-expected-bytes.
 *
 *   node --test test/first-run/bundle-drift.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  expectedFiles,
  expectedRegistryServer,
  assembleBundle,
  PROD_ENDPOINT,
  SHARED_DIR,
  DEFAULT_CLAUDE_PLUGIN_DIR,
  DEFAULT_MCP_REGISTRY_DIR,
} from '../../distribution/publish.mjs';

const REGEN = 'node distribution/publish.mjs';

/** Compare .mcp.json ignoring ONLY mcpServers.squire.url (field-scoped, not file-scoped). */
function mcpMatchesIgnoringEndpoint(expected, actual) {
  let e; let a;
  try { e = JSON.parse(expected); a = JSON.parse(actual); } catch { return false; }
  const strip = (o) => {
    const c = JSON.parse(JSON.stringify(o));
    if (c?.mcpServers?.squire) delete c.mcpServers.squire.url;
    return JSON.stringify(c);
  };
  return strip(e) === strip(a);
}

/**
 * Byte-match a bundle+registry pair on disk against the in-memory expected bytes.
 * @param {{ pluginDir: string, registryDir: string }} dirs
 * @returns {string[]} problems (empty = agrees)
 */
function driftProblems({ pluginDir, registryDir }) {
  const problems = [];
  const expected = expectedFiles({ endpoint: PROD_ENDPOINT });
  for (const [rel, expectedContent] of Object.entries(expected)) {
    const onDisk = path.join(pluginDir, rel);
    if (!fs.existsSync(onDisk)) { problems.push(`missing generated file: ${rel} (run: ${REGEN})`); continue; }
    const actual = fs.readFileSync(onDisk, 'utf8');
    if (rel === '.mcp.json') {
      // Endpoint field exempt; every other byte still asserted (FR-015).
      if (!mcpMatchesIgnoringEndpoint(expectedContent, actual)) {
        problems.push(`${rel} drifted from distribution/shared/ (beyond the exempt endpoint field) — run: ${REGEN}`);
      }
      continue;
    }
    if (actual !== expectedContent) {
      problems.push(`${rel} drifted from distribution/shared/ — hand-edit the source, then run: ${REGEN}`);
    }
  }
  // Registry channel.
  const srvExpected = expectedRegistryServer();
  const srvPath = path.join(registryDir, 'server.json');
  if (!fs.existsSync(srvPath)) problems.push(`missing generated file: server.json (run: ${REGEN})`);
  else if (fs.readFileSync(srvPath, 'utf8') !== srvExpected) {
    problems.push(`server.json drifted from the expected registry content — run: ${REGEN}`);
  }
  // EXTRA-FILE guard (032 review MEDIUM #3): a committed file the generator does
  // NOT emit would pass the loops above, get installed by every rehearsal (the
  // harness copies the whole dir), yet never be published. Walk both committed
  // dirs and flag anything outside the expected set.
  const listFiles = (dir) => {
    const out = [];
    const walk = (d, rel) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else out.push(r);
      }
    };
    walk(dir, '');
    return out;
  };
  const pluginExpected = new Set(Object.keys(expected));
  for (const rel of listFiles(pluginDir)) {
    if (!pluginExpected.has(rel)) problems.push(`unexpected committed file in claude-plugin: ${rel} — not emitted by the generator (remove it, or add it to expectedFiles)`);
  }
  for (const rel of listFiles(registryDir)) {
    if (rel !== 'server.json') problems.push(`unexpected committed file in mcp-registry: ${rel} — not emitted by the generator`);
  }
  return problems;
}

// --- Content budgets (FR-017, R9 — re-homed from the retired bundle-agreement.test.mjs) ---
// RBD-13 numbers: skill description ≤250 chars (the /skills UI truncation cap),
// skill body ≤400 lines, onboard ≤300 lines. Guards the M2-signed-off shared
// content this feature consumes read-only; kept in the always-run suite.
export const BUDGETS = { skillDescriptionChars: 250, skillBodyLines: 400, onboardLines: 300 };

function frontmatterDescription(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const d = m[1].match(/^description:\s*(.*)$/m);
  return d ? d[1].trim() : null;
}
function bodyAfterFrontmatter(src) { return src.replace(/^---\n[\s\S]*?\n---\n/, ''); }

function checkContentBudgets() {
  const problems = [];
  const skill = fs.readFileSync(path.join(SHARED_DIR, 'skill.md'), 'utf8');
  const onboard = fs.readFileSync(path.join(SHARED_DIR, 'onboard.md'), 'utf8');
  const desc = frontmatterDescription(skill);
  if (desc == null) problems.push('skill.md has no frontmatter description');
  else if (desc.length > BUDGETS.skillDescriptionChars)
    problems.push(`skill.md description is ${desc.length} chars (budget ${BUDGETS.skillDescriptionChars}; /skills UI truncates)`);
  const skillBodyLines = bodyAfterFrontmatter(skill).split('\n').length;
  if (skillBodyLines > BUDGETS.skillBodyLines) problems.push(`skill.md body is ${skillBodyLines} lines (budget ${BUDGETS.skillBodyLines})`);
  const onboardLines = onboard.split('\n').length;
  if (onboardLines > BUDGETS.onboardLines) problems.push(`onboard.md is ${onboardLines} lines (budget ${BUDGETS.onboardLines})`);
  return problems;
}

// --- Tests -------------------------------------------------------------------

test('committed bundles byte-match a fresh regeneration from shared/ (FR-014)', () => {
  const problems = driftProblems({ pluginDir: DEFAULT_CLAUDE_PLUGIN_DIR, registryDir: DEFAULT_MCP_REGISTRY_DIR });
  assert.deepEqual(problems, [], `bundle drift — run \`${REGEN}\`:\n  ${problems.join('\n  ')}`);
});

test('the .mcp.json endpoint field is exempt but every other byte is asserted (FR-015)', () => {
  // A throwaway copy with only the endpoint rewritten does NOT count as drift...
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-drift-ep-'));
  try {
    assembleBundle({ outDir: tmp });
    const mcp = path.join(tmp, '.mcp.json');
    const j = JSON.parse(fs.readFileSync(mcp, 'utf8'));
    j.mcpServers.squire.url = 'http://localhost:3052/mcp';
    fs.writeFileSync(mcp, JSON.stringify(j, null, 2) + '\n');
    const problems = driftProblems({ pluginDir: tmp, registryDir: DEFAULT_MCP_REGISTRY_DIR });
    assert.deepEqual(problems.filter((p) => p.includes('.mcp.json')), [], 'endpoint-only change must be exempt');

    // ...but changing another field in .mcp.json IS drift.
    const j2 = JSON.parse(fs.readFileSync(mcp, 'utf8'));
    j2.mcpServers.squire.type = 'sse';
    fs.writeFileSync(mcp, JSON.stringify(j2, null, 2) + '\n');
    const problems2 = driftProblems({ pluginDir: tmp, registryDir: DEFAULT_MCP_REGISTRY_DIR });
    assert.ok(problems2.some((p) => p.includes('.mcp.json')), 'a non-endpoint change to .mcp.json must be caught');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the committed .mcp.json endpoint is pinned to prod (FR-016, INV-2)', () => {
  // A SEPARATE assertion, so the endpoint exemption can never let a dev URL ship.
  const mcp = JSON.parse(fs.readFileSync(path.join(DEFAULT_CLAUDE_PLUGIN_DIR, '.mcp.json'), 'utf8'));
  assert.equal(
    mcp.mcpServers.squire.url,
    'https://squiredocs.com/mcp',
    'committed bundle must ship the prod endpoint, never a dev URL',
  );
  // And the registry endpoint is prod too.
  const srv = JSON.parse(fs.readFileSync(path.join(DEFAULT_MCP_REGISTRY_DIR, 'server.json'), 'utf8'));
  assert.equal(srv.remotes[0].url, 'https://squiredocs.com/mcp');
});

test('shared content is within the context budgets (FR-017, RBD-13)', () => {
  const problems = checkContentBudgets();
  assert.deepEqual(problems, [], `budget overrun: ${problems.join('; ')}`);
  assert.equal(BUDGETS.skillDescriptionChars, 250, 'skill description budget is the /skills UI cap');
});

test('a hand-edited generated file is detected as drift, naming the file (SC-003, tamper)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-drift-tamper-'));
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-drift-reg-'));
  try {
    assembleBundle({ outDir: tmp });
    fs.writeFileSync(path.join(reg, 'server.json'), expectedRegistryServer());

    // A clean materialization must agree with itself first (sanity).
    assert.deepEqual(driftProblems({ pluginDir: tmp, registryDir: reg }), [], 'fresh materialization must agree');

    // Mutate ONE byte of a generated file → drift, naming exactly that file.
    const skill = path.join(tmp, 'skills', 'squire', 'SKILL.md');
    fs.appendFileSync(skill, '\nHAND EDIT\n');
    const problems = driftProblems({ pluginDir: tmp, registryDir: reg });
    assert.ok(problems.length > 0, 'a hand-edit must be detected');
    assert.ok(problems.some((p) => p.includes('SKILL.md')), 'the drifted file must be named');

    // Tampering with server.json is likewise caught.
    fs.appendFileSync(path.join(reg, 'server.json'), '\n');
    assert.ok(driftProblems({ pluginDir: tmp, registryDir: reg }).some((p) => p.includes('server.json')), 'server.json tamper caught');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(reg, { recursive: true, force: true });
  }
});
