# MCP Agent Authentication: Production Implementation Plan

## Overview

This document details the implementation plan for productionizing the MCP agent authentication system, enabling real Google OAuth users to securely delegate their permissions to AI agents (like Claude Code).

**Current State:** Manual token generation via CLI script
**Target State:** Full OAuth 2.0 authorization flow with user consent UI

---

## Table of Contents

1. [Architecture](#architecture)
2. [Security Model](#security-model)
3. [Database Changes](#database-changes)
4. [Backend Implementation](#backend-implementation)
5. [Frontend Implementation](#frontend-implementation)
6. [Configuration](#configuration)
7. [Migration Guide](#migration-guide)
8. [Testing Strategy](#testing-strategy)
9. [Rollout Plan](#rollout-plan)

---

## Architecture

### Authorization Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OAuth 2.0 + PKCE Flow                               │
└─────────────────────────────────────────────────────────────────────────────┘

  AI Agent                    Server                         User Browser
     │                           │                                │
     │  1. Generate PKCE         │                                │
     │     code_verifier         │                                │
     │     code_challenge        │                                │
     │                           │                                │
     │  2. Redirect user ────────┼───────────────────────────────►│
     │     /mcp/auth/authorize   │                                │
     │     ?agent_client_id=...  │                                │
     │     &scope=...            │                                │
     │     &code_challenge=...   │                                │
     │     &state=...            │                                │
     │                           │                                │
     │                           │  3. Check user session         │
     │                           │◄───────────────────────────────│
     │                           │                                │
     │                           │  4. Show consent page ────────►│
     │                           │     (agent name, scopes)       │
     │                           │                                │
     │                           │  5. User approves ◄────────────│
     │                           │     POST /mcp/auth/approve     │
     │                           │                                │
     │                           │  6. Create delegation          │
     │                           │     Generate auth code         │
     │                           │                                │
     │                           │  7. Redirect to agent ─────────│
     │  8. Receive callback ◄────┼─────────────────────────────── │
     │     ?code=...&state=...   │                                │
     │                           │                                │
     │  9. Exchange code ───────►│                                │
     │     POST /mcp/auth/token  │                                │
     │     + code_verifier       │                                │
     │                           │                                │
     │  10. Receive tokens ◄─────│                                │
     │      access_token         │                                │
     │      refresh_token        │                                │
     │                           │                                │
     ▼                           ▼                                ▼
```

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Server Components                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  server/mcp/auth/                                                           │
│  ├── registered-agents.js    # Known agent types and their allowed scopes   │
│  ├── oauth-flow.js           # Authorization endpoints                       │
│  ├── tokens.js               # Token generation (access + refresh)          │
│  ├── pkce.js                 # PKCE validation utilities                    │
│  ├── delegation.js           # [existing] Delegation CRUD                   │
│  ├── jwt.js                  # [existing] JWT utilities                     │
│  └── middleware.js           # [existing] Auth middleware                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                             Frontend Components                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  client/src/                                                                │
│  ├── pages/                                                                 │
│  │   └── AgentAuthorizePage.jsx    # OAuth consent page                     │
│  ├── components/                                                            │
│  │   ├── AgentConsentForm.jsx      # Scope selection, approve/deny         │
│  │   ├── AgentDelegationList.jsx   # List of authorized agents             │
│  │   └── AgentDelegationCard.jsx   # Individual delegation display         │
│  └── contexts/                                                              │
│      └── AuthContext.jsx           # [extend] Add delegation management    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Security Model

### Threat Model

| Threat | Mitigation |
|--------|------------|
| CSRF during authorization | `state` parameter validation |
| Authorization code interception | PKCE with S256 challenge |
| Token theft | Short-lived access tokens (1h), refresh rotation |
| Malicious agent impersonation | Registered agent allowlist |
| Scope escalation | Server-side scope validation against allowlist |
| Replay attacks | Single-use auth codes, `jti` in tokens |
| Token leakage in logs | Never log full tokens, use truncated IDs |

### Token Security

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Token Hierarchy                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Authorization Code (5 min)                                                  │
│  ├── Single use                                                             │
│  ├── Bound to code_challenge                                                │
│  └── Stored in memory/redis (not DB)                                        │
│                                                                              │
│  Access Token (1 hour)                                                       │
│  ├── JWT with delegation claims                                             │
│  ├── Stateless validation                                                   │
│  └── Contains: delegationId, userId, agentId, scopes                        │
│                                                                              │
│  Refresh Token (30 days)                                                     │
│  ├── Opaque token (not JWT)                                                 │
│  ├── Stored hashed in DB                                                    │
│  ├── Rotated on each use                                                    │
│  └── Tied to delegation record                                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### PKCE Implementation

```javascript
// Agent generates:
code_verifier = base64url(random(32 bytes))  // 43-128 chars
code_challenge = base64url(sha256(code_verifier))

// Server validates:
sha256(received_code_verifier) === stored_code_challenge
```

---

## Database Changes

### Migration: `011_mcp_auth_enhancements.js`

```javascript
/**
 * Migration: Enhance MCP auth for production OAuth flow
 */
exports.up = (pgm) => {
  // 1. Add refresh token support to delegations
  pgm.addColumns('agent_delegations', {
    refresh_token_hash: {
      type: 'varchar(64)',
      comment: 'SHA-256 hash of current refresh token',
    },
    refresh_token_version: {
      type: 'integer',
      notNull: true,
      default: 0,
      comment: 'Incremented on each refresh, enables rotation',
    },
    refresh_token_expires_at: {
      type: 'timestamptz',
      comment: 'When the refresh token expires',
    },
  });

  // 2. Create registered agents table
  pgm.createTable('registered_agents', {
    id: {
      type: 'varchar(64)',
      primaryKey: true,
      comment: 'Agent client ID (e.g., "claude-code")',
    },
    name: {
      type: 'varchar(255)',
      notNull: true,
      comment: 'Display name for consent screen',
    },
    description: {
      type: 'text',
      comment: 'Description shown during authorization',
    },
    icon_url: {
      type: 'varchar(512)',
      comment: 'URL to agent icon for consent screen',
    },
    allowed_scopes: {
      type: 'text[]',
      notNull: true,
      default: pgm.func("ARRAY['documents:read']"),
      comment: 'Maximum scopes this agent can request',
    },
    default_scopes: {
      type: 'text[]',
      notNull: true,
      default: pgm.func("ARRAY['documents:read']"),
      comment: 'Default scopes if none specified',
    },
    allowed_redirect_uris: {
      type: 'text[]',
      notNull: true,
      default: '{}',
      comment: 'Allowed redirect URIs for this agent',
    },
    is_public_client: {
      type: 'boolean',
      notNull: true,
      default: true,
      comment: 'True for clients that cannot keep secrets (CLI tools)',
    },
    client_secret_hash: {
      type: 'varchar(64)',
      comment: 'For confidential clients only',
    },
    is_enabled: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // 3. Create authorization codes table (short-lived, could use Redis instead)
  pgm.createTable('mcp_auth_codes', {
    code_hash: {
      type: 'varchar(64)',
      primaryKey: true,
      comment: 'SHA-256 hash of authorization code',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    agent_client_id: {
      type: 'varchar(64)',
      notNull: true,
      references: 'registered_agents(id)',
      onDelete: 'CASCADE',
    },
    agent_instance_id: {
      type: 'varchar(255)',
      comment: 'Unique identifier for this agent instance',
    },
    scopes: {
      type: 'text[]',
      notNull: true,
    },
    code_challenge: {
      type: 'varchar(128)',
      notNull: true,
      comment: 'PKCE code challenge',
    },
    code_challenge_method: {
      type: 'varchar(10)',
      notNull: true,
      default: 'S256',
    },
    redirect_uri: {
      type: 'varchar(512)',
      notNull: true,
    },
    expires_at: {
      type: 'timestamptz',
      notNull: true,
    },
    used_at: {
      type: 'timestamptz',
      comment: 'Set when code is exchanged (prevents reuse)',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Index for cleanup job
  pgm.createIndex('mcp_auth_codes', 'expires_at', {
    name: 'idx_mcp_auth_codes_expires',
  });

  // 4. Update agent_delegations to reference registered agent
  pgm.addColumns('agent_delegations', {
    agent_client_id: {
      type: 'varchar(64)',
      references: 'registered_agents(id)',
      onDelete: 'SET NULL',
      comment: 'Reference to registered agent (NULL for legacy delegations)',
    },
    agent_instance_id: {
      type: 'varchar(255)',
      comment: 'Unique identifier for this agent instance',
    },
  });

  // 5. Seed initial registered agents
  pgm.sql(`
    INSERT INTO registered_agents (id, name, description, allowed_scopes, default_scopes, allowed_redirect_uris, is_public_client)
    VALUES
      ('claude-code', 'Claude Code', 'AI coding assistant for VS Code and CLI',
       ARRAY['documents:read', 'documents:write'],
       ARRAY['documents:read', 'documents:write'],
       ARRAY['http://localhost:*', 'http://127.0.0.1:*', 'vscode://anthropic.claude-code/*'],
       true),
      ('claude-desktop', 'Claude Desktop', 'Claude AI desktop application',
       ARRAY['documents:read', 'documents:write'],
       ARRAY['documents:read'],
       ARRAY['http://localhost:*', 'http://127.0.0.1:*', 'claude://callback'],
       true)
    ON CONFLICT (id) DO NOTHING;
  `);

  // 6. Add table comments
  pgm.sql(`
    COMMENT ON TABLE registered_agents IS 'Allowlist of AI agents that can request authorization';
    COMMENT ON TABLE mcp_auth_codes IS 'Short-lived authorization codes for OAuth flow';
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('mcp_auth_codes');
  pgm.dropTable('registered_agents');
  pgm.dropColumns('agent_delegations', [
    'refresh_token_hash',
    'refresh_token_version',
    'refresh_token_expires_at',
    'agent_client_id',
    'agent_instance_id',
  ]);
};
```

---

## Backend Implementation

### File: `server/mcp/auth/registered-agents.js`

```javascript
/**
 * Registered Agents Management
 *
 * Manages the allowlist of AI agents that can request authorization.
 */

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

/**
 * Get a registered agent by client ID
 */
async function getRegisteredAgent(clientId) {
  const result = await pool.query(
    `SELECT * FROM registered_agents
     WHERE id = $1 AND is_enabled = true`,
    [clientId]
  );
  return result.rows[0] || null;
}

/**
 * Validate requested scopes against agent's allowed scopes
 */
function validateScopes(agent, requestedScopes) {
  const requested = Array.isArray(requestedScopes)
    ? requestedScopes
    : requestedScopes.split(' ').filter(Boolean);

  const invalid = requested.filter(s => !agent.allowed_scopes.includes(s));

  if (invalid.length > 0) {
    return {
      valid: false,
      error: `Invalid scopes: ${invalid.join(', ')}`,
      allowedScopes: agent.allowed_scopes,
    };
  }

  return { valid: true, scopes: requested };
}

/**
 * Validate redirect URI against agent's allowed patterns
 */
function validateRedirectUri(agent, redirectUri) {
  const patterns = agent.allowed_redirect_uris;

  for (const pattern of patterns) {
    if (matchUriPattern(pattern, redirectUri)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    error: 'redirect_uri not allowed for this agent',
  };
}

/**
 * Match URI against pattern (supports * wildcards)
 */
function matchUriPattern(pattern, uri) {
  // Convert pattern to regex
  // http://localhost:* -> http://localhost:\d+
  // vscode://anthropic.claude-code/* -> vscode://anthropic\.claude-code/.*
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special chars
    .replace(/\*/g, '.*');                    // * -> .*

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(uri);
}

/**
 * Get all enabled registered agents (for admin UI)
 */
async function listRegisteredAgents() {
  const result = await pool.query(
    `SELECT id, name, description, icon_url, allowed_scopes, default_scopes, is_public_client
     FROM registered_agents
     WHERE is_enabled = true
     ORDER BY name`
  );
  return result.rows;
}

module.exports = {
  init,
  getRegisteredAgent,
  validateScopes,
  validateRedirectUri,
  listRegisteredAgents,
};
```

### File: `server/mcp/auth/pkce.js`

```javascript
/**
 * PKCE (Proof Key for Code Exchange) utilities
 *
 * Implements RFC 7636 for public clients.
 */
const crypto = require('crypto');

/**
 * Validate PKCE code verifier against stored challenge
 */
function validateCodeVerifier(codeVerifier, codeChallenge, method = 'S256') {
  if (method !== 'S256') {
    return { valid: false, error: 'Only S256 method is supported' };
  }

  // code_verifier must be 43-128 characters
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) {
    return { valid: false, error: 'Invalid code_verifier length' };
  }

  // Calculate expected challenge
  const expectedChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  if (expectedChallenge !== codeChallenge) {
    return { valid: false, error: 'code_verifier does not match code_challenge' };
  }

  return { valid: true };
}

/**
 * Validate code challenge format
 */
function validateCodeChallenge(codeChallenge) {
  // Base64url encoded SHA-256 hash is 43 characters
  if (!codeChallenge || codeChallenge.length !== 43) {
    return { valid: false, error: 'Invalid code_challenge format' };
  }

  // Must be valid base64url
  if (!/^[A-Za-z0-9_-]+$/.test(codeChallenge)) {
    return { valid: false, error: 'code_challenge must be base64url encoded' };
  }

  return { valid: true };
}

/**
 * Generate a secure random state parameter
 */
function generateState() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate authorization code
 */
function generateAuthCode() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Hash authorization code for storage
 */
function hashAuthCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

module.exports = {
  validateCodeVerifier,
  validateCodeChallenge,
  generateState,
  generateAuthCode,
  hashAuthCode,
};
```

### File: `server/mcp/auth/oauth-flow.js`

```javascript
/**
 * OAuth 2.0 Authorization Flow for MCP Agents
 *
 * Implements authorization code flow with PKCE.
 */
const crypto = require('crypto');
const { getRegisteredAgent, validateScopes, validateRedirectUri } = require('./registered-agents');
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
    agent_instance_id,
    scope,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method = 'S256',
  } = req.query;

  // 1. Validate required parameters
  const errors = [];
  if (!agent_client_id) errors.push('agent_client_id is required');
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

  // 3. Get registered agent
  const agent = await getRegisteredAgent(agent_client_id);
  if (!agent) {
    return res.status(400).json({ error: 'invalid_client', details: 'Unknown agent_client_id' });
  }

  // 4. Validate redirect URI
  const uriValidation = validateRedirectUri(agent, redirect_uri);
  if (!uriValidation.valid) {
    return res.status(400).json({ error: 'invalid_request', details: uriValidation.error });
  }

  // 5. Validate scopes
  const requestedScopes = scope || agent.default_scopes.join(' ');
  const scopeValidation = validateScopes(agent, requestedScopes);
  if (!scopeValidation.valid) {
    return res.status(400).json({ error: 'invalid_scope', details: scopeValidation.error });
  }

  // 6. Check if user is authenticated
  if (!req.user) {
    // Store auth request in session and redirect to login
    req.session.pendingAuthRequest = {
      agent_client_id,
      agent_instance_id,
      scopes: scopeValidation.scopes,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
    };
    return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
  }

  // 7. Check for existing delegation
  const existingDelegation = await getActiveDelegation(req.user.userId, agent_client_id);

  // 8. Redirect to consent page
  const consentParams = new URLSearchParams({
    agent_client_id,
    agent_instance_id: agent_instance_id || '',
    scope: scopeValidation.scopes.join(' '),
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
    existing_delegation: existingDelegation ? 'true' : 'false',
  });

  res.redirect(`/authorize?${consentParams.toString()}`);
}

/**
 * Handle POST /mcp/auth/approve
 *
 * User approves the authorization request.
 */
async function handleApprove(req, res) {
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
    return res.status(401).json({ error: 'unauthorized' });
  }

  // 2. Handle denial
  if (!approved || approved === 'false') {
    const denyUrl = new URL(redirect_uri);
    denyUrl.searchParams.set('error', 'access_denied');
    denyUrl.searchParams.set('error_description', 'User denied the authorization request');
    denyUrl.searchParams.set('state', state);
    return res.redirect(denyUrl.toString());
  }

  // 3. Re-validate everything server-side
  const agent = await getRegisteredAgent(agent_client_id);
  if (!agent) {
    return res.status(400).json({ error: 'invalid_client' });
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

  res.redirect(callbackUrl.toString());
}

/**
 * Handle POST /mcp/auth/token
 *
 * Exchange authorization code for tokens.
 */
async function handleToken(req, res) {
  const {
    grant_type,
    code,
    code_verifier,
    redirect_uri,
    refresh_token,
  } = req.body;

  if (grant_type === 'authorization_code') {
    return handleAuthCodeExchange(req, res, { code, code_verifier, redirect_uri });
  } else if (grant_type === 'refresh_token') {
    return handleRefreshToken(req, res, { refresh_token });
  } else {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
}

/**
 * Exchange authorization code for tokens
 */
async function handleAuthCodeExchange(req, res, { code, code_verifier, redirect_uri }) {
  // 1. Validate required parameters
  if (!code || !code_verifier || !redirect_uri) {
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
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code',
    });
  }

  const authCode = codeResult.rows[0];

  // 3. Validate redirect_uri matches
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

module.exports = {
  init,
  handleAuthorize,
  handleApprove,
  handleToken,
  handleRevoke,
  handleListDelegations,
  handleDeleteDelegation,
};
```

### File: `server/mcp/auth/index.js` (Router)

```javascript
/**
 * MCP Auth Router
 *
 * Mounts all OAuth endpoints for agent authorization.
 */
const express = require('express');
const oauthFlow = require('./oauth-flow');
const { requireAuth } = require('../../auth/middleware');

const router = express.Router();

// Public endpoints (agent-initiated)
router.get('/authorize', oauthFlow.handleAuthorize);
router.post('/token', oauthFlow.handleToken);
router.post('/revoke', oauthFlow.handleRevoke);

// Protected endpoints (user-initiated, require session auth)
router.post('/approve', requireAuth, oauthFlow.handleApprove);
router.get('/delegations', requireAuth, oauthFlow.handleListDelegations);
router.delete('/delegations/:id', requireAuth, oauthFlow.handleDeleteDelegation);

module.exports = router;
```

---

## Frontend Implementation

### File: `client/src/pages/AuthorizePage.jsx`

```jsx
/**
 * Agent Authorization Consent Page
 *
 * Displays agent info and requested permissions, allowing user to approve/deny.
 */
import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const SCOPE_DESCRIPTIONS = {
  'documents:read': {
    label: 'Read your documents',
    description: 'View document titles, content, and metadata',
    icon: '📖',
  },
  'documents:write': {
    label: 'Edit your documents',
    description: 'Create, modify, and delete documents on your behalf',
    icon: '✏️',
  },
};

export default function AuthorizePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, isLoading: authLoading } = useAuth();

  const [agentInfo, setAgentInfo] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const agentClientId = searchParams.get('agent_client_id');
  const scopes = searchParams.get('scope')?.split(' ') || [];
  const redirectUri = searchParams.get('redirect_uri');
  const state = searchParams.get('state');
  const codeChallenge = searchParams.get('code_challenge');
  const codeChallengeMethod = searchParams.get('code_challenge_method');
  const agentInstanceId = searchParams.get('agent_instance_id');
  const existingDelegation = searchParams.get('existing_delegation') === 'true';

  useEffect(() => {
    if (!agentClientId) {
      setError('Missing agent_client_id parameter');
      setIsLoading(false);
      return;
    }

    // Fetch agent info
    fetch(`/api/mcp/agents/${agentClientId}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setError(data.error);
        } else {
          setAgentInfo(data);
        }
      })
      .catch(err => setError('Failed to load agent information'))
      .finally(() => setIsLoading(false));
  }, [agentClientId]);

  const handleDecision = async (approved) => {
    setIsSubmitting(true);

    try {
      const response = await fetch('/mcp/auth/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          agent_client_id: agentClientId,
          agent_instance_id: agentInstanceId,
          scopes: scopes.join(' '),
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          approved,
        }),
      });

      if (response.redirected) {
        window.location.href = response.url;
      } else {
        const data = await response.json();
        if (data.error) {
          setError(data.error);
        }
      }
    } catch (err) {
      setError('Failed to process authorization');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="auth-page">
        <div className="auth-card loading">
          <div className="spinner" />
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>Sign in required</h2>
          <p>Please sign in to authorize this application.</p>
          <a href={`/login?returnTo=${encodeURIComponent(window.location.href)}`}>
            Sign in with Google
          </a>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="auth-page">
        <div className="auth-card error">
          <h2>Authorization Error</h2>
          <p>{error}</p>
          <button onClick={() => window.close()}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="agent-header">
          {agentInfo?.iconUrl ? (
            <img src={agentInfo.iconUrl} alt="" className="agent-icon" />
          ) : (
            <div className="agent-icon default">🤖</div>
          )}
          <h2>{agentInfo?.name || agentClientId}</h2>
          {agentInfo?.description && (
            <p className="agent-description">{agentInfo.description}</p>
          )}
        </div>

        <div className="consent-section">
          <p className="consent-prompt">
            <strong>{agentInfo?.name}</strong> wants to access your account
          </p>

          <div className="permissions-list">
            <h3>This will allow the application to:</h3>
            <ul>
              {scopes.map(scope => {
                const info = SCOPE_DESCRIPTIONS[scope] || {
                  label: scope,
                  description: '',
                  icon: '🔐'
                };
                return (
                  <li key={scope}>
                    <span className="scope-icon">{info.icon}</span>
                    <div className="scope-details">
                      <strong>{info.label}</strong>
                      {info.description && <p>{info.description}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {existingDelegation && (
            <div className="existing-warning">
              <p>You've previously authorized this application.
                 Approving will update the permissions.</p>
            </div>
          )}

          <div className="user-info">
            <p>Signed in as <strong>{user.email}</strong></p>
          </div>
        </div>

        <div className="button-group">
          <button
            className="btn-deny"
            onClick={() => handleDecision(false)}
            disabled={isSubmitting}
          >
            Deny
          </button>
          <button
            className="btn-approve"
            onClick={() => handleDecision(true)}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Authorizing...' : 'Authorize'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

### File: `client/src/components/AgentDelegationList.jsx`

```jsx
/**
 * Agent Delegation List
 *
 * Displays and manages user's authorized AI agents.
 */
import { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';

export default function AgentDelegationList() {
  const [delegations, setDelegations] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchDelegations();
  }, []);

  const fetchDelegations = async () => {
    try {
      const response = await fetch('/mcp/auth/delegations', {
        credentials: 'include',
      });
      const data = await response.json();

      if (data.error) {
        setError(data.error);
      } else {
        setDelegations(data.delegations);
      }
    } catch (err) {
      setError('Failed to load authorized agents');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevoke = async (delegationId, agentName) => {
    if (!confirm(`Revoke access for ${agentName}? This will sign out the agent.`)) {
      return;
    }

    try {
      const response = await fetch(`/mcp/auth/delegations/${delegationId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (response.ok) {
        setDelegations(prev => prev.filter(d => d.id !== delegationId));
      } else {
        const data = await response.json();
        alert(data.error || 'Failed to revoke access');
      }
    } catch (err) {
      alert('Failed to revoke access');
    }
  };

  if (isLoading) {
    return <div className="loading">Loading authorized agents...</div>;
  }

  if (error) {
    return <div className="error">{error}</div>;
  }

  if (delegations.length === 0) {
    return (
      <div className="empty-state">
        <h3>No authorized agents</h3>
        <p>When you authorize AI agents to access your documents, they'll appear here.</p>
      </div>
    );
  }

  return (
    <div className="delegation-list">
      <h3>Authorized AI Agents</h3>
      <p className="subtitle">
        These applications can access your documents on your behalf.
      </p>

      <ul>
        {delegations.map(delegation => (
          <li key={delegation.id} className="delegation-card">
            <div className="delegation-header">
              {delegation.iconUrl ? (
                <img src={delegation.iconUrl} alt="" className="agent-icon" />
              ) : (
                <div className="agent-icon default">🤖</div>
              )}
              <div className="agent-info">
                <strong>{delegation.agentName}</strong>
                {delegation.description && (
                  <p className="description">{delegation.description}</p>
                )}
              </div>
            </div>

            <div className="delegation-details">
              <div className="scopes">
                <span className="label">Permissions:</span>
                <span className="value">{delegation.scopes.join(', ')}</span>
              </div>
              <div className="dates">
                <span>
                  Authorized {formatDistanceToNow(new Date(delegation.createdAt))} ago
                </span>
                {delegation.lastUsedAt && (
                  <span>
                    Last used {formatDistanceToNow(new Date(delegation.lastUsedAt))} ago
                  </span>
                )}
              </div>
            </div>

            <button
              className="btn-revoke"
              onClick={() => handleRevoke(delegation.id, delegation.agentName)}
            >
              Revoke Access
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

## Configuration

### Environment Variables

```bash
# =============================================================================
# MCP Agent Authentication (Production)
# =============================================================================

# JWT secret for agent access tokens (REQUIRED - generate with crypto.randomBytes(32))
MCP_JWT_SECRET=<64-character-hex-string>

# Secret for signing refresh tokens (REQUIRED - different from access token secret)
MCP_REFRESH_SECRET=<64-character-hex-string>

# Secret for signing authorization codes (REQUIRED)
MCP_AUTH_CODE_SECRET=<64-character-hex-string>

# Token expiration settings (optional, shown are defaults)
MCP_ACCESS_TOKEN_EXPIRY=1h
MCP_REFRESH_TOKEN_EXPIRY=30d
MCP_AUTH_CODE_EXPIRY=5m

# Rate limiting (optional)
MCP_RATE_LIMIT_WINDOW_MS=60000
MCP_RATE_LIMIT_MAX_REQUESTS=60
```

### Kubernetes Secret

```yaml
# k8s/mcp-auth-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: mcp-auth-secret
  namespace: collab
type: Opaque
stringData:
  mcp-jwt-secret: "<generate-with-crypto.randomBytes(32).toString('hex')>"
  mcp-refresh-secret: "<generate-with-crypto.randomBytes(32).toString('hex')>"
  mcp-auth-code-secret: "<generate-with-crypto.randomBytes(32).toString('hex')>"
```

### Generate Secrets Script

```bash
#!/bin/bash
# script/generate-mcp-secrets.sh

echo "MCP_JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
echo "MCP_REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
echo "MCP_AUTH_CODE_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
```

---

## Migration Guide

### From Current POC to Production

1. **Run database migration**
   ```bash
   npm run migrate
   ```

2. **Generate and configure secrets**
   ```bash
   ./script/generate-mcp-secrets.sh >> .env
   kubectl create secret generic mcp-auth-secret --from-env-file=.env -n collab
   ```

3. **Update deployment to use secrets**
   ```yaml
   env:
     - name: MCP_JWT_SECRET
       valueFrom:
         secretKeyRef:
           name: mcp-auth-secret
           key: mcp-jwt-secret
   ```

4. **Existing delegations**: The migration preserves existing delegations. They will continue to work but won't have refresh tokens until users re-authorize.

5. **Update MCP client configuration**: Clients need to implement the OAuth flow instead of using static tokens.

---

## Testing Strategy

### Unit Tests

```javascript
// server/mcp/__tests__/auth/oauth-flow.test.js

describe('OAuth Authorization Flow', () => {
  describe('GET /mcp/auth/authorize', () => {
    it('rejects unknown agent_client_id', async () => { ... });
    it('rejects invalid redirect_uri', async () => { ... });
    it('rejects invalid scope', async () => { ... });
    it('rejects missing PKCE code_challenge', async () => { ... });
    it('redirects unauthenticated users to login', async () => { ... });
    it('redirects to consent page with valid params', async () => { ... });
  });

  describe('POST /mcp/auth/approve', () => {
    it('creates delegation and returns auth code', async () => { ... });
    it('handles denial by redirecting with error', async () => { ... });
  });

  describe('POST /mcp/auth/token', () => {
    it('exchanges valid code for tokens', async () => { ... });
    it('rejects invalid PKCE code_verifier', async () => { ... });
    it('rejects expired auth code', async () => { ... });
    it('rejects reused auth code', async () => { ... });
    it('refreshes token with valid refresh_token', async () => { ... });
    it('rotates refresh token on use', async () => { ... });
  });
});
```

### Integration Tests

```javascript
// server/mcp/__tests__/integration/oauth-flow.test.js

describe('Complete OAuth Flow', () => {
  it('completes full authorization flow', async () => {
    // 1. Agent initiates authorization
    // 2. User logs in
    // 3. User approves on consent page
    // 4. Agent exchanges code for tokens
    // 5. Agent uses access token to call MCP tools
    // 6. Agent refreshes expired access token
  });

  it('handles token refresh rotation correctly', async () => { ... });
  it('prevents token reuse after refresh', async () => { ... });
  it('revocation invalidates all tokens', async () => { ... });
});
```

### E2E Tests

```javascript
// e2e/mcp-oauth.spec.js (Playwright)

test('user can authorize and revoke agent', async ({ page }) => {
  // 1. Navigate to authorization URL
  // 2. Log in with Google
  // 3. Verify consent page shows correct info
  // 4. Click Authorize
  // 5. Verify redirect with code
  // 6. Go to settings
  // 7. Verify agent appears in list
  // 8. Click Revoke
  // 9. Verify agent removed
});
```

---

## Rollout Plan

### Phase 1: Backend Implementation (Week 1)
- [ ] Database migration
- [ ] `registered-agents.js` module
- [ ] `pkce.js` utilities
- [ ] `oauth-flow.js` endpoints
- [ ] Update `jwt.js` for refresh tokens
- [ ] Unit tests for all new code

### Phase 2: Frontend Implementation (Week 2)
- [ ] Authorization consent page
- [ ] Agent delegation list component
- [ ] Settings page integration
- [ ] CSS/styling for auth pages
- [ ] Frontend tests

### Phase 3: Integration & Testing (Week 3)
- [ ] Integration tests
- [ ] E2E tests
- [ ] Security review
- [ ] Load testing
- [ ] Documentation updates

### Phase 4: Deployment (Week 4)
- [ ] Generate production secrets
- [ ] Configure Kubernetes secrets
- [ ] Deploy to staging
- [ ] Test with real Claude Code/Desktop
- [ ] Deploy to production
- [ ] Monitor for issues

---

## Future Enhancements (Post-MVP)

1. **Activity log UI**: Show users what agents have done
2. **Per-document scopes**: `documents:read:doc-uuid` for granular access
3. **Agent client secrets**: For confidential server-side agents
4. **Scope consent granularity**: Let users choose which scopes to grant
5. **Expiration selection**: Let users set custom delegation expiry
6. **Notification system**: Alert users when agents perform sensitive actions
7. **Admin panel**: Manage registered agents, view all delegations

---

## References

- [RFC 6749: OAuth 2.0](https://tools.ietf.org/html/rfc6749)
- [RFC 7636: PKCE](https://tools.ietf.org/html/rfc7636)
- [RFC 7009: Token Revocation](https://tools.ietf.org/html/rfc7009)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [OWASP OAuth Security](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html)
