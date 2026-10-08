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
const UTILS = ['cat', 'grep', 'sed', 'head', 'cut', 'tr', 'mkdir', 'rmdir', 'rm', 'mv', 'chmod', 'mktemp', 'dirname', 'basename', 'od', 'awk'];
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

/** .env as lines; the Compose project name is random, so it is matched apart. */
const PROJECT_RE = /^COMPOSE_PROJECT_NAME=squire-docs-[0-9a-f]{8}$/;
function envLines(dir) {
  return fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n');
}
/** Assert .env holds exactly these lines plus one unique project name, in order. */
function assertEnv(dir, { version = '1.2.3', port } = {}) {
  const lines = envLines(dir);
  assert.equal(lines.pop(), '', '.env ends with a newline');
  assert.equal(lines[0], `SQUIRE_VERSION=${version}`);
  assert.match(lines[1], PROJECT_RE);
  assert.deepEqual(lines.slice(2), port ? [`SQUIRE_PORT=${port}`] : []);
  return lines[1].split('=')[1];
}

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

// Rerunning the installer on an installation resumes it (first-user report
// 2026-10-08: a failed image pull left a folder the rerun refused to start).

/** A completed install at 1.2.3; returns its cwd and folder. */
function installed(args = []) {
  const r = run(['--version', '1.2.3', ...args]);
  assert.equal(r.status, 0, r.stderr);
  return { cwd: r.cwd, dir: r.dir };
}

