/**
 * Feature 032 US2 (T015, FR-012/013, RBD-6, contracts INV-1) — publish-mechanism test.
 *
 * Exercises distribution/publish.mjs's push path against LOCAL BARE-REPO FIXTURES
 * ONLY — never a real remote, never a real network call (RBD-6). CI never runs the
 * real publish; this proves the mechanism (and its fail-closed guards) without one.
 *
 *   node --test test/first-run/publish-mechanism.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  publishMirrors,
  mirrorRemoteFor,
  CHANNELS,
  PROD_ENDPOINT,
  SHIP_VERSION,
  REPO_ROOT,
} from '../../distribution/publish.mjs';

// Deterministic git identity for fixture commits (no dependence on global config).
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.local',
};
for (const [k, v] of Object.entries(GIT_ENV)) process.env[k] = v;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * Build a publish env from the process env with EVERY real SQUIRE_MIRROR_* var
 * stripped, then layer the fixture URLs on top (032 review HIGH #1). Without this,
 * a runner that has `export SQUIRE_MIRROR_MCP_REGISTRY=...` (the documented publish
 * var) would make this suite push to the REAL GitHub mirror. Callers assert the
 * configured-channel count equals the number of fixtures they supplied, so an
 * inherited remote can never silently ride along.
 */
function fixtureEnv(overrides) {
  const clean = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('SQUIRE_MIRROR_')) clean[k] = v;
  }
  return { ...clean, ...overrides };
}
function configuredCount(env) {
  return CHANNELS.filter((ch) => mirrorRemoteFor(ch, env)).length;
}

