/**
 * Shared diff utilities for the AI chat inline diff view.
 *
 * Computes a structured diff from two markdown strings, suitable for
 * rendering as a line-by-line table in the chat UI.
 */

const { structuredPatch } = require('diff');
const { postProcessDiffLines } = require('./diff-postprocess');

const MAX_DIFF_CHARS = 50000;
const MAX_DIFF_LINES = 200;

/**
 * Compute a chat-friendly diff between two markdown strings.
 *
 * @param {string} mdBefore - Markdown before the change
 * @param {string} mdAfter  - Markdown after the change
 * @returns {{ lines: string[], hunkStarts: Array, formatAnnotations?: object, truncatedByServer?: boolean } | null}
 */
function computeChatDiff(mdBefore, mdAfter) {
  const patch = structuredPatch('', '', mdBefore, mdAfter, '', '', { context: 2 });
  const lines = [];
  const hunkStarts = [];
  for (let h = 0; h < patch.hunks.length; h++) {
    if (h > 0) lines.push('~~~');
    hunkStarts.push({ index: lines.length, oldStart: patch.hunks[h].oldStart, newStart: patch.hunks[h].newStart });
    for (const line of patch.hunks[h].lines) {
      if (line === '\\ No newline at end of file') continue;
      lines.push(line);
    }
  }

  // Post-process: strip <span style> tags, detect format-only pairs
  const processed = postProcessDiffLines(lines, hunkStarts);

  const totalChars = processed.lines.reduce((sum, l) => sum + l.length, 0);
  if (totalChars > MAX_DIFF_CHARS) {
    return {
      lines: processed.lines.slice(0, MAX_DIFF_LINES),
      hunkStarts: processed.hunkStarts.filter(hs => hs.index < MAX_DIFF_LINES),
      formatAnnotations: processed.formatAnnotations
        ? Object.fromEntries(Object.entries(processed.formatAnnotations).filter(([k]) => Number(k) < MAX_DIFF_LINES))
        : undefined,
      // inlineSegments keys are OUTPUT line indices, exactly like
      // formatAnnotations — filter to survivors so no key references a
      // truncated-away line (feature 022, FR-005).
      inlineSegments: processed.inlineSegments
        ? Object.fromEntries(Object.entries(processed.inlineSegments).filter(([k]) => Number(k) < MAX_DIFF_LINES))
        : undefined,
      truncatedByServer: true,
    };
  }

  return {
    lines: processed.lines,
    hunkStarts: processed.hunkStarts,
    formatAnnotations: processed.formatAnnotations,
    inlineSegments: processed.inlineSegments,
  };
}

module.exports = { computeChatDiff };
