/**
 * The one definition of *acting identity* for undo/redo attribution
 * (feature 040, FR-005/FR-015).
 *
 * ⚠️ MODULE INVARIANT — THIS FILE MUST CONTAIN ZERO `require` STATEMENTS. ⚠️
 *
 * That is not a style preference: it is what makes FR-005's "no circular
 * dependency with the chat surface" a *structural* property rather than a
 * convention someone has to remember. `server/index.js`'s restore route, the
 * undo internals (`server/undo/*`), the MCP tools and `server/api/chat.js`
 * all read from here; if this leaf ever grew a dependency of its own it could
 * close a cycle back through one of them. Anything that needs a dependency
 * belongs in a different module.
 *
 * See specs/040-restore-undo-attribution/contracts/agent-identity.md.
 */

/**
 * The single authoritative display name of the in-app chat assistant.
 *
 * WHAT IS RECORDED UNDER THIS IDENTITY: the assistant's OWN edits — the `modify`
 * calls it makes on the user's behalf from the chat panel. Nothing else.
 *
 * A human web-UI restore is NOT recorded here. It briefly was, so that the chat
 * undo endpoint could invert it; that was cut on 2026-08-02 (see
 * design/collaboration-core.md and specs/040-restore-undo-attribution/, US1/US6
 * CUT) because it put a human's restore into the assistant's undo queue under
 * the assistant's name. A web-UI restore is attributed to the human in
 * `yjs_updates` and is simply not an undo target; you revert one by restoring
 * again. An agent/MCP restore is recorded under that agent's own name, not this
 * one.
 *
 * WHO READS IT: the chat surface's undo/redo and undo-status endpoints resolve
 * the acting identity through this same constant, so the identity the
 * assistant's edits are recorded under and the identity those endpoints query
 * can never drift apart.
 *
 * @type {string}
 */
const CHAT_AGENT_NAME = 'Squire Docs Assistant';

/**
 * The one definition of "is this row mine?" for undo/attribution identity
 * (FR-015). Replaces six hand-rolled comparisons that disagreed with each
 * other about `null` vs `undefined`.
 *
 * Semantics:
 *  1. Symmetric — `isSameIdentity(x, y) === isSameIdentity(y, x)`.
 *  2. `null`/`undefined` equivalence — an absent agent name is the same
 *     identity whether it arrives as `null` (from a DB row) or `undefined`
 *     (from an in-process identity object that omitted the field). This is
 *     the FR-015 bug fix; `edit-range.js` previously rejected that match.
 *  3. `userId` is compared with strict `===` and never coerced. A `null` user
 *     id equals only another `null` user id; the caller decides whether that
 *     is meaningful.
 *  4. `''` is NOT `null` — an empty-string agent name is a *distinct*
 *     identity, not an absent one. This feature never writes it (FR-007), but
 *     legacy rows carry it and they must not be silently folded into the
 *     human identity.
 *  5. Pure — no I/O, no logging, no throwing.
 *
 * @param {{userId: string|null|undefined, agentName: string|null|undefined}} a
 * @param {{userId: string|null|undefined, agentName: string|null|undefined}} b
 * @returns {boolean}
 */
function isSameIdentity(a, b) {
  if (!a || !b) return false;
  return a.userId === b.userId
    && (a.agentName ?? null) === (b.agentName ?? null);
}

module.exports = { CHAT_AGENT_NAME, isSameIdentity };
