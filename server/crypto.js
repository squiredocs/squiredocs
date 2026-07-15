/**
 * AES-256-GCM encryption utility for BYOK API keys, with a rotatable keyring.
 *
 * Stored formats:
 *   - Legacy (untagged): `iv:authTag:ciphertext`  (base64 components)
 *   - Keyed  (tagged):   `k<id>:iv:authTag:ciphertext`
 * The `:` split count disambiguates them (base64 never contains `:`): 3 parts
 * is legacy, 4 parts is keyed with the id in the first field.
 *
 * Keyring (all env, all optional except in production):
 *   - API_KEY_ENCRYPTION_KEY      — the "legacy" key (64-char hex = 32 bytes).
 *                                   Decrypts every untagged value; also usable
 *                                   as the encryption primary (the default).
 *   - API_KEY_ENCRYPTION_KEYS     — additional keyed entries, comma-separated
 *                                   `id:hex` pairs, e.g. "2:<64hex>,3:<64hex>".
 *   - API_KEY_ENCRYPTION_PRIMARY  — id used to ENCRYPT new values. Defaults to
 *                                   `legacy`. When it is `legacy`, new values
 *                                   are written untagged (byte-identical to the
 *                                   pre-rotation format); otherwise tagged.
 *
 * Rotation: add a new keyed entry, point PRIMARY at it, deploy, run
 * `script/reencrypt-byok-keys.js`, verify zero values remain on the old key,
 * then drop the old key. See the script's --verify mode.
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const LEGACY_ID = 'legacy'; // reserved id for untagged ciphertext / API_KEY_ENCRYPTION_KEY

// Default dev key — NOT safe for production. Set API_KEY_ENCRYPTION_KEY in env.
const DEV_KEY = '0'.repeat(64);

const ID_RE = /^[A-Za-z0-9_-]+$/;

function parseHexKey(hex, label) {
  if (typeof hex !== 'string' || hex.length !== 64) {
    throw new Error(`${label} must be a 64-character hex string (32 bytes)`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Build the keyring from the environment on each call (no caching, so tests and
 * hot-reloaded config observe env changes). Returns { keys: Map<id,Buffer>,
 * primaryId, usingDevLegacy }.
 */
function buildKeyring() {
  const keys = new Map();

  // The legacy key: API_KEY_ENCRYPTION_KEY, or the dev fallback.
  const legacyHex = process.env.API_KEY_ENCRYPTION_KEY || DEV_KEY;
  keys.set(LEGACY_ID, parseHexKey(legacyHex, 'API_KEY_ENCRYPTION_KEY'));
  const usingDevLegacy = legacyHex === DEV_KEY;

  // Additional keyed entries: "id:hex,id:hex".
  const extra = process.env.API_KEY_ENCRYPTION_KEYS;
  if (extra) {
    for (const entry of extra.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(':');
      if (sep < 0) {
        throw new Error('API_KEY_ENCRYPTION_KEYS entries must be "id:hexkey"');
      }
      const id = trimmed.slice(0, sep).trim();
      const hex = trimmed.slice(sep + 1).trim();
      if (!ID_RE.test(id) || id === LEGACY_ID) {
        throw new Error(`API_KEY_ENCRYPTION_KEYS has an invalid key id "${id}" (reserved or non-alphanumeric)`);
      }
      keys.set(id, parseHexKey(hex, `API_KEY_ENCRYPTION_KEYS[${id}]`));
    }
  }

  const primaryId = process.env.API_KEY_ENCRYPTION_PRIMARY || LEGACY_ID;
  if (!keys.has(primaryId)) {
    throw new Error(`API_KEY_ENCRYPTION_PRIMARY "${primaryId}" is not present in the keyring`);
  }

  // The primary key must be real in production (dev fallback is never allowed to
  // encrypt live data). Only guard the primary — an old dev-value legacy key
  // that is not the primary is harmless.
  if (primaryId === LEGACY_ID && usingDevLegacy) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('API_KEY_ENCRYPTION_KEY must be set in production');
    }
    if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
      console.warn('WARNING: Using default encryption key in non-development environment. Set API_KEY_ENCRYPTION_KEY.');
    }
  }

  return { keys, primaryId, usingDevLegacy };
}

/** The id of the key a stored value is encrypted under (`legacy` when untagged). */
function keyIdOf(stored) {
  const parts = String(stored).split(':');
  if (parts.length === 4) return parts[0].startsWith('k') ? parts[0].slice(1) : parts[0];
  if (parts.length === 3) return LEGACY_ID;
  throw new Error('Malformed ciphertext: expected 3 (legacy) or 4 (keyed) colon-separated parts');
}

/** The id used to encrypt new values right now. */
function primaryKeyId() {
  return buildKeyring().primaryId;
}

/**
 * Encrypt a plaintext string with the primary key.
 * @param {string} plaintext
 * @returns {string} `iv:authTag:ciphertext` (legacy primary) or
 *                   `k<id>:iv:authTag:ciphertext` (keyed primary)
 */
function encrypt(plaintext) {
  const { keys, primaryId } = buildKeyring();
  const key = keys.get(primaryId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const body = [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
  return primaryId === LEGACY_ID ? body : `k${primaryId}:${body}`;
}

/**
 * Decrypt a stored value, selecting the key by its tag (untagged ⇒ legacy key).
 * @param {string} stored
 * @returns {string} plaintext
 */
function decrypt(stored) {
  const { keys } = buildKeyring();
  const parts = String(stored).split(':');
  let id, ivB64, authTagB64, ciphertextB64;
  if (parts.length === 4) {
    id = parts[0].startsWith('k') ? parts[0].slice(1) : parts[0];
    [, ivB64, authTagB64, ciphertextB64] = parts;
  } else if (parts.length === 3) {
    id = LEGACY_ID;
    [ivB64, authTagB64, ciphertextB64] = parts;
  } else {
    throw new Error('Malformed ciphertext: expected 3 (legacy) or 4 (keyed) colon-separated parts');
  }
  const key = keys.get(id);
  if (!key) {
    throw new Error(`No encryption key configured for id "${id}" (was it retired before re-encryption?)`);
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/** True when the stored value is already encrypted under the current primary key. */
function isUnderPrimary(stored) {
  return keyIdOf(stored) === buildKeyring().primaryId;
}

/**
 * Return a value encrypted under the current primary key, re-encrypting only if
 * it isn't already (a no-op — returning the input unchanged — when it is).
 */
function reencrypt(stored) {
  if (isUnderPrimary(stored)) return stored;
  return encrypt(decrypt(stored));
}

module.exports = { encrypt, decrypt, reencrypt, isUnderPrimary, keyIdOf, primaryKeyId };
