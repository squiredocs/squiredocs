/**
 * distribution/self-host/release.mjs (feature 060, T005, research R6,
 * contracts/compose-and-assets.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REPOSITORY,
  VERSION_TOKEN,
  ASSET_NAMES,
  parseReleaseTag,
  validateRepository,
} from '../../distribution/self-host/release.mjs';
import { SELF_HOST_DIR, PLACEHOLDER, TEST_REPOSITORY, releasedCopy, placeholderCopy, tempDir, which } from './helpers.mjs';

const RELEASE = path.join(SELF_HOST_DIR, 'release.mjs');

test('constants', () => {
  assert.equal(REPOSITORY, 'squiredocs/squiredocs', 'Sam named the repository on 2026-10-07 (RBD-060-1)');
  assert.notEqual(REPOSITORY, PLACEHOLDER);
  assert.equal(VERSION_TOKEN, '__SQUIRE_VERSION__');
  assert.deepEqual(ASSET_NAMES, ['compose.yml', 'squire', 'env.example', 'SHA256SUMS']);
});

test('parseReleaseTag accepts release and prerelease tags', () => {
  assert.deepEqual(parseReleaseTag('v1.2.3'), { version: '1.2.3', prerelease: false });
  assert.deepEqual(parseReleaseTag('v1.2.3-rc.1'), { version: '1.2.3-rc.1', prerelease: true });
  assert.deepEqual(parseReleaseTag('v0.0.0-ci.42'), { version: '0.0.0-ci.42', prerelease: true });
});

test('parseReleaseTag rejects non-release tags', () => {
  for (const bad of ['1.2.3', 'v1.2', 'vnext', 'v1.2.3+meta', '', 'v1.2.3.4', 'refs/tags/v1.2.3']) {
    assert.throws(() => parseReleaseTag(bad), /not a release tag/, bad);
  }
});

test('validateRepository refuses the placeholder and a mismatch', () => {
  assert.throws(() => validateRepository('<org>/<repo>'), /placeholder/);
  assert.throws(() => validateRepository('<org>/<repo>', '<org>/<repo>'), /placeholder/);
  assert.throws(() => validateRepository('acme/squire-docs', 'someone/fork'), /runs in someone\/fork/);
  assert.throws(() => validateRepository('Acme/Squire-Docs', 'Acme/Squire-Docs'), /lowercase/);
  assert.throws(() => validateRepository('acme', 'acme'), /owner\/name/);
});

test('validateRepository accepts a case-insensitive match', () => {
  validateRepository(REPOSITORY, 'SquireDocs/SquireDocs');
  assert.throws(() => validateRepository(REPOSITORY, 'samg/collab'), /runs in samg\/collab/);
  validateRepository('acme/squire-docs', 'acme/squire-docs');
  validateRepository('acme/squire-docs', 'Acme/Squire-Docs');
  validateRepository('acme/squire-docs');
});

test('CLI validate with the placeholder exits 1 naming the problem', () => {
  const r = spawnSync(process.execPath, [path.join(placeholderCopy(), 'release.mjs'), 'validate', '--tag', 'v1.2.3', '--github-repository', 'samg/collab'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /placeholder/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('CLI stamp with the placeholder exits 1 and writes nothing', () => {
  const out = path.join(tempDir(), 'assets');
  const r = spawnSync(process.execPath, [path.join(placeholderCopy(), 'release.mjs'), 'stamp', '--version', '1.2.3', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /placeholder/);
  assert.equal(fs.existsSync(out), false);
});

test('CLI validate on a released copy prints the output lines', () => {
  const src = releasedCopy();
  const cli = path.join(src, 'release.mjs');
  let r = spawnSync(process.execPath, [cli, 'validate', '--tag', 'v1.2.3', '--github-repository', 'SquireDocs/SquireDocs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `version=1.2.3\nprerelease=false\nimage=ghcr.io/${TEST_REPOSITORY}\n`);

  r = spawnSync(process.execPath, [cli, 'validate', '--tag', 'v2.0.0-rc.1', '--github-repository', TEST_REPOSITORY], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^version=2\.0\.0-rc\.1\nprerelease=true\n/);

  for (const [args, re] of [
    [['--tag', 'vnext', '--github-repository', TEST_REPOSITORY], /not a release tag/],
    [['--tag', 'v1.2.3', '--github-repository', 'someone/fork'], /runs in someone\/fork/],
    [['--tag', 'v1.2.3'], /Usage/],
    [['--tag'], /needs a value/],
  ]) {
    r = spawnSync(process.execPath, [cli, 'validate', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, re);
  }
});

test('stampAssets writes exactly the four assets, stamped and verifiable', async () => {
  const src = releasedCopy();
  const mod = await import(pathToFileURL(path.join(src, 'release.mjs')).href);
  const out = path.join(tempDir(), 'assets');
  const { files } = mod.stampAssets({ version: '1.2.3', outDir: out });
  assert.deepEqual(files, ASSET_NAMES);
  assert.deepEqual(fs.readdirSync(out).sort(), [...ASSET_NAMES].sort());

  for (const name of ASSET_NAMES) {
    const text = fs.readFileSync(path.join(out, name), 'utf8');
    assert.ok(!text.includes('__SQUIRE_'), `${name} has a token`);
    assert.ok(!text.includes('<org>') && !text.includes('<repo>'), `${name} has a placeholder`);
  }
  const compose = fs.readFileSync(path.join(out, 'compose.yml'), 'utf8');
  assert.match(compose, new RegExp(`image: ghcr\\.io/${TEST_REPOSITORY}:\\$\\{SQUIRE_VERSION:-1\\.2\\.3\\}`));
  assert.match(fs.readFileSync(path.join(out, 'env.example'), 'utf8'), /^SQUIRE_VERSION=1\.2\.3$/m);
  assert.equal(fs.statSync(path.join(out, 'squire')).mode & 0o777, 0o755);
  assert.equal(
    fs.readFileSync(path.join(out, 'squire'), 'utf8'),
    fs.readFileSync(path.join(SELF_HOST_DIR, 'squire'), 'utf8'),
  );

  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8');
  assert.deepEqual(
    sums.trim().split('\n').map((l) => l.split('  ')[1]),
    ['compose.yml', 'squire', 'env.example'],
  );
  const sha = which('sha256sum');
  if (sha) {
    const r = spawnSync(sha, ['-c', 'SHA256SUMS'], { cwd: out, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

test('stampAssets rejects a version with a leading v', async () => {
  const src = releasedCopy();
  const mod = await import(pathToFileURL(path.join(src, 'release.mjs')).href);
  assert.throws(() => mod.stampAssets({ version: 'v1.2.3', outDir: path.join(tempDir(), 'a') }), /no leading v/);
});

test('stampAssets fails when a placeholder survives', async () => {
  // The sources with the placeholder back in compose.yml (RBD-060-1 refusal).
  const mod = await import(pathToFileURL(path.join(placeholderCopy(), 'release.mjs')).href);
  assert.throws(
    () => mod.stampAssets({ version: '1.2.3', outDir: path.join(tempDir(), 'a') }),
    /compose\.yml still contains <org>/,
  );
});

test('CLI stamp on a released copy succeeds', () => {
  const src = releasedCopy();
  const out = path.join(tempDir(), 'assets');
  const r = spawnSync(process.execPath, [path.join(src, 'release.mjs'), 'stamp', '--version', '1.0.0-rc.1', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.deepEqual(fs.readdirSync(out).sort(), [...ASSET_NAMES].sort());
});
