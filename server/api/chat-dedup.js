/**
 * Read result deduplication for model messages.
 *
 * When the assistant reads the same document multiple times in a conversation,
 * only the most recent read result is kept in full. Older results are replaced
 * with a short stub to save context window space.
 *
 * This mirrors the pattern used by tools like Claude Code, where re-reading a
 * file replaces the previous read rather than accumulating.
 */

const DEDUP_TOOL_NAMES = new Set(['read_document', 'read_document_version']);

const SUPERSEDED_STUB = {
  type: 'text',
  value: '[Previous read — superseded by a more recent read of this document below]',
};

/**
 * Build a deduplication key from a tool call's input.
 * Groups by toolName + docGuid + xpath + format (+ versionId for version reads).
 */
function buildDedupKey(toolName, input) {
  const docGuid = input.docGuid || '';
  const xpath = input.xpath || '';
  const format = input.format || 'structured';

  if (toolName === 'read_document_version') {
    const versionId = input.versionId || '';
    return `${toolName}:${docGuid}:${versionId}:${xpath}:${format}`;
  }
  return `${toolName}:${docGuid}:${xpath}:${format}`;
}

/**
 * Deduplicate repeated read_document / read_document_version results.
 *
 * When the same document (same docGuid + xpath + format) has been read multiple
 * times, only the most recent result is kept. Older results are replaced with a
 * short stub. Tool-call parts in assistant messages are preserved.
 *
 * Pure function: returns a new array without modifying the input.
 *
 * @param {Array} messages - Model-format messages from convertToModelMessages()
 * @returns {Array} Messages with superseded read results stubbed out
 */
function deduplicateReadResults(messages) {
  // Phase 1: Index all read tool calls from assistant messages
  // Map<dedupKey, toolCallId[]> — ordered by appearance
  const dedupGroups = new Map();

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (part.type !== 'tool-call' || !DEDUP_TOOL_NAMES.has(part.toolName)) continue;

      const dedupKey = buildDedupKey(part.toolName, part.input || {});

      if (!dedupGroups.has(dedupKey)) {
        dedupGroups.set(dedupKey, []);
      }
      dedupGroups.get(dedupKey).push(part.toolCallId);
    }
  }

  // Phase 2: Identify superseded toolCallIds (all but the last per group)
  const supersededIds = new Set();
  for (const [, ids] of dedupGroups) {
    if (ids.length <= 1) continue;
    for (let i = 0; i < ids.length - 1; i++) {
      supersededIds.add(ids[i]);
    }
  }

  if (supersededIds.size === 0) return messages;

  // Phase 3: Clone affected tool messages and replace superseded outputs
  return messages.map(msg => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    const hasSuperseded = msg.content.some(
      part => part.type === 'tool-result' && supersededIds.has(part.toolCallId)
    );
    if (!hasSuperseded) return msg;

    return {
      ...msg,
      content: msg.content.map(part => {
        if (part.type !== 'tool-result' || !supersededIds.has(part.toolCallId)) return part;
        return { ...part, output: SUPERSEDED_STUB };
      }),
    };
  });
}

module.exports = { deduplicateReadResults, buildDedupKey, SUPERSEDED_STUB };
