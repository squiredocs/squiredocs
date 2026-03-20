/**
 * OAuth 2.0 Authorization Flow for MCP Agents
 *
 * Implements authorization code flow with PKCE.
 */
const crypto = require('crypto');
const { getRegisteredAgent, validateScopes, validateRedirectUri, isLocalhostUri, createOrUpdateAgent } = require('./registered-agents');

/**
 * Validate redirect URI against agent's allowed patterns.
 * Auto-registered agents (empty allowed_redirect_uris) are restricted to localhost only.
 */
function checkRedirectUri(agent, redirectUri) {
  const uriValidation = validateRedirectUri(agent, redirectUri);
  if (uriValidation.valid) {
    return { allowed: true };
  }

  // Auto-registered agents (empty allowed list) may only use localhost
  if (agent.allowed_redirect_uris.length === 0) {
    if (isLocalhostUri(redirectUri)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      error: 'Auto-registered agents may only use localhost redirect URIs. Register via POST /mcp/auth/register first.',
    };
  }

  // Pre-registered agent, URI didn't match
  return {
    allowed: false,
    error: 'redirect_uri is not allowed for this agent',
  };
}
const { validateCodeChallenge, generateAuthCode, hashAuthCode, validateCodeVerifier } = require('./pkce');
const { generateAgentToken } = require('./jwt');
const { createDelegation, getActiveDelegation } = require('./delegation');

let pool = null;

const AUTH_CODE_EXPIRY_SECONDS = 300; // 5 minutes
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

function init(dbPool) {
  pool = dbPool;
}

/**
 * Handle GET /mcp/auth/authorize
 *
 * Validates the authorization request and redirects to consent page.
 */
async function handleAuthorize(req, res) {
  const {
    agent_client_id,
    client_id, // Standard OAuth parameter
    agent_instance_id,
    scope,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method = 'S256',
  } = req.query;

  // Support both agent_client_id (custom) and client_id (standard OAuth)
  const clientId = agent_client_id || client_id;

  // Log OAuth authorization attempts
  console.log(`[MCP OAuth] Authorization request - client: ${clientId}, redirect: ${redirect_uri}`);

  // 1. Validate required parameters
  const errors = [];
  if (!clientId) errors.push('client_id is required');
  if (!redirect_uri) errors.push('redirect_uri is required');
  if (!code_challenge) errors.push('code_challenge is required (PKCE)');
  if (!state) errors.push('state is required');

  if (errors.length > 0) {
    return res.status(400).json({ error: 'invalid_request', details: errors });
  }

  // 2. Validate code_challenge format
  const challengeValidation = validateCodeChallenge(code_challenge);
  if (!challengeValidation.valid) {
    return res.status(400).json({ error: 'invalid_request', details: challengeValidation.error });
  }

  // 3. Get or create registered agent (allow dynamic registration)
  let agent = await getRegisteredAgent(clientId);
  if (!agent) {
    // Auto-register new agents on first authorization request
    agent = await createOrUpdateAgent({
      id: clientId,
      name: clientId,
      description: `Auto-registered agent: ${clientId}`,
      allowed_scopes: ['documents:read', 'documents:write'],
      default_scopes: ['documents:read'],
      allowed_redirect_uris: [], // No redirect URI restrictions
      is_public_client: true,
    });
    console.log(`[MCP OAuth] Auto-registered new agent: ${clientId}`);
  }

  // 4. Validate redirect URI
  const redirectCheck = checkRedirectUri(agent, redirect_uri);
  if (!redirectCheck.allowed) {
    console.log(`[MCP OAuth] REJECTED redirect_uri for ${clientId}: ${redirect_uri} - ${redirectCheck.error}`);
    return res.status(400).json({ error: 'invalid_request', error_description: redirectCheck.error });
  }

  // 5. Validate scopes
  const requestedScopes = scope || agent.default_scopes.join(' ');
  const scopeValidation = validateScopes(agent, requestedScopes);
  if (!scopeValidation.valid) {
    return res.status(400).json({ error: 'invalid_scope', details: scopeValidation.error });
  }

  console.log(`[MCP OAuth] User authenticated: ${req.user ? (req.user.email || req.user.userId) : 'none (will show login page)'}`);

  // 6. Always redirect to consent page - let React handle authentication
  // The AuthorizePage component will show a login prompt if user isn't authenticated

  // 7. Check for existing delegation (only if user is authenticated)
  const existingDelegation = req.user ? await getActiveDelegation(req.user.userId, clientId) : null;

  // 8. Redirect to consent page
  const consentParams = new URLSearchParams({
    agent_client_id: clientId,
    agent_instance_id: agent_instance_id || '',
    scope: scopeValidation.scopes.join(' '),
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
    existing_delegation: existingDelegation ? 'true' : 'false',
  });

  const consentUrl = `/authorize?${consentParams.toString()}`;
  console.log(`[MCP OAuth] Redirecting to consent page: ${consentUrl}`);
  res.redirect(consentUrl);
}