/** A seeded bare repo with one initial commit on branch `main`. Returns file:// URL. */
function makeBareRepo(root, name) {
  const bare = path.join(root, `${name}.git`);
  git(['init', '--bare', '-b', 'main', bare]);
  const seed = path.join(root, `${name}-seed`);
  git(['clone', bare, seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${name} mirror\n`);
  git(['add', '-A'], seed);
  git(['commit', '-m', 'seed'], seed);
  git(['push', 'origin', 'main'], seed);
  fs.rmSync(seed, { recursive: true, force: true });
  return { url: `file://${bare}`, bare };
}

/** Clone a bare repo to a fresh work dir and return that dir. */
function checkout(root, bare, name) {
  const wd = path.join(root, `${name}-check-${Math.random().toString(36).slice(2)}`);
  git(['clone', bare, wd]);
  return wd;
}

test('first publish pushes generated bundles to configured mirrors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-publish-'));
  try {
    const cp = makeBareRepo(root, 'squire-plugin');
    const reg = makeBareRepo(root, 'squire-mcp-registry');
    const env = fixtureEnv({
      SQUIRE_MIRROR_CLAUDE_PLUGIN: cp.url,
      SQUIRE_MIRROR_MCP_REGISTRY: reg.url,
    });
    // No inherited real remote can ride along: exactly the two fixtures.
    assert.equal(configuredCount(env), 2, 'only the two fixture channels are configured');

    const res = publishMirrors({ env });
    assert.equal(res.ok, true, `publish should succeed: ${res.problems.join('; ')}`);
    assert.equal(res.pushed.filter((l) => l.includes('pushed')).length, 2, 'both channels pushed');

    // The pushed bundle is the real generated content.
    const wd = checkout(root, cp.bare, 'cp');
    const plugin = JSON.parse(fs.readFileSync(path.join(wd, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.name, 'squire');
    assert.equal(plugin.version, SHIP_VERSION);
    assert.match(
      fs.readFileSync(path.join(wd, '.mcp.json'), 'utf8'),
      /https:\/\/squiredocs\.com\/mcp/,
      'pushed .mcp.json ships the prod endpoint',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('re-push with changed content but unchanged version is refused (FR-013)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-publish-'));
  try {
    const cp = makeBareRepo(root, 'squire-plugin');
    const env = fixtureEnv({ SQUIRE_MIRROR_CLAUDE_PLUGIN: cp.url });
    // Exactly one fixture channel configured — no inherited mcp-registry remote.
    assert.equal(configuredCount(env), 1, 'only the one fixture channel is configured');

    // First publish lands v1.0.0.
    const first = publishMirrors({ env });
    assert.equal(first.ok, true, `first publish should succeed: ${first.problems.join('; ')}`);

    // Simulate the mirror carrying DIFFERENT content at the SAME version: hand-edit
    // a generated file in the mirror while leaving plugin.json at 1.0.0. A real
    // "shared/ changed but version not bumped" produces exactly this shape.
    const wd = checkout(root, cp.bare, 'cp');
    fs.appendFileSync(path.join(wd, 'skills', 'squire', 'SKILL.md'), '\nstale mirror edit\n');
    git(['add', '-A'], wd);
    git(['commit', '-m', 'stale content, same version'], wd);
    git(['push', 'origin', 'main'], wd);

    const second = publishMirrors({ env });
    assert.equal(second.ok, false, 'must refuse when content differs but version is unchanged');
    assert.ok(
      second.problems.some((p) => p.includes('version is unchanged')),
      `refusal must name the version guard: ${second.problems.join('; ')}`,
    );
    assert.equal(second.pushed.filter((l) => l.includes('pushed')).length, 0, 'nothing pushed on refusal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a NEW channel (Kiro, POWER.md frontmatter carrier) pushes then refuses change-without-bump (FR-026)', () => {
  // Proves the version-carrier generalization (T004) drives the guard for a channel
  // whose version rides in POWER.md YAML frontmatter — the novel non-JSON carrier.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-publish-kiro-'));
  try {
    const kp = makeBareRepo(root, 'squire-kiro-power');
    const env = fixtureEnv({ SQUIRE_MIRROR_KIRO_POWER: kp.url });
    // Exactly one fixture channel configured — no inherited remote rides along.
    assert.equal(configuredCount(env), 1, 'only the one Kiro fixture channel is configured');

    // First publish lands the Kiro bundle (v1.0.0 from POWER.md frontmatter).
    const first = publishMirrors({ env });
    assert.equal(first.ok, true, `first Kiro publish should succeed: ${first.problems.join('; ')}`);
    assert.equal(first.pushed.filter((l) => l.includes('pushed')).length, 1, 'the Kiro channel pushed');

    // The pushed bundle carries the real generated POWER.md + prod mcp.json.
    const wd = checkout(root, kp.bare, 'kp');
    const power = fs.readFileSync(path.join(wd, 'POWER.md'), 'utf8');
    assert.match(power, /^version: "1\.0\.0"$/m, 'POWER.md frontmatter carries version 1.0.0');
    assert.match(
      fs.readFileSync(path.join(wd, 'mcp.json'), 'utf8'),
      /https:\/\/squiredocs\.com\/mcp/,
      'pushed mcp.json ships the prod endpoint',
    );

    // Simulate the mirror carrying DIFFERENT content at the SAME version: hand-edit a
    // generated steering file while leaving POWER.md's frontmatter version at 1.0.0.
    fs.appendFileSync(path.join(wd, 'steering', 'specs-sync-workflow.md'), '\nstale mirror edit\n');
    git(['add', '-A'], wd);
    git(['commit', '-m', 'stale content, same version'], wd);
    git(['push', 'origin', 'main'], wd);

    const second = publishMirrors({ env });
    assert.equal(second.ok, false, 'must refuse when content differs but the POWER.md version is unchanged');
    assert.ok(
      second.problems.some((p) => p.includes('version is unchanged') && p.includes('POWER.md')),
      `refusal must name the POWER.md version carrier: ${second.problems.join('; ')}`,
    );
    assert.equal(second.pushed.filter((l) => l.includes('pushed')).length, 0, 'nothing pushed on refusal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Kiro mirror whose POWER.md lost its version frontmatter is refused as unreadable (FR-017 hole check)', () => {
  // The security hole the version-carrier generalization must NOT open: a channel
  // whose carrier can't be read must REFUSE, never be treated as first-publish and
  // republished unguarded.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-publish-kiro-unreadable-'));
  try {
    const kp = makeBareRepo(root, 'squire-kiro-power');
    const env = fixtureEnv({ SQUIRE_MIRROR_KIRO_POWER: kp.url });
    const first = publishMirrors({ env });
    assert.equal(first.ok, true, `first Kiro publish should succeed: ${first.problems.join('; ')}`);

    // Corrupt the mirror's POWER.md: strip the `version:` line from the frontmatter,
    // change other content too, keep the file present. readVersion now throws on the
    // mirror side → mirrorVersionUnreadable → refuse.
    const wd = checkout(root, kp.bare, 'kp');
    const power = fs.readFileSync(path.join(wd, 'POWER.md'), 'utf8');
    fs.writeFileSync(path.join(wd, 'POWER.md'), power.replace(/^version: ".*"$/m, '') + '\nstale\n');
    git(['add', '-A'], wd);
    git(['commit', '-m', 'drop version frontmatter'], wd);
    git(['push', 'origin', 'main'], wd);

    const second = publishMirrors({ env });
    assert.equal(second.ok, false, 'must refuse when the mirror version carrier is unreadable');
    assert.ok(
      second.problems.some((p) => p.includes('unreadable')),
      `refusal must cite the unreadable carrier: ${second.problems.join('; ')}`,
    );
    assert.equal(second.pushed.filter((l) => l.includes('pushed')).length, 0, 'nothing pushed on refusal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a populated Kiro mirror whose POWER.md carrier is ABSENT is refused, not treated as first-publish (033 review MEDIUM)', () => {
  // The carrier-absent counterpart to the unreadable guard: if the mirror still holds
  // generator-emitted content (mcp.json, steering/) but POWER.md — the version carrier —
  // was deleted/renamed mirror-side, a naive `existsSync(carrier)` gate would fall
  // through to "first publish" and republish unguarded. It must REFUSE.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-publish-kiro-nocarrier-'));
  try {
    const kp = makeBareRepo(root, 'squire-kiro-power');
    const env = fixtureEnv({ SQUIRE_MIRROR_KIRO_POWER: kp.url });
    const first = publishMirrors({ env });
    assert.equal(first.ok, true, `first Kiro publish should succeed: ${first.problems.join('; ')}`);

    // Delete POWER.md (the carrier) from the mirror but leave the rest of the bundle,
    // and change a steering file so `changed` is true.
    const wd = checkout(root, kp.bare, 'kp');
    fs.rmSync(path.join(wd, 'POWER.md'));
    fs.appendFileSync(path.join(wd, 'steering', 'specs-sync-workflow.md'), '\nstale mirror edit\n');
    git(['add', '-A'], wd);
    git(['commit', '-m', 'drop the version carrier, keep the rest'], wd);
    git(['push', 'origin', 'main'], wd);

    const second = publishMirrors({ env });
    assert.equal(second.ok, false, 'must refuse a populated mirror missing its version carrier');
    assert.ok(
      second.problems.some((p) => p.includes('unreadable')),
      `refusal must cite the missing/unreadable carrier: ${second.problems.join('; ')}`,
    );
    assert.equal(second.pushed.filter((l) => l.includes('pushed')).length, 0, 'nothing pushed on refusal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--publish with no configured remotes fails closed with zero side effects, naming all four vars (INV-1)', () => {
  // No mirror env vars → mirrorRemoteFor returns null for every channel.
  const env = {};
  for (const ch of CHANNELS) assert.equal(mirrorRemoteFor(ch, env), null, `${ch.id}: no committed default remote`);

  const before = fs.readdirSync(REPO_ROOT).filter((n) => n.startsWith('.publish-mirror-'));
  const res = publishMirrors({ env });
  assert.equal(res.ok, false, 'must fail closed');
  assert.equal(res.pushed.length, 0, 'nothing pushed');
  assert.ok(
    res.problems.some((p) => p.includes('no mirror remotes configured')),
    `must explain the fail-closed refusal: ${res.problems.join('; ')}`,
  );
  // The refusal names EVERY channel's mirror env var (all four wave-1+wave-2 names).
  const msg = res.problems.join(' ');
  for (const ch of CHANNELS) assert.ok(msg.includes(ch.mirrorEnv), `refusal must name ${ch.mirrorEnv}`);
  assert.equal(CHANNELS.length, 4, 'four channels are wired');
  const after = fs.readdirSync(REPO_ROOT).filter((n) => n.startsWith('.publish-mirror-'));
  assert.deepEqual(after, before, 'no scratch clone dir created — zero side effects');
});

test('mirrorRemoteFor never resolves a committed default (INV-1)', () => {
  // Even with the process env stripped of the mirror vars, resolution is null.
  const env = { PATH: process.env.PATH };
  for (const ch of CHANNELS) {
    assert.equal(mirrorRemoteFor(ch, env), null, `${ch.id}: remote must come only from configured env`);
  }
});

test('CLI refuses --publish combined with a non-prod --endpoint or --out (032 review HIGH #2)', () => {
  const script = path.join(REPO_ROOT, 'distribution', 'publish.mjs');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-pub-guard-'));
  try {
    // A dev endpoint on the publish path must be refused BEFORE any push, even
    // with a fixture remote configured — the push path can never stage dev bytes.
    const env = fixtureEnv({ SQUIRE_MIRROR_CLAUDE_PLUGIN: `file://${outDir}/nope.git` });
    for (const args of [
      ['--publish', '--endpoint', 'http://localhost:3052/mcp', '--out', outDir],
      ['--publish', '--endpoint', 'http://localhost:3052/mcp'],
      ['--publish', '--out', outDir],
    ]) {
      const r = spawnSync('node', [script, ...args], { encoding: 'utf8', env });
      assert.equal(r.status, 2, `must refuse ${args.join(' ')} (exit 2): ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--publish cannot be combined/i, `must explain the refusal for ${args.join(' ')}`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
