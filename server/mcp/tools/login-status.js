/**
 * login_status MCP tool (feature 008-mcp-login-bootstrap).
 *
 * Polls the state of a pending authorization started by `login`. Thin delegate
 * over loginService.getStatus, which implements the full decision table:
 * slow_down (premature poll), pending, denied, a uniform expired (also covers
 * unknown / already-delivered / claimed handles — no oracle), the one-shot
 * approved payload with the claim recipe (no credential), and — with
 * `inline: true` — the one-time in-band credential delivery for shell-less
 * agents. No scope required (FR-004); identical for anonymous and authenticated
 * callers (D2).
 */
const loginService = require('../auth/login-service');

function init() {}

const name = 'login_status';

const description = `Poll the status of a pending login started with the \`login\` tool. Pass the \`handle\` you received. Poll about every 5 seconds and respect any \`slow_down\` result (it raises the required interval).

Results carry a \`status\`: \`pending\` (keep polling), \`slow_down\` (you polled too fast — wait \`pollIntervalSeconds\`), \`denied\` (terminal — call \`login\` again), \`expired\` (expired or unknown handle — call \`login\` again), or \`approved\`. On \`approved\` you get, ONCE, a \`claimCommand\`: a curl recipe that writes the credential to a file with owner-only (0600) permissions. Run it within the claim window, store the token in your MCP client config or an env file, then reconnect.

If you have no shell, call \`login_status({ handle, inline: true })\`: on approval it returns the credential in-band exactly once, prefixed with a do-not-echo warning. NEVER print, echo, paste, or log the credential either way.`;

const inputSchema = {
  type: 'object',
  properties: {
    handle: {
      type: 'string',
      description: 'The handle returned by login.',
    },
    inline: {
      type: 'boolean',
      description:
        'Opt-in: return the credential inline on approval (only for agents with no shell). Default false.',
    },
  },
  required: ['handle'],
};

/**
 * @param {object} args - { handle, inline? }
 * @param {object} agentToken - dispatch context; carries baseUrl for the claim recipe.
 */
async function handler(args, agentToken) {
  const baseUrl = (agentToken && agentToken.baseUrl) || '';
  return loginService.getStatus(args.handle, {
    inline: args.inline === true,
    baseUrl,
  });
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
