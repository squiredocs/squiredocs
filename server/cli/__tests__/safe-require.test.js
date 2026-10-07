/**
 * Feature 059 (T066, FR-038, research R9): the CLI and every command module
 * load with NODE_ENV=production and none of the four generated secrets set,
 * and never pull in the modules that check secrets at load time (or the
 * server itself).
 *
 * Runs in a plain Node child process: Jest's module registry is not
 * require.cache, and a real process is what `docker compose exec` gives.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const FORBIDDEN = [
  'server/auth/jwt.js',
  'server/mcp/auth/jwt.js',
  'server/auth/routes.js',
  'server/index.js',
];
const SECRETS = ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET', 'MCP_JWT_SECRET', 'API_KEY_ENCRYPTION_KEY', 'API_KEY_ENCRYPTION_KEYS'];

test('requiring server/cli and every command loads no secret-checking module', () => {
  const env = { ...process.env, NODE_ENV: 'production' };
  for (const k of SECRETS) delete env[k];
  const script = `
    const path = require('path');
    const cli = require('./server/cli');
    for (const c of Object.values(cli.COMMANDS)) c.load();
    process.stdout.write(JSON.stringify(Object.keys(require.cache).map((f) => path.relative(process.cwd(), f))));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env, encoding: 'utf8' });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  const loaded = JSON.parse(r.stdout).map((f) => f.split(path.sep).join('/'));
  for (const f of FORBIDDEN) expect(loaded).not.toContain(f);
  expect(loaded).toContain('server/cli/index.js');
  expect(loaded).toContain('server/cli/token-create.js');
  expect(loaded).toContain('server/auth/signin-links.js');
});
