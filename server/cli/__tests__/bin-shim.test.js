/**
 * Feature 059 (T067, FR-038, FR-044): the bin/squire.js shim as a real
 * process: usage and exit codes, and doctor --json against a closed database
 * port.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const BIN = path.join(ROOT, 'bin', 'squire.js');

function squire(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [k, v] of Object.entries(envOverrides)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 15000 });
}

describe('bin/squire.js', () => {
  test('no arguments: usage on stderr, exit 2', () => {
    const r = squire([]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^Usage: squire <command>/);
  });

  test('--help: exit 0', () => {
    const r = squire(['--help']);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/claim-link/);
  });

  test('doctor --json with the database on a closed port: exit 1, parseable JSON with ok false', () => {
    const r = squire(['doctor', '--json'], {
      DATABASE_URL: undefined,
      DB_HOST: '127.0.0.1',
      DB_PORT: '1',
      DB_NAME: 'none',
      PORT: '1',
      SQUIRE_MODE: 'local',
    });
    expect(r.status).toBe(1);
    const d = JSON.parse(r.stdout);
    expect(d.ok).toBe(false);
    expect(d.failed).toContain('database');
    expect(d.checks.database.message).toMatch(/DB_HOST=127\.0\.0\.1, DB_PORT=1/);
  });
});