/** Every entry in the folder with its bytes, mode, and mtime. */
function snapshot(dir) {
  const out = {};
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    out[n] = { body: fs.readFileSync(p, 'utf8'), mode: st.mode, mtime: st.mtimeMs };
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UPGRADE_RE = /To upgrade, set SQUIRE_VERSION/;

test('rerun on an existing install starts it, runs doctor, prints the link, and touches no file', () => {
  const { cwd, dir } = installed();
  const before = snapshot(dir);
  const r = run(['--name', 'Ada Lovelace', '--email', 'ada@example.com'], { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${LINK}\n`);
  assert.deepEqual(snapshot(dir), before, 'folder unchanged, byte for byte');
  assert.ok(!r.calls.some((c) => c.startsWith('curl') && c.includes(' -o ')), 'no downloads');
  assert.deepEqual(dockerCalls(r.calls).filter((c) => / (up|exec) /.test(c)), [
    'docker compose up -d --wait',
    'docker compose exec -T app squire doctor',
    'docker compose exec -T app squire claim-link --name Ada Lovelace --email ada@example.com',
  ]);
  const real = fs.realpathSync(dir);
  assert.match(r.stderr, new RegExp(`^Squire Docs 1\\.2\\.3 is already installed in ${esc(real)}\\. Starting it again; nothing in the folder is downloaded or changed\\.\n`));
  assert.match(r.stderr, /Open the claim link below, check your name and email, and click Continue\./);
  assert.match(r.stderr, /Open this link within 15 minutes to create the owner account\./, 'claim-link stderr passed through');
  assert.match(r.stderr, new RegExp(`running at http://localhost:3910 in ${esc(real)}\\.`));
  assert.doesNotMatch(r.stderr, UPGRADE_RE, 'latest is the installed release');
  assert.doesNotMatch(r.stderr, /^Error/m);
});

test('rerun on a claimed instance says the link signs the owner in', () => {
  const { cwd } = installed();
  const r = run(['--name', 'Ada'], {
    cwd,
    env: { STUB_CLAIM_STDERR: 'This instance already has an owner (Ada Lovelace, ada@example.com); --name and --email were ignored. The link signs in the owner within 15 minutes.' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${LINK}\n`);
  assert.match(r.stderr, /already has an owner \(Ada Lovelace, ada@example\.com\)/);
  assert.match(r.stderr, /Open the sign-in link below to sign in as the owner\./);
  assert.doesNotMatch(r.stderr, /Open the claim link/);
});

test('the upgrade hint appears only when the latest release is newer than the installed one', () => {
  const { cwd, dir } = installed();
  const real = fs.realpathSync(dir);
  const newer = run([], { cwd, env: { STUB_LATEST_VERSION: '1.4.0' } });
  assert.equal(newer.status, 0, newer.stderr);
  assert.equal(newer.stdout, `${LINK}\n`);
  assert.ok(
    newer.stderr.endsWith(
      `Squire Docs 1.4.0 is available. This installation runs 1.2.3. To upgrade, set SQUIRE_VERSION=1.4.0 in ${real}/.env, then run:\n` +
        `  cd ${real} && docker compose pull && docker compose up -d --wait\n`,
    ),
    newer.stderr,
  );
  assert.ok(!dockerCalls(newer.calls).some((c) => c.includes(' pull')), 'never upgrades by itself');
  assert.match(envLines(dir)[0], /^SQUIRE_VERSION=1\.2\.3$/);
  for (const latest of ['1.2.3', '1.2.0', '0.9.9', '']) {
    const r = run([], { cwd, env: { STUB_LATEST_VERSION: latest } });
    assert.equal(r.status, 0, `${latest}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, UPGRADE_RE, `latest ${JSON.stringify(latest)}`);
    assert.doesNotMatch(r.stderr, /is available/);
  }
});

test('the installed release comes from .env, then from the compose.yml default; prereleases sort first', () => {
  for (const [envBody, latest, hint] of [
    ['SQUIRE_VERSION=1.2.3-rc.1\n', '1.2.3', true],
    ['SQUIRE_VERSION="1.2.3"\n', '1.10.0', true],
    ['SQUIRE_VERSION=1.10.0\n', '1.9.0', false],
    ['COMPOSE_PROJECT_NAME=x\n', '1.2.3', false], // compose default 1.2.3
    ['COMPOSE_PROJECT_NAME=x\n', '2.0.0', true],
  ]) {
    const { cwd, dir } = installed();
    fs.writeFileSync(path.join(dir, '.env'), envBody);
    const r = run([], { cwd, env: { STUB_LATEST_VERSION: latest } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(UPGRADE_RE.test(r.stderr), hint, `${envBody.trim()} vs ${latest}: ${r.stderr}`);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), envBody, '.env untouched');
  }
});

test('--version on an existing install explains how to switch and does not apply it', () => {
  const { cwd, dir } = installed();
  const real = fs.realpathSync(dir);
  const r = run(['--version', '1.4.0'], { cwd, env: { STUB_LATEST_VERSION: '1.4.0' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${LINK}\n`);
  assert.match(
    r.stderr,
    new RegExp(
      `--version 1\\.4\\.0 was not applied: the installer never changes the release of an existing installation, which runs 1\\.2\\.3\\.\n` +
        `To switch to 1\\.4\\.0, set SQUIRE_VERSION=1\\.4\\.0 in ${esc(real)}/\\.env, then run:\n` +
        `  cd ${esc(real)} && docker compose pull && docker compose up -d --wait\n`,
    ),
  );
  assert.doesNotMatch(r.stderr, UPGRADE_RE, 'the switch note replaces the upgrade hint');
  assert.match(envLines(dir)[0], /^SQUIRE_VERSION=1\.2\.3$/);
  assert.ok(!r.calls.some((c) => c.startsWith('curl')), 'no lookup, no downloads');

  const same = run(['--version', '1.2.3'], { cwd });
  assert.equal(same.status, 0, same.stderr);
  assert.doesNotMatch(same.stderr, /was not applied|To switch/);
});

test('a rerun uses the port saved in .env, and SQUIRE_PORT when set', () => {
  const { cwd, dir } = installed();
  fs.appendFileSync(path.join(dir, '.env'), 'SQUIRE_PORT=4011\n');
  const r = run([], { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /running at http:\/\/localhost:4011 /);
  const e = run([], { cwd, env: { SQUIRE_PORT: '4022' } });
  assert.equal(e.status, 0, e.stderr);
  assert.match(e.stderr, /running at http:\/\/localhost:4022 /);
  assert.ok(envLines(dir).includes('SQUIRE_PORT=4011'), '.env untouched');
});

test('a failed rerun never removes anything from the installation', () => {
  for (const env of [
    { STUB_DOCKER_UP_EXIT: '1', STUB_DOCKER_UP_STDERR: 'dependency failed to start: container is unhealthy' },
    { STUB_DOCKER_UP_EXIT: '1', STUB_DOCKER_UP_STDERR: ' app Error error from registry: unauthorized' },
    { STUB_DOCTOR_EXIT: '1' },
    { STUB_CLAIM_EXIT: '1' },
  ]) {
    const { cwd, dir } = installed();
    const before = snapshot(dir);
    const r = run([], { cwd, env });
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.equal(r.stdout, '');
    assert.deepEqual(snapshot(dir), before, JSON.stringify(env));
  }
});

test('an install folder without the ./squire wrapper still gets doctor and a link', () => {
  const { cwd, dir } = installed();
  fs.rmSync(path.join(dir, 'squire'));
  const r = run([], { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${LINK}\n`);
  assert.deepEqual(dockerCalls(r.calls).filter((c) => / exec /.test(c)), [
    'docker compose exec -T app squire doctor',
    'docker compose exec -T app squire claim-link',
  ]);
});

// ── Image download failures ───────────────────────────────────────────────

test('an unauthorized image pull names the image and the registry reason, keeps the files, and a rerun finishes', () => {
  const out = [
    ' app Pulling',
    ' app Error error from registry: unauthorized',
    'Error response from daemon: error from registry: unauthorized',
  ].join('\n');
  const bad = run(['--version', '1.2.3', '--name', 'Ada'], { env: { STUB_DOCKER_UP_EXIT: '1', STUB_DOCKER_UP_STDERR: out } });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  const lines = bad.stderr.trim().split('\n');
  assert.equal(
    lines.pop(),
    'Error: Could not download the image ghcr.io/squiredocs/squiredocs:1.2.3 (the registry said: error from registry: unauthorized). ' +
      'Your install folder is fine. Run the same install command again; it picks up where it left off.',
  );
  assert.match(bad.stderr, /Error response from daemon/, 'compose output passed through');
  assert.doesNotMatch(bad.stderr, /did not start/);
  const before = snapshot(bad.dir);
  assert.deepEqual(Object.keys(before), ['.env', '.env.example', 'SHA256SUMS', 'compose.yml', 'squire']);
  assert.ok(!dockerCalls(bad.calls).some((c) => c.includes('doctor')));

  const again = run(['--version', '1.2.3', '--name', 'Ada'], { cwd: bad.cwd });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, `${LINK}\n`);
  assert.deepEqual(snapshot(bad.dir), before);
  assert.ok(dockerCalls(again.calls).includes('docker compose exec -T app squire claim-link --name Ada'));
});

test('other registry and network failures get the download message, naming the failing service image', () => {
  for (const [stderr, image, reason] of [
    ['Error response from daemon: pull access denied for ghcr.io/squiredocs/squiredocs, repository does not exist or may require authorization', 'ghcr.io/squiredocs/squiredocs:1.2.3', 'pull access denied for ghcr.io/squiredocs/squiredocs'],
    [' app Error manifest for ghcr.io/squiredocs/squiredocs:1.2.3 not found: manifest unknown: manifest unknown', 'ghcr.io/squiredocs/squiredocs:1.2.3', 'manifest for ghcr.io/squiredocs/squiredocs:1.2.3 not found'],
    [' postgres Error toomanyrequests: You have reached your pull rate limit.', 'pgvector/pgvector:pg16', 'toomanyrequests: You have reached your pull rate limit.'],
    [' redis Error Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host', 'redis:7', 'dial tcp: lookup registry-1.docker.io: no such host'],
    ['Error response from daemon: Get "https://ghcr.io/v2/": net/http: TLS handshake timeout', 'ghcr.io/squiredocs/squiredocs:1.2.3', 'TLS handshake timeout'],
  ]) {
    const r = run(['--version', '1.2.3'], { env: { STUB_DOCKER_UP_EXIT: '1', STUB_DOCKER_UP_STDERR: stderr } });
    assert.equal(r.status, 1, stderr);
    const last = r.stderr.trim().split('\n').pop();
    assert.ok(last.startsWith(`Error: Could not download the image ${image} (the registry said: `), last);
    assert.ok(last.includes(reason), last);
    assert.match(last, /Run the same install command again; it picks up where it left off\.$/);
    assert.ok(fs.existsSync(path.join(r.dir, 'compose.yml')), 'installation kept');
  }
});

test('a pull failure on a rerun names the installed release', () => {
  const { cwd } = installed();
  const r = run([], { cwd, env: { STUB_LATEST_VERSION: '1.4.0', STUB_DOCKER_UP_EXIT: '1', STUB_DOCKER_UP_STDERR: ' app Error error from registry: denied' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not download the image ghcr\.io\/squiredocs\/squiredocs:1\.2\.3 \(the registry said: error from registry: denied\)/);
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

// Review finding H2: a non-empty folder is never written to, and the failure
// cleanup can only ever remove files this run created.
test('a non-empty --dir is refused before anything is downloaded, and its files are untouched', () => {
  const cwd = tempDir('squire-060-cwd-');
  const dir = path.join(cwd, 'mine');
  fs.mkdirSync(dir);
  const mine = { '.env': 'MY_SECRET=1\n', '.env.example': 'mine\n', squire: 'my script\n', 'notes.txt': 'keep me\n' };
  for (const [n, body] of Object.entries(mine)) fs.writeFileSync(path.join(dir, n), body);
  const r = run(['--dir', 'mine', '--version', '1.2.3'], { cwd });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  const real = fs.realpathSync(dir);
  assert.equal(
    r.stderr,
    `Error: ${real} is not empty. Squire Docs installs only into a new or empty folder, so it never overwrites your files. Choose another folder with --dir.\n`,
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(mine).sort());
  for (const [n, body] of Object.entries(mine)) assert.equal(fs.readFileSync(path.join(dir, n), 'utf8'), body, n);
  assert.ok(!r.calls.some((c) => c.startsWith('curl')), 'nothing downloaded');
  assert.ok(!dockerCalls(r.calls).some((c) => / up /.test(c)), 'nothing started');
});

test('a failed download never removes a file the user already had (hidden files count as content)', () => {
  const cwd = tempDir('squire-060-cwd-');
  const dir = path.join(cwd, 'squire-docs');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), 'my checksums\n');
  fs.writeFileSync(path.join(dir, '.hidden'), 'x\n');
  const r = run(['--version', '1.2.3'], { cwd, env: { STUB_CURL_FAIL: 'compose.yml' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not empty/);
  assert.equal(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'), 'my checksums\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.hidden', 'SHA256SUMS']);

  const onlyHidden = tempDir('squire-060-cwd-');
  fs.mkdirSync(path.join(onlyHidden, 'squire-docs'));
  fs.writeFileSync(path.join(onlyHidden, 'squire-docs', '.env'), 'MINE=1\n');
  const h = run(['--version', '1.2.3'], { cwd: onlyHidden });
  assert.equal(h.status, 1);
  assert.match(h.stderr, /is not empty/);
  assert.equal(fs.readFileSync(path.join(onlyHidden, 'squire-docs', '.env'), 'utf8'), 'MINE=1\n');
});

test('a --dir that is a file is refused', () => {
  const cwd = tempDir('squire-060-cwd-');
  fs.writeFileSync(path.join(cwd, 'squire-docs'), 'a file\n');
  const r = run(['--version', '1.2.3'], { cwd });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /squire-docs exists and is not a folder\. Choose a new or empty folder with --dir\./);
  assert.equal(fs.readFileSync(path.join(cwd, 'squire-docs'), 'utf8'), 'a file\n');
  assert.ok(!r.calls.some((c) => c.startsWith('curl')));
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
  assertEnv(r.dir);
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
  assertEnv(dir);
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
  assertEnv(r.dir);
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
  assertEnv(r.dir);
  assert.equal(fs.readFileSync(path.join(r.dir, '.env.example'), 'utf8'), fs.readFileSync(path.join(ASSETS, 'env.example'), 'utf8'));
  assert.equal(fs.statSync(path.join(r.dir, 'squire')).mode & 0o111, 0o111);
  const order = dockerCalls(r.calls).filter((c) => / (up|exec) /.test(c));
  assert.deepEqual(order, [
    'docker compose up -d --wait',
    'docker compose exec -T app squire doctor',
    'docker compose exec -T app squire claim-link --name Ada Lovelace --email ada@example.com',
  ]);
});

// Review finding M1: folders that share a basename never share a Compose project.
test('each install writes its own COMPOSE_PROJECT_NAME, and every compose call runs where .env is', () => {
  const pwdLog = path.join(tempDir(), 'pwd.log');
  const a = run(['--version', '1.2.3'], { env: { STUB_PWD_LOG: pwdLog } });
  assert.equal(a.status, 0, a.stderr);
  const b = run(['--version', '1.2.3']);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(path.basename(a.dir), path.basename(b.dir));
  const pa = assertEnv(a.dir);
  const pb = assertEnv(b.dir);
  assert.notEqual(pa, pb, 'two installs in same-named folders get different project names');
  // docker compose reads .env (and so COMPOSE_PROJECT_NAME) from its working
  // directory: up, doctor, and claim-link must all run in the install folder.
  const composeCalls = dockerCalls(a.calls).filter((c) => c.startsWith('docker compose'));
  const pwds = fs.readFileSync(pwdLog, 'utf8').split('\n').filter(Boolean);
  assert.equal(pwds.length, composeCalls.length);
  const real = fs.realpathSync(a.dir);
  composeCalls.forEach((c, i) => {
    if (/ (up|exec) /.test(c)) assert.equal(fs.realpathSync(pwds[i]), real, c);
  });
  assert.equal(composeCalls.filter((c) => / (up|exec) /.test(c)).length, 3);
  // The wrapper changes to its own folder first, so ./squire from anywhere does too.
  assert.match(fs.readFileSync(path.join(a.dir, 'squire'), 'utf8'), /^cd "\$\(dirname "\$0"\)"/m);
});

// Review finding M6: the port the first up used is the port later commands use.
test('SQUIRE_PORT is written to .env when set, and left out when unset or empty', () => {
  const r = run(['--version', '1.2.3'], { env: { SQUIRE_PORT: '4011' } });
  assert.equal(r.status, 0, r.stderr);
  assertEnv(r.dir, { port: '4011' });
  assert.match(r.stderr, /running at http:\/\/localhost:4011/);
  const e = run(['--version', '1.2.3'], { env: { SQUIRE_PORT: '' } });
  assert.equal(e.status, 0, e.stderr);
  assertEnv(e.dir);
});

test('an invalid SQUIRE_PORT is refused before anything is created', () => {
  for (const port of ['abc', '0', '65536', '123456', '80 81', '4000\nAPP_URL=http://evil']) {
    const r = run(['--version', '1.2.3'], { env: { SQUIRE_PORT: port } });
    assert.equal(r.status, 1, JSON.stringify(port));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /is not a port number\. Set it to a free port from 1 to 65535/);
    assert.equal(fs.existsSync(r.dir), false);
    assert.deepEqual(r.calls, []);
  }
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
  assert.ok(fs.existsSync(path.join(r.dir, 'compose.yml')), 'installation kept, so a rerun resumes it');
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

// ── Truncated downloads (review finding H1) ──────────────────────────────

/** Feed `text` to the shell on stdin, as curl | sh does, with every stub on PATH. */
function runPiped(text) {
  const cwd = tempDir('squire-060-cwd-');
  const log = path.join(tempDir(), 'stub.log');
  fs.writeFileSync(log, '');
  const r = spawnSync(SHELL, ['-s', '--', '--version', '1.2.3', '--name', 'Ada'], {
    cwd,
    input: text,
    encoding: 'utf8',
    env: { PATH: PIPE_BIN, HOME: cwd, STUB_LOG: log, STUB_CURL_DIR: ASSETS, STUB_LATEST_VERSION: '1.2.3', STUB_REAL_SHA256SUM: REAL_SHA256SUM || '' },
  });
  return { status: r.status, stdout: r.stdout, calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), cwd };
}
const PIPE_BIN = makeBin();

function assertRunsNothing(text, label) {
  const r = runPiped(text);
  assert.deepEqual(r.calls, [], `${label}: no docker or curl call`);
  assert.equal(r.stdout, '', `${label}: prints nothing on stdout`);
  assert.deepEqual(fs.readdirSync(r.cwd), [], `${label}: creates nothing`);
}

test('the whole script piped on stdin installs (control for the truncation tests)', () => {
  const r = runPiped(fs.readFileSync(SCRIPT, 'utf8'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${LINK}\n`);
});

test('every truncation at a line boundary runs nothing', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(text.endsWith('\n{ main "$@"; }\n'), 'the last line calls main inside a brace group');
  const lines = text.split('\n');
  // lines ends with '' (the final newline); the last real line is { main "$@"; }.
  for (let k = 0; k < lines.length - 2; k++) {
    assertRunsNothing(lines.slice(0, k).join('\n') + (k ? '\n' : ''), `first ${k} lines`);
  }
});

test('sampled truncations inside a line run nothing', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const end = text.lastIndexOf('\n{ main "$@"; }');
  for (let cut = 1; cut < end; cut += 41) assertRunsNothing(text.slice(0, cut), `first ${cut} bytes`);
});

test('every truncation inside the last line runs nothing (brace group, review H1 follow-up)', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const start = text.lastIndexOf('\n{ main "$@"; }') + 1;
  const stop = text.length - 1; // the full last line without its newline still runs, by design
  for (let cut = start; cut < stop; cut += 1) assertRunsNothing(text.slice(0, cut), `first ${cut} bytes`);
});

// ── Static checks ─────────────────────────────────────────────────────────

test('POSIX sh: no bashisms the plan forbids', () => {
  const text = fs.readFileSync(path.join(SELF_HOST_DIR, 'install.sh'), 'utf8');
  assert.equal(text.split('\n')[0], '#!/bin/sh');
  const code = text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  for (const re of [/\[\[/, /\blocal\s/, /pipefail/, /\bfunction\s/, /\$\{[A-Za-z_]+\[/, /<<</, /(^|[;&|]\s*)read\s/m]) {
    assert.ok(!re.test(code), `forbidden construct ${re}`);
  }
  assert.ok(fs.statSync(path.join(SELF_HOST_DIR, 'install.sh')).mode & 0o100, 'executable on disk');
  const idx = spawnSync('git', ['ls-files', '-s', 'distribution/self-host/install.sh'], { cwd: path.join(SELF_HOST_DIR, '../..'), encoding: 'utf8' });
  if (idx.status === 0 && idx.stdout.trim()) assert.match(idx.stdout, /^100755 /, 'git records install.sh as 100755');
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
