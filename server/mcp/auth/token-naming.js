/**
 * Mint-time token naming (feature 037, FR-017).
 *
 * Since 037 a token's display name is a USER-FACING PRESENCE LABEL: it is what
 * a watching human sees on the cursor while the agent imports, and what version
 * history records as the author. So it must answer "who is here", not "what
 * operation ran" — which is why both minting tools stopped defaulting to
 * `Minted by … via <tool>` (design/agent-surface-mcp.md, Amendment 2026-07-30
 * as corrected 2026-07-31: the name describes the agent, not the operation).
 *
 * One shared rule, in one place, so the two tools cannot drift.
 */

const FALLBACK_NAME = 'AI Agent';
const MAX_NAME_LENGTH = 255;

/**
 * Derive the default name for a token minted by this principal.
 *
 * For a delegation principal `agentName` is the OAuth-registered `client_name`
 * (oauth-flow.js) — i.e. "Claude Code" — which IS the connecting client's
 * identity, needing no new plumbing. For an sk_sqd_ principal minting a child
 * token it is the parent token's own (already agent-descriptive) name, so the
 * convention propagates rather than being re-derived.
 *
 * `agentId` is deliberately NEVER a fallback: `api-token:<uuid>` is an opaque
 * identifier, and surfacing that as a cursor label would be worse than the
 * generic name.
 *
 * @param {object} agentToken - the authenticated principal
 * @returns {string} a 1..255 character display name
 */
function deriveMintedTokenName(agentToken) {
  const raw = agentToken && typeof agentToken.agentName === 'string'
    ? agentToken.agentName.trim()
    : '';
  return (raw || FALLBACK_NAME).slice(0, MAX_NAME_LENGTH);
}

module.exports = { deriveMintedTokenName, FALLBACK_NAME, MAX_NAME_LENGTH };
