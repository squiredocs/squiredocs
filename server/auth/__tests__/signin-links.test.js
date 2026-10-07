/**
 * Feature 059 (T034, FR-026 to FR-031, FR-045, SC-004): the sign-in link
 * store against a real database. Claiming is defined by an empty users table,
 * so this suite runs on a fresh clone of the migrated template (research R15)
 * and resets users and links inside that clone only.
 */
const crypto = require('crypto');
const { createFreshInstanceDb, dropFreshInstanceDb } = require('../../__tests__/helpers/db');
const users = require('../users');
const links = require('../signin-links');
const { resolveOwner, OWNER_KEY } = require('../instance-owner');

describe('sign-in links', () => {
  let fresh;
  let db;

  beforeAll(async () => {
    fresh = await createFreshInstanceDb();
    db = fresh.pool;
    users.init(db);
  });

  afterAll(async () => {
    await dropFreshInstanceDb(fresh);
  });

  beforeEach(async () => {
    // This suite's private clone: safe to reset.
    await db.query('DELETE FROM signin_links');
    await db.query('DELETE FROM app_settings WHERE key = $1', [OWNER_KEY]);
    await db.query('DELETE FROM users');
  });

  const rowFor = async (token) =>
    (await db.query('SELECT * FROM signin_links WHERE token_hash = $1', [links.hashToken(token)])).rows[0];
  const addUser = async (email = `u-${crypto.randomUUID()}@example.com`, isAdmin = false) =>
    (await db.query('INSERT INTO users (email, name, is_admin) VALUES ($1, $2, $3) RETURNING *', [email, 'User', isAdmin])).rows[0];
  const claimFields = { name: 'Sam', email: 'sam@example.com' };

  test('the stored row holds only the hash; the token appears in no column', async () => {
    const { token, id } = await links.mintLink(db, { kind: 'claim', prefillName: 'Sam', prefillEmail: 'sam@example.com', source: 'cli' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = (await db.query('SELECT * FROM signin_links WHERE id = $1', [id])).rows[0];
    expect(row.token_hash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    for (const v of Object.values(row)) {
      if (typeof v === 'string') expect(v).not.toContain(token);
    }
    expect(row).toMatchObject({ kind: 'claim', prefill_name: 'Sam', prefill_email: 'sam@example.com', source: 'cli', used_at: null, user_id: null });
  });

  test('expiry is 15 minutes after creation', async () => {
    const { token } = await links.mintLink(db, { kind: 'claim', source: 'cli' });
    const row = await rowFor(token);
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(15 * 60 * 1000);
  });

  test('peek changes nothing and reports kind, expiry, and prefill only', async () => {
    const { token } = await links.mintLink(db, { kind: 'claim', prefillName: 'Sam', source: 'cli' });
    const before = await rowFor(token);
    const peek = await links.peekLink(db, token);
    expect(peek).toEqual({ valid: true, kind: 'claim', expiresAt: before.expires_at.toISOString(), prefill: { name: 'Sam', email: null } });
    expect(await rowFor(token)).toEqual(before);
  });

  test('peek of a signin link prefills the target user; invalid links say only valid:false', async () => {
    const u = await addUser('target@example.com');
    const { token } = await links.mintLink(db, { kind: 'signin', userId: u.id, source: 'cli' });
    expect(await links.peekLink(db, token)).toMatchObject({ valid: true, kind: 'signin', prefill: { name: 'User', email: 'target@example.com' } });
    expect(await links.peekLink(db, crypto.randomBytes(32).toString('base64url'))).toEqual({ valid: false });
    expect(await links.peekLink(db, 'short')).toEqual({ valid: false });
    // A claim link on an instance that has users is invalid too.
    const claim = await links.mintLink(db, { kind: 'claim', source: 'cli' });
    expect(await links.peekLink(db, claim.token)).toEqual({ valid: false });
  });

  test('redeem twice: one success, one link_invalid', async () => {
    const u = await addUser();
    const { token } = await links.mintLink(db, { kind: 'signin', userId: u.id, source: 'cli' });
    const first = await links.redeemLink(db, token);
    expect(first.user.id).toBe(u.id);
    expect(first.isNew).toBe(false);
    await expect(links.redeemLink(db, token)).rejects.toMatchObject({ code: 'link_invalid' });
    expect((await rowFor(token)).used_at).not.toBeNull();
  });

  test('an expired link is refused', async () => {
    const u = await addUser();
    const { token } = await links.mintLink(db, { kind: 'signin', userId: u.id, source: 'cli' });
    await db.query("UPDATE signin_links SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [links.hashToken(token)]);
    await expect(links.redeemLink(db, token)).rejects.toMatchObject({ code: 'link_invalid' });
    expect(await links.peekLink(db, token)).toEqual({ valid: false });
  });

  test('claim validation failure does not spend the link', async () => {
    const { token } = await links.mintLink(db, { kind: 'claim', source: 'cli' });
    await expect(links.redeemLink(db, token, { name: '', email: 'sam@example.com' })).rejects.toMatchObject({ code: 'claim_invalid', field: 'name' });
    await expect(links.redeemLink(db, token, { name: 'Sam', email: 'not-an-email' })).rejects.toMatchObject({ code: 'claim_invalid', field: 'email' });
    expect((await rowFor(token)).used_at).toBeNull();
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
  });

  test('claim with zero users creates an administrator with signin_link and records the owner', async () => {
    const { token } = await links.mintLink(db, { kind: 'claim', source: 'cli' });
    const { user, isNew } = await links.redeemLink(db, token, { ...claimFields, ctx: { ip: '203.0.113.5', userAgent: 'UA' } });
    expect(isNew).toBe(true);
    expect(user).toMatchObject({ name: 'Sam', email: 'sam@example.com', is_admin: true, signup_source: 'signin_link', google_id: null, signup_ip: '203.0.113.5' });
    const owner = await resolveOwner(db);
    expect(owner).toMatchObject({ via: 'record' });
    expect(owner.user.id).toBe(user.id);
  });

  test('claim when a user exists is refused with instance_claimed and creates nothing', async () => {
    const { token } = await links.mintLink(db, { kind: 'claim', source: 'cli' });
    await addUser();
    await expect(links.redeemLink(db, token, claimFields)).rejects.toMatchObject({ code: 'instance_claimed' });
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
  });

  test('redeeming one claim link voids the other outstanding claim link (SC-004, US1-6)', async () => {
    const a = await links.mintLink(db, { kind: 'claim', source: 'startup' });
    const b = await links.mintLink(db, { kind: 'claim', source: 'cli' });
    await links.redeemLink(db, b.token, claimFields);
    expect((await rowFor(a.token)).used_at).not.toBeNull();
    await expect(links.redeemLink(db, a.token, { name: 'X', email: 'x@example.com' })).rejects.toMatchObject({ code: 'link_invalid' });
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
  });

  test('mint prunes rows used or expired more than 24 hours ago and keeps newer ones', async () => {
    const u = await addUser();
    const old1 = await links.mintLink(db, { kind: 'signin', userId: u.id, source: 'cli' });
    const old2 = await links.mintLink(db, { kind: 'signin', userId: u.id, source: 'cli' });
    const recent = await links.mintLink(db, { kind: 'signin', userId: u.id, source: 'cli' });
    await db.query("UPDATE signin_links SET expires_at = now() - interval '25 hours' WHERE id = $1", [old1.id]);
    await db.query("UPDATE signin_links SET used_at = now() - interval '25 hours' WHERE id = $1", [old2.id]);
    await db.query("UPDATE signin_links SET expires_at = now() - interval '23 hours' WHERE id = $1", [recent.id]);
    await links.mintLink(db, { kind: 'signin', userId: u.id, source: 'cli' });
    const ids = (await db.query('SELECT id FROM signin_links')).rows.map((r) => r.id);
    expect(ids).not.toContain(old1.id);
    expect(ids).not.toContain(old2.id);
    expect(ids).toContain(recent.id);
  });

  test('two concurrent claim redemptions with different links create exactly one user', async () => {
    const a = await links.mintLink(db, { kind: 'claim', source: 'cli' });
    const b = await links.mintLink(db, { kind: 'claim', source: 'cli' });
    const results = await Promise.allSettled([
      links.redeemLink(db, a.token, { name: 'A', email: 'a@example.com' }),
      links.redeemLink(db, b.token, { name: 'B', email: 'b@example.com' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(['link_invalid', 'instance_claimed']).toContain(rejected[0].reason.code);
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
  });

  test('the module requires no JWT module (the CLI loads it)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../signin-links'), 'utf8');
    expect(src).not.toMatch(/require\(['"][./]*(auth\/)?jwt['"]\)|mcp\/auth\/jwt/);
  });
});
