/**
 * Feature 059 (T064, FR-042): `squire mode`.
 */
const { _resetInstanceConfigForTests } = require('../../instance-config');
const { runCli } = require('./helpers');

describe('squire mode', () => {
  const saved = process.env.SQUIRE_MODE;
  afterAll(() => {
    if (saved === undefined) delete process.env.SQUIRE_MODE;
    else process.env.SQUIRE_MODE = saved;
    _resetInstanceConfigForTests();
  });

  test('local: the mode, how sign-in works, and what team mode needs', async () => {
    process.env.SQUIRE_MODE = 'local';
    _resetInstanceConfigForTests();
    const r = await runCli(['mode']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Mode: local$/m);
    expect(r.out).toMatch(/SQUIRE_MODE=team/);
    expect(r.out).toMatch(/GOOGLE_CLIENT_ID/);
    expect(r.out).toMatch(/GOOGLE_CLIENT_SECRET/);
    expect(r.out).toMatch(/docker compose up -d/);
  });

  test('team: the mode and how to switch back to local', async () => {
    process.env.SQUIRE_MODE = 'team';
    _resetInstanceConfigForTests();
    const r = await runCli(['mode']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Mode: team$/m);
    expect(r.out).toMatch(/SQUIRE_MODE=local/);
    expect(r.out).toMatch(/docker compose up -d/);
  });

  test('an invalid SQUIRE_MODE exits 1 with the setting to fix', async () => {
    process.env.SQUIRE_MODE = 'teams';
    _resetInstanceConfigForTests();
    const r = await runCli(['mode']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/SQUIRE_MODE must be "local" or "team".*\.env/);
  });
});
