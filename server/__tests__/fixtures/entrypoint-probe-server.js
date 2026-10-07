/**
 * Feature 058 (T007): stands in for server/index.js in the entrypoint ordering
 * test. It requires the three real modules that check secrets at require time
 * and proves the encryption key works, so the test catches any reordering that
 * would load the server before the secrets are in the environment.
 */
require('../../auth/jwt');
require('../../mcp/auth/jwt');
const crypto = require('../../crypto');

const ciphertext = crypto.encrypt('probe');
if (crypto.decrypt(ciphertext) !== 'probe') throw new Error('probe round trip failed');

const NAMES = ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET', 'MCP_JWT_SECRET', 'API_KEY_ENCRYPTION_KEY'];
global.__entrypointProbe = {
  ok: true,
  env: Object.fromEntries(NAMES.map((n) => [n, Boolean(process.env[n])])),
};

module.exports = global.__entrypointProbe;
