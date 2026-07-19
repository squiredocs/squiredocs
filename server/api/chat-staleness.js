/**
 * Concurrent-edit awareness helpers.
 *
 * The agent caches document content from its read_document and modify results.
 * When someone else (another user, or the human typing directly) edits the same
 * document, that cache goes stale and the agent risks discussing or overwriting
 * content it can no longer see. These helpers reconstruct, from the conversation
 * history plus the document's update log, the agent's last-seen clock per
 * document and who has edited since.
 *
 * Pure functions only — the database read lives in the chat endpoint.
 */

// Tool calls whose results reflect the *current* document (not a historical
// version) and therefore advance the agent's baseline view.
const SNAPSHOT_TOOLS = new Set(['read_document', 'modify']);

/**
 * Whether a tool call is a snapshot of CURRENT content. A read_document call
 * WITH versionId returns historical content (feature 019 DR-1) — it must
 * neither advance the observed-clock baseline nor count as the agent's
 * latest view of the document.
 */
function isCurrentSnapshotCall(toolName, input) {
  return SNAPSHOT_TOOLS.has(toolName) && !(input && input.versionId);
}

/**
 * Highest document clock the agent has observed per document, derived from its
 * read_document / modify tool results. Edits beyond this clock that the agent
 * did not make are news to the agent.
 *
 * @param {Array} messages - model-format messages (from convertToModelMessages)
 * @returns {Map<string, number>} docGuid -> max observed clock
 */
function getObservedClocks(messages) {
  // toolCallId -> docGuid, from assistant tool-calls.
  const docByCall = new Map();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === 'tool-call' && isCurrentSnapshotCall(part.toolName, part.input) && part.input?.docGuid) {
        docByCall.set(part.toolCallId, part.input.docGuid);
      }
    }
  }

  const observed = new Map();
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== 'tool-result') continue;
      const docGuid = docByCall.get(part.toolCallId);
      if (!docGuid) continue;
      const clock = part.output?.value?.clock;
      if (typeof clock !== 'number') continue;
      const prev = observed.get(docGuid);
      if (prev === undefined || clock > prev) observed.set(docGuid, clock);
    }
  }
  return observed;
}

/**
 * Documents whose most recent snapshot in the agent's view is a `modify` the
 * user has since undone (via the chat Undo button). The undo runs out-of-band
 * through the agent's own identity, so foreignEditsSince can't see it as a
 * change — but the revert is recorded as `reverted: true` on the persisted
 * modify tool part. A doc qualifies only while that reverted modify is still the
 * agent's latest read/modify of it; a later read_document clears it (the agent
 * has re-read the reverted content), as does a redo (which clears `reverted`).
 *
 * @param {Array} messages - stored UI-format messages ({ parts: [...] })
 * @returns {Set<string>} docGuids whose latest agent edit is currently undone
 */
function getRevertedDocs(messages) {
  const lastSnapshot = new Map(); // docGuid -> { toolName, reverted }
  for (const msg of messages) {
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
      const toolName = part.toolName
        || (typeof part.type === 'string' && part.type.startsWith('tool-') ? part.type.slice(5) : null);
      if (!toolName || !isCurrentSnapshotCall(toolName, part.input)) continue;
      const docGuid = part.input?.docGuid;
      if (!docGuid) continue;
      lastSnapshot.set(docGuid, { toolName, reverted: part.reverted === true });
    }
  }
  const reverted = new Set();
  for (const [docGuid, snap] of lastSnapshot) {
    if (snap.toolName === 'modify' && snap.reverted) reverted.add(docGuid);
  }
  return reverted;
}

/**
 * Distinct editors, other than this agent, among updates after `sinceClock`.
 * The agent's own edits carry its agentName + userId; the human typing directly
 * carries a null agentName, and other users carry their own userId — all of
 * those count as foreign.
 *
 * @param {Array} updates - [{ clock, userId, agentName, userName }]
 * @param {number} sinceClock
 * @param {{ userId: string, agentName: string }} agent
 * @returns {Array<{ name: string, isAgent: boolean }>} distinct foreign editors
 */
function foreignEditsSince(updates, sinceClock, agent) {
  const editors = new Map(); // dedup key -> editor
  for (const u of updates) {
    if (typeof u.clock !== 'number' || u.clock <= sinceClock) continue;
    const isOwnAgent = u.agentName === agent.agentName && u.userId === agent.userId;
    if (isOwnAgent) continue;
    const key = u.agentName ? `${u.userId}:${u.agentName}` : (u.userId || 'unknown');
    if (!editors.has(key)) {
      editors.set(key, {
        name: u.userName || u.agentName || 'another collaborator',
        isAgent: !!u.agentName,
      });
    }
  }
  return [...editors.values()];
}

/**
 * Build a short context note listing documents that changed outside the
 * conversation, or null when nothing is stale.
 *
 * @param {Array<{ title: string|null, docGuid: string, editors: Array<{name}>, reverted?: boolean }>} entries
 * @returns {string|null}
 */
function buildStalenessNote(entries) {
  if (!entries || entries.length === 0) return null;
  const lines = entries.map(e => {
    const label = e.title ? `"${e.title}"` : e.docGuid;
    if (e.reverted && (!e.editors || e.editors.length === 0)) {
      return `- ${label}: your earlier edit was undone by the user and is no longer in the document.`;
    }
    const names = e.editors.map(ed => ed.name).join(', ');
    return `- ${label} was edited by ${names} since you last read it.`;
  });
  return '[System note: these documents changed outside this conversation]\n'
    + lines.join('\n') + '\n'
    + 'Silently re-read each document listed above before relying on its content or '
    + 'editing it. Do NOT tell the user that the document changed or that you are about '
    + 'to re-read it — just re-read it. Only after re-reading, mention the change if it '
    + "is relevant to the user's request; otherwise stay silent about it.";
}

module.exports = {
  getObservedClocks,
  getRevertedDocs,
  foreignEditsSince,
  buildStalenessNote,
  SNAPSHOT_TOOLS,
  isCurrentSnapshotCall,
};
