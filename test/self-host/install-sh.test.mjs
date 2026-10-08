/**
 * distribution/self-host/install.sh without Docker (feature 060, T013/T015,
 * FR-014 to FR-020, contracts/install-sh.md).
 *
 * Each case runs a temp copy of the production script (REPOSITORY replaced,
 * nothing else) under dash when present, with PATH set to a per-test bin
 * directory holding the stub docker/curl/checksum tools from
 * fixtures/stub-bin and symlinks to the few real utilities the script uses.
 * The release assets are real: release.mjs stamps them from the production
 * sources, so checksums and the wrapper are the shipped ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SELF_HOST_DIR, STUB_BIN, PLACEHOLDER, TEST_REPOSITORY, releasedCopy, placeholderCopy, tempDir, which } from './helpers.mjs';

const SHELL = which('dash') || '/bin/sh';
const REAL_SHA256SUM = which('sha256sum');
const UTILS = ['cat', 'grep', 'sed', 'head', 'cut', 'tr', 'mkdir', 'rmdir', 'rm', 'mv', 'chmod', 'mktemp', 'dirname', 'basename'];
const LINK = 'http://localhost:3910/claim#Abc_123-xyz';

// A byte-identical copy of the production files (REPOSITORY is set).
const SRC = releasedCopy();
const SCRIPT = path.join(SRC, 'install.sh');
const { stampAssets } = await import(pathToFileURL(path.join(SRC, 'release.mjs')).href);
const ASSETS = path.join(tempDir(), 'assets');
stampAssets({ version: '1.2.3', outDir: ASSETS });

/**
 * Build a bin directory. `tools` picks stubs: docker, curl, sha256sum ('real'
 * symlink or 'stub'), shasum ('stub').
 */
function makeBin({ docker = true, curl = true, sha256sum = 'real', shasum = false } = {}) {
  const bin = tempDir('squire-060-bin-');
  for (const u of UTILS) {
    const real = which(u);
    if (real) fs.symlinkSync(real, path.join(bin, u));
  }
  if (docker) fs.symlinkSync(path.join(STUB_BIN, 'docker'), path.join(bin, 'docker'));
  if (curl) fs.symlinkSync(path.join(STUB_BIN, 'curl'), path.join(bin, 'curl'));
  if (sha256sum === 'real' && REAL_SHA256SUM) fs.symlinkSync(REAL_SHA256SUM, path.join(bin, 'sha256sum'));
  if (sha256sum === 'stub') fs.symlinkSync(path.join(STUB_BIN, 'sha256sum'), path.join(bin, 'sha256sum'));
  if (shasum) fs.symlinkSync(path.join(STUB_BIN, 'shasum'), path.join(bin, 'shasum'));
  return bin;
}

function run(args = [], { env = {}, bin = {}, cwd, script = SCRIPT } = {}) {
  const work = cwd || tempDir('squire-060-cwd-');
  const log = path.join(tempDir(), 'stub.log');
  fs.writeFileSync(log, '');
  const r = spawnSync(SHELL, [script, ...args], {
    cwd: work,
    encoding: 'utf8',
    // stdin closed: the script must never read it.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: makeBin(bin),
      HOME: work,
      STUB_LOG: log,
      STUB_CURL_DIR: ASSETS,
      STUB_LATEST_VERSION: '1.2.3',
      STUB_REAL_SHA256SUM: REAL_SHA256SUM || '',
      ...env,
    },
  });
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, cwd: work, dir: path.join(work, 'squire-docs') };
}

const dockerCalls = (calls) => calls.filter((c) => c.startsWith('docker '));

// ── Refusals before anything is created ───────────────────────────────────

test('refuses the placeholder repository', () => {
  const copy = path.join(placeholderCopy(), 'install.sh');
  assert.ok(fs.readFileSync(copy, 'utf8').includes(`REPOSITORY='${PLACEHOLDER}'`));
  const r = run(['--version', '1.2.3'], { script: copy });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /has not been released yet/);
  assert.equal(fs.existsSync(r.dir), false);
  assert.deepEqual(r.calls, []);
});

