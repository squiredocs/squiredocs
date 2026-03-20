/**
 * AES-256-GCM encryption utility for BYOK API keys.
 *
 * Keys are stored as `iv:authTag:ciphertext` (base64-encoded components).
 * Requires API_KEY_ENCRYPTION_KEY env var (64-char hex string = 32 bytes).
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

// Default dev key — NOT safe for production. Set API_KEY_ENCRYPTION_KEY in env.
const DEV_KEY = '0'.repeat(64);

function getEncryptionKey() {
  const hex = process.env.API_KEY_ENCRYPTION_KEY || DEV_KEY;
  if (hex === DEV_KEY && process.env.NODE_ENV === 'production') {
    throw new Error('API_KEY_ENCRYPTION_KEY must be set in production');
  }
  if (hex === DEV_KEY && process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
    console.warn('WARNING: Using default encryption key in non-development environment. Set API_KEY_ENCRYPTION_KEY.');
  }
  if (hex.length !== 64) {
    throw new Error('API_KEY_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string.
 * @param {string} plaintext
 * @returns {string} `iv:authTag:ciphertext` (base64)
 */
function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

/**
 * Decrypt a stored encrypted string.
 * @param {string} stored `iv:authTag:ciphertext` (base64)
 * @returns {string} plaintext
 */
function decrypt(stored) {
  const key = getEncryptionKey();
  const [ivB64, authTagB64, ciphertextB64] = stored.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
