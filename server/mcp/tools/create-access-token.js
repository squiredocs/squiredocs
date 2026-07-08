/**
 * create_access_token MCP Tool
 *
 * Mints a temporary sk_sqd_ API token for the calling principal's user, so an
 * MCP-connected agent can use the REST API (notably the markdown export
 * endpoint) from a shell without a human-provisioned personal access token.
 *
 * Security shape: one-way mint only. Scopes are capped at the caller's own
 * scopes, TTL is bounded, tokens minted by this tool cannot mint further
 * tokens, provenance is recorded (minted_by_* columns) so revoking the
 * minting credential revokes its children, and the caller's raw credential
 * is never returned or logged.
 */
const apiTokens = require('../auth/api-tokens');
const delegation = require('../auth/delegation');

// apiTokens and delegation are boot-time singletons wired up in
// server/mcp/index.js init(); the tool holds no persistence handle of its
// own. init is kept only to satisfy the tool contract.
function init() {}

const KNOWN_SCOPES = ['documents:read', 'documents:write'];
const DEFAULT_SCOPES = ['documents:read'];

const name = 'create_access_token';

const description = `Mint a temporary API token (prefixed sk_sqd_) for REST access — e.g. exporting documents as markdown via curl without document content passing through model context.

The token is scoped to AT MOST your own permissions (default: documents:read, which is all the export API needs), expires automatically (default 1 hour, max 24 hours), and is shown ONLY ONCE in this tool's result — store it immediately (e.g. in an environment variable). It appears under the user's Settings → API Tokens and is revoked automatically if your own credential is revoked. Tokens minted by this tool cannot mint further tokens.

Usage: create_access_token() or create_access_token({ scopes: ["documents:read"], ttlSeconds: 600 })
Then follow the returned curlExample. Full export recipe: get_tool_documentation({ tool: "export_api" }).`;

const inputSchema = {
  type: 'object',
  properties: {
    scopes: {
      type: 'array',
      items: { type: 'string', enum: KNOWN_SCOPES },
      description:
        "Scopes for the minted token; must be a subset of your own scopes. Default: ['documents:read'] (sufficient for the export API).",
    },
    ttlSeconds: {
      type: 'number',
      description: `Token lifetime in seconds. Default ${apiTokens.MINTED_TOKEN_DEFAULT_TTL_SECONDS} (1 hour); min ${apiTokens.MINTED_TOKEN_MIN_TTL_SECONDS}, max ${apiTokens.MINTED_TOKEN_MAX_TTL_SECONDS} (24 hours).`,
    },
  },
  required: [],
};

/**
 * Validate the scopes argument. validateToolArgs in the tool registry only
 * checks top-level scalar enums, so array items and ranges are validated
 * here (same pattern as modify's in-handler validation).
 */
function resolveScopes(requested, granted) {
  if (requested === undefined) {
    return DEFAULT_SCOPES;
  }
  if (!Array.isArray(requested) || requested.length === 0 || !requested.every((s) => typeof s === 'string')) {
    throw new Error(
      `Invalid parameters for tool '${name}': 'scopes' must be a non-empty array of strings. Valid values: ${KNOWN_SCOPES.join(', ')}`
    );
  }
  const scopes = [...new Set(requested)];
  const unknown = scopes.filter((s) => !KNOWN_SCOPES.includes(s));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid parameters for tool '${name}': unknown scope${unknown.length > 1 ? 's' : ''} ${unknown.map((s) => `'${s}'`).join(', ')}. Valid values: ${KNOWN_SCOPES.join(', ')}`
    );
  }
  const exceeding = scopes.filter((s) => !granted.includes(s));
  if (exceeding.length > 0) {
    throw new Error(
      `Insufficient scope: cannot mint a token with scope${exceeding.length > 1 ? 's' : ''} ${exceeding.map((s) => `'${s}'`).join(', ')}. Granted scopes: ${granted.join(', ')}`
    );
  }
  return scopes;
}

function resolveTtlSeconds(ttlSeconds) {
  const { MINTED_TOKEN_DEFAULT_TTL_SECONDS, MINTED_TOKEN_MIN_TTL_SECONDS, MINTED_TOKEN_MAX_TTL_SECONDS } = apiTokens;
  if (ttlSeconds === undefined) {
    return MINTED_TOKEN_DEFAULT_TTL_SECONDS;
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MINTED_TOKEN_MIN_TTL_SECONDS || ttlSeconds > MINTED_TOKEN_MAX_TTL_SECONDS) {
    throw new Error(
      `Invalid parameters for tool '${name}': 'ttlSeconds' must be an integer between ${MINTED_TOKEN_MIN_TTL_SECONDS} and ${MINTED_TOKEN_MAX_TTL_SECONDS} (got ${JSON.stringify(ttlSeconds)})`
    );
  }
  return ttlSeconds;
}

/**
 * Handler function for the tool
 * @param {object} args - { scopes?, ttlSeconds? }
 * @param {object} agentToken - Authenticated principal (agent JWT or API token)
 * @returns {Promise<object>} Minted token details (plaintext shown once)
 */
async function handler(args, agentToken) {
  const granted = agentToken.scopes || [];
  const scopes = resolveScopes(args.scopes, granted);
  const ttlSeconds = resolveTtlSeconds(args.ttlSeconds);

  // No chaining: a token minted by this tool cannot mint further tokens.
  // Otherwise each child would be a fresh minter with its own cap budget.
  if (agentToken.apiTokenId) {
    const parent = await apiTokens.getTokenById(agentToken.apiTokenId);
    if (parent && (parent.minted_by_delegation_id || parent.minted_by_api_token_id)) {
      throw new Error(
        'Tokens minted by create_access_token cannot mint further tokens. Use your original credential.'
      );
    }
  }

  // Agent JWTs are stateless (1h expiry) and minting is the one operation
  // whose product outlives the JWT, so re-check the delegation in the DB —
  // a just-revoked delegation must not be able to mint a fresh 24h token
  // during the remainder of its JWT's lifetime.
  if (agentToken.delegationId) {
    const check = await delegation.checkDelegation(agentToken.delegationId, null);
    if (!check.isValid) {
      throw new Error(`Cannot mint token: ${check.reason}`);
    }
  }

  const minter = {
    delegationId: agentToken.delegationId || null,
    apiTokenId: agentToken.apiTokenId || null,
  };
  const displaced = await apiTokens.enforceMinterCap(minter);

  const tokenName = `Minted by ${agentToken.agentName || agentToken.agentId || 'agent'} via MCP`.slice(0, 255);
  const { token, record } = await apiTokens.createToken(agentToken.userId, tokenName, {
    scopes,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    mintedByDelegationId: minter.delegationId,
    mintedByApiTokenId: minter.apiTokenId,
  });

  const baseUrl = agentToken.baseUrl || 'https://squiredocs.com';
  return {
    token,
    tokenPrefix: record.token_prefix,
    scopes: record.scopes,
    expiresAt: record.expires_at,
    ttlSeconds,
    // Placeholder env var rather than the raw token, so agents don't paste
    // the secret into argv/shell history when copying the example.
    curlExample:
      `export SQUIRE_TOKEN='<token above>'\n` +
      `curl -sf -H "Authorization: Bearer $SQUIRE_TOKEN" \\\n` +
      `  "${baseUrl}/api/docs/<docId>/export?format=markdown" -o doc.md`,
    message:
      'Temporary API token created. It is shown only once — store it now (e.g. in an env var). ' +
      'It appears under Settings → API Tokens and expires automatically.' +
      (displaced > 0 ? ` Note: ${displaced} older minted token(s) were revoked to stay under the per-minter cap.` : ''),
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