/**
 * Handle POST /mcp/auth/approve
 *
 * User approves the authorization request.
 */
async function handleApprove(req, res) {
  console.log('[MCP OAuth] Approve request received');
  console.log('[MCP OAuth] User:', req.user ? (req.user.email || req.user.userId) : 'none');
  console.log('[MCP OAuth] Request body:', JSON.stringify(req.body, null, 2));

  const {
    agent_client_id,
    agent_instance_id,
    scopes,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
    approved,
  } = req.body;

  // 1. Verify user is authenticated
  if (!req.user) {
    console.log('[MCP OAuth] REJECTED: User not authenticated');
    return res.status(401).json({ error: 'unauthorized' });
  }

  // 2. Handle denial
  if (!approved || approved === 'false') {
    const denyUrl = new URL(redirect_uri);
    denyUrl.searchParams.set('error', 'access_denied');
    denyUrl.searchParams.set('error_description', 'User denied the authorization request');
    denyUrl.searchParams.set('state', state);
    const redirectUrl = denyUrl.toString();

    // Return JSON for API requests, redirect for browser requests
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ redirectUrl });
    }

    return res.redirect(redirectUrl);
  }

  // 3. Get or create registered agent (allow dynamic registration)
  let agent = await getRegisteredAgent(agent_client_id);
  if (!agent) {
    // Auto-register new agents if they don't exist
    agent = await createOrUpdateAgent({
      id: agent_client_id,
      name: agent_client_id,
      description: `Auto-registered agent: ${agent_client_id}`,
      allowed_scopes: ['documents:read', 'documents:write'],
      default_scopes: ['documents:read'],
      allowed_redirect_uris: [],
      is_public_client: true,
    });
    console.log(`[MCP OAuth] Auto-registered new agent in approve: ${agent_client_id}`);
  }

  // Validate redirect URI (defense in depth - also validated in handleAuthorize)
  const redirectCheck = checkRedirectUri(agent, redirect_uri);
  if (!redirectCheck.allowed) {
    console.log(`[MCP OAuth] REJECTED redirect_uri in approve for ${agent_client_id}: ${redirect_uri} - ${redirectCheck.error}`);
    return res.status(400).json({ error: 'invalid_request', error_description: redirectCheck.error });
  }

  const scopeArray = Array.isArray(scopes) ? scopes : scopes.split(' ');
  const scopeValidation = validateScopes(agent, scopeArray);
  if (!scopeValidation.valid) {
    return res.status(400).json({ error: 'invalid_scope' });
  }

  // 4. Generate authorization code
  const authCode = generateAuthCode();
  const codeHash = hashAuthCode(authCode);
  const expiresAt = new Date(Date.now() + AUTH_CODE_EXPIRY_SECONDS * 1000);

  // 5. Store authorization code
  await pool.query(
    `INSERT INTO mcp_auth_codes
     (code_hash, user_id, agent_client_id, agent_instance_id, scopes,
      code_challenge, code_challenge_method, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [codeHash, req.user.userId, agent_client_id, agent_instance_id,
     scopeValidation.scopes, code_challenge, code_challenge_method, redirect_uri, expiresAt]
  );

  // 6. Redirect back to agent with authorization code
  const callbackUrl = new URL(redirect_uri);
  callbackUrl.searchParams.set('code', authCode);
  callbackUrl.searchParams.set('state', state);

  const redirectUrl = callbackUrl.toString();

  console.log('[MCP OAuth] APPROVED - Redirecting to:', redirectUrl);
  console.log('[MCP OAuth] Accept header:', req.headers.accept);

  // Return JSON for API requests, redirect for browser requests
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    console.log('[MCP OAuth] Returning JSON response with redirectUrl');
    return res.json({ redirectUrl });
  }

  console.log('[MCP OAuth] Returning HTTP redirect');
  res.redirect(redirectUrl);
}

/**
 * Handle POST /mcp/auth/token
 *
 * Exchange authorization code for tokens.
 */
async function handleToken(req, res) {
  console.log('[MCP OAuth] Token request received');
  console.log('[MCP OAuth] Content-Type:', req.headers['content-type']);
  console.log('[MCP OAuth] Request body:', JSON.stringify(req.body, null, 2));
  console.log('[MCP OAuth] Grant type:', req.body.grant_type);

  const {
    grant_type,
    code,
    code_verifier,
    redirect_uri,
    refresh_token,
  } = req.body;

  if (grant_type === 'authorization_code') {
    console.log('[MCP OAuth] Exchanging authorization code for tokens');
    return handleAuthCodeExchange(req, res, { code, code_verifier, redirect_uri });
  } else if (grant_type === 'refresh_token') {
    console.log('[MCP OAuth] Refreshing access token');
    return handleRefreshToken(req, res, { refresh_token });
  } else {
    console.log('[MCP OAuth] REJECTED: Unsupported grant type:', grant_type);
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
}

/**
 * Exchange authorization code for tokens
 */
async function handleAuthCodeExchange(req, res, { code, code_verifier, redirect_uri }) {
  console.log('[MCP OAuth] Exchanging auth code - redirect_uri:', redirect_uri);

  // 1. Validate required parameters
  if (!code || !code_verifier || !redirect_uri) {
    console.log('[MCP OAuth] REJECTED: Missing required parameters');
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'code, code_verifier, and redirect_uri are required',
    });
  }

  // 2. Look up authorization code
  const codeHash = hashAuthCode(code);
  const codeResult = await pool.query(
    `SELECT * FROM mcp_auth_codes
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [codeHash]
  );

  if (codeResult.rows.length === 0) {
    console.log('[MCP OAuth] REJECTED: Invalid or expired authorization code');
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code',
    });
  }

  const authCode = codeResult.rows[0];
  console.log('[MCP OAuth] Found auth code for user:', authCode.user_id, 'agent:', authCode.agent_client_id);

  // 3. Validate redirect_uri matches (security: ensure it matches what was stored)
  // Note: We no longer validate against allowed patterns, but we still check it matches
  // the redirect_uri from the authorization request for security
  if (authCode.redirect_uri !== redirect_uri) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'redirect_uri does not match',
    });
  }

  // 4. Validate PKCE code_verifier
  const pkceValidation = validateCodeVerifier(
    code_verifier,
    authCode.code_challenge,
    authCode.code_challenge_method
  );
  if (!pkceValidation.valid) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: pkceValidation.error,
    });
  }

  // 5. Mark code as used (single-use)
  await pool.query(
    'UPDATE mcp_auth_codes SET used_at = NOW() WHERE code_hash = $1',
    [codeHash]
  );

  // 6. Get registered agent
  const agent = await getRegisteredAgent(authCode.agent_client_id);

  // 7. Create or update delegation
  const agentId = authCode.agent_instance_id
    ? `${authCode.agent_client_id}:${authCode.agent_instance_id}`
    : authCode.agent_client_id;

  const delegation = await createDelegation(
    authCode.user_id,
    agentId,
    agent.name,
    {
      scopes: authCode.scopes,
      expiresAt: null, // Delegation doesn't expire, refresh token does
      metadata: {
        agent_client_id: authCode.agent_client_id,
        agent_instance_id: authCode.agent_instance_id,
      },
    }
  );

  // 8. Generate refresh token
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await pool.query(
    `UPDATE agent_delegations
     SET refresh_token_hash = $1,
         refresh_token_version = refresh_token_version + 1,
         refresh_token_expires_at = $2,
         agent_client_id = $3,
         agent_instance_id = $4
     WHERE id = $5`,
    [refreshTokenHash, refreshExpiresAt, authCode.agent_client_id, authCode.agent_instance_id, delegation.id]
  );

  // 9. Generate access token
  const accessToken = generateAgentToken({
    ...delegation,
    scopes: authCode.scopes,
  });

  console.log('[MCP OAuth] Token exchange SUCCESS - delegation:', delegation.id, 'scopes:', authCode.scopes);

  // 10. Return tokens
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600, // 1 hour
    refresh_token: refreshToken,
    scope: authCode.scopes.join(' '),
  });
}

