/**
 * Login-service orchestration layer (feature 008-mcp-login-bootstrap).
 *
 * Sits above the pending-authorization store and the reused delegation /
 * api-token machinery. It owns:
 *   - handle + user-code generation and SHA-256 hashing (nothing secret at rest),
 *   - agentName validation (D9),
 *   - the login → status → approve/deny → claim state-machine decisions,
 *   - mint-at-delivery (D6) inside the atomic claim transaction,
 *   - lazy GC / auto-revoke of lapsed approvals (FR-021).
 *
 * The credential (an sk_sqd_ token) is minted only at delivery (REST claim or
 * inline), never stored, never logged.
 */
const crypto = require('crypto');

const store = require('./pending-authorizations');
const delegation = require('./delegation');
const apiTokens = require('./api-tokens');
const rateLimit = require('./rate-limit');
const {
  AUTHORIZATION_TTL_SECONDS,
  CLAIM_WINDOW_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  SLOW_DOWN_INCREMENT_SECONDS,
  CREDENTIAL_TTL_DAYS,
  USER_CODE_LENGTH,
  USER_CODE_ALPHABET,
  AGENT_NAME_MAX_LENGTH,
  MAX_PENDING_PER_IP,
  MAX_PENDING_GLOBAL,
  LOGIN_CALLS_PER_MINUTE_PER_IP,
  HANDLE_PREFIX,
} = require('./login-constants');

// Canonical file the shipped claim recipe writes the credential to. Every
// emitted recipe (claim command + nextSteps registration one-liner) pre-fills
// this ONE path so the tool, the REST wrappers, and agents.md never disagree
// (feature 009, FR-011/FR-021; the path the successful live test used).
const CREDENTIAL_FILE_PATH = '~/.squire/credential';

// The two scopes a login-born delegation always carries (never any admin
// capability — Constitution Principle V).
const LOGIN_SCOPES = ['documents:read', 'documents:write'];

let pool = null;

function init(dbPool) {
  pool = dbPool;
  store.init(dbPool);
}

function requirePool() {
  if (!pool) throw new Error('login-service not initialized');
  return pool;
}

// ── generation & hashing ────────────────────────────────────────────────────

/** High-entropy session handle: sqlh_ + 256 bits base64url. Returned once. */
function generateHandle() {
  return HANDLE_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest — the only form of the handle ever persisted/queried. */
function hashHandle(handle) {
  return crypto.createHash('sha256').update(String(handle)).digest('hex');
}

/**
 * Generate an 8-char user code from the RFC 8628 consonant alphabet using
 * rejection sampling (no modulo bias). Returns both the normalized bare code
 * and the grouped XXXX-XXXX display form.
 */
function generateUserCode() {
  const alphabet = USER_CODE_ALPHABET;
  const n = alphabet.length; // 20
  // Largest multiple of n that fits in a byte — reject bytes at/above it.
  const limit = Math.floor(256 / n) * n;
  let code = '';
  while (code.length < USER_CODE_LENGTH) {
    const [byte] = crypto.randomBytes(1);
    if (byte >= limit) continue; // reject to avoid bias
    code += alphabet[byte % n];
  }
  const display = `${code.slice(0, 4)}-${code.slice(4)}`;
  return { code, display };
}

/** Normalize a submitted code: uppercase, strip hyphens/whitespace. */
function normalizeCode(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[-\s]/g, '');
}

/** SHA-256 hex digest of a normalized code. */
function hashCode(normalized) {
  return crypto.createHash('sha256').update(String(normalized)).digest('hex');
}

/**
 * Constant-time comparison of two hex digests (defense in depth for the rare
 * paths that compare rather than index-lookup). Length mismatch ⇒ false without
 * leaking via timing on the compare itself.
 */
function timingSafeEqualHex(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Validate a self-declared agentName (D9): required, non-empty after trim,
 * ≤ 100 chars, no control characters. Returns the trimmed name or throws the
 * standard tool-parameter error shape (matches the registry's validation errors).
 */
function validateAgentName(agentName) {
  const label = "Invalid parameters for tool 'login':";
  if (typeof agentName !== 'string') {
    throw new Error(`${label} 'agentName' must be a string.`);
  }
  const trimmed = agentName.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} 'agentName' must not be empty.`);
  }
  if (trimmed.length > AGENT_NAME_MAX_LENGTH) {
    throw new Error(`${label} 'agentName' must be ${AGENT_NAME_MAX_LENGTH} characters or fewer.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error(`${label} 'agentName' must not contain control characters.`);
  }
  return trimmed;
}

// ── result builders ─────────────────────────────────────────────────────────

function expiredResult() {
  return { status: 'expired', message: 'Expired or unknown. Call login to start over.' };
}

