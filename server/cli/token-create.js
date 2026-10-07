/**
 * `squire token create --name N [--email E] [--scopes S] [--expires-in D]
 *   [--out PATH] [--stdout]` (feature 059, FR-043, RBD-059-7, RBD-059-22).
 *
 * Mints an sk_sqd_ token through the existing token module (same cap, hashing,
 * prefix, and Settings listing) for:
 *   local mode  the resolved owner, unless --email names another account;
 *   team mode   --email (required).
 *
 * The token is written to a file created exclusively with mode 0600 (default
 * <data dir>/tokens/<slug>.token, directory 0700). The file is opened BEFORE
 * minting and removed if minting fails, so no token is ever orphaned. The
 * token value is never printed unless --stdout is given.
 */
const fs = require('fs');
const path = require('path');
const { getInstanceConfig } = require('../instance-config');
const { resolveOwner } = require('../auth/instance-owner');
const { findUserByEmail } = require('../auth/users');
const apiTokens = require('../mcp/auth/api-tokens');
const { msg } = require('./messages');

const ALLOWED_SCOPES = ['documents:read', 'documents:write'];
const DEFAULT_EXPIRES_IN = '30d';

// The do-not-echo warning from the MCP create_access_token tool's inline mode
// (server/mcp/tools/create-access-token.js), adapted to the CLI.
const STDOUT_WARNING =
  'This token is a secret printed because you passed --stdout. Never print, echo, paste, or ' +
  'repeat it in any output. Store it via heredoc (not argv): ' +
  "umask 077; mkdir -p ~/.squire; cat > ~/.squire/token <<'EOF' ... EOF";

/** Parse <n>d or <n>h, 1 hour to 365 days. @returns {number|null} milliseconds */
function parseExpiresIn(value) {
  const m = /^(\d{1,4})([dh])$/.exec(String(value));
  if (!m) return null;
  const n = Number(m[1]);
  const hours = m[2] === 'd' ? n * 24 : n;
  if (hours < 1 || hours > 365 * 24) return null;
  return hours * 3600 * 1000;
}

/** @returns {string[]|null} */
function parseScopes(value) {
  if (value === undefined) return [...ALLOWED_SCOPES];
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0 || list.some((s) => !ALLOWED_SCOPES.includes(s))) return null;
  return [...new Set(list)];
}

function slug(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return s || 'token';
}

async function resolveTarget({ args, pool, mode }) {
  const email = typeof args.email === 'string' ? args.email.trim() : '';
  if (email) {
    const user = await findUserByEmail(pool, email);
    return user ? { user } : { error: ['tokenUnknownEmail', { email }], code: 1 };
  }
  if (mode === 'team') return { error: ['tokenTeamNeedsEmail', {}], code: 2 };
  const owner = await resolveOwner(pool);
  if (owner.user) return { user: owner.user };
  if (owner.reason === 'no_users') return { error: ['tokenNoOwner', {}], code: 1 };
  return { error: ['tokenOwnerAmbiguous', {}], code: 1 };
}

async function tokenCreate({ args = {}, pool, out, err, now = () => Date.now() }) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    err.write(`${msg('tokenNameRequired')}\n`);
    return 2;
  }
  const scopes = parseScopes(args.scopes);
  if (!scopes) {
    err.write(`${msg('tokenBadScopes', { scopes: args.scopes })}\n`);
    return 2;
  }
  const expiresInRaw = args['expires-in'] === undefined ? DEFAULT_EXPIRES_IN : args['expires-in'];
  const ttlMs = parseExpiresIn(expiresInRaw);
  if (ttlMs === null) {
    err.write(`${msg('tokenBadExpiry', { value: expiresInRaw })}\n`);
    return 2;
  }

  const config = getInstanceConfig();
  const target = await resolveTarget({ args, pool, mode: config.mode });
  if (target.error) {
    err.write(`${msg(...target.error)}\n`);
    return target.code;
  }
  const { user } = target;
  const expiresAt = new Date(now() + ttlMs);

  apiTokens.init(pool);

  if (args.stdout) {
    let minted;
    try {
      minted = await apiTokens.createToken(user.id, name, { scopes, expiresAt });
    } catch (e) {
      err.write(`${msg('tokenMintFailed', { reason: e.message })}\n`);
      return 1;
    }
    err.write(`${STDOUT_WARNING}\n`);
    err.write(`Token "${name}" for ${user.email} (expires ${expiresAt.toISOString()}).\n`);
    out.write(`${minted.token}\n`);
    return 0;
  }

  const filePath = path.resolve(
    typeof args.out === 'string' && args.out ? args.out : path.join(config.dataDir, 'tokens', `${slug(name)}.token`)
  );
  let fd;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fd = fs.openSync(filePath, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') {
      err.write(`${msg('tokenFileExists', { path: filePath })}\n`);
      return 1;
    }
    err.write(`${msg('tokenFileError', { path: filePath, reason: e.code || e.message })}\n`);
    return 1;
  }

  const discardFile = () => {
    if (fd !== null && fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(filePath); } catch { /* best effort */ }
  };

  let minted;
  try {
    minted = await apiTokens.createToken(user.id, name, { scopes, expiresAt });
  } catch (e) {
    discardFile();
    err.write(`${msg('tokenMintFailed', { reason: e.message })}\n`);
    return 1;
  }
  try {
    fs.writeSync(fd, `${minted.token}\n`);
    fs.closeSync(fd);
    fd = null;
    // openSync's mode is filtered by the umask; make the 0600 explicit.
    fs.chmodSync(filePath, 0o600);
  } catch (e) {
    // The token exists but could not be stored: revoke it so none is orphaned.
    discardFile();
    try { await apiTokens.revokeToken(minted.record.id, user.id); } catch { /* reported below */ }
    err.write(`${msg('tokenFileError', { path: filePath, reason: e.code || e.message })}\n`);
    return 1;
  }

  err.write(
    `Token "${name}" for ${user.email} written to ${filePath} (expires ${expiresAt.toISOString().slice(0, 10)}). ` +
    `Copy it to your machine: docker compose cp app:${filePath} ~/.squire/token && chmod 600 ~/.squire/token\n`
  );
  return 0;
}

module.exports = { tokenCreate, parseExpiresIn, parseScopes, slug, STDOUT_WARNING };
