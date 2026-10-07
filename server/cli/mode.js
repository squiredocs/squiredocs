/**
 * `squire mode` (feature 059, FR-042): the current mode and what switching
 * to the other one requires. Human text on stdout.
 */
const { getInstanceConfig } = require('../instance-config');
const { getProviders } = require('../auth/providers');

function modeText({ mode, env = process.env }) {
  if (mode === 'local') {
    return [
      'Mode: local',
      'Sign-in: one owner, by links from `squire claim-link`. Sign-up is closed.',
      'To switch to team mode: set SQUIRE_MODE=team and GOOGLE_CLIENT_ID and',
      'GOOGLE_CLIENT_SECRET in .env, then run docker compose up -d.',
    ].join('\n');
  }
  const listed = getProviders({ mode, env }).filter((p) => p.listed).map((p) => p.label);
  return [
    'Mode: team',
    `Sign-in: ${listed.length ? listed.join(', ') : 'no listed provider'}, plus links from \`squire login-link\`. ` +
      'A first sign-in creates an account.',
    'To switch to local mode: set SQUIRE_MODE=local in .env (or remove it), then run',
    'docker compose up -d. Only the owner can sign in afterward, by links from `squire claim-link`.',
  ].join('\n');
}

async function mode({ out, env = process.env }) {
  out.write(`${modeText({ mode: getInstanceConfig().mode, env })}\n`);
  return 0;
}

module.exports = { mode, modeText };
