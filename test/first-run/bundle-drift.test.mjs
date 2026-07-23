/**
 * Feature 032 US3 + Feature 033 US4 (T014, FR-024/025) — bundle drift guard.
 *
 * The generated-copies rule, enforced in the always-run suite, GENERALIZED over the
 * CHANNELS registry (wave 1: claude-plugin + mcp-registry; wave 2: kiro-power +
 * cursor-plugin). Every committed file under each channel's outDir must byte-equal a
 * FRESH regeneration from that channel's pure in-memory `files()` map. A one-byte
 * hand-edit fails CI; an extra committed file the generator does not emit fails CI.
 *
 * CRITICAL WIRING (INV-3): the expected bytes come from publish.mjs's PURE, in-memory
 * `channel.files()` — this test NEVER runs the disk-writing generator against the
 * committed tree first (that would make the guard vacuous), and CI must not regenerate
 * before this check. The comparison is committed-on-disk-bytes vs in-memory-expected.
 *
 * The ONLY drift exemption is each channel's `endpointRel` mcp file's single server
 * `url` field (field-scoped, not file-scoped) — every other byte is asserted, and a
 * SEPARATE prod-pin assertion proves the committed endpoint is the prod URL so the
 * exemption can never let a dev URL ship.
 *
 *   node --test test/first-run/bundle-drift.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHANNELS,
  PROD_ENDPOINT,
  SHARED_DIR,
  generateAll,
} from '../../distribution/publish.mjs';

const REGEN = 'node distribution/publish.mjs';

/** Recursively list files under a dir, as rel paths (posix separators). */
function listFiles(dir) {
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
}

/**
 * Normalize an mcp.json string by stripping the single server's `url` (the only
 * drift-exempt field). Works for BOTH server-key conventions (`squire` on wave 1,
 * `squire-docs` on wave 2): it deletes `.url` on every entry under `mcpServers`.
 */
function stripMcpEndpoint(content) {
  const c = JSON.parse(content);
  if (c && c.mcpServers) {
    for (const k of Object.keys(c.mcpServers)) {
      if (c.mcpServers[k] && typeof c.mcpServers[k] === 'object') delete c.mcpServers[k].url;
    }
  }
  return JSON.stringify(c);
}

/**
 * Byte-match one channel's committed (or materialized) files against its pure
 * in-memory `files()` bytes. @returns {string[]} problems (empty = agrees).
 */
