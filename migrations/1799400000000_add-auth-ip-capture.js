/**
 * Migration: signup/login IP + user-agent capture (feature 034 — abuse signals).
 *
 * Design ground truth: design/authentication-and-sharing.md, section "Abuse
 * signals: signup/login IP + user-agent". On 2026-07-25 a single actor relayed
 * five Google accounts to farm the $10 signup AI-credit grant; the app stored no
 * network or device metadata anywhere, so the spray was only visible through
 * content/timing forensics. This migration adds the two storage shapes that make
 * such a spray cheaply detectable:
 *
 *   1. Four nullable columns on `users` — the at-a-glance admin signal, one row
 *      per account, kept for the life of the account:
 *        - signup_ip / signup_user_agent      : written ONCE at account creation
 *          (findOrCreateUser INSERT column list only), never overwritten.
 *        - last_login_ip / last_login_user_agent : refreshed on every completed
 *          login (updateLastLogin), alongside last_login_at.
 *   2. `auth_events` — the append-only trail (one row per completed signup or
 *      login) that powers correlation over time: shared-IP grouping across
 *      accounts and the exhaust-grant-then-respawn relay pattern.
 *
 * Why the users columns are NULLABLE with no default and no backfill (FR-014):
 * the data simply was not captured before this feature, and fabricating it would
 * be worse than NULL. Pre-existing accounts keep absent signup values forever;
 * their last-login pair fills on the next login. Nullable also keeps the ALTER
 * fast and safe on a live table (no row rewrite).
 *
 * Why there is NO length CHECK on the *_user_agent columns: truncation to 512
 * chars is a single app-side operation in server/auth/auth-context.js (FR-007).
 * A database constraint would turn an out-of-bound value into a thrown error
 * INSIDE the auth path — exactly the outcome FR-008 forbids (capture must never
 * block a sign-in). The bound is asserted by tests, not by a constraint that
 * fails closed onto a broken login.
 *
 * Why `inet` and not `text`: it validates on write, normalizes IPv4/IPv6,
 * accepts the `::ffff:` dual-stack form Express produces, and gives the
 * follow-on detector real address operators (`<<=`, network containment)
 * instead of string prefix matching. The write-side risk this creates (an
 * unparsable value raising inside the auth statement) is closed in JS by
 * net.isIP() in auth-context.js before the value is ever bound.
 *
 * Timestamp 1799400000000 > the current latest migration 1799300000000
 * (add-signup-source-to-users), satisfying node-pg-migrate's checkOrder, and
 * trivially clears the 1795000000000 floor imposed by the retired feature-008
 * phantom pgmigrations row.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    signup_ip: { type: 'inet' },
    signup_user_agent: { type: 'text' },
    last_login_ip: { type: 'inet' },
    last_login_user_agent: { type: 'text' },
  });

  // Append-only trail. Application code only ever INSERTs here; the sole delete
  // paths are the 180-day retention purge and the FK cascade below.
  pgm.createTable('auth_events', {
    id: { type: 'bigserial', primaryKey: true },
    // ON DELETE CASCADE (FR-009): an auth event without its user has no
    // resolvable identity, and account deletion must take its trail with it.
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    event: {
      type: 'text',
      notNull: true,
      check: "event IN ('signup','login')",
    },
    // The auth CHANNEL of THIS event (design gap G-1's adopted default), using
    // the same value domain as users.signup_source. Dev-login records 'browser'.
    signup_source: {
      type: 'text',
      notNull: true,
      default: 'browser',
      check: "signup_source IN ('browser','agent_oauth')",
    },
    ip: { type: 'inet' },
    user_agent: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // FR-010: the 180-day purge is a single indexed DELETE on event time.
  pgm.createIndex('auth_events', ['created_at'], { name: 'auth_events_created_at_idx' });

  // Postgres does NOT auto-index FK columns. Without this, every user delete
  // (029's deleteUserByEmail, admin cleanup, the synthetic wipe) sequentially
  // scans auth_events to cascade.
  pgm.createIndex('auth_events', ['user_id'], { name: 'auth_events_user_id_idx' });

  // RBD-6: the correlation query shape the trail exists to serve — shared-IP
  // grouping across accounts, ordered in time.
  pgm.createIndex('auth_events', ['ip', 'created_at'], { name: 'auth_events_ip_created_at_idx' });
};

/**
 * Rollback migration. Drops the table (its indexes go with it), then the four
 * columns. No data preservation is expected — the capture is re-derivable only
 * from future sign-ins.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('auth_events');
  pgm.dropColumns('users', [
    'signup_ip',
    'signup_user_agent',
    'last_login_ip',
    'last_login_user_agent',
  ]);
};
