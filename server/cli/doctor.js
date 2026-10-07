/**
 * `squire doctor [--json]` (feature 059, FR-039, SC-006, RBD-059-23,
 * contracts/squire-cli.md).
 *
 * checks (gate `ok`): database, migrations, server (/ready), mode, appUrl,
 * owner (reported, always ok). info (never gates): redis, email,
 * imageStorage, semanticSearch, assistantKeys.
 *
 * `ok` is the AND of every check. `failed` lists the names of the failing
 * checks, so a reader can see why doctor says no while /ready says yes: the
 * server can be serving (server.ok) while the instance is still misconfigured
 * for remote use (appUrl.ok false). SC-006's "ok matches /ready" holds for a
 * healthy instance; every other disagreement is named in `failed`.
 *
 * The database, Redis, and /ready probes run concurrently, each bounded to
 * 2 s, so the command answers within 5 s even when all three hang.
 */
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { getInstanceConfig, isLoopbackHost } = require('../instance-config');
const { getProviders, checkBootProviders } = require('../auth/providers');
const { resolveOwner } = require('../auth/instance-owner');
const { canConnect, dbUnreachableMessage } = require('./db');
const { msg } = require('./messages');

const PROBE_TIMEOUT_MS = 2000;
// Feature 008's migration was rolled back and its file deleted; script/migrate.js
// removes its pgmigrations row. It is neither pending nor unknown.
const RETIRED_MIGRATIONS = new Set(['1794000000000_create-mcp-pending-authorizations']);
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

