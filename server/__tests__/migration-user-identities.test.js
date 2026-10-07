/**
 * Feature 059 (T005, FR-001, FR-002, FR-014, SC-005): the identity migration.
 *
 *   (a) the post-migration schema, read from information_schema/pg_constraint;
 *   (b) the exported BACKFILL_SQL over seeded legacy rows: one identity per
 *       google_id with the right issuer, users rows byte-identical, idempotent;
 *   (c) the compatibility trigger (RBD-059-24).
 *
 * Rows are this suite's own (unique email suffix) and are deleted by id.
 */
const crypto = require('crypto');
const { createPool } = require('./helpers/db');
const { BACKFILL_SQL } = require('../../migrations/1799830000000_add-user-identities-and-signin-links');

const SUFFIX = '@migration-identities.test.example.com';

describe('migration 1799830000000 user identities and sign-in links', () => {
  let pool;
  const created = [];

  beforeAll(() => {
    pool = createPool();
  });

  afterAll(async () => {
    if (created.length) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [created]);
    await pool.end();
  });

  const insertLegacy = async (googleId) => {
    const { rows } = await pool.query(
      'INSERT INTO users (google_id, email, name) VALUES ($1, $2, $3) RETURNING *',
      [googleId, `${crypto.randomUUID()}${SUFFIX}`, 'Legacy']
    );
    created.push(rows[0].id);
    return rows[0];
  };

  const identitiesOf = async (userId) =>
    (await pool.query('SELECT * FROM user_identities WHERE user_id = $1', [userId])).rows;

  describe('(a) schema', () => {
    test('users.google_id is nullable and still unique', async () => {
      const { rows } = await pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'google_id'`
      );
      expect(rows[0].is_nullable).toBe('YES');
      const gid = `dup-${crypto.randomUUID()}`;
      await insertLegacy(gid);
      await expect(insertLegacy(gid)).rejects.toThrow(/users_google_id_key/);
    });

    test('(issuer, subject) is unique', async () => {
      const u = await insertLegacy(null);
      const subject = `s-${crypto.randomUUID()}`;
      await pool.query("INSERT INTO user_identities (user_id, issuer, subject) VALUES ($1, 'x', $2)", [u.id, subject]);
      await expect(
        pool.query("INSERT INTO user_identities (user_id, issuer, subject) VALUES ($1, 'x', $2)", [u.id, subject])
      ).rejects.toThrow(/user_identities_issuer_subject_key/);
    });

    test('identities and links cascade with their user', async () => {
      const { rows } = await pool.query(
        `SELECT con.conrelid::regclass::text AS tbl, con.confdeltype
           FROM pg_constraint con
          WHERE con.contype = 'f' AND con.confrelid = 'users'::regclass
            AND con.conrelid IN ('user_identities'::regclass, 'signin_links'::regclass)`
      );
      expect(rows.map((r) => [r.tbl, r.confdeltype]).sort()).toEqual([
        ['signin_links', 'c'],
        ['user_identities', 'c'],
      ]);
    });

    test.each(['users', 'auth_events'])('%s.signup_source accepts signin_link and rejects nonsense', async (table) => {
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%signup_source%'`,
        [table]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].def).toMatch(/'signin_link'/);
      const u = await insertLegacy(null);
      if (table === 'users') {
        await pool.query("UPDATE users SET signup_source = 'signin_link' WHERE id = $1", [u.id]);
        await expect(
          pool.query("UPDATE users SET signup_source = 'nonsense' WHERE id = $1", [u.id])
        ).rejects.toThrow(/check constraint/);
      } else {
        await pool.query("INSERT INTO auth_events (user_id, event, signup_source) VALUES ($1, 'login', 'signin_link')", [u.id]);
        await expect(
          pool.query("INSERT INTO auth_events (user_id, event, signup_source) VALUES ($1, 'login', 'nonsense')", [u.id])
        ).rejects.toThrow(/check constraint/);
      }
    });

    test('signin_links: claim has no user, signin has one; prefill is claim-only', async () => {
      const u = await insertLegacy(null);
      const ins = (kind, userId, prefill = null) =>
        pool.query(
          `INSERT INTO signin_links (token_hash, kind, user_id, prefill_name, source, expires_at)
           VALUES ($1, $2, $3, $4, 'cli', now() + interval '15 minutes')`,
          [crypto.randomBytes(32).toString('hex'), kind, userId, prefill]
        );
      await expect(ins('claim', u.id)).rejects.toThrow(/signin_links_kind_user_check/);
      await expect(ins('signin', null)).rejects.toThrow(/signin_links_kind_user_check/);
      await expect(ins('signin', u.id, 'Name')).rejects.toThrow(/signin_links_prefill_check/);
      await ins('signin', u.id);
      await pool.query('DELETE FROM signin_links WHERE user_id = $1', [u.id]);
    });
  });

  describe('(b) backfill', () => {
    test('one Google identity, one dev identity, none for NULL; users untouched; idempotent', async () => {
      const g = await insertLegacy(`${Date.now()}${Math.floor(Math.random() * 1e6)}`);
      const d = await insertLegacy(`dev-test-${crypto.randomUUID().slice(0, 8)}`);
      const n = await insertLegacy(null);
      // Make the rows look pre-059: drop what the compatibility trigger created.
      await pool.query('DELETE FROM user_identities WHERE user_id = ANY($1::uuid[])', [[g.id, d.id, n.id]]);

      const snapshot = async () =>
        (await pool.query('SELECT * FROM users WHERE id = ANY($1::uuid[]) ORDER BY id', [[g.id, d.id, n.id]])).rows;
      const before = await snapshot();

      await pool.query(BACKFILL_SQL);

      const gi = await identitiesOf(g.id);
      expect(gi).toHaveLength(1);
      expect(gi[0]).toMatchObject({ issuer: 'https://accounts.google.com', subject: g.google_id, email_verified: null });
      expect(gi[0].created_at.getTime()).toBe(g.created_at.getTime());
      const di = await identitiesOf(d.id);
      expect(di).toHaveLength(1);
      expect(di[0]).toMatchObject({ issuer: 'dev', subject: d.google_id, email_verified: null });
      expect(await identitiesOf(n.id)).toHaveLength(0);

      expect(await snapshot()).toEqual(before);

      // A second run inserts nothing.
      const again = await pool.query(BACKFILL_SQL);
      expect(again.rowCount).toBe(0);
    });
  });

  describe('(c) compatibility trigger', () => {
    test('a row inserted the old way gets exactly one identity with the right issuer', async () => {
      const g = await insertLegacy(`trig-${crypto.randomUUID()}`);
      expect((await identitiesOf(g.id)).map((i) => [i.issuer, i.subject])).toEqual([
        ['https://accounts.google.com', g.google_id],
      ]);
      const d = await insertLegacy(`dev-test-${crypto.randomUUID().slice(0, 8)}`);
      expect((await identitiesOf(d.id)).map((i) => i.issuer)).toEqual(['dev']);
    });

    test('a row inserted with google_id NULL gets none', async () => {
      const n = await insertLegacy(null);
      expect(await identitiesOf(n.id)).toHaveLength(0);
    });
  });
});
