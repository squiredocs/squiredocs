/**
 * Append-only auth-event trail + its retention job (feature 034, contract C3).
 *
 * One row per COMPLETED signup or login. The trail is what powers correlation
 * over time — shared-IP grouping across accounts, and the
 * exhaust-grant-then-respawn relay pattern the 2026-07-25 five-account spray
 * used. The per-account snapshot on `users` is the at-a-glance signal; this is
 * the sequence behind it.
 *
 * Two policies define this module:
 *
 *  1. APPEND-ONLY. There is exactly one write path (`record`, an INSERT) and
 *     exactly one delete path (`purgeOlderThan`, the 180-day retention sweep),
 *     plus the FK cascade when a user is deleted. No update path and no per-row
 *     delete exists anywhere in `server/` — that is the property that makes the
 *     trail evidence rather than mutable state.
 *
 *  2. NEVER BLOCKS AUTH (FR-008 / SC-003). `record` is wholly try/catch-wrapped:
 *     an uninitialized pool, a lost connection, or a constraint violation is
 *     logged and swallowed, returning `false`. It must never throw and never
 *     reject, because it is awaited on the sign-in path.
 */

// Database pool — set by init(), shared with server/auth/users.js.
let pool = null;

// Retention window for the trail. The per-account users.* capture columns are
// explicitly NOT subject to this (FR-010) — they live as long as the account.
const RETENTION_DAYS = 180;

// Daily sweep. FR-010 asks for removal "within roughly a day" of eligibility.
const DEFAULT_INTERVAL_MS = 86_400_000;

// The single interval handle (module-level so startPurgeJob is idempotent).
let purgeTimer = null;

/**
 * Initialize with a database pool. Called from users.init(pool), so every
 * existing init path (app boot and every test that calls users.init) wires the
 * trail with no new call site.
 * @param {import('pg').Pool} dbPool
 */
function init(dbPool) {
  pool = dbPool;
}

/**
 * Coerce to the CHECK-constrained event domain. A bad value becomes the safe
 * default rather than a constraint violation — mirroring how findOrCreateUser
 * guards signup_source today.
 * @param {*} event
 * @returns {'signup'|'login'}
 */
function safeEvent(event) {
  return event === 'signup' ? 'signup' : 'login';
}

/**
 * Coerce to the CHECK-constrained channel domain (design gap G-1's adopted
 * default: this records the channel of THIS event).
 * @param {*} signupSource
 * Feature 059 (RBD-059-6) adds `signin_link`: a sign-in (or owner claim) by a
 * single-use link minted inside the container.
 * @returns {'browser'|'agent_oauth'|'signin_link'}
 */
function safeSignupSource(signupSource) {
  if (signupSource === 'agent_oauth' || signupSource === 'signin_link') return signupSource;
  return 'browser';
}

/**
 * Append one immutable trail row. NEVER throws and never rejects (FR-008).
 *
 * @param {object} entry
 * @param {string} entry.userId - the authenticating user's UUID
 * @param {'signup'|'login'} entry.event
 * @param {'browser'|'agent_oauth'|'signin_link'} [entry.signupSource] - channel of THIS event
 * @param {string|null} [entry.ip] - already validated by authContext()
 * @param {string|null} [entry.userAgent] - already truncated by authContext()
 * @returns {Promise<boolean>} true if the row landed, false if it was swallowed
 */
async function record({ userId, event, signupSource, ip = null, userAgent = null } = {}) {
  try {
    if (!pool) throw new Error('auth-events not initialized (call init(pool))');
    if (!userId) throw new Error('record() requires a userId');
    await pool.query(
      `INSERT INTO auth_events (user_id, event, signup_source, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, safeEvent(event), safeSignupSource(signupSource), ip, userAgent]
    );
    return true;
  } catch (err) {
    // Swallowed deliberately: an abuse-signal row is never worth a failed login.
    console.error('[AuthEvents] failed to record auth event:', err?.message || err);
    return false;
  }
}

/**
 * Delete trail rows older than `days` (FR-010). Touches ONLY auth_events — the
 * per-account users capture columns are exempt from retention.
 *
 * Rejects on a database error; both callers (the boot sweep and the interval)
 * catch and log. This is never on an auth path.
 *
 * @param {number} [days=RETENTION_DAYS]
 * @returns {Promise<number>} rows deleted
 */
async function purgeOlderThan(days = RETENTION_DAYS) {
  if (!pool) throw new Error('auth-events not initialized (call init(pool))');
  const result = await pool.query(
    `DELETE FROM auth_events WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return result.rowCount;
}

/**
 * Start the retention job: one immediate sweep at boot, then a daily tick.
 *
 * The repo has no general-purpose scheduler (server/lifecycle.js is init/drain
 * state only), so this is the smallest mechanism that satisfies FR-010 (RBD-8).
 * The timer is unref()'d so it can never hold the process open during a drain,
 * and the job is idempotent: a second call does not create a second timer.
 * Multiple replicas are harmless — the DELETE is set-based and idempotent.
 *
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=86400000]
 * @param {number} [opts.days=RETENTION_DAYS]
 */
function startPurgeJob({ intervalMs = DEFAULT_INTERVAL_MS, days = RETENTION_DAYS } = {}) {
  const sweep = () => {
    purgeOlderThan(days)
      .then((deleted) => {
        if (deleted > 0) {
          console.log(`[AuthEvents] purged ${deleted} auth event(s) older than ${days} days`);
        }
      })
      .catch((err) => {
        console.error('[AuthEvents] purge failed:', err?.message || err);
      });
  };

  if (purgeTimer) return; // already scheduled — no second timer, no extra sweep

  // Boot sweep, fire-and-forget.
  sweep();

  purgeTimer = setInterval(sweep, intervalMs);
  if (typeof purgeTimer.unref === 'function') purgeTimer.unref();
}

/** Stop the retention job. Safe to call when it was never started. */
function stopPurgeJob() {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}

module.exports = {
  init,
  record,
  purgeOlderThan,
  startPurgeJob,
  stopPurgeJob,
  RETENTION_DAYS,
};