function driftForChannel(channel, outDir = channel.outDir) {
  const problems = [];
  const expected = channel.files({ endpoint: PROD_ENDPOINT });
  for (const [rel, expectedContent] of Object.entries(expected)) {
    const onDisk = path.join(outDir, rel);
    if (!fs.existsSync(onDisk)) { problems.push(`${channel.id}: missing generated file ${rel} (run: ${REGEN})`); continue; }
    const actual = fs.readFileSync(onDisk, 'utf8');
    if (channel.endpointRel && rel === channel.endpointRel) {
      // Endpoint field exempt; every other byte still asserted (FR-015/024).
      let ok = false;
      try { ok = stripMcpEndpoint(expectedContent) === stripMcpEndpoint(actual); } catch { ok = false; }
      if (!ok) problems.push(`${channel.id}/${rel} drifted (beyond the exempt endpoint field) — run: ${REGEN}`);
      continue;
    }
    if (actual !== expectedContent) {
      problems.push(`${channel.id}/${rel} drifted from its source — hand-edit the source, then run: ${REGEN}`);
    }
  }
  // EXTRA-FILE guard (032 review MEDIUM #3, generalized to all channels): a committed
  // file the generator does NOT emit would pass the loop above, get installed by every
  // rehearsal, yet never be published. Flag anything outside the expected set.
  const expectedSet = new Set(Object.keys(expected));
  for (const rel of listFiles(outDir)) {
    if (!expectedSet.has(rel)) problems.push(`${channel.id}: unexpected committed file ${rel} — not emitted by the generator (remove it, or add it to files())`);
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

test('every committed channel bundle byte-matches a fresh regeneration (FR-014/024)', () => {
  for (const ch of CHANNELS) {
    const problems = driftForChannel(ch);
    assert.deepEqual(problems, [], `bundle drift in ${ch.id} — run \`${REGEN}\`:\n  ${problems.join('\n  ')}`);
  }
});

test('all four channels are wired (FR-029): claude-plugin, mcp-registry, kiro-power, cursor-plugin', () => {
  const ids = CHANNELS.map((c) => c.id).sort();
  assert.deepEqual(ids, ['claude-plugin', 'cursor-plugin', 'kiro-power', 'mcp-registry']);
});

test('each mcp endpoint field is exempt but every other byte is asserted (FR-015/024)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-drift-ep-'));
  try {
    generateAll({ outRoot: tmp });
    for (const ch of CHANNELS) {
      if (!ch.endpointRel) continue;
      const outDir = path.join(tmp, ch.id);
      const mcpPath = path.join(outDir, ch.endpointRel);
      // Rewrite ONLY the endpoint url → must remain exempt (no drift for that file).
      const j = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      const serverKey = Object.keys(j.mcpServers)[0];
      j.mcpServers[serverKey].url = 'http://localhost:3052/mcp';
      fs.writeFileSync(mcpPath, JSON.stringify(j, null, 2) + '\n');
      const exempt = driftForChannel(ch, outDir).filter((p) => p.includes(ch.endpointRel));
      assert.deepEqual(exempt, [], `${ch.id}: endpoint-only change must be exempt`);

      // ...but changing a NON-endpoint field in the same mcp file IS drift. Add a
      // stray sibling key so both wave-1 (has `type`) and wave-2 (bare url) trip.
      const j2 = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      j2.mcpServers[serverKey].injected = 'drift';
      fs.writeFileSync(mcpPath, JSON.stringify(j2, null, 2) + '\n');
      const caught = driftForChannel(ch, outDir).filter((p) => p.includes(ch.endpointRel));
      assert.ok(caught.length > 0, `${ch.id}: a non-endpoint change to ${ch.endpointRel} must be caught`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('every committed mcp endpoint is pinned to prod (FR-016/024, INV-2)', () => {
  // A SEPARATE per-channel assertion, so the endpoint exemption can never let a dev
  // URL ship on ANY channel.
  for (const ch of CHANNELS) {
    if (!ch.endpointRel) continue;
    const j = JSON.parse(fs.readFileSync(path.join(ch.outDir, ch.endpointRel), 'utf8'));
    const serverKey = Object.keys(j.mcpServers)[0];
    assert.equal(
      j.mcpServers[serverKey].url,
      PROD_ENDPOINT,
      `${ch.id}: committed ${ch.endpointRel} must ship the prod endpoint, never a dev URL`,
    );
  }
  // The registry channel's remote endpoint is prod too (no endpointRel — checked directly).
  const reg = CHANNELS.find((c) => c.id === 'mcp-registry');
  const srv = JSON.parse(reg.files()['server.json']);
  assert.equal(srv.remotes[0].url, PROD_ENDPOINT);
});

test('shared content is within the context budgets (FR-017, RBD-13)', () => {
  const problems = checkContentBudgets();
  assert.deepEqual(problems, [], `budget overrun: ${problems.join('; ')}`);
  assert.equal(BUDGETS.skillDescriptionChars, 250, 'skill description budget is the /skills UI cap');
});

test('a hand-edited generated file is detected as drift, naming the file (SC-003, tamper)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-drift-tamper-'));
  try {
    generateAll({ outRoot: tmp });
    // A clean materialization must agree with itself first (sanity), every channel.
    for (const ch of CHANNELS) {
      assert.deepEqual(driftForChannel(ch, path.join(tmp, ch.id)), [], `${ch.id}: fresh materialization must agree`);
    }

    // Mutate ONE byte of a generated file in EACH channel → drift naming that file.
    const tamper = {
      'claude-plugin': 'skills/squire/SKILL.md',
      'mcp-registry': 'server.json',
      'kiro-power': 'POWER.md',
      'cursor-plugin': 'rules/squire-spec-loop.mdc',
    };
    for (const ch of CHANNELS) {
      const rel = tamper[ch.id];
      fs.appendFileSync(path.join(tmp, ch.id, rel), '\nHAND EDIT\n');
      const problems = driftForChannel(ch, path.join(tmp, ch.id));
      assert.ok(problems.length > 0, `${ch.id}: a hand-edit must be detected`);
      assert.ok(problems.some((p) => p.includes(rel)), `${ch.id}: the drifted file ${rel} must be named`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an extra committed file (not emitted by the generator) is flagged (FR-024, extra-file guard)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-drift-extra-'));
  try {
    generateAll({ outRoot: tmp });
    for (const ch of CHANNELS) {
      const outDir = path.join(tmp, ch.id);
      fs.writeFileSync(path.join(outDir, 'SNEAKED_IN.md'), 'not from the generator\n');
      const problems = driftForChannel(ch, outDir);
      assert.ok(problems.some((p) => p.includes('SNEAKED_IN.md')), `${ch.id}: an extra committed file must be flagged`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
