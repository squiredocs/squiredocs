#!/usr/bin/env node
/**
 * The `squire` command (feature 059, FR-038). In the image it is on PATH as
 * /usr/local/bin/squire (`docker compose exec app squire <command>`); in
 * development run `node bin/squire.js <command>`.
 *
 * Order matters: the database variables and the generated secrets must be in
 * the environment before anything under server/ that reads them is loaded.
 *   1. dotenv (as the image entrypoint does; never overrides set variables)
 *   2. script/setup-db-env.js (DATABASE_URL from DB_* when unset)
 *   3. 058's resolveSecrets in read-only mode (generate: false): the CLI
 *      never creates secrets, it only adopts the ones the server generated
 *   4. server/cli main()
 */
const path = require('node:path');

async function run() {
  require('dotenv').config({ path: path.resolve('.env'), quiet: true });
  require('../script/setup-db-env');

  try {
    const { getInstanceConfig } = require('../server/instance-config');
    const { resolveSecrets } = require('../server/boot/secrets');
    resolveSecrets({ env: process.env, dataDir: getInstanceConfig().dataDir, generate: false, log: { log() {}, warn() {}, error() {} } });
  } catch {
    // A bad configuration value is reported by the command itself (with the
    // setting to fix); an unreadable secrets file only matters to commands
    // that load the token modules, which never check secrets at load time.
  }

  const { main } = require('../server/cli');
  return main(process.argv.slice(2));
}

run().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`squire: ${err?.stack || err}\nRun: squire doctor\n`);
    process.exitCode = 1;
  }
);
