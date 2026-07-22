/**
 * Migration: Add a per-user signup_source provenance column (feature 029,
 * FR-012, RBD-6/RBD-7).
 *
 * Records how an account was born so agent-first cohorts are separable from
 * browser signups from day one — data that is cheap now and impossible to
 * backfill later (D5). Values:
 *   - 'browser'     : default; browser sign-in (and ALL pre-existing rows).
 *   - 'agent_oauth' : account created mid consent returnTo round-trip
 *                     (a valid same-origin returnTo present at creation time).
 *
 * Stamped ONCE at creation, never overwritten on later login (findOrCreateUser
 * writes it only in the INSERT column list, never in ON CONFLICT DO UPDATE).
 *
 * Timestamp 1799300000000 > the current latest migration 1799200000000
 * (drop-yjs-state-vectors), satisfying node-pg-migrate checkOrder and trivially
 * clearing the stale >1795000000000 floor (RBD-7).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    signup_source: {
      type: 'text',
      notNull: true,
      default: 'browser',
      check: "signup_source IN ('browser', 'agent_oauth')",
    },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('users', ['signup_source']);
};
