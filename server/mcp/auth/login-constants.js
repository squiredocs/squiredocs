/**
 * Operational constants for the MCP login bootstrap (feature 008).
 *
 * Every tunable number the login flow depends on lives here as a named
 * constant (ledger D4/D10): durations, code shape, caps, and rate limits.
 * They are contracts-by-value, not by-spec — changing one here changes the
 * behavior without a spec edit. Imported by the store, service, tools, and
 * routers, and re-exported for tests.
 *
 * MAX_PENDING_GLOBAL honors an env override (LOGIN_MAX_PENDING_GLOBAL) so the
 * global-cap test can exercise the ceiling without inserting ~500 rows
 * (analyze C2). The override is read at module load; production leaves it
 * unset and gets 500.
 */

// Authorization lifetime: 10 minutes from creation to the human decision (D4).
const AUTHORIZATION_TTL_SECONDS = 600;

// Approved-to-claim window: 5 minutes to move the credential over the byte
// channel (or inline) before the approval lapses and its delegation is revoked.
const CLAIM_WINDOW_SECONDS = 300;

// Polling discipline (D8): 5s minimum interval, +5s per premature poll.
const MIN_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;

// Minted credential lifetime (design-fixed).
const CREDENTIAL_TTL_DAYS = 30;

// User code: 8 chars from the RFC 8628 §6.1 consonant alphabet (no vowels, no
// ambiguous glyphs, no accidental words). Displayed grouped XXXX-XXXX.
const USER_CODE_LENGTH = 8;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

// Self-declared agent display name (D9).
const AGENT_NAME_MAX_LENGTH = 100;

// Outstanding pending-authorization caps (D10). Global cap is env-overridable
// for tests (analyze C2).
const MAX_PENDING_PER_IP = 5;
const MAX_PENDING_GLOBAL = (() => {
  const raw = process.env.LOGIN_MAX_PENDING_GLOBAL;
  if (raw !== undefined && raw !== '') {
    const parsed = parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 500;
})();

// Rate limits (D10).
const LOGIN_CALLS_PER_MINUTE_PER_IP = 10;
const CODE_ATTEMPTS_PER_MINUTE_PER_USER = 5;
const CODE_ATTEMPTS_PER_HOUR_PER_IP = 20;
const CLAIM_ATTEMPTS_PER_MINUTE_PER_IP = 10;

// Handle prefix — recognizable in transcripts, distinct from sk_sqd_ tokens.
const HANDLE_PREFIX = 'sqlh_';

module.exports = {
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
  CODE_ATTEMPTS_PER_MINUTE_PER_USER,
  CODE_ATTEMPTS_PER_HOUR_PER_IP,
  CLAIM_ATTEMPTS_PER_MINUTE_PER_IP,
  HANDLE_PREFIX,
};
