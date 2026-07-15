/**
 * login MCP tool (feature 008-mcp-login-bootstrap).
 *
 * The in-session onboarding entry point. An MCP client with no credential can
 * call this (it is one of exactly two tools an anonymous session sees) to start
 * a device-authorization-style pairing: it returns a one-shot user code, a
 * /activate URL, and a session handle. The user approves in a browser; the
 * agent then polls login_status and claims the credential over REST.
 *
 * No scope required (FR-004); works identically for authenticated callers, for
 * whom it mints a fresh pairing (re-pairing / rotation) — D2.
 */
const loginService = require('../auth/login-service');
const rateLimit = require('../auth/rate-limit');
const { LOGIN_CALLS_PER_MINUTE_PER_IP } = require('../auth/login-constants');

// Wired as a boot-time singleton in server/mcp/index.js init(); the tool holds
// no persistence handle of its own.
function init() {}

const name = 'login';

const description = `Start onboarding for THIS agent from inside the current session — the recommended way to connect when you have no credential yet. Returns a short user code, a verification URL (\`<base>/activate\`), and a \`handle\`.

Relay to your user: print the URL bare on its own line and tell them to open it, sign in, and enter the code. Then poll \`login_status({ handle })\` about every 5 seconds (respect any \`slow_down\`) until it reports approved. On approval you receive a one-time recipe to claim the credential over REST (a curl command that writes an \`sk_sqd_\` token to a file with 0600 permissions); write that token into your MCP client config or an env file and reconnect — there is no mid-session toolset upgrade. If you have no shell, poll with \`login_status({ handle, inline: true })\` to receive the credential in-band once (opt-in, warned).

NEVER move the credential through this conversation: don't print, echo, or paste it. The handle is safe transcript residue — short-lived, one-shot, dead after the claim.

Parameter: \`agentName\` — your self-declared display name (max 100 chars), shown to the user on the consent page. It is NOT verified; the user is asked to approve skeptically.`;

const inputSchema = {
  type: 'object',
  properties: {
    agentName: {
      type: 'string',
      description:
        'Your self-declared display name, shown to the user on the consent page (max 100 chars).',
    },
  },
  required: ['agentName'],
};

/**
 * @param {object} args - { agentName }
 * @param {object} agentToken - dispatch context; carries clientIp + baseUrl
 *   (anonymous: { isAnonymous:true, baseUrl, clientIp }; authenticated: the
 *   agent token augmented with baseUrl + clientIp).
 */
async function handler(args, agentToken) {
  // Throws the standard tool-parameter error shape on invalid names (D9); no
  // pending authorization is created on validation failure.
  const agentName = loginService.validateAgentName(args.agentName);

  const ip = (agentToken && agentToken.clientIp) || 'unknown';
  const baseUrl = (agentToken && agentToken.baseUrl) || '';

  // Abuse gate 1: per-IP login rate (10/min). Gates 2 (per-IP cap) and 3
  // (global cap) live in createPendingAuthorization, after its GC sweep so the
  // counts are fresh. Every gate returns the same uniform retriable result.
  const gate = await rateLimit.consume(`login:ip:${ip}`, LOGIN_CALLS_PER_MINUTE_PER_IP, 60);
  if (!gate.allowed) {
    return {
      status: 'rate_limited',
      retryable: true,
      message: 'Too many login attempts. Wait a minute and try again.',
    };
  }

  return loginService.createPendingAuthorization({ agentName, ip, baseUrl });
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
