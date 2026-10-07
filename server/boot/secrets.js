/**
 * Generated secrets (feature 058, research R4, data-model section 2).
 *
 * For each of the four secrets the server checks at require time: the
 * environment wins; else the value in <dataDir>/secrets.json; else (when
 * `generate` is true) 32 random bytes as 64 hex characters, written to the
 * file. The file holds only generated values, is mode 0600, is written
 * atomically, and is never regenerated when it cannot be read: losing it loses
 * the BYOK encryption key, so a broken file stops boot instead.
 *
 * Two replicas starting together on a shared volume cannot end up with
 * different secrets: the first creation publishes with link(2), which fails
 * with EEXIST for the loser, and the loser adopts the winner's file
 * (Constitution VII, RBD-058-31).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SECRET_NAMES = Object.freeze([
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_SECRET',
  'MCP_JWT_SECRET',
  'API_KEY_ENCRYPTION_KEY',
]);

const FILE_NAME = 'secrets.json';

class SecretsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretsError';
  }
}

function present(v) {
  return v !== undefined && v !== null && v !== '';
}

/** Read the secrets file. Missing → null. Anything else wrong → SecretsError. */
function readSecretsFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new SecretsError(
      `Cannot read ${filePath}: ${err.message}. Do not delete this file: it holds the ` +
      'encryption key for stored API keys. Fix its permissions (owner uid 100, mode 0600).'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SecretsError(
      `${filePath} is not valid JSON (${err.message}). Do not delete it: it holds the ` +
      'encryption key for stored API keys. Restore it from a backup or repair it by hand.'
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretsError(
      `${filePath} must contain a JSON object. Do not delete it: it holds the ` +
      'encryption key for stored API keys. Restore it from a backup or repair it by hand.'
    );
  }
  return parsed;
}

function writeError(dir, err) {
  return new SecretsError(
    `Cannot write ${path.join(dir, FILE_NAME)} (${err.code || err.message}): the data directory ${dir} ` +
    'must be writable by the app user (uid 100). For a bind mount run ' +
    `\`chown -R 100:101 ${dir}\`.`
  );
}

/**
 * mkdir -p without { recursive: true }: Node's recursive mkdir spins forever
 * on some pseudo filesystems (seen under /proc), and a boot must fail, not hang.
 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o750 });
  } catch (err) {
    if (err.code === 'EEXIST') return;
    if (err.code !== 'ENOENT' || path.dirname(dir) === dir) throw err;
    ensureDir(path.dirname(dir));
    try { fs.mkdirSync(dir, { mode: 0o750 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

/** Write `obj` to a fresh temp file in `dir` (mode 0600, fsynced). Returns its path. */
function writeTemp(dir, obj) {
  const tmp = path.join(dir, `${FILE_NAME}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  let fd;
  try {
    ensureDir(dir);
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, `${JSON.stringify(obj, null, 2)}\n`);
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    throw writeError(dir, err);
  }
  fs.closeSync(fd);
  return tmp;
}

/**
 * Resolve the four secrets into `env`.
 * @param {object} opts
 * @param {object} opts.env - mutated: each resolved secret is assigned
 * @param {string} opts.dataDir - absolute directory holding secrets.json
 * @param {boolean} [opts.generate=true] - false: read the file, never create values
 * @param {object} [opts.log=console]
 * @param {object} [opts._hooks] - test-only: { beforePublish(tmpPath, finalPath) }
 * @returns {{ generated: string[], fromFile: string[], fromEnv: string[], path: string }}
 */
function resolveSecrets({ env, dataDir, generate = true, log = console, _hooks = {} }) {
  const filePath = path.join(dataDir, FILE_NAME);

  // A keyring rotation (API_KEY_ENCRYPTION_KEYS) means the operator chose keys
  // explicitly; a generated legacy key would turn a clear "missing key" error
  // into a silent wrong-key decrypt failure (RBD-058-26).
  const names = SECRET_NAMES.filter(
    (n) => !(n === 'API_KEY_ENCRYPTION_KEY' && present(env.API_KEY_ENCRYPTION_KEYS))
  );

  const fromEnv = names.filter((n) => present(env[n]));
  const needed = names.filter((n) => !present(env[n]));
  const result = { generated: [], fromFile: [], fromEnv, path: filePath };
  if (needed.length === 0) return result;

  let fileObj = readSecretsFile(filePath);

  const apply = (obj) => {
    result.fromFile = [];
    for (const n of needed) {
      if (obj && present(obj[n])) {
        env[n] = String(obj[n]);
        result.fromFile.push(n);
      }
    }
  };

  apply(fileObj);
  const missing = needed.filter((n) => !result.fromFile.includes(n));
  if (missing.length === 0 || !generate) return result;

  const generatedValues = {};
  for (const n of missing) generatedValues[n] = crypto.randomBytes(32).toString('hex');
  // Merge onto the file's existing object (unknown future keys preserved);
  // environment values are never written.
  const next = { ...(fileObj || {}), ...generatedValues };
  const tmp = writeTemp(dataDir, next);

  try {
    if (_hooks.beforePublish) _hooks.beforePublish(tmp, filePath);
    if (fileObj === null) {
      // First creation: link(2) refuses to replace an existing file, so of two
      // replicas racing on one volume exactly one publishes.
      try {
        fs.linkSync(tmp, filePath);
      } catch (err) {
        if (err.code !== 'EEXIST') throw writeError(dataDir, err);
        // Lost the race: adopt the winner's values. If the winner's file
        // lacks a key we needed, the next boot adds it.
        fileObj = readSecretsFile(filePath);
        apply(fileObj);
        log.info?.(`[Secrets] adopted values from ${filePath} written by another process`);
        return result;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    } else {
      try {
        fs.renameSync(tmp, filePath);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw writeError(dataDir, err);
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }

  for (const n of missing) env[n] = generatedValues[n];
  result.generated = missing;
  (log.info || log.log).call(log, `[Secrets] generated ${missing.join(', ')} into ${filePath}`);
  return result;
}

module.exports = { SECRET_NAMES, SecretsError, resolveSecrets };
