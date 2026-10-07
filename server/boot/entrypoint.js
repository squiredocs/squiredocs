/**
 * Boot entrypoint (feature 058, research R3).
 *
 * The image's CMD runs script/entrypoint.js, which calls main() here. Order:
 *
 *   1. dotenv          a .env value must be in the environment before the
 *                      secrets file is consulted, or the file would beat it
 *                      (dotenv never overrides set variables; RBD-058-25)
 *   2. telemetry       OpenTelemetry's require hooks only instrument modules
 *                      loaded after start(); this file loads pg (for the lock)
 *                      before server/index.js runs (RBD-058-32)
 *   3. config          fail fast on a bad APP_URL, STORAGE_DRIVER, ... before
 *                      anything is written
 *   4. secrets         env, else secrets.json, else generated
 *   5. migrations      under an advisory lock, when MIGRATE_ON_BOOT=true
 *   6. the server      required last: its auth and crypto modules check the
 *                      secrets at require time
 *
 * `npm run dev` and `npm start` run server/index.js directly and skip all of
 * this; they need the secrets in the environment as before.
 */
const path = require('node:path');

/**
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {string} [opts.serverModule] - module to require last (tests pass a probe)
 * @param {string} [opts.dotenvPath='.env'] - relative to the working directory
 * @param {object} [opts.log=console]
 */
async function main({
  env = process.env,
  serverModule = require.resolve('../index.js'),
  dotenvPath = '.env',
  log = console,
} = {}) {
  require('dotenv').config({ path: path.resolve(dotenvPath), processEnv: env, quiet: true });

  require('../telemetry').start();

  const { resolveInstanceConfig } = require('../instance-config');
  const config = resolveInstanceConfig(env);

  const { resolveSecrets } = require('./secrets');
  resolveSecrets({ env, dataDir: config.dataDir, log });

  if (config.migrateOnBoot) {
    const { runMigrationsWithLock } = require('./migrate-lock');
    await runMigrationsWithLock({ env, log });
  }

  return require(serverModule);
}

module.exports = { main };
