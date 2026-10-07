/**
 * compose.yml, .env.example, and the squire wrapper (feature 060, T007,
 * contracts/compose-and-assets.md, FR-001 to FR-008).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { REPOSITORY, VERSION_TOKEN } from '../../distribution/self-host/release.mjs';
import { ROOT, SELF_HOST_DIR, STUB_BIN, tempDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const read = (name) => fs.readFileSync(path.join(SELF_HOST_DIR, name), 'utf8');

// ── compose.yml ────────────────────────────────────────────────────────────
const composeText = read('compose.yml');
const compose = yaml.load(composeText);

test('compose: exactly app, postgres, redis', () => {
  assert.deepEqual(Object.keys(compose.services).sort(), ['app', 'postgres', 'redis']);
});

test('compose: postgres and redis publish no ports; app binds 127.0.0.1', () => {
  assert.equal(compose.services.postgres.ports, undefined);
  assert.equal(compose.services.redis.ports, undefined);
  assert.equal(compose.services.postgres.expose, undefined);
  assert.deepEqual(compose.services.app.ports, ['127.0.0.1:${SQUIRE_PORT:-3910}:3001']);
});

test('compose: health checks and dependencies (FR-002)', () => {
  for (const [name, svc] of Object.entries(compose.services)) {
    assert.ok(svc.healthcheck && svc.healthcheck.test, `${name} has a healthcheck`);
  }
  assert.match(compose.services.postgres.healthcheck.test.join(' '), /pg_isready -h 127\.0\.0\.1/);
  assert.match(compose.services.redis.healthcheck.test.join(' '), /redis-cli ping/);
  const appCheck = compose.services.app.healthcheck;
  assert.match(appCheck.test.join(' '), /http:\/\/localhost:3001\/ready/);
  assert.equal(appCheck.start_period, '90s');
  assert.deepEqual(compose.services.app.depends_on, {
    postgres: { condition: 'service_healthy' },
    redis: { condition: 'service_healthy' },
  });
});

test('compose: the app health check is the Dockerfile /ready probe', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const m = /CMD node -e "([^"]+)"/.exec(dockerfile);
  assert.ok(m, 'Dockerfile HEALTHCHECK probe found');
  assert.deepEqual(compose.services.app.healthcheck.test, ['CMD', 'node', '-e', m[1]]);
});

test('compose: images and volumes (FR-001, FR-003)', () => {
  assert.equal(compose.services.app.image, `ghcr.io/${REPOSITORY}:\${SQUIRE_VERSION:-${VERSION_TOKEN}}`);
  assert.equal(compose.services.postgres.image, 'pgvector/pgvector:pg16');
  assert.equal(compose.services.redis.image, 'redis:7');
  assert.deepEqual(Object.keys(compose.volumes).sort(), ['postgres-data', 'redis-data', 'squire-data']);
  assert.deepEqual(compose.services.app.volumes, ['squire-data:/data']);
  assert.deepEqual(compose.services.postgres.volumes, ['postgres-data:/var/lib/postgresql/data']);
  assert.deepEqual(compose.services.redis.volumes, ['redis-data:/data']);
});

test('compose: app environment, env_file, and no mode or hosted flags (FR-004, FR-006, RBD-060-22)', () => {
  const env = compose.services.app.environment;
  assert.equal(env.APP_URL, '${APP_URL:-http://localhost:${SQUIRE_PORT:-3910}}');
  assert.equal(env.DATABASE_URL, 'postgresql://squire:squire@postgres:5432/squire');
  assert.equal(env.REDIS_HOST, 'redis');
  assert.equal(env.REDIS_PORT, '6379');
  assert.deepEqual(compose.services.app.env_file, [{ path: '.env', required: false }]);
  assert.deepEqual(compose.services.postgres.environment, {
    POSTGRES_USER: 'squire', POSTGRES_PASSWORD: 'squire', POSTGRES_DB: 'squire',
  });
  for (const banned of ['SQUIRE_MODE', 'SQUIRE_HOSTED', 'NODE_ENV']) {
    assert.ok(!composeText.includes(banned), `compose.yml must not mention ${banned}`);
  }
});

// ── .env.example ───────────────────────────────────────────────────────────
const envText = read('.env.example');
const envLines = envText.split('\n');
// Every setting line, commented or not: [name, commented, rawLine]
const settings = envLines
  .map((l) => /^(# )?([A-Z][A-Z0-9_]*)=(.*)$/.exec(l))
  .filter(Boolean)
  .map((m) => ({ name: m[2], commented: Boolean(m[1]), value: m[3] }));
const names = settings.map((s) => s.name);

test('.env.example: SQUIRE_PORT and SQUIRE_VERSION first; only SQUIRE_VERSION uncommented', () => {
  assert.deepEqual(names.slice(0, 2), ['SQUIRE_PORT', 'SQUIRE_VERSION']);
  assert.deepEqual(settings.filter((s) => !s.commented).map((s) => s.name), ['SQUIRE_VERSION']);
  assert.equal(settings.find((s) => s.name === 'SQUIRE_VERSION').value, VERSION_TOKEN);
  assert.equal(settings.find((s) => s.name === 'SQUIRE_PORT').value, '3910');
  assert.match(envText, /local mode/i);
});

test('.env.example: the groups appear in the contract order', () => {
  const order = ['SQUIRE_PORT', 'SQUIRE_VERSION', 'SQUIRE_MODE', 'ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
    'SMTP_HOST', 'STORAGE_DRIVER', 'APP_URL'];
  const idx = order.map((n) => names.indexOf(n));
  assert.ok(idx.every((i) => i >= 0), `all present: ${order.join(', ')}`);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'in order');
  assert.equal(settings.find((s) => s.name === 'SQUIRE_MODE').value, 'local');
});

test('.env.example: lists every server-wide assistant key the provider module reads', () => {
  const { PROVIDERS } = require(path.join(ROOT, 'server/api/ai-providers.js'));
  const keys = Object.values(PROVIDERS).map((p) => p.serverKeyEnv).filter(Boolean);
  assert.ok(keys.length >= 2);
  for (const k of keys) assert.ok(names.includes(k), `${k} listed`);
});

test('.env.example: email, image, and URL settings with their defaults', () => {
  for (const n of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
    'STORAGE_DRIVER', 'S3_IMAGE_BUCKET', 'S3_IMAGE_REGION', 'S3_ENDPOINT', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'APP_URL']) {
    assert.ok(names.includes(n), `${n} listed`);
  }
  assert.equal(settings.find((s) => s.name === 'SMTP_PORT').value, '465');
  assert.equal(settings.find((s) => s.name === 'STORAGE_DRIVER').value, 'local');
  // FR-040: plain HTTP only on localhost; exposing needs TLS and an https APP_URL.
  assert.match(envText, /only on localhost/);
  assert.match(envText, /TLS-terminating[\s#]+proxy/);
  assert.match(settings.find((s) => s.name === 'APP_URL').value, /^https:\/\//);
});

test('.env.example: never lists hosted, development, or secret settings (FR-008)', () => {
  for (const banned of ['SQUIRE_HOSTED', 'NODE_ENV', 'CLIENT_URL', 'MIGRATE_ON_BOOT', 'ACCESS_TOKEN_SECRET',
    'REFRESH_TOKEN_SECRET', 'MCP_JWT_SECRET', 'API_KEY_ENCRYPTION_KEY', 'ENABLE_DEV_ENDPOINTS', 'DATABASE_URL',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    assert.ok(!envText.includes(banned), `must not mention ${banned}`);
  }
  assert.ok(!names.some((n) => n.startsWith('DB_')), 'no DB_ settings');
  assert.ok(!/^SQUIRE_MODE=team/m.test(envText), 'no uncommented SQUIRE_MODE=team');
});

// ── squire wrapper ─────────────────────────────────────────────────────────
const wrapperPath = path.join(SELF_HOST_DIR, 'squire');
const wrapper = fs.readFileSync(wrapperPath, 'utf8');

test('wrapper: POSIX shebang, cd to its folder, TTY-gated exec, args passed through (FR-007)', () => {
  assert.equal(wrapper.split('\n')[0], '#!/bin/sh');
  assert.match(wrapper, /cd "\$\(dirname "\$0"\)"/);
  assert.match(wrapper, /if \[ -t 0 \] && \[ -t 1 \]; then exec docker compose exec app squire "\$@"; fi/);
  assert.match(wrapper, /^exec docker compose exec -T app squire "\$@"$/m);
  assert.equal(fs.statSync(wrapperPath).mode & 0o111, 0o111, 'executable on disk');
});

test('wrapper: the git index records mode 100755', () => {
  const r = spawnSync('git', ['ls-files', '-s', 'distribution/self-host/squire'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 || r.stdout.trim() === '') return; // not staged yet (merge-queue note T010)
  assert.match(r.stdout, /^100755 /);
});

function runWrapper({ exit = '0', args = ['doctor', '--json'] } = {}) {
  const dir = tempDir();
  fs.copyFileSync(wrapperPath, path.join(dir, 'squire'));
  fs.chmodSync(path.join(dir, 'squire'), 0o755);
  const log = path.join(dir, 'stub.log');
  const other = tempDir();
  // Run from another folder: the wrapper must cd to its own.
  const r = spawnSync('/bin/sh', [path.join(dir, 'squire'), ...args], {
    cwd: other,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${STUB_BIN}:/usr/bin:/bin`, STUB_LOG: log, STUB_EXEC_EXIT: exit, STUB_DOCTOR_EXIT: exit },
  });
  return { r, log: fs.readFileSync(log, 'utf8') };
}

test('wrapper: uses -T when stdout is a pipe and passes arguments through', () => {
  const { r, log } = runWrapper({ args: ['token', 'create', '--name', 'Claude Code'] });
  assert.equal(r.status, 0);
  assert.equal(log, 'docker compose exec -T app squire token create --name Claude Code\n');
});

test('wrapper: passes the exit code through', () => {
  assert.equal(runWrapper({ exit: '0' }).r.status, 0);
  assert.equal(runWrapper({ exit: '1' }).r.status, 1);
  assert.equal(runWrapper({ exit: '2', args: ['mode'] }).r.status, 2);
});