/**
 * Refresh an access token
 */
async function handleRefreshToken(req, res, { refresh_token }) {
  if (!refresh_token) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'refresh_token is required',
    });
  }

  // 1. Hash the refresh token
  const refreshTokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');

  // 2. Find delegation with matching refresh token
  const result = await pool.query(
    `SELECT d.*, ra.name as agent_display_name
     FROM agent_delegations d
     LEFT JOIN registered_agents ra ON d.agent_client_id = ra.id
     WHERE d.refresh_token_hash = $1
       AND d.revoked_at IS NULL
       AND d.refresh_token_expires_at > NOW()`,
    [refreshTokenHash]
  );

  if (result.rows.length === 0) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid or expired refresh token',
    });
  }

  const delegation = result.rows[0];

  // 3. Generate new refresh token (rotation)
  const newRefreshToken = crypto.randomBytes(32).toString('base64url');
  const newRefreshTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await pool.query(
    `UPDATE agent_delegations
     SET refresh_token_hash = $1,
         refresh_token_version = refresh_token_version + 1,
         refresh_token_expires_at = $2,
         last_used_at = NOW()
     WHERE id = $3`,
    [newRefreshTokenHash, refreshExpiresAt, delegation.id]
  );

  // 4. Generate new access token
  const accessToken = generateAgentToken(delegation);

  // 5. Return new tokens
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: newRefreshToken,
    scope: delegation.scopes.join(' '),
  });
}

