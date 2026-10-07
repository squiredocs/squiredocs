/**
 * Feature 059 (T064, FR-043, RBD-059-7, RBD-059-22): `squire token create`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFreshInstanceDb, dropFreshInstanceDb } = require('../../__tests__/helpers/db');
const { _resetInstanceConfigForTests } = require('../../instance-config');
const { recordOwner, OWNER_KEY } = require('../../auth/instance-owner');
const { runCli } = require('./helpers');

describe('squire token create', () => {
  let fresh;
  let db;
  let dataDir;
  let owner;
  const KEYS = ['SQUIRE_MODE', 'SQUIRE_DATA_DIR'];
  const saved = {};

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    fresh = await createFreshInstanceDb();
    db = fresh.pool;
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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-token-'));
    process.env.SQUIRE_DATA_DIR = dataDir;
    process.env.SQUIRE_MODE = 'local';
    _resetInstanceConfigForTests();
    await db.query('DELETE FROM app_settings WHERE key = $1', [OWNER_KEY]);
    await db.query('DELETE FROM users');
    owner = (await db.query("INSERT INTO users (email, name, is_admin) VALUES ('owner@example.com', 'Owner', true) RETURNING *")).rows[0];
    await recordOwner(db, owner.id);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const run = (argv) => runCli(['token', 'create', ...argv], { url: fresh.url });
  // Direct SQL: the command re-initializes the token module with its own pool.
  const tokensOf = async (userId) =>
    (await db.query('SELECT name, scopes, expires_at FROM mcp_api_tokens WHERE user_id = $1 ORDER BY created_at', [userId])).rows;

  test('local: writes a 0600 file in a 0700 directory; the token is never printed; it is listed for the owner', async () => {
    const r = await run(['--name', 'Claude Code']);
    expect(r.code).toBe(0);
    const file = path.join(dataDir, 'tokens', 'claude-code.token');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const token = fs.readFileSync(file, 'utf8').trim();
    expect(token).toMatch(/^sk_sqd_/);
    expect(r.out).toBe('');
    expect(r.err).not.toContain(token);
    expect(r.err).toContain(file);
    expect(r.err).toContain(`docker compose cp app:${file} ~/.squire/token`);

    const list = await tokensOf(owner.id);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Claude Code');
    expect(list[0].scopes.sort()).toEqual(['documents:read', 'documents:write']);
    const thirtyDays = Date.now() + 30 * 24 * 3600 * 1000;
    expect(Math.abs(new Date(list[0].expires_at).getTime() - thirtyDays)).toBeLessThan(60 * 1000);
  });

  test('team mode without --email exits 2 naming --email', async () => {
    process.env.SQUIRE_MODE = 'team';
    _resetInstanceConfigForTests();
    const r = await run(['--name', 'Bot']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/squire token create --name N --email/);
    expect(await tokensOf(owner.id)).toHaveLength(0);
  });

  test('team mode with --email mints for that account (case-insensitive)', async () => {
    process.env.SQUIRE_MODE = 'team';
    _resetInstanceConfigForTests();
    const r = await run(['--name', 'Bot', '--email', 'OWNER@example.com', '--out', path.join(dataDir, 'bot.token')]);
    expect(r.code).toBe(0);
    expect(await tokensOf(owner.id)).toHaveLength(1);
  });

  test('an existing file is refused and no token is minted', async () => {
    const out = path.join(dataDir, 'existing.token');
    fs.writeFileSync(out, 'old');
    const r = await run(['--name', 'Again', '--out', out]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already exists/);
    expect(fs.readFileSync(out, 'utf8')).toBe('old');
    expect(await tokensOf(owner.id)).toHaveLength(0);
  });

  test('--stdout prints only the token on stdout, the warning on stderr, and writes no file', async () => {
    const r = await run(['--name', 'Inline', '--stdout']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^sk_sqd_\S+$/);
    expect(r.out.trim().split('\n')).toHaveLength(1);
    expect(r.err).toMatch(/Never print, echo, paste, or repeat it/);
    expect(fs.existsSync(path.join(dataDir, 'tokens'))).toBe(false);
  });

  test('scopes and expiry are honored', async () => {
    const r = await run(['--name', 'Reader', '--scopes', 'documents:read', '--expires-in', '12h', '--stdout']);
    expect(r.code).toBe(0);
    const [t] = await tokensOf(owner.id);
    expect(t.scopes).toEqual(['documents:read']);
    expect(Math.abs(new Date(t.expires_at).getTime() - (Date.now() + 12 * 3600 * 1000))).toBeLessThan(60 * 1000);
  });

  test.each([
    [['--scopes', 'documents:admin'], /--scopes/],
    [['--scopes', ''], /--scopes/],
    [['--expires-in', '0h'], /--expires-in/],
    [['--expires-in', '366d'], /--expires-in/],
    [['--expires-in', '30m'], /--expires-in/],
  ])('bad input %j exits 2', async (extra, re) => {
    const r = await run(['--name', 'X', ...extra]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(re);
    expect(await tokensOf(owner.id)).toHaveLength(0);
  });

  test('local with no owner refuses with the claim-link next action', async () => {
    await db.query('DELETE FROM app_settings WHERE key = $1', [OWNER_KEY]);
    await db.query('DELETE FROM users');
    const r = await run(['--name', 'X']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/squire claim-link/);
  });
});
