/**
 * Document snapshot deduplication for model messages.
 *
 * The assistant accumulates full-document snapshots two ways:
 *   - read_document / read_document_version results
 *   - modify results, which echo the updated document content
 *
 * Keeping every snapshot in context wastes the window and lets the model act
 * on a stale copy. We keep only the most recent full-document snapshot per
 * document in full and stub the older ones. A modify supersedes an earlier
 * full read of the same document (and vice versa), since both describe the
 * whole document at a point in time. Partial (xpath-scoped) reads are
 * deduplicated per (docGuid + xpath + format) on their own track.
 *
 * This mirrors the pattern used by tools like Claude Code, where re-reading a
 * file replaces the previous read rather than accumulating.
 */

const SUPERSEDED_STUB = {
  type: 'text',
  value: '[Previous read, superseded by a more recent snapshot of this document below]',
};

const SUPERSEDED_CONTENT_NOTE =
  '[Updated document content omitted, superseded by a more recent snapshot of this document below]';

/**
 * Build the deduplication group key for a content-producing tool call, or
 * null if the call does not produce a deduplicable document snapshot.
 *
 * - modify: joins the structured full-doc group for its docGuid
 * - read_document_version: per (docGuid, versionId, xpath, format)
 * - read_document WITH xpath: per (docGuid, xpath, format) — partial read
 * - read_document WITHOUT xpath: the full-doc group, per (docGuid, format)
 */
function buildDedupKey(toolName, input) {
  const docGuid = input.docGuid || '';

  if (toolName === 'modify') {
    return `full:${docGuid}:structured`;
  }

  if (toolName === 'read_document_version') {
    const versionId = input.versionId || '';
    const xpath = input.xpath || '';
    const format = input.format || 'structured';
    return `rv:${docGuid}:${versionId}:${xpath}:${format}`;
  }

  if (toolName === 'read_document') {
    const format = input.format || 'structured';
    const xpath = input.xpath || '';
    if (xpath) return `rx:${docGuid}:${xpath}:${format}`;
    return `full:${docGuid}:${format}`;
  }

  return null;
}

/** True when a tool-result output carries document content we can stub. */
function outputHasContent(output) {
  return !!output
    && output.type === 'json'
    && !!output.value
    && typeof output.value === 'object'
    && output.value.content != null;
}

/**
 * Whether a tool call contributed a full/partial document snapshot.
 * Reads always do; a modify only does when it actually changed the doc and
 * echoed content back.
 */
function isContentBearing(toolName, output) {
  if (toolName === 'read_document' || toolName === 'read_document_version') return true;
  if (toolName === 'modify') return outputHasContent(output);
  return false;
}

/** Replace just the `content` field of a modify result, keeping the rest. */
function stubModifyContent(output) {
  if (!outputHasContent(output)) return output;
  const { content, ...rest } = output.value;
  return { ...output, value: { ...rest, content: SUPERSEDED_CONTENT_NOTE } };
}

/**
 * Deduplicate repeated document snapshots across read_document,
 * read_document_version, and modify results.
 *
 * Within each group only the most recent content-bearing snapshot is kept;
 * earlier ones are stubbed. Read results are replaced wholesale with a short
 * stub; modify results keep their metadata (changed, summary, diff) and only
 * lose the echoed content. Tool-call parts in assistant messages are
 * preserved untouched.
 *
 * Pure function: returns a new array without modifying the input.
 *
 * @param {Array} messages - Model-format messages from convertToModelMessages()
 * @returns {Array} Messages with superseded snapshots stubbed out
 */
function deduplicateReadResults(messages) {
  // Phase 1: index tool-result outputs by toolCallId.
  const outputById = new Map();
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === 'tool-result') outputById.set(part.toolCallId, part.output);
    }
  }

  // Phase 2: group content-bearing tool calls by dedup key, in order.
  // Map<dedupKey, { toolCallId, toolName }[]>
  const dedupGroups = new Map();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== 'tool-call') continue;
      const dedupKey = buildDedupKey(part.toolName, part.input || {});
      if (!dedupKey) continue;
      if (!isContentBearing(part.toolName, outputById.get(part.toolCallId))) continue;

      if (!dedupGroups.has(dedupKey)) dedupGroups.set(dedupKey, []);
      dedupGroups.get(dedupKey).push({ toolCallId: part.toolCallId, toolName: part.toolName });
    }
  }

  // Phase 3: every snapshot but the last in its group is superseded.
  const supersededIds = new Map(); // toolCallId -> toolName
  for (const [, entries] of dedupGroups) {
    if (entries.length <= 1) continue;
    for (let i = 0; i < entries.length - 1; i++) {
      supersededIds.set(entries[i].toolCallId, entries[i].toolName);
    }
  }

  if (supersededIds.size === 0) return messages;

  // Phase 4: clone affected tool messages and stub superseded outputs.
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
        if (supersededIds.get(part.toolCallId) === 'modify') {
          return { ...part, output: stubModifyContent(part.output) };
        }
        return { ...part, output: SUPERSEDED_STUB };
      }),
    };
  });
}

module.exports = {
  deduplicateReadResults,
  buildDedupKey,
  SUPERSEDED_STUB,
  SUPERSEDED_CONTENT_NOTE,
};
