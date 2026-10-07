/**
 * Migration: user identities and sign-in links (feature 059, design
 * self-hosting-local-mode.md D3/D5, data-model.md).
 *
 * TIMESTAMP: 1799830000000 is greater than every file in migrations/ (the
 * latest before this one is 1799820000000_create-document-access-view) and
 * than the retired phantom 1794000000000 that script/migrate.js deletes from
 * pgmigrations, so node-pg-migrate's checkOrder accepts it. Later migrations
 * in the self-host campaign must use a timestamp above this one.
 *
 * One migration, one transaction (node-pg-migrate's default):
 *
 *   1. `user_identities`: one row per (issuer, subject) a person signs in
 *      with. Sign-in resolves users through this table only (FR-003).
 *   2. `signin_links`: single-use, 15-minute links minted inside the
 *      container. Only the SHA-256 hash of the token is stored (FR-026).
 *   3. Backfill (FR-002, RBD-059-16): one identity per user with a google_id.
 *      Faucet rows (`dev-test-%`) get issuer `dev` so the faucet keeps finding
 *      them; everything else is a Google subject. The users table is not
 *      modified by the backfill.
 *   4. `users.google_id` DROP NOT NULL. The UNIQUE constraint and
 *      idx_users_google_id stay; new rows never write it (RBD-059-2).
 *   5. Both `signup_source` CHECKs (users, auth_events) widen to accept
 *      `signin_link` (RBD-059-6). The originals were auto-named by inline
 *      `check:` options, so they are found through pg_constraint.
 *   6. Compatibility trigger `users_google_id_identity` (RBD-059-24): a users
 *      row inserted WITH a google_id (a pre-059 pod during the rolling
 *      deploy, a test fixture, a dev script) gets the matching identity, so
 *      its next sign-in on a 059 pod is a returning identity rather than an
 *      `account_exists` refusal. Inert for 059's own writes (google_id NULL).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */

const GOOGLE_ISSUER = 'https://accounts.google.com';

// Exported so the migration test runs the exact statement against seeded
// legacy rows (research R11). Idempotent: ON CONFLICT DO NOTHING.
const BACKFILL_SQL = `
  INSERT INTO user_identities (user_id, issuer, subject, created_at)
  SELECT id,
         CASE WHEN google_id LIKE 'dev-test-%' THEN 'dev' ELSE '${GOOGLE_ISSUER}' END,
         google_id,
         created_at
    FROM users
   WHERE google_id IS NOT NULL
  ON CONFLICT (issuer, subject) DO NOTHING
`;

// Replace the auto-named signup_source CHECK on `table` with `newCheck`.
function replaceSignupSourceCheckSql(table, newCheck) {
  return `
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE rel.relname = '${table}'
       AND nsp.nspname = current_schema()
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%signup_source%'
  LOOP
    EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE ${table} ADD CONSTRAINT ${table}_signup_source_check CHECK (${newCheck});
`;
}

exports.BACKFILL_SQL = BACKFILL_SQL;

exports.up = (pgm) => {
  pgm.createTable('user_identities', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    issuer: { type: 'text', notNull: true },
    subject: { type: 'text', notNull: true },
    email_verified: { type: 'boolean' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_used_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('user_identities', 'user_identities_issuer_subject_key', 'UNIQUE (issuer, subject)');
  pgm.addConstraint('user_identities', 'user_identities_issuer_length_check', 'CHECK (length(issuer) BETWEEN 1 AND 512)');
  pgm.addConstraint('user_identities', 'user_identities_subject_length_check', 'CHECK (length(subject) BETWEEN 1 AND 255)');
  // Postgres does not index FK columns; every user delete cascades here.
  pgm.createIndex('user_identities', ['user_id'], { name: 'user_identities_user_id_idx' });

  pgm.createTable('signin_links', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    token_hash: { type: 'text', notNull: true, unique: true },
    kind: { type: 'text', notNull: true, check: "kind IN ('claim', 'signin')" },
    user_id: { type: 'uuid', references: 'users', onDelete: 'CASCADE' },
    prefill_name: { type: 'text' },
    prefill_email: { type: 'text' },
    source: { type: 'text', notNull: true, check: "source IN ('cli', 'startup')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
  });
  pgm.addConstraint(
    'signin_links',
    'signin_links_kind_user_check',
    "CHECK ((kind = 'claim' AND user_id IS NULL) OR (kind = 'signin' AND user_id IS NOT NULL))"
  );
  pgm.addConstraint(
    'signin_links',
    'signin_links_prefill_check',
    "CHECK (kind = 'claim' OR (prefill_name IS NULL AND prefill_email IS NULL))"
  );
  pgm.createIndex('signin_links', ['expires_at'], { name: 'signin_links_expires_at_idx' });
  pgm.createIndex('signin_links', ['user_id'], { name: 'signin_links_user_id_idx' });

  pgm.sql(BACKFILL_SQL);

  pgm.sql('ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL');

  pgm.sql(replaceSignupSourceCheckSql('users', "signup_source IN ('browser', 'agent_oauth', 'signin_link')"));
  pgm.sql(replaceSignupSourceCheckSql('auth_events', "signup_source IN ('browser', 'agent_oauth', 'signin_link')"));

  pgm.sql(`
CREATE FUNCTION users_google_id_identity() RETURNS trigger AS $$
BEGIN
  INSERT INTO user_identities (user_id, issuer, subject, created_at)
  VALUES (
    NEW.id,
    CASE WHEN NEW.google_id LIKE 'dev-test-%' THEN 'dev' ELSE '${GOOGLE_ISSUER}' END,
    NEW.google_id,
    NEW.created_at
  )
  ON CONFLICT (issuer, subject) DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_google_id_identity
  AFTER INSERT ON users
  FOR EACH ROW
  WHEN (NEW.google_id IS NOT NULL)
  EXECUTE FUNCTION users_google_id_identity();
`);
};

/**
 * Rollback. Fails loudly (SET NOT NULL) if any user has no google_id: such a
 * user cannot be represented in the pre-059 schema.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS users_google_id_identity ON users');
  pgm.sql('DROP FUNCTION IF EXISTS users_google_id_identity()');

  pgm.sql("UPDATE users SET signup_source = 'browser' WHERE signup_source = 'signin_link'");
  pgm.sql("UPDATE auth_events SET signup_source = 'browser' WHERE signup_source = 'signin_link'");
  pgm.sql(replaceSignupSourceCheckSql('users', "signup_source IN ('browser', 'agent_oauth')"));
  pgm.sql(replaceSignupSourceCheckSql('auth_events', "signup_source IN ('browser','agent_oauth')"));

  pgm.sql('ALTER TABLE users ALTER COLUMN google_id SET NOT NULL');

  pgm.dropTable('signin_links');
  pgm.dropTable('user_identities');
};
