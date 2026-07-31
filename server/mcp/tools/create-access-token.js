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
 *
 * Delivery shape: by default the result contains NO token — it carries a
 * one-shot claim recipe (GET /api/tokens/claim, see api/token-claim.js and
 * auth/pending-mints.js) and the token is minted at claim time, landing on
 * disk without transiting model context. inline: true is the explicit
 * opt-in for shell-less agents.
 */
const apiTokens = require('../auth/api-tokens');
const delegation = require('../auth/delegation');
const pendingMints = require('../auth/pending-mints');
const { deriveMintedTokenName, MAX_NAME_LENGTH } = require('../auth/token-naming');

// apiTokens and delegation are boot-time singletons wired up in
// server/mcp/index.js init(); the tool holds no persistence handle of its
// own. init is kept only to satisfy the tool contract.
function init() {}

const KNOWN_SCOPES = ['documents:read', 'documents:write'];
const DEFAULT_SCOPES = ['documents:read'];

const name = 'create_access_token';

const description = `Mint a temporary API token (prefixed sk_sqd_) for REST access — exporting AND importing documents as markdown via curl without document content passing through model context.

The result contains NO token. It returns a one-shot claimCommand: run it in your shell within 5 minutes and the token is written straight to ~/.squire/token (it never enters this conversation). Reference it as $(cat ~/.squire/token) afterward. Pass inline: true ONLY if you cannot run shell commands — the token then appears once, in-band.

The token is scoped to AT MOST your own permissions. Default: documents:read, which covers export only — to IMPORT or sync-push markdown, mint with scopes: ["documents:read", "documents:write"]. It expires automatically (default 1 hour, max 24 hours), appears under the user's Settings → API Tokens, and is revoked automatically if your own credential is revoked. Tokens minted by this tool cannot mint further tokens.

The token's name is your public identity — it is the live presence label people watching a document see while you work in it, and the author recorded in version history — so name the token after YOURSELF (e.g. "Claude Code"), never after the operation.

Usage: create_access_token() or create_access_token({ scopes: ["documents:read", "documents:write"], ttlSeconds: 600 })
Then run claimCommand and follow curlExample / importCurlExample. Full REST recipe (export, import, two-way sync): get_tool_documentation({ tool: "rest_api" }).`;

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
      description: `Token lifetime in seconds (counted from the claim). Default ${apiTokens.MINTED_TOKEN_DEFAULT_TTL_SECONDS} (1 hour); min ${apiTokens.MINTED_TOKEN_MIN_TTL_SECONDS}, max ${apiTokens.MINTED_TOKEN_MAX_TTL_SECONDS} (24 hours).`,
    },
    inline: {
      type: 'boolean',
      description:
        'Return the token in-band instead of via claimCommand. ONLY for agents with no shell — the token lands in the conversation, which the claim flow exists to avoid. Default false.',
    },
    name: {
      type: 'string',
      description:
        'Display name for the token — name it after YOURSELF, the agent (e.g. "Claude Code"). This name is shown to people watching the document as your live presence label while you import, and recorded as the author in version history. Not an operation name. Defaults to your own agent name.',
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
 * Validate the optional `name` argument (feature 037, RBD-10).
 *
 * Caller-supplied names win — an agent that knows what it is called should say
 * so. When absent, the default describes the AGENT rather than this call, since
 * the name is the token's public identity: a live presence label and a
 * version-history author.
 */
function resolveName(requested, agentToken) {
  if (requested === undefined) {
    return deriveMintedTokenName(agentToken);
  }
  const trimmed = typeof requested === 'string' ? requested.trim() : '';
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(
      `Invalid parameters for tool '${name}': 'name' must be a non-empty string of at most ${MAX_NAME_LENGTH} characters (got ${JSON.stringify(requested)})`
    );
  }
  return trimmed;
}

/**
 * Mint-eligibility guards shared by both delivery modes and both tools that
 * prepare claim deliveries (create_access_token, import_markdown_file).
 *
 * No chaining: a token minted by this tool cannot mint further tokens.
 * Otherwise each child would be a fresh minter with its own cap budget.
 *
 * Delegation liveness: agent JWTs are stateless (1h expiry) and minting is
 * the one operation whose product outlives the JWT, so re-check the
 * delegation in the DB — a just-revoked delegation must not be able to mint
 * a fresh 24h token during the remainder of its JWT's lifetime.
 */
async function assertCanMint(agentToken) {
  if (agentToken.apiTokenId) {
    const parent = await apiTokens.getTokenById(agentToken.apiTokenId);
    if (parent && (parent.minted_by_delegation_id || parent.minted_by_api_token_id)) {
      throw new Error(
        'Tokens minted by create_access_token cannot mint further tokens. Use your original credential.'
      );
    }
  }

  if (agentToken.delegationId) {
    const check = await delegation.checkDelegation(agentToken.delegationId, null);
    if (!check.isValid) {
      throw new Error(`Cannot mint token: ${check.reason}`);
    }
  }
}

