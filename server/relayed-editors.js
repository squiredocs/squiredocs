/**
 * Who to NAME in an "edited by …" claim (feature 047, NF-3).
 *
 * ── Why this module exists ─────────────────────────────────────────────────
 * Two surfaces tell a model, in prose it repeats to the user, that a document
 * was "edited by X": the chat staleness note (`server/api/chat-staleness.js`)
 * and the `modify` conflict refusal (`server/mcp/tools/modify.js`). Both built
 * that name straight from the row's stamped `userName || agentName`.
 *
 * For a `via_sync` row that stamp is the CHANNEL the content arrived on, never a
 * claim that the stamped user wrote it (feature 038). So after a reconnect
 * re-supplied content the server had lost, both surfaces confidently named the
 * RELAYER as the editor of words they may never have written — the same lie
 * feature 045 closed on the version-history surfaces, reaching the user through
 * a different door.
 *
 * The classification lives HERE, in one neutral place, rather than in either
 * caller, for the reason 045 FR-007 exists: two hand-rolled copies of "who
 * authored this row" drifted apart once already, and a surface that grows its
 * own notion of authorship is exactly how a confident wrong author gets back in.
 * Neither caller may re-derive it.
 *
 * PURE — no I/O. Callers resolve (`resupply-resolution.resolveForRows`) and pass
 * the context in, which keeps the database read at the call site and keeps this
 * module free of the resolver's import list.
 *
 * With NO resolution context, and for every row that is not `via_sync`, the
 * output is byte-for-byte the pre-047 logic: the baseline is one argument away.
 */

// Feature 040 (FR-015): the one shared "is this row mine?" predicate.
const { isSameIdentity } = require('./agent-identity');

/**
 * Dedup key for the single "we could not tell who" entry. The leading space
 * cannot collide with a user id or a `userId:agentName` pair.
 */
const SYNCED_EDITOR_KEY = ' synced';

/**
 * How an unattributable relayed change is NAMED. Deliberately not a person:
 * callers render it as transport ("changes arrived over a sync reconnect"),
 * never as a participant in an "edited by" list.
 */
const SYNCED_EDITOR_NAME = 'an unidentified author';

/**
 * The editors ONE row attests to.
 *
 * @param {Object} u - an update row ({ clock, userId, agentName, userName, viaSync })
 * @param {{outcomes: Map, directory: Map}} [resolution]
 * @returns {Array<{key: string, name: string, isAgent: boolean, isSynced?: boolean, identity: object|null}>}
 */
function editorsForRow(u, resolution) {
  const outcome = u.viaSync === true && resolution && resolution.outcomes
    ? resolution.outcomes.get(u.clock)
    : undefined;

  if (!outcome) {
    // Not relayed (or no context): the stamp IS the authorship claim, unchanged.
    return [{
      key: u.agentName ? `${u.userId}:${u.agentName}` : (u.userId || 'unknown'),
      name: u.userName || u.agentName || 'another collaborator',
      isAgent: !!u.agentName,
      identity: { userId: u.userId, agentName: u.agentName },
    }];
  }

  // Every origin the payload's own client identities resolve to — never the
  // relayer. Display names come from the per-request directory; a resolved id
  // absent from it is a deleted account. The local `userName || agentName`
  // rendering is kept exactly as it was, so only the SOURCE of the identity
  // changes here, not the wording either caller emits.
  const editors = outcome.origins.map((origin) => {
    const fields = resolution.directory ? resolution.directory.get(origin.userId) : null;
    return {
      key: origin.agentName ? `${origin.userId}:${origin.agentName}` : origin.userId,
      name: (fields && fields.userName) || origin.agentName || 'another collaborator',
      isAgent: !!origin.agentName,
      identity: { userId: origin.userId, agentName: origin.agentName },
    };
  });

  if (outcome.unresolved) {
    // Authorship is not determinable. Say so, rather than name the relayer.
    // `identity: null` also means this entry can never be filtered away as the
    // reader's own edit — unknown authorship is always news.
    editors.push({
      key: SYNCED_EDITOR_KEY,
      name: SYNCED_EDITOR_NAME,
      isAgent: false,
      isSynced: true,
      identity: null,
    });
  }
  return editors;
}

/**
 * Distinct editors, other than `agent`, among updates after `sinceClock`.
 *
 * The self-check runs against the RESOLVED identity, not the stamp, so a relayed
 * row is judged by who wrote it rather than by who carried it back. That closes
 * the mirror-image hole: a row stamped with the reader's own identity but
 * carrying someone else's content used to be skipped silently as "mine".
 *
 * @param {Array} updates
 * @param {number} sinceClock
 * @param {{userId: string, agentName: string|null}} agent
 * @param {{resolution?: {outcomes: Map, directory: Map}}} [opts]
 * @returns {Array<{name: string, isAgent: boolean, isSynced?: boolean}>}
 */
function distinctForeignEditors(updates, sinceClock, agent, { resolution } = {}) {
  const editors = new Map(); // dedup key -> editor
  for (const u of updates || []) {
    if (typeof u.clock !== 'number' || u.clock <= sinceClock) continue;
    for (const candidate of editorsForRow(u, resolution)) {
      if (candidate.identity && isSameIdentity(candidate.identity, agent)) continue;
      if (editors.has(candidate.key)) continue;
      const entry = { name: candidate.name, isAgent: candidate.isAgent };
      if (candidate.isSynced) entry.isSynced = true;
      editors.set(candidate.key, entry);
    }
  }
  return [...editors.values()];
}

/**
 * Split a resolved editor list into the names that may appear in an "edited by"
 * sentence and whether any change was unattributable.
 *
 * Both callers need this split and neither may improvise it: the unattributable
 * bucket exists precisely so that nothing has to invent a name for it.
 *
 * @param {Array<{name: string, isSynced?: boolean}>} editors
 * @returns {{names: string[], hasUnattributed: boolean}}
 */
function splitEditors(editors) {
  const list = editors || [];
  return {
    names: list.filter(e => !e.isSynced).map(e => e.name),
    hasUnattributed: list.some(e => e.isSynced),
  };
}

module.exports = {
  editorsForRow,
  distinctForeignEditors,
  splitEditors,
  SYNCED_EDITOR_KEY,
  SYNCED_EDITOR_NAME,
};
