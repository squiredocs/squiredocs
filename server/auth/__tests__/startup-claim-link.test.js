/**
 * Feature 059 (T044, D11, FR-036, FR-037): the startup-log claim link.
 */
const fs = require('fs');
const path = require('path');
const { createFreshInstanceDb, dropFreshInstanceDb } = require('../../__tests__/helpers/db');
const { _resetInstanceConfigForTests } = require('../../instance-config');
const users = require('../users');
const links = require('../signin-links');

const APP = 'http://localhost:3910';

describe('maybeLogStartupClaimLink', () => {
  let fresh;
  let db;
  const savedAppUrl = process.env.APP_URL;

  beforeAll(async () => {
    process.env.APP_URL = APP;
    _resetInstanceConfigForTests();
    fresh = await createFreshInstanceDb();
    db = fresh.pool;
    users.init(db);
  });

  afterAll(async () => {
    await dropFreshInstanceDb(fresh);
    if (savedAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedAppUrl;
    _resetInstanceConfigForTests();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM signin_links');
    await db.query('DELETE FROM users');
  });

  const logger = () => ({ log: jest.fn(), error: jest.fn() });

  test('local + zero users logs the marked block with exactly one URL line; the link claims with an empty prefill', async () => {
    const log = logger();
    expect(await links.maybeLogStartupClaimLink({ pool: db, mode: 'local', log })).toBe(true);
    expect(log.log).toHaveBeenCalledTimes(1);
    const block = log.log.mock.calls[0][0].split('\n');
    expect(block[0]).toBe('==================== Squire Docs: claim this instance ====================');
    expect(block[1]).toBe('Open this link within 15 minutes to create the owner account:');
    expect(block[3]).toBe('Expired? Run: docker compose exec app squire claim-link');
    expect(block[4]).toMatch(/^=+$/);
    const urlLines = block.filter((l) => l.includes('/claim#'));
    expect(urlLines).toHaveLength(1);
    expect(urlLines[0]).toMatch(/^http:\/\/localhost:3910\/claim#[A-Za-z0-9_-]{43}$/);

    const token = urlLines[0].split('#')[1];
    const row = (await db.query('SELECT * FROM signin_links WHERE token_hash = $1', [links.hashToken(token)])).rows[0];
    expect(row).toMatchObject({ kind: 'claim', source: 'startup', prefill_name: null, prefill_email: null });
    expect(await links.peekLink(db, token)).toMatchObject({ valid: true, prefill: { name: null, email: null } });
    const { user } = await links.redeemLink(db, token, { name: 'Owner', email: 'owner@example.com' });
    expect(user.is_admin).toBe(true);
  });

  test('local with a user logs nothing and mints nothing', async () => {
    await db.query("INSERT INTO users (email, name) VALUES ('x@example.com', 'X')");
    const log = logger();
    expect(await links.maybeLogStartupClaimLink({ pool: db, mode: 'local', log })).toBe(false);
    expect(log.log).not.toHaveBeenCalled();
    expect((await db.query('SELECT count(*)::int AS n FROM signin_links')).rows[0].n).toBe(0);
  });

  test('team mode logs nothing', async () => {
    const log = logger();
    expect(await links.maybeLogStartupClaimLink({ pool: db, mode: 'team', log })).toBe(false);
    expect(log.log).not.toHaveBeenCalled();
  });

  test('a database error is logged and swallowed', async () => {
    const log = logger();
    const broken = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    await expect(links.maybeLogStartupClaimLink({ pool: broken, mode: 'local', log })).resolves.toBe(false);
    expect(log.error).toHaveBeenCalled();
    expect(log.log).not.toHaveBeenCalled();
  });

  test('server/index.js calls it inside the listen callback, before lifecycle.markInitialized()', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
    const listen = src.indexOf('app.listen(PORT');
    const call = src.indexOf('maybeLogStartupClaimLink(');
    const ready = src.indexOf('lifecycle.markInitialized()', listen);
    expect(listen).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(listen);
    expect(ready).toBeGreaterThan(call);
    // awaited, so the block is in the log before /ready turns 200
    expect(src.slice(call - 80, call)).toMatch(/await require\('\.\/auth\/signin-links'\)\.\s*$/);
  });
});