/**
 * Handle POST /mcp/auth/revoke
 */
async function handleRevoke(req, res) {
  const { token, token_type_hint } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  // Try to revoke as refresh token
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const result = await pool.query(
    `UPDATE agent_delegations
     SET revoked_at = NOW(), refresh_token_hash = NULL
     WHERE refresh_token_hash = $1
     RETURNING id`,
    [tokenHash]
  );

  // Always return 200 per RFC 7009
  res.json({ success: true });
}

/**
 * Handle GET /mcp/auth/delegations
 *
 * List user's active delegations
 */
async function handleListDelegations(req, res) {
  if (!req.user) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const result = await pool.query(
    `SELECT
       d.id,
       d.agent_id,
       d.agent_name,
       d.scopes,
       d.created_at,
       d.last_used_at,
       d.expires_at,
       ra.name as registered_name,
       ra.description as agent_description,
       ra.icon_url
     FROM agent_delegations d
     LEFT JOIN registered_agents ra ON d.agent_client_id = ra.id
     WHERE d.user_id = $1
       AND d.revoked_at IS NULL
       AND (d.expires_at IS NULL OR d.expires_at > NOW())
     ORDER BY d.last_used_at DESC NULLS LAST, d.created_at DESC`,
    [req.user.userId]
  );

  res.json({
    delegations: result.rows.map(d => ({
      id: d.id,
      agentId: d.agent_id,
      agentName: d.registered_name || d.agent_name,
      description: d.agent_description,
      iconUrl: d.icon_url,
      scopes: d.scopes,
      createdAt: d.created_at,
      lastUsedAt: d.last_used_at,
      expiresAt: d.expires_at,
    })),
  });
}

/**
 * Handle DELETE /mcp/auth/delegations/:id
 */
async function handleDeleteDelegation(req, res) {
  if (!req.user) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { id } = req.params;

  const result = await pool.query(
    `UPDATE agent_delegations
     SET revoked_at = NOW(), refresh_token_hash = NULL
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [id, req.user.userId]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Delegation not found' });
  }

  res.json({ success: true });
}

/**
 * Handle POST /mcp/auth/register
 * Dynamic Client Registration (RFC 7591)
 * 
 * Allows any service to register as an MCP agent dynamically.
 */
async function handleRegister(req, res) {
  const { client_name, redirect_uris, scopes } = req.body;
  console.log('[MCP OAuth] Client registration request:', client_name, 'redirect_uris:', redirect_uris);

  // Generate a unique client ID if not provided
  const clientId = req.body.client_id || `client_${crypto.randomBytes(16).toString('hex')}`;

  // Default scopes if not provided
  const allowedScopes = scopes && Array.isArray(scopes) 
    ? scopes 
    : ['documents:read', 'documents:write'];

  // Create or update the agent
  const agent = await createOrUpdateAgent({
    id: clientId,
    name: client_name || clientId,
    description: `OAuth registered agent: ${client_name || clientId}`,
    allowed_scopes: allowedScopes,
    default_scopes: allowedScopes,
    allowed_redirect_uris: redirect_uris || [], // Enforced during authorization
    is_public_client: true,
  });

  console.log(`[MCP OAuth] Registered new agent: ${clientId}`);

  // Return client configuration per RFC 7591
  res.status(201).json({
    client_id: agent.id,
    client_name: agent.name,
    redirect_uris: redirect_uris || [],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: agent.allowed_scopes.join(' '),
  });
}

module.exports = {
  init,
  handleAuthorize,
  handleApprove,
  handleToken,
  handleRevoke,
  handleRegister,
  handleListDelegations,
  handleDeleteDelegation,
};