function probeReady(url, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      done(res.statusCode === 200 ? { ok: true } : { ok: false, reason: `HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, reason: 'timed out' }); });
    req.on('error', (e) => done({ ok: false, reason: e.code || e.message }));
  });
}

/** Raw RESP PING (no client library), honoring REDIS_PASSWORD. */
function probeRedis(env, timeoutMs = PROBE_TIMEOUT_MS) {
  if (!env.REDIS_HOST) return Promise.resolve({ state: 'off', reason: 'REDIS_HOST is not set' });
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const sock = net.connect({ host: env.REDIS_HOST, port: Number(env.REDIS_PORT) || 6379 });
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done({ state: 'down', reason: 'timed out' }));
    sock.on('error', (e) => done({ state: 'down', reason: e.code || e.message }));
    sock.on('connect', () => {
      if (env.REDIS_PASSWORD) sock.write(`AUTH ${env.REDIS_PASSWORD}\r\n`);
      sock.write('PING\r\n');
    });
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('+PONG')) done({ state: 'up' });
      else if (buf.includes('-')) done({ state: 'down', reason: buf.trim().split('\r\n').pop() });
    });
  });
}

async function pendingMigrations(pool, migrationsDir) {
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => /\.(js|cjs|sql)$/.test(f))
    .map((f) => f.replace(/\.(js|cjs|sql)$/, ''))
    .filter((n) => !RETIRED_MIGRATIONS.has(n));
  let ran = new Set();
  try {
    const { rows } = await pool.query('SELECT name FROM pgmigrations');
    ran = new Set(rows.map((r) => r.name));
  } catch (e) {
    if (e.code !== '42P01') throw e; // no pgmigrations table: everything is pending
  }
  return files.filter((n) => !ran.has(n)).length;
}

function appUrlCheck(appUrl) {
  const u = new URL(appUrl);
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
  return ok ? { ok: true, value: appUrl } : { ok: false, value: appUrl, message: msg('doctorAppUrl', { value: appUrl }) };
}

/**
 * Run every check. Exported for tests.
 * @param {{ pool: object, env?: object, readyUrl?: string, migrationsDir?: string }} opts
 */
async function runChecks({ pool, env = process.env, readyUrl, migrationsDir = DEFAULT_MIGRATIONS_DIR }) {
  const url = readyUrl || `http://127.0.0.1:${env.PORT || 3001}/ready`;
  const checks = {};
  const info = {};

  let config = null;
  let configError = null;
  try {
    config = getInstanceConfig();
  } catch (e) {
    configError = e;
  }

  const [dbOk, ready, redis] = await Promise.all([canConnect(pool), probeReady(url), probeRedis(env)]);

  checks.database = dbOk ? { ok: true } : { ok: false, message: dbUnreachableMessage(env) };

  if (dbOk) {
    try {
      const pending = await pendingMigrations(pool, migrationsDir);
      checks.migrations = pending === 0
        ? { ok: true, pending: 0 }
        : { ok: false, pending, message: msg('doctorMigrations', { pending }) };
    } catch (e) {
      checks.migrations = { ok: false, message: dbUnreachableMessage(env) };
    }
  } else {
    checks.migrations = { ok: false, message: checks.database.message };
  }

  checks.server = ready.ok
    ? { ok: true, ready: true }
    : { ok: false, ready: false, message: msg('doctorServer', { url, reason: ready.reason }) };

  if (configError) {
    const message = msg('configError', { message: configError.message });
    checks.mode = { ok: false, message };
    checks.appUrl = { ok: false, message };
  } else {
    const providers = getProviders({ mode: config.mode, env });
    const boot = checkBootProviders({ mode: config.mode, providers });
    checks.mode = {
      ok: boot.ok,
      mode: config.mode,
      providers: providers.filter((p) => p.listed).map((p) => p.id),
      ...(boot.ok ? {} : { message: msg('doctorNoProvider') }),
    };
    checks.appUrl = appUrlCheck(config.appUrl);
  }

  if (dbOk) {
    try {
      const owner = await resolveOwner(pool);
      checks.owner = { ok: true, hasOwner: !!owner.user };
    } catch {
      checks.owner = { ok: true, hasOwner: null };
    }
  } else {
    checks.owner = { ok: true, hasOwner: null };
  }

  info.redis = redis;
  if (config) {
    info.email = config.smtp.host
      ? { on: true, host: config.smtp.host }
      : { on: false, reason: 'SMTP_HOST is not set' };
    info.imageStorage = { driver: config.storageDriver };
  }
  info.semanticSearch = env.GOOGLE_GENERATIVE_AI_API_KEY
    ? { on: true }
    : { on: false, reason: 'no embedding key (GOOGLE_GENERATIVE_AI_API_KEY)' };
  try {
    const { listProviders } = require('../api/ai-providers');
    const withKeys = listProviders().filter((p) => p.serverKeyEnv && env[p.serverKeyEnv]).map((p) => p.id);
    info.assistantKeys = { on: withKeys.length > 0, providers: withKeys };
  } catch {
    info.assistantKeys = { on: false, providers: [] };
  }

  const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);
  return { ok: failed.length === 0, failed, checks, info };
}

function humanReport(report) {
  const lines = [];
  for (const [name, c] of Object.entries(report.checks)) {
    let detail = '';
    if (name === 'mode' && c.mode) detail = ` (${c.mode}${c.providers?.length ? `: ${c.providers.join(', ')}` : ''})`;
    if (name === 'appUrl' && c.value) detail = ` (${c.value})`;
    if (name === 'owner') detail = c.hasOwner === null ? ' (unknown)' : c.hasOwner ? ' (claimed)' : ' (no owner yet)';
    if (name === 'migrations' && c.ok) detail = ' (none pending)';
    lines.push(`${c.ok ? 'ok  ' : 'FAIL'} ${name}${detail}${c.ok ? '' : `: ${c.message}`}`);
  }
  const i = report.info;
  lines.push('');
  lines.push(`info redis: ${i.redis.state}${i.redis.reason ? ` (${i.redis.reason})` : ''}`);
  if (i.email) lines.push(`info email: ${i.email.on ? `on (${i.email.host})` : `off (${i.email.reason})`}`);
  if (i.imageStorage) lines.push(`info image storage: ${i.imageStorage.driver}`);
  lines.push(`info semantic search: ${i.semanticSearch.on ? 'on' : `off (${i.semanticSearch.reason})`}`);
  lines.push(`info assistant keys: ${i.assistantKeys.on ? i.assistantKeys.providers.join(', ') : 'none (users can add their own in Settings)'}`);
  lines.push('');
  lines.push(report.ok ? 'Squire Docs is ready.' : `Not ready: ${report.failed.join(', ')}.`);
  return lines.join('\n');
}

async function doctor({ args = {}, pool, env = process.env, out, readyUrl, migrationsDir }) {
  const report = await runChecks({ pool, env, readyUrl, migrationsDir });
  out.write(args.json ? `${JSON.stringify(report)}\n` : `${humanReport(report)}\n`);
  return report.ok ? 0 : 1;
}

module.exports = { doctor, runChecks, probeReady, probeRedis, pendingMigrations, RETIRED_MIGRATIONS };