test('usage errors exit 2 naming the flag and --help', () => {
  for (const [args, re] of [
    [['--bogus'], /Unknown option --bogus/],
    [['--dir'], /--dir needs a value/],
    [['--name'], /--name needs a value/],
    [['extra'], /Unexpected argument extra/],
    [['--version', 'v1.2.3'], /without a leading v, for example --version 1\.2\.3/],
    [['--version', '1.2'], /--version 1\.2 is not X\.Y\.Z/],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, re);
    assert.match(r.stderr, /--help/);
    assert.equal(fs.existsSync(r.dir), false);
  }
});

test('--help prints usage on stderr and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Usage: sh install\.sh/);
  assert.deepEqual(r.calls, []);
});

for (const [label, env, bin, re] of [
  ['docker missing', {}, { docker: false }, /Docker is not installed.*https:\/\/docs\.docker\.com\/compose\/install\//],
  ['compose plugin missing', { STUB_DOCKER_COMPOSE_MISSING: '1' }, {}, /Docker Compose v2 is not available.*compose\/install/],
  ['compose v1', { STUB_DOCKER_COMPOSE_VERSION: '1.29.2' }, {}, /Found Docker Compose 1\.29\.2\. Squire Docs needs Docker Compose 2\.24 or later/],
  ['compose v2 older than 2.24', { STUB_DOCKER_COMPOSE_VERSION: 'v2.23.3' }, {}, /Found Docker Compose 2\.23\.3\. Squire Docs needs Docker Compose 2\.24 or later/],
  ['daemon down', { STUB_DOCKER_INFO_EXIT: '1' }, {}, /Docker is not running\. Start Docker Desktop or the docker service/],
  ['curl missing', {}, { curl: false }, /curl is not installed/],
  ['no checksum tool', {}, { sha256sum: false }, /Neither sha256sum nor shasum.*never used unverified/],
]) {
  test(`prerequisite refusal: ${label}`, () => {
    const r = run(['--name', 'Ada'], { env, bin });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, re);
    assert.equal(r.stderr.trim().split('\n').length, 1, 'one message');
    assert.equal(fs.existsSync(r.dir), false, 'no folder created');
    assert.ok(!r.calls.some((c) => c.startsWith('curl')), 'nothing downloaded');
    assert.ok(!r.calls.some((c) => / up /.test(c)), 'nothing started');
  });
}

test('Compose 2.24.0 exactly is accepted, and a desktop suffix parses', () => {
  for (const v of ['2.24.0', 'v2.29.1-desktop.1', '3.0.0']) {
    const r = run([], { env: { STUB_DOCKER_COMPOSE_VERSION: v } });
    assert.equal(r.status, 0, `${v}: ${r.stderr}`);
  }
});

// ── Existing installation ─────────────────────────────────────────────────