/**
 * Prepare a one-shot claim delivery for the calling principal: run the
 * mint-eligibility guards, create the pending-mint record in Redis, and
 * return the claim ingredients. This is the single mint path shared with
 * import_markdown_file (feature 019, R1) — the pending-mint record shape,
 * claim window, hashing, and redemption are untouched.
 *
 * @param {object} agentToken - Authenticated principal (agent JWT or API token)
 * @param {object} opts - { scopes, ttlSeconds, name }
 * @returns {Promise<{claimSecret: string, claimUrl: string, claimExpiresInSeconds: number}>}
 */
async function prepareClaimDelivery(agentToken, { scopes, ttlSeconds, name }) {
  await assertCanMint(agentToken);

  const claimSecret = await pendingMints.createPendingMint({
    userId: agentToken.userId,
    name,
    scopes,
    ttlSeconds,
    mintedByDelegationId: agentToken.delegationId || null,
    mintedByApiTokenId: agentToken.apiTokenId || null,
  });

  const baseUrl = agentToken.baseUrl || 'https://squiredocs.com';
  return {
    claimSecret,
    claimUrl: `${baseUrl}/api/tokens/claim`,
    claimExpiresInSeconds: pendingMints.CLAIM_TTL_SECONDS,
  };
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

  const minter = {
    delegationId: agentToken.delegationId || null,
    apiTokenId: agentToken.apiTokenId || null,
  };
  const tokenName = resolveName(args.name, agentToken);
  const baseUrl = agentToken.baseUrl || 'https://squiredocs.com';

  // The usage examples never contain a secret in either delivery mode: the
  // token lives at ~/.squire/token and is referenced via $(cat ...).
  const curlExample =
    `curl -sf -H "Authorization: Bearer $(cat ~/.squire/token)" \\\n` +
    `  "${baseUrl}/api/docs/<docId>/export?format=markdown" -o doc.md`;
  // The import example only works with documents:write; shown regardless so
  // the byte channel is discoverable in both directions from the mint.
  const importCurlExample =
    `curl -sf -X POST -H "Authorization: Bearer $(cat ~/.squire/token)" \\\n` +
    `  -H "Content-Type: text/markdown" --data-binary @doc.md \\\n` +
    `  "${baseUrl}/api/docs/import?frontmatter=true"` +
    (scopes.includes('documents:write')
      ? ''
      : `\n(importing requires documents:write — this token is read-only; re-mint with scopes: ["documents:read", "documents:write"])`);

  if (args.inline === true) {
    // Explicit opt-in for shell-less agents: the token is delivered in-band
    // (there is no other channel available to such an agent) with a
    // do-not-echo warning leading the result.
    await assertCanMint(agentToken);
    const displaced = await apiTokens.enforceMinterCap(minter);
    const { token, record } = await apiTokens.createToken(agentToken.userId, tokenName, {
      scopes,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      mintedByDelegationId: minter.delegationId,
      mintedByApiTokenId: minter.apiTokenId,
    });
    return {
      warning:
        'This token is a secret delivered in-band because you passed inline: true. ' +
        'Never print, echo, paste, or repeat it in any output. If you can run shell ' +
        'commands, store it via heredoc (not argv): ' +
        "umask 077; mkdir -p ~/.squire; cat > ~/.squire/token <<'EOF' ... EOF",
      token,
      tokenPrefix: record.token_prefix,
      scopes: record.scopes,
      expiresAt: record.expires_at,
      ttlSeconds,
      curlExample,
      importCurlExample,
      message:
        'Temporary API token created (inline delivery). It is shown only once. ' +
        'It appears under Settings → API Tokens and expires automatically.' +
        (displaced > 0 ? ` Note: ${displaced} older minted token(s) were revoked to stay under the per-minter cap.` : ''),
    };
  }

  // Default: claim delivery. No token is minted yet and none appears in this
  // result — the claim endpoint mints at redemption time and returns the raw
  // bytes, so the credential goes server → disk without transiting model
  // context. The claim secret below is acceptable transcript residue: it is
  // one-shot, expires in minutes, and grants nothing but the claim.
  const { claimSecret, claimUrl, claimExpiresInSeconds } = await prepareClaimDelivery(agentToken, {
    scopes,
    ttlSeconds,
    name: tokenName,
  });

  return {
    scopes,
    ttlSeconds,
    claimUrl,
    claimExpiresInSeconds,
    claimCommand:
      `umask 077; mkdir -p ~/.squire\n` +
      `curl -sf -H "Authorization: Bearer ${claimSecret}" \\\n` +
      `  "${baseUrl}/api/tokens/claim" -o ~/.squire/token \\\n` +
      `  && echo "token written to ~/.squire/token" \\\n` +
      `  || echo "claim failed: already claimed, expired (${Math.round(pendingMints.CLAIM_TTL_SECONDS / 60)} min), or refused"`,
    curlExample,
    importCurlExample,
    message:
      'No token is included in this response. Run claimCommand in your shell within ' +
      `${Math.round(pendingMints.CLAIM_TTL_SECONDS / 60)} minutes — the first claim wins and the URL is dead afterward. ` +
      `The token (expires ${ttlSeconds}s after the claim) is written straight to ~/.squire/token; ` +
      'reference it as $(cat ~/.squire/token) and never print or echo it. ' +
      'It appears under Settings → API Tokens once claimed. ' +
      'No shell? Re-run with inline: true.',
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
  prepareClaimDelivery,
};
