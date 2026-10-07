/**
 * Feature 059 (T012, RBD-059-4): owner resolution against a real, zero-user
 * database (a fresh clone of the migrated template, research R15). Each case
 * resets users and the owner key inside that clone only.
 */
const { createFreshInstanceDb, dropFreshInstanceDb } = require('../../__tests__/helpers/db');
const { resolveOwner, recordOwner, hasOwner, OWNER_KEY } = require('../instance-owner');

describe('instance owner', () => {
  let fresh;
  let db;

  beforeAll(async () => {
    fresh = await createFreshInstanceDb();
    db = fresh.pool;
  });

  afterAll(async () => {
    await dropFreshInstanceDb(fresh);
  });

  beforeEach(async () => {
    // Safe: this is this suite's own private clone, never a shared database.
    await db.query('DELETE FROM app_settings WHERE key = $1', [OWNER_KEY]);
    await db.query('DELETE FROM users');
  });

  const addUser = async (email, isAdmin = false) => {
    const { rows } = await db.query(
      'INSERT INTO users (email, name, is_admin) VALUES ($1, $2, $3) RETURNING *',
      [email, email.split('@')[0], isAdmin]
    );
    return rows[0];
  };

  test('zero users gives no_users', async () => {
    expect(await resolveOwner(db)).toEqual({ user: null, reason: 'no_users' });
    expect(await hasOwner(db)).toBe(false);
  });

  test('the recorded owner wins over a single administrator', async () => {
    const owner = await addUser('owner@example.com', false);
    await addUser('admin@example.com', true);
    await recordOwner(db, owner.id);
    const r = await resolveOwner(db);
    expect(r.via).toBe('record');
    expect(r.user.id).toBe(owner.id);
    expect(await hasOwner(db)).toBe(true);
  });

  test('a recorded id whose user was deleted falls back to the single administrator', async () => {
    const gone = await addUser('gone@example.com', true);
    await recordOwner(db, gone.id);
    await db.query('DELETE FROM users WHERE id = $1', [gone.id]);
    const admin = await addUser('admin@example.com', true);
    const r = await resolveOwner(db);
    expect(r).toMatchObject({ via: 'single_admin' });
    expect(r.user.id).toBe(admin.id);
  });

  test('exactly one administrator resolves with via single_admin', async () => {
    await addUser('member@example.com', false);
    const admin = await addUser('admin@example.com', true);
    const r = await resolveOwner(db);
    expect(r.via).toBe('single_admin');
    expect(r.user.id).toBe(admin.id);
  });

  test('two administrators and no record gives ambiguous_admins', async () => {
    await addUser('a1@example.com', true);
    await addUser('a2@example.com', true);
    expect(await resolveOwner(db)).toEqual({ user: null, reason: 'ambiguous_admins' });
    expect(await hasOwner(db)).toBe(false);
  });

  test('recordOwner overwrites an earlier record', async () => {
    const a = await addUser('a@example.com');
    const b = await addUser('b@example.com');
    await recordOwner(db, a.id);
    await recordOwner(db, b.id);
    expect((await resolveOwner(db)).user.id).toBe(b.id);
  });
});
