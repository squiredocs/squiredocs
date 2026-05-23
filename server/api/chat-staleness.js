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
      if (part.type === 'tool-call' && SNAPSHOT_TOOLS.has(part.toolName) && part.input?.docGuid) {
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
 * @param {Array<{ title: string|null, docGuid: string, editors: Array<{name}> }>} entries
 * @returns {string|null}
 */
function buildStalenessNote(entries) {
  if (!entries || entries.length === 0) return null;
  const lines = entries.map(e => {
    const label = e.title ? `"${e.title}"` : e.docGuid;
    const names = e.editors.map(ed => ed.name).join(', ');
    return `- ${label} was edited by ${names} since you last read it. `
      + 'Re-read it before relying on its content or editing it.';
  });
  return '[System note: these documents changed outside this conversation]\n' + lines.join('\n');
}

module.exports = {
  getObservedClocks,
  foreignEditsSince,
  buildStalenessNote,
  SNAPSHOT_TOOLS,
};