test('existing compose.yml prints the upgrade command and changes nothing', () => {
  const cwd = tempDir('squire-060-cwd-');
  const dir = path.join(cwd, 'squire-docs');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SQUIRE_VERSION=1.0.0\n');
  const before = fs.readdirSync(dir).sort();
  const r = run([], { cwd, env: { STUB_LATEST_VERSION: '1.4.0' } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  const real = fs.realpathSync(dir);
  assert.equal(
    r.stderr,
    `Squire Docs is already installed in ${real}.\n` +
      `To upgrade, set SQUIRE_VERSION in ${real}/.env to the new release, for example 1.4.0, then run:\n` +
      `  cd ${real} && docker compose pull && docker compose up -d --wait\n`,
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'SQUIRE_VERSION=1.0.0\n');
  assert.ok(!r.calls.some((c) => c.startsWith('curl') && c.includes(' -o ')), 'no downloads');
});

test('existing install without a resolvable latest version omits the example', () => {
  const cwd = tempDir('squire-060-cwd-');
  fs.mkdirSync(path.join(cwd, 'squire-docs'));
  fs.writeFileSync(path.join(cwd, 'squire-docs', 'compose.yml'), '');
  const r = run([], { cwd, env: { STUB_LATEST_VERSION: '' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /to the new release, then run:/);
});

test('an empty existing folder is a fresh install and is kept on failure', () => {
  const cwd = tempDir('squire-060-cwd-');
  fs.mkdirSync(path.join(cwd, 'squire-docs'));
  const ok = run([], { cwd });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `${LINK}\n`);

  const cwd2 = tempDir('squire-060-cwd-');
  fs.mkdirSync(path.join(cwd2, 'squire-docs'));
  const bad = run([], { cwd: cwd2, env: { STUB_CURL_FAIL: 'squire' } });
  assert.equal(bad.status, 1);
  assert.deepEqual(fs.readdirSync(path.join(cwd2, 'squire-docs')), [], 'files removed, folder it did not create kept');
});

// ── Version resolution and downloads ──────────────────────────────────────

test('without --version the latest release comes from the releases/latest Location header', () => {
  const r = run([], { env: { STUB_LATEST_VERSION: '1.2.3' } });
  assert.equal(r.status, 0, r.stderr);
  const head = r.calls.find((c) => c.startsWith('curl') && / -[a-zA-Z]*I /.test(c));
  assert.ok(head && head.includes(`https://github.com/${TEST_REPOSITORY}/releases/latest`), head);
  const downloads = r.calls.filter((c) => c.startsWith('curl') && c.includes(' -o '));
  assert.deepEqual(
    downloads.map((c) => c.split(' ').pop()),
    ['SHA256SUMS', 'compose.yml', 'squire', 'env.example'].map(
      (n) => `https://github.com/${TEST_REPOSITORY}/releases/download/v1.2.3/${n}`,
    ),
  );
  assert.equal(fs.readFileSync(path.join(r.dir, '.env'), 'utf8'), 'SQUIRE_VERSION=1.2.3\n');
});

test('an unresolvable latest version names --version and removes the folder', () => {
  const r = run([], { env: { STUB_LATEST_VERSION: '' } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Pass the release to install with --version X\.Y\.Z/);
  assert.equal(fs.existsSync(r.dir), false);
});

test('--version skips latest resolution; --dir is honored', () => {
  const cwd = tempDir('squire-060-cwd-');
  const r = run(['--version', '1.2.3', '--dir', 'other-folder'], { cwd, env: { STUB_LATEST_VERSION: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.startsWith('curl') && / -[a-zA-Z]*I /.test(c)), 'no latest lookup');
  const dir = path.join(cwd, 'other-folder');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.env', '.env.example', 'SHA256SUMS', 'compose.yml', 'squire']);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'SQUIRE_VERSION=1.2.3\n');
  assert.equal(fs.existsSync(path.join(cwd, 'squire-docs')), false);
});

test('a failed download names the asset and release, removes this run\'s files and folder', () => {
  for (const asset of ['SHA256SUMS', 'compose.yml', 'squire', 'env.example']) {
    const r = run(['--version', '1.2.3'], { env: { STUB_CURL_FAIL: asset } });
    assert.equal(r.status, 1, asset);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`Could not download ${asset} for Squire Docs 1\\.2\\.3`));
    assert.match(r.stderr, /--version/);
    assert.equal(fs.existsSync(r.dir), false, `${asset}: folder removed`);
    assert.ok(!r.calls.some((c) => / up /.test(c)), 'nothing started');
  }
});

test('SQUIRE_INSTALL_ASSET_URL replaces the download base and changes nothing else', () => {
  const r = run(['--version', '1.2.3'], { env: { SQUIRE_INSTALL_ASSET_URL: 'http://127.0.0.1:8000/' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${LINK}\n`);
  const downloads = r.calls.filter((c) => c.startsWith('curl') && c.includes(' -o '));
  assert.deepEqual(
    downloads.map((c) => c.split(' ').pop()),
    ['SHA256SUMS', 'compose.yml', 'squire', 'env.example'].map((n) => `http://127.0.0.1:8000/${n}`),
  );
  assert.equal(fs.readFileSync(path.join(r.dir, '.env'), 'utf8'), 'SQUIRE_VERSION=1.2.3\n');
});

// ── Checksums ─────────────────────────────────────────────────────────────

test('a checksum mismatch names the file, removes this run\'s files, and never starts', () => {
  const tampered = path.join(tempDir(), 'assets');
  fs.cpSync(ASSETS, tampered, { recursive: true });
  fs.appendFileSync(path.join(tampered, 'compose.yml'), '# tampered\n');
  const r = run(['--version', '1.2.3'], { env: { STUB_CURL_DIR: tampered } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Checksum mismatch for compose\.yml/);
  assert.equal(fs.existsSync(r.dir), false);
  assert.ok(!dockerCalls(r.calls).some((c) => c.includes(' up ')), 'never calls docker compose up');
});

test('the shasum branch verifies with real digests when sha256sum is absent', () => {
  const r = run(['--version', '1.2.3'], { bin: { sha256sum: false, shasum: true } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.some((c) => c === 'shasum -a 256 compose.yml'));

  const tampered = path.join(tempDir(), 'assets');
  fs.cpSync(ASSETS, tampered, { recursive: true });
  fs.appendFileSync(path.join(tampered, 'squire'), '\n');
  const bad = run(['--version', '1.2.3'], { bin: { sha256sum: false, shasum: true }, env: { STUB_CURL_DIR: tampered } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Checksum mismatch for squire/);
});

test('a SHA256SUMS that does not list a file is refused', () => {
  const partial = path.join(tempDir(), 'assets');
  fs.cpSync(ASSETS, partial, { recursive: true });
  const sums = fs.readFileSync(path.join(partial, 'SHA256SUMS'), 'utf8').split('\n').filter((l) => !l.endsWith('env.example'));
  fs.writeFileSync(path.join(partial, 'SHA256SUMS'), sums.join('\n'));
  const r = run(['--version', '1.2.3'], { env: { STUB_CURL_DIR: partial } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not list env\.example/);
  assert.equal(fs.existsSync(r.dir), false);
});

// ── Success path ──────────────────────────────────────────────────────────

test('success: folder contents, .env, executable wrapper, call order, and stdout is only the link', () => {
  const r = run(['--name', 'Ada Lovelace', '--email', 'ada@example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${LINK}\n`);
  assert.deepEqual(fs.readdirSync(r.dir).sort(), ['.env', '.env.example', 'SHA256SUMS', 'compose.yml', 'squire']);
  assert.equal(fs.readFileSync(path.join(r.dir, '.env'), 'utf8'), 'SQUIRE_VERSION=1.2.3\n');
  assert.equal(fs.readFileSync(path.join(r.dir, '.env.example'), 'utf8'), fs.readFileSync(path.join(ASSETS, 'env.example'), 'utf8'));
  assert.equal(fs.statSync(path.join(r.dir, 'squire')).mode & 0o111, 0o111);
  const order = dockerCalls(r.calls).filter((c) => / (up|exec) /.test(c));
  assert.deepEqual(order, [
    'docker compose up -d --wait',
    'docker compose exec -T app squire doctor',
    'docker compose exec -T app squire claim-link --name Ada Lovelace --email ada@example.com',
  ]);
});

test('success without --name and --email calls a bare claim-link', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(dockerCalls(r.calls).includes('docker compose exec -T app squire claim-link'));
});

test('the success message carries the FR-040 TLS sentence on stderr', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Plain HTTP is supported only on localhost\. To expose this instance, put a TLS-terminating proxy in front of it and set an https APP_URL in \.env\./);
  const header = fs.readFileSync(path.join(SELF_HOST_DIR, 'install.sh'), 'utf8').split('set -eu')[0];
  assert.match(header.replace(/\n# /g, ' '), /Plain HTTP is supported only on localhost\. To expose an instance to other machines, put a TLS-terminating proxy in front of it and set an https APP_URL/);
  assert.match(header, /SQUIRE_INSTALL_ASSET_URL/);
});

test('piping stdout to tail -n 1 yields the link', () => {
  const r = run([]);
  assert.equal(r.stdout.trim().split('\n').pop(), LINK);
});

test('the script never reads stdin, and neither do the commands it runs', () => {
  const stdinLog = path.join(tempDir(), 'stdin.log');
  const cwd = tempDir('squire-060-cwd-');
  const r = spawnSync(SHELL, [SCRIPT], {
    cwd,
    input: 'echo SHOULD-NOT-RUN\n',
    encoding: 'utf8',
    env: { PATH: makeBin(), STUB_CURL_DIR: ASSETS, STUB_LATEST_VERSION: '1.2.3', STUB_STDIN_LOG: stdinLog, STUB_REAL_SHA256SUM: REAL_SHA256SUM || '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${LINK}\n`);
  assert.equal(fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, 'utf8') : '', '');
});

// ── Failures after the stack starts ───────────────────────────────────────

test('a port conflict prints the SQUIRE_PORT message and keeps the files', () => {
  const r = run([], { env: { STUB_DOCKER_UP_EXIT: '1', STUB_DOCKER_UP_STDERR: 'Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:3910 failed: port is already allocated' } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  const real = fs.realpathSync(r.dir);
  assert.match(r.stderr, new RegExp(`Port 3910 is in use\\. Set SQUIRE_PORT in ${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.env and run docker compose up -d --wait again\\.`));
  assert.ok(fs.existsSync(path.join(r.dir, 'compose.yml')), 'installation kept');
  assert.ok(!dockerCalls(r.calls).some((c) => c.includes('doctor')));
});

test('the port message uses SQUIRE_PORT when set, and matches "address already in use"', () => {
  const r = run([], { env: { SQUIRE_PORT: '4000', STUB_DOCKER_UP_EXIT: '1', STUB_DOCKER_UP_STDERR: 'listen tcp 127.0.0.1:4000: bind: address already in use' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Port 4000 is in use/);
});

test('another up failure names docker compose logs app', () => {
  const r = run([], { env: { STUB_DOCKER_UP_EXIT: '1', STUB_DOCKER_UP_STDERR: 'dependency failed to start: container squire-docs-app-1 is unhealthy' } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /container squire-docs-app-1 is unhealthy/);
  assert.match(r.stderr, /docker compose logs app/);
  assert.ok(fs.existsSync(path.join(r.dir, 'compose.yml')), 'installation kept, so a rerun prints the upgrade command');
});

test('a doctor failure exits 1 and never mints a link', () => {
  const r = run([], { env: { STUB_DOCTOR_EXIT: '1' } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /doctor: all checks passed/, 'doctor output passed through on stderr');
  assert.match(r.stderr, /Fix the failed check, then run \.\/squire claim-link/);
  assert.ok(!dockerCalls(r.calls).some((c) => c.includes('claim-link')));
});

test('a claim-link that fails or prints a non-link exits 1 naming ./squire claim-link', () => {
  for (const env of [
    { STUB_CLAIM_EXIT: '1' },
    { STUB_CLAIM_OUTPUT: 'not a link' },
    { STUB_CLAIM_OUTPUT: `${LINK}\nextra line` },
    { STUB_CLAIM_OUTPUT: 'http://localhost:3910/claim#bad token' },
    { STUB_CLAIM_OUTPUT: '' },
  ]) {
    const r = run([], { env });
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /\.\/squire claim-link/);
  }
});

// ── Static checks ─────────────────────────────────────────────────────────

test('POSIX sh: no bashisms the plan forbids', () => {
  const text = fs.readFileSync(path.join(SELF_HOST_DIR, 'install.sh'), 'utf8');
  assert.equal(text.split('\n')[0], '#!/bin/sh');
  const code = text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  for (const re of [/\[\[/, /\blocal\s/, /pipefail/, /\bfunction\s/, /\$\{[A-Za-z_]+\[/, /<<</, /(^|[;&|]\s*)read\s/m]) {
    assert.ok(!re.test(code), `forbidden construct ${re}`);
  }
  assert.equal(fs.statSync(path.join(SELF_HOST_DIR, 'install.sh')).mode & 0o111, 0o111, 'executable on disk');
});

test('shellcheck -s sh passes (skipped when shellcheck is not installed)', (t) => {
  const sc = which('shellcheck');
  if (!sc) {
    t.diagnostic('shellcheck not installed; skipped');
    t.skip('shellcheck not installed; skipped');
    return;
  }
  const r = spawnSync(sc, ['-s', 'sh', path.join(SELF_HOST_DIR, 'install.sh'), path.join(SELF_HOST_DIR, 'squire')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