function rateLimitedResult() {
  return {
    status: 'rate_limited',
    retryable: true,
    message: 'Too many login attempts. Wait a minute and try again.',
  };
}

function secondsUntil(ts) {
  return Math.max(0, Math.ceil((new Date(ts).getTime() - Date.now()) / 1000));
}

function buildClaimCommand(baseUrl, handle) {
  return (
    `umask 077 && curl -fsS -H "Authorization: Bearer ${handle}" `
    + `"${baseUrl}/api/login/claim" -o ${CREDENTIAL_FILE_PATH} && chmod 600 ${CREDENTIAL_FILE_PATH}`
  );
}

/**
 * The ONLY place the per-IP login rate-limit key string + budget constant live
 * (feature 009, RD-8). Both the `login` MCP tool and `POST /api/login/start`
 * call this, so the two doors share one budget — a login start over REST spends
 * the same `login:ip:<ip>` bucket as one over MCP, never a fresh 10. Returns the
 * rate-limiter's discriminated result unchanged: { allowed, retryAfterSeconds }.
 */
async function checkLoginRateLimit(ip) {
  return rateLimit.consume(`login:ip:${ip}`, LOGIN_CALLS_PER_MINUTE_PER_IP, 60);
}

/**
 * Pure builder for the `nextSteps` block attached to every approved/inline
 * delivery (feature 009, FR-011/FR-013). Carries NO credential material — it
 * references the claimed token only through `$(cat <file>)`, with the canonical
 * credential file path pre-filled. Teaches the credentialed MCP registration
 * one-liner (the `--header` form ONLY — the bare form never appears) plus the
 * top three runnable REST recipes. Kept to three recipes so the approved payload
 * still renders in MCP clients (~2 KB rule of thumb), not a full reference.
 */
function buildNextSteps(baseUrl, credentialFilePath = CREDENTIAL_FILE_PATH) {
  const cred = `$(cat ${credentialFilePath})`;
  return {
    registerMcp:
      `claude mcp add --transport http squire ${baseUrl}/mcp `
      + `--header "Authorization: Bearer ${cred}"`,
    restRecipes: [
      {
        what: 'List your documents',
        command: `curl -fsS -H "Authorization: Bearer ${cred}" "${baseUrl}/api/docs"`,
      },
      {
        what: 'Create a document from a markdown file',
        command:
          `curl -fsS -X POST -H "Authorization: Bearer ${cred}" `
          + `-H "Content-Type: text/markdown" --data-binary @doc.md "${baseUrl}/api/docs/import"`,
      },
      {
        what: 'Export a document as markdown',
        command:
          `curl -fsS -H "Authorization: Bearer ${cred}" `
          + `"${baseUrl}/api/docs/<docId>/export?format=markdown" -o doc.md`,
      },
    ],
    note:
      'Credential file path follows wherever you wrote it in the claim step '
      + `(default ${credentialFilePath}).`,
  };
}

// ── GC / auto-revoke ────────────────────────────────────────────────────────

/**
 * Flip lapsed approved rows to expired and revoke each delegation (FR-021).
 * revokeDelegation cascades to any minted token. Returns the count swept.
 */
async function sweepLapsedApproved() {
  const lapsed = await store.expireLapsedApproved();
  for (const row of lapsed) {
    if (row.delegation_id) {
      await delegation.revokeDelegation(row.delegation_id);
    }
  }
  return lapsed.length;
}

/** Opportunistic GC on each login: revoke lapsed approvals, expire stale
 *  pendings, delete terminal residue older than 24h. No background job. */
async function runGcSweep() {
  await sweepLapsedApproved();
  await store.expireLapsedPending();
  await store.deleteTerminalOlderThan(24);
}

// ── login: create a pending authorization ───────────────────────────────────

/**
 * Create a pending authorization. Runs the lazy GC sweep, then the per-IP and
 * global caps (after GC so the counts are fresh), then inserts. Returns a
 * discriminated result: a uniform rate_limited on any cap breach, else the
 * pending_authorization payload (handle returned once, only its hash stored).
 * Assumes agentName is already validated.
 */
async function createPendingAuthorization({ agentName, ip, baseUrl }) {
  await runGcSweep();

  if ((await store.countPendingByIp(ip)) >= MAX_PENDING_PER_IP) {
    return rateLimitedResult();
  }
  if ((await store.countPendingGlobal()) >= MAX_PENDING_GLOBAL) {
    return rateLimitedResult();
  }

  const handle = generateHandle();
  const handleHash = hashHandle(handle);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_TTL_SECONDS * 1000);

  const { userCode } = await store.create({
    agentName,
    handleHash,
    originIp: ip,
    expiresAt,
    generateCode: () => {
      const { code, display } = generateUserCode();
      return { userCode: display, userCodeHash: hashCode(code) };
    },
  });

  const verificationUri = `${baseUrl}/activate`;
  return {
    status: 'pending_authorization',
    handle,
    userCode,
    verificationUri,
    expiresInSeconds: AUTHORIZATION_TTL_SECONDS,
    pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS,
    instructions:
      `Tell your user: open ${verificationUri} and enter code ${userCode}. `
      + 'Print the URL bare on its own line. Then poll '
      + `login_status({ handle }) every ${MIN_POLL_INTERVAL_SECONDS} seconds until approved. `
      + 'Never move the credential through this conversation.',
  };
}

