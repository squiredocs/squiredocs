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
    const env = {
      ...process.env,
      SQUIRE_MIRROR_CLAUDE_PLUGIN: cp.url,
      SQUIRE_MIRROR_MCP_REGISTRY: reg.url,
    };

    const res = publishMirrors({ env, endpoint: PROD_ENDPOINT });
    assert.equal(res.ok, true, `publish should succeed: ${res.problems.join('; ')}`);
    assert.equal(res.pushed.filter((l) => l.includes('pushed')).length, 2, 'both channels pushed');

    // The pushed bundle is the real generated content.
    const wd = checkout(root, cp.bare, 'cp');
    const plugin = JSON.parse(fs.readFileSync(path.join(wd, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.name, 'squire');
    assert.equal(plugin.version, '1.0.0');
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
    const env = { ...process.env, SQUIRE_MIRROR_CLAUDE_PLUGIN: cp.url };

    // First publish lands v1.0.0.
    const first = publishMirrors({ env, endpoint: PROD_ENDPOINT });
    assert.equal(first.ok, true, `first publish should succeed: ${first.problems.join('; ')}`);

    // Simulate the mirror carrying DIFFERENT content at the SAME version: hand-edit
    // a generated file in the mirror while leaving plugin.json at 1.0.0. A real
    // "shared/ changed but version not bumped" produces exactly this shape.
    const wd = checkout(root, cp.bare, 'cp');
    fs.appendFileSync(path.join(wd, 'skills', 'squire', 'SKILL.md'), '\nstale mirror edit\n');
    git(['add', '-A'], wd);
    git(['commit', '-m', 'stale content, same version'], wd);
    git(['push', 'origin', 'main'], wd);

    const second = publishMirrors({ env, endpoint: PROD_ENDPOINT });
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

test('--publish with no configured remotes fails closed with zero side effects (INV-1)', () => {
  // No mirror env vars → mirrorRemoteFor returns null for every channel.
  const env = {};
  for (const ch of CHANNELS) assert.equal(mirrorRemoteFor(ch, env), null, `${ch.id}: no committed default remote`);

  const before = fs.readdirSync(REPO_ROOT).filter((n) => n.startsWith('.publish-mirror-'));
  const res = publishMirrors({ env, endpoint: PROD_ENDPOINT });
  assert.equal(res.ok, false, 'must fail closed');
  assert.equal(res.pushed.length, 0, 'nothing pushed');
  assert.ok(
    res.problems.some((p) => p.includes('no mirror remotes configured')),
    `must explain the fail-closed refusal: ${res.problems.join('; ')}`,
  );
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
