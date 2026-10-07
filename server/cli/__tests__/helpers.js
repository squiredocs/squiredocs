/**
 * Shared fixtures for the `squire` CLI suites (feature 059): captured
 * stdout/stderr and a main() runner bound to a fresh instance database.
 */
const { Pool } = require('pg');
const { main } = require('..');

function capture() {
  let text = '';
  return {
    write: (s) => { text += s; return true; },
    get text() { return text; },
  };
}

/**
 * Run the CLI with argv against the database at `url`.
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
async function runCli(argv, { url, env, ...extra } = {}) {
  const out = capture();
  const err = capture();
  const code = await main(argv, {
    out,
    err,
    ...(env ? { env } : {}),
    createPool: () => new Pool({ connectionString: url }),
    ...extra,
  });
  return { code, out: out.text, err: err.text };
}

module.exports = { capture, runCli };
