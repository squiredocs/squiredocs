/**
 * Feature 059 (T037, T042): `squire claim-link` on an unclaimed and on a
 * claimed instance, against a fresh instance database.
 */
const { createFreshInstanceDb, dropFreshInstanceDb } = require('../../__tests__/helpers/db');
const { _resetInstanceConfigForTests } = require('../../instance-config');
const users = require('../../auth/users');
const links = require('../../auth/signin-links');
const { recordOwner, OWNER_KEY } = require('../../auth/instance-owner');
const { runCli } = require('./helpers');

const APP = 'http://localhost:3910';
const LINK_RE = new RegExp(`^${APP.replace(/[.]/g, '\\.')}/claim#([A-Za-z0-9_-]{43})$`);

describe('squire claim-link', () => {
  let fresh;
  let db;
  const saved = {};

  beforeAll(async () => {
    for (const k of ['SQUIRE_MODE', 'APP_URL']) saved[k] = process.env[k];
    process.env.SQUIRE_MODE = 'local';
    process.env.APP_URL = APP;
    _resetInstanceConfigForTests();
    fresh = await createFreshInstanceDb();
    db = fresh.pool;
    users.init(db);
  });

  afterAll(async () => {
    await dropFreshInstanceDb(fresh);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetInstanceConfigForTests();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM signin_links');
    await db.query('DELETE FROM app_settings WHERE key = $1', [OWNER_KEY]);
    await db.query('DELETE FROM users');
  });

  const run = (argv) => runCli(argv, { url: fresh.url });
  const tokenOf = (stdout) => LINK_RE.exec(stdout.trim())[1];
  const rowOf = async (token) =>
    (await db.query('SELECT * FROM signin_links WHERE token_hash = $1', [links.hashToken(token)])).rows[0];

  describe('unclaimed', () => {
    test('stdout is exactly one link line; the explanation is on stderr; the row carries the prefill', async () => {
      const r = await run(['claim-link', '--name', 'Sam', '--email', 'sam@example.com']);
      expect(r.code).toBe(0);
      expect(r.out.split('\n').filter(Boolean)).toHaveLength(1);
      expect(r.out.trim()).toMatch(LINK_RE);
      expect(r.err).toMatch(/Open this link within 15 minutes to create the owner account/);
      expect(r.err).not.toContain(tokenOf(r.out));
      const row = await rowOf(tokenOf(r.out));
      expect(row).toMatchObject({ kind: 'claim', prefill_name: 'Sam', prefill_email: 'sam@example.com', source: 'cli' });
    });

    test('no flags: an empty prefill', async () => {
      const r = await run(['claim-link']);
      expect(r.code).toBe(0);
      expect(await rowOf(tokenOf(r.out))).toMatchObject({ prefill_name: null, prefill_email: null });
    });

    test('a bad --email exits 2 with the reason and mints nothing', async () => {
      const r = await run(['claim-link', '--email', 'not-an-email']);
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toMatch(/not a valid email address/);
      expect((await db.query('SELECT count(*)::int AS n FROM signin_links')).rows[0].n).toBe(0);
    });
  });

  describe('claimed', () => {
    async function claim() {
      const { token } = await links.mintLink(db, { kind: 'claim', source: 'cli' });
      const { user } = await links.redeemLink(db, token, { name: 'Owner', email: 'owner@example.com' });
      return user;
    }

    test('the link signs in the owner without changing their name or email; flags are ignored and said so', async () => {
      const owner = await claim();
      const r = await run(['claim-link', '--name', 'Other', '--email', 'other@example.com']);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/already has an owner \(Owner, owner@example\.com\); --name and --email were ignored/);
      const token = tokenOf(r.out);
      expect(await rowOf(token)).toMatchObject({ kind: 'signin', user_id: owner.id });
      const { user } = await links.redeemLink(db, token, { name: 'Other', email: 'other@example.com' });
      expect(user.id).toBe(owner.id);
      const after = (await db.query('SELECT name, email FROM users WHERE id = $1', [owner.id])).rows[0];
      expect(after).toEqual({ name: 'Owner', email: 'owner@example.com' });
    });

    test('without flags, no "ignored" clause', async () => {
      await claim();
      const r = await run(['claim-link']);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/already has an owner/);
      expect(r.err).not.toMatch(/ignored/);
    });

    test('ambiguous admins exit 1 naming squire login-link --email', async () => {
      await db.query("INSERT INTO users (email, name, is_admin) VALUES ('a1@example.com', 'A1', true), ('a2@example.com', 'A2', true)");
      const r = await run(['claim-link']);
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toMatch(/squire login-link --email/);
    });

    test('a single administrator without a record is the owner', async () => {
      const { rows } = await db.query("INSERT INTO users (email, name, is_admin) VALUES ('solo@example.com', 'Solo', true) RETURNING id");
      const r = await run(['claim-link']);
      expect(r.code).toBe(0);
      expect(await rowOf(tokenOf(r.out))).toMatchObject({ kind: 'signin', user_id: rows[0].id });
      await recordOwner(db, rows[0].id);
    });
  });
});
