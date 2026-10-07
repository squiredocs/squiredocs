/**
 * Instance configuration (feature 058).
 *
 * The one place the self-host configuration surface is resolved: the public
 * origin (APP_URL) and everything derived from it, the hosted-service flag,
 * the data directory, migrate-on-boot, the image storage driver, and SMTP.
 * Consumers call getInstanceConfig() at call time and never read these
 * variables from process.env themselves (RBD-058-16), so a test can flip a
 * value and reset the memo without reloading modules.
 *
 * This module requires only node built-ins so that auth/jwt.js, email.js, and
 * the boot entrypoint can all require it without a cycle.
 *
 * Variables, defaults, and boot failures: specs/058-self-host-config/contracts/environment.md.
 */
const path = require('node:path');

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const SES_DEFAULT_HOST = 'email-smtp.us-west-2.amazonaws.com';
const STORAGE_DRIVERS = ['local', 's3'];

/** A set, non-empty environment value, or undefined. */
function read(env, name) {
  const v = env[name];
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

/** Parse an absolute http(s) URL and return its origin, or throw naming `name`. */
function originOf(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL (got ${JSON.stringify(value)})`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must be an absolute http(s) URL (got ${JSON.stringify(value)})`);
  }
  return url.origin;
}

function parseBoolean(env, name, defaultValue) {
  const raw = read(env, name);
  if (raw === undefined) return defaultValue;
  const v = raw.toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ConfigError(`${name} must be true or false (got ${JSON.stringify(raw)})`);
}

/** Host is localhost or a loopback address (127.0.0.0/8, [::1]). */
function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]' || h === '::1') return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
}

function resolveAppUrl(env) {
  const explicit = read(env, 'APP_URL');
  if (explicit !== undefined) return { appUrl: originOf(explicit, 'APP_URL'), appUrlSource: 'APP_URL' };
  const clientUrl = read(env, 'CLIENT_URL');
  if (clientUrl !== undefined) return { appUrl: originOf(clientUrl, 'CLIENT_URL'), appUrlSource: 'CLIENT_URL' };
  // SQUIRE_PORT is deliberately not consulted: the container cannot see the
  // host port, so compose passes APP_URL explicitly (RBD-058-18).
  const port = read(env, 'PORT') || '3001';
  return { appUrl: originOf(`http://localhost:${port}`, 'PORT'), appUrlSource: 'default' };
}

const MODES = ['local', 'team'];

/**
 * Instance mode (feature 059, design D1, research R4). Unset means local;
 * values are case-sensitive. Anything else stops the boot naming both values.
 */
function resolveMode(env) {
  const raw = read(env, 'SQUIRE_MODE');
  if (raw === undefined) return 'local';
  if (MODES.includes(raw)) return raw;
  throw new ConfigError(`SQUIRE_MODE must be "local" or "team" (got ${JSON.stringify(raw)}).`);
}

function resolveStorageDriver(env) {
  const raw = read(env, 'STORAGE_DRIVER');
  if (raw === undefined) return read(env, 'S3_IMAGE_BUCKET') ? 's3' : 'local';
  const v = raw.toLowerCase();
  if (!STORAGE_DRIVERS.includes(v)) {
    throw new ConfigError(`STORAGE_DRIVER must be one of: ${STORAGE_DRIVERS.join(', ')} (got ${JSON.stringify(raw)})`);
  }
  return v;
}

/**
 * SMTP settings (research R12, RBD-058-8). Generic SMTP_* names win over the
 * SES_* aliases. The SES default host applies only when the configuration
 * arrives through the SES aliases alone, so the hosted deploy needs no new
 * variable while a generic config with no host stays off.
 */