// ── login_status: the polling / delivery decision table ─────────────────────

/**
 * Resolve login_status for a handle. Implements the full decision table from
 * contracts/login-tools.md: slow_down, pending, denied, uniform expired, the
 * one-shot approved payload (claim recipe, no credential), and the inline
 * one-time credential delivery.
 */
async function getStatus(handle, { inline = false, baseUrl = '' } = {}) {
  const handleHash = hashHandle(handle);
  const row = await store.findByHandleHash(handleHash);
  if (!row) return expiredResult();

  // Poll discipline (D8): a premature poll is throttled with slow_down and
  // permanently raises this handle's required interval — and it does NOT consume
  // the one-shot approved payload.
  const poll = await store.recordPoll(handleHash, SLOW_DOWN_INCREMENT_SECONDS);
  if (poll && poll.premature) {
    return {
      status: 'slow_down',
      pollIntervalSeconds: poll.requiredInterval,
      message: `Polling too fast. Wait at least ${poll.requiredInterval} seconds between polls.`,
    };
  }
  const currentInterval = poll ? poll.requiredInterval : MIN_POLL_INTERVAL_SECONDS;

  switch (row.state) {
    case 'denied':
      return {
        status: 'denied',
        message: 'The user denied this request. Terminal — call login again to retry.',
      };

    case 'pending':
      if (new Date(row.expires_at).getTime() <= Date.now()) return expiredResult();
      return {
        status: 'pending',
        expiresInSeconds: secondsUntil(row.expires_at),
        pollIntervalSeconds: currentInterval,
      };

    case 'approved': {
      if (new Date(row.claim_expires_at).getTime() <= Date.now()) {
        await sweepLapsedApproved();
        return expiredResult();
      }

      if (inline) {
        // Inline is a claim through the polling channel: it succeeds on an
        // approved, unclaimed authorization within the window even if the recipe
        // payload was already delivered (D12 shell-less recovery).
        const claimed = await claimCredential(handle, 'inline');
        if (!claimed.ok) {
          if (claimed.error === 'token_limit') {
            return {
              status: 'token_limit',
              message:
                'This account has reached its API-token limit. Revoke a token in '
                + 'Settings → API Tokens, then retry — the approval stays valid until its window expires.',
            };
          }
          return expiredResult();
        }
        return {
          status: 'approved',
          warning:
            'DO NOT ECHO: the credential below is a secret. Never print, echo, paste, or log it. '
            + 'Write it directly into your MCP client configuration, then reconnect.',
          credential: claimed.token,
          expiresInDays: CREDENTIAL_TTL_DAYS,
          nextSteps: buildNextSteps(baseUrl),
        };
      }

      // Default channel: deliver the one-shot approved payload exactly once.
      const delivered = await store.markPayloadDelivered(handleHash);
      if (!delivered) return expiredResult();
      return {
        status: 'approved',
        claimCommand: buildClaimCommand(baseUrl, handle),
        claimExpiresInSeconds: secondsUntil(delivered.claim_expires_at),
        nextSteps: buildNextSteps(baseUrl),
        instructions: [
          'Run the claim command within 5 minutes; it writes the credential to a file with '
            + 'owner-only (0600) permissions.',
          'Write the credential into your MCP client config or an env file, then reconnect — '
            + 'no mid-session toolset upgrade happens; persist and reconnect is the contract.',
          'NEVER print, echo, or paste the credential anywhere. The handle in this transcript is '
            + 'acceptable residue: short-lived, one-shot, dead after the claim.',
        ],
      };
    }

    case 'expired':
    case 'claimed':
    default:
      return expiredResult();
  }
}

// ── code entry & consent decision ───────────────────────────────────────────

/**
 * Consume a user code on behalf of the signed-in user (consent page step 2).
 * Returns { ok: true, authorizationId, agentName, scopes, expiresAt } or
 * { ok: false } — the caller renders a uniform invalid-or-expired for the false
 * case across every cause (FR-015).
 */
