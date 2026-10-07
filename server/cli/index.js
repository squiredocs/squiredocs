/**
 * The in-container `squire` CLI (feature 059, FR-038 to FR-044,
 * contracts/squire-cli.md). bin/squire.js loads the database environment and
 * the generated secrets, then calls main().
 *
 * Process rules:
 *   - stdout carries only machine-relevant output (the bare link, the doctor
 *     JSON, the token for `token create --stdout`, the `mode` text); every
 *     explanation goes to stderr;
 *   - exit 0 on success, 1 on failure, 2 on a usage error;
 *   - every failure names the next action (server/cli/messages.js).
 *
 * This module and everything it requires must load with NODE_ENV=production
 * and no secrets set: it never requires server/auth/jwt.js,
 * server/mcp/auth/jwt.js, server/auth/routes.js, or server/index.js
 * (safe-require.test.js pins that).
 */
const { parseArgs } = require('node:util');
const { msg } = require('./messages');
const { createCliPool, canConnect, dbUnreachableMessage } = require('./db');

const USAGE = `Usage: squire <command> [options]

Commands:
  doctor [--json]                         check that this instance can serve requests
  claim-link [--name N] [--email E]       print a one-time link that claims this instance
                                          (or, once claimed, signs in the owner)
  login-link --email E                    print a one-time sign-in link for an account
  mode                                    show the instance mode and how to change it
  token create --name N [--email E] [--scopes S] [--expires-in D] [--out PATH] [--stdout]
                                          create an sk_sqd_ API token, written to a 0600 file

Links expire after 15 minutes and work once. Run commands as:
  docker compose exec app squire <command>
`;

const COMMANDS = {
  doctor: { options: { json: { type: 'boolean' } }, needsDb: 'probe', load: () => require('./doctor').doctor },
  'claim-link': {
    options: { name: { type: 'string' }, email: { type: 'string' } },
    needsDb: true,
    load: () => require('./claim-link').claimLink,
  },
  'login-link': { options: { email: { type: 'string' } }, needsDb: true, load: () => require('./login-link').loginLink },
  mode: { options: {}, needsDb: false, load: () => require('./mode').mode },
  'token create': {
    options: {
      name: { type: 'string' },
      email: { type: 'string' },
      scopes: { type: 'string' },
      'expires-in': { type: 'string' },
      out: { type: 'string' },
      stdout: { type: 'boolean' },
    },
    needsDb: true,
    load: () => require('./token-create').tokenCreate,
  },
};

/**
 * @param {string[]} argv - arguments after the program name
 * @param {{ env?: object, out?: object, err?: object, createPool?: Function }} [io]
 * @returns {Promise<number>} exit code
 */
async function main(argv, { env = process.env, out = process.stdout, err = process.stderr, createPool = createCliPool, ...extra } = {}) {
  if (argv.length === 0) {
    err.write(USAGE);
    return 2;
  }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    err.write(USAGE);
    return 0;
  }

  let name = argv[0];
  let rest = argv.slice(1);
  if (name === 'token') {
    if (rest[0] !== 'create') {
      err.write(`${msg('usage', { reason: 'The token command has one subcommand: token create --name N.' })}\n`);
      return 2;
    }
    name = 'token create';
    rest = rest.slice(1);
  }
  const command = COMMANDS[name];
  if (!command) {
    err.write(`${msg('unknownCommand', { command: name })}\n`);
    return 2;
  }

  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: command.options, strict: true, allowPositionals: false }));
  } catch (e) {
    err.write(`${msg('usage', { reason: `${e.message}.` })}\n`);
    return 2;
  }

  // Configuration errors (a bad SQUIRE_MODE, APP_URL, ...) are reported with
  // the setting to fix. doctor reports them as a failing check instead.
  if (name !== 'doctor') {
    try {
      require('../instance-config').getInstanceConfig();
    } catch (e) {
      err.write(`${msg('configError', { message: e.message })}\n`);
      return 1;
    }
  }

  const run = command.load();
  if (!command.needsDb) return run({ args: values, env, out, err, ...extra });

  const pool = createPool(env);
  try {
    if (command.needsDb === true && !(await canConnect(pool))) {
      err.write(`${dbUnreachableMessage(env)}\n`);
      return 1;
    }
    return await run({ args: values, pool, env, out, err, ...extra });
  } catch (e) {
    if (isConnectionError(e)) {
      err.write(`${dbUnreachableMessage(env)}\n`);
      return 1;
    }
    throw e;
  } finally {
    await pool.end().catch(() => {});
  }
}

function isConnectionError(e) {
  return ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', '57P03', '3D000', '28P01'].includes(e?.code)
    || /timeout exceeded when trying to connect|Connection terminated/i.test(e?.message || '');
}

module.exports = { main, USAGE, COMMANDS };