function resolveSmtp(env) {
  const generic = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']
    .some((n) => read(env, n) !== undefined);
  const ses = ['SES_SMTP_HOST', 'SES_SMTP_USER', 'SES_SMTP_PASS', 'SES_FROM_EMAIL']
    .some((n) => read(env, n) !== undefined);
  const viaSesAliases = !generic && ses;

  let port = 465;
  const rawPort = read(env, 'SMTP_PORT');
  if (rawPort !== undefined) {
    const n = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(n) || n < 1 || n > 65535) {
      throw new ConfigError(`SMTP_PORT must be an integer from 1 to 65535 (got ${JSON.stringify(rawPort)})`);
    }
    port = n;
  }
  const secure = parseBoolean(env, 'SMTP_SECURE', port === 465);

  return Object.freeze({
    host: read(env, 'SMTP_HOST') || read(env, 'SES_SMTP_HOST') || (viaSesAliases ? SES_DEFAULT_HOST : undefined),
    port,
    secure,
    user: read(env, 'SMTP_USER') || read(env, 'SES_SMTP_USER'),
    pass: read(env, 'SMTP_PASS') || read(env, 'SES_SMTP_PASS'),
    from: read(env, 'SMTP_FROM') || read(env, 'SES_FROM_EMAIL'),
    viaSesAliases,
  });
}

/**
 * Resolve the instance configuration from an environment object. Pure: no
 * logging, no filesystem access. Throws ConfigError naming the variable.
 * @param {object} env
 * @returns {Readonly<object>}
 */
function resolveInstanceConfig(env = process.env) {
  const { appUrl, appUrlSource } = resolveAppUrl(env);
  const appUrlParsed = new URL(appUrl);
  const isProduction = env.NODE_ENV === 'production';

  // A malformed value fails boot like every other boolean here: silently
  // treating it as off would turn squiredocs.com into a self-hosted instance
  // (058 review M2).
  const hosted = parseBoolean(env, 'SQUIRE_HOSTED', false);

  const dataDir = read(env, 'SQUIRE_DATA_DIR') || '/data';
  if (!path.isAbsolute(dataDir)) {
    throw new ConfigError(`SQUIRE_DATA_DIR must be an absolute path (got ${JSON.stringify(dataDir)})`);
  }

  const endpointRaw = read(env, 'S3_ENDPOINT');
  const endpoint = endpointRaw === undefined ? undefined : originOf(endpointRaw, 'S3_ENDPOINT');

  return Object.freeze({
    mode: resolveMode(env),
    appUrl,
    appUrlSource,
    // Verbatim when set (no normalization), so the CORS comparison and the
    // production redirect validation behave exactly as before.
    clientUrl: read(env, 'CLIENT_URL') || appUrl,
    googleRedirectUri: read(env, 'GOOGLE_REDIRECT_URI') || `${appUrl}/auth/google/callback`,
    publicOrigin: read(env, 'PUBLIC_ORIGIN') || appUrl,
    cookieSecure: appUrlParsed.protocol === 'https:',
    insecureRemoteHttp: isProduction && appUrlParsed.protocol === 'http:' && !isLoopbackHost(appUrlParsed.hostname),
    hosted,
    dataDir: path.resolve(dataDir),
    migrateOnBoot: parseBoolean(env, 'MIGRATE_ON_BOOT', true),
    storageDriver: resolveStorageDriver(env),
    s3: Object.freeze({
      bucket: read(env, 'S3_IMAGE_BUCKET') || '',
      region: read(env, 'S3_IMAGE_REGION') || 'us-east-1',
      accessKeyId: read(env, 'AWS_ACCESS_KEY_ID') || '',
      secretAccessKey: read(env, 'AWS_SECRET_ACCESS_KEY') || '',
      endpoint,
    }),
    smtp: resolveSmtp(env),
  });
}

let memo = null;

/** Memoized resolve of process.env. Throws ConfigError on an invalid value. */
function getInstanceConfig() {
  if (!memo) memo = resolveInstanceConfig(process.env);
  return memo;
}

/** Drop the memo so the next getInstanceConfig() re-reads process.env. */
function _resetInstanceConfigForTests() {
  memo = null;
}

/**
 * Express middleware for hosted-only routes. Placed first in a route's handler
 * list, a non-hosted instance skips the route exactly as if it were never
 * registered (Express falls through to the default 404; RBD-058-29).
 */
function hostedOnly(req, res, next) {
  if (getInstanceConfig().hosted) return next();
  return next('route');
}

module.exports = {
  ConfigError,
  MODES,
  SES_DEFAULT_HOST,
  resolveInstanceConfig,
  getInstanceConfig,
  _resetInstanceConfigForTests,
  hostedOnly,
  isLoopbackHost,
};