async function enterCode(code, userId) {
  const normalized = normalizeCode(code);
  if (normalized.length === 0) return { ok: false };
  const row = await store.consumeCode(hashCode(normalized), userId);
  if (!row) return { ok: false };
  return {
    ok: true,
    authorizationId: row.id,
    agentName: row.agent_name,
    scopes: LOGIN_SCOPES,
    expiresAt: row.expires_at,
  };
}

/**
 * Approve a consent request (single pg transaction). D7 token-cap pre-check
 * first; then createDelegation + the atomic approve on one client so a
 * TTL-lapsed approve creates nothing. Returns a discriminated status:
 *   'approved' | 'token_limit' | 'expired' (TTL lapsed) | 'invalid' (unknown row
 *   or not the code-enterer).
 */
async function approveAuthorization(authorizationId, userId) {
  // Ownership + existence pre-check (uniform 'invalid' for both, FR).
  const existing = await store.findById(authorizationId);
  if (!existing || existing.entered_by_user_id !== userId) {
    return { status: 'invalid' };
  }

  // D7: fail at the consent page if the user is already at the token cap.
  if ((await apiTokens.countActiveTokens(userId)) >= apiTokens.MAX_TOKENS_PER_USER) {
    return { status: 'token_limit' };
  }

  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    const delegationRecord = await delegation.createDelegation(
      userId,
      `mcp-login:${authorizationId}`,
      existing.agent_name,
      { scopes: LOGIN_SCOPES, client }
    );
    const approved = await store.approve(
      client,
      authorizationId,
      userId,
      delegationRecord.id,
      CLAIM_WINDOW_SECONDS
    );
    if (!approved) {
      await client.query('ROLLBACK');
      return { status: 'expired' };
    }
    await client.query('COMMIT');
    return { status: 'approved', delegationId: delegationRecord.id };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deny a consent request. Ownership-checked; a uniform 'invalid' for unknown,
 * non-owned, or non-pending rows.
 */
async function denyAuthorization(authorizationId, userId) {
  const existing = await store.findById(authorizationId);
  if (!existing || existing.entered_by_user_id !== userId) {
    return { status: 'invalid' };
  }
  const denied = await store.deny(authorizationId);
  if (!denied) return { status: 'invalid' };
  return { status: 'denied' };
}

// ── claim: mint at delivery ─────────────────────────────────────────────────

/**
 * Atomically claim the credential for a handle and mint the sk_sqd_ token in
 * the SAME transaction (D6). Exactly one concurrent claim wins; losers and every
 * non-claimable cause get the uniform failure. On a token-cap mint failure the
 * transaction rolls back (row stays approved, retriable within the window —
 * FR-022) and the distinct token_limit is surfaced. A lapsed approval is
 * lazily revoked before returning the uniform failure (FR-021).
 *
 * @returns {Promise<{ok:true, token}|{ok:false, error:'invalid_or_expired'|'token_limit'|'mint_failed'}>}
 */
async function claimCredential(handle, channel = 'rest') {
  const handleHash = hashHandle(handle);
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    const row = await store.claim(client, handleHash, channel);
    if (!row) {
      await client.query('ROLLBACK');
      // Miss may be a lapsed approval — revoke it so Settings shows no zombie.
      await sweepLapsedApproved();
      return { ok: false, error: 'invalid_or_expired' };
    }

    // A user who revoked in Settings between approve and claim gets no token.
    const check = await delegation.checkDelegation(row.delegation_id, null);
    if (!check.isValid) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'invalid_or_expired' };
    }

    const tokenName = `${row.agent_name} (via MCP login)`.slice(0, 255);
    let minted;
    try {
      minted = await apiTokens.createToken(row.approved_by_user_id, tokenName, {
        scopes: check.delegation.scopes,
        expiresAt: new Date(Date.now() + CREDENTIAL_TTL_DAYS * 24 * 60 * 60 * 1000),
        mintedByDelegationId: row.delegation_id,
        client,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (/Maximum of/.test(err.message)) {
        return { ok: false, error: 'token_limit' };
      }
      console.error('[login] credential mint failed during claim:', err.message);
      return { ok: false, error: 'mint_failed' };
    }

    await client.query('COMMIT');
    return { ok: true, token: minted.token };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  init,
  LOGIN_SCOPES,
  // generation & hashing
  generateHandle,
  hashHandle,
  generateUserCode,
  normalizeCode,
  hashCode,
  timingSafeEqualHex,
  validateAgentName,
  // shared gates & recipe builders (feature 009 — one key, one payload family)
  checkLoginRateLimit,
  buildNextSteps,
  buildClaimCommand,
  CREDENTIAL_FILE_PATH,
  // flow
  createPendingAuthorization,
  getStatus,
  enterCode,
  approveAuthorization,
  denyAuthorization,
  claimCredential,
  // GC (exposed for the claim router's lapse handling and tests)
  sweepLapsedApproved,
  runGcSweep,
};
