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
 * Remove hard-break markers (a trailing backslash the canonical serializer emits
 * immediately before a newline for a `hardBreak`) from a full canonical markdown
 * serialization, keyed on the serializer's own grammar (feature 028, FR-002/FR-003).
 *
 * A trailing backslash on line L is a hard-break marker — and exactly one is
 * removed — if and only if BOTH:
 *   (a) L lies outside every fenced block (code fences and diagram fences alike,
 *       RBD-3). Fence state is a whole-document property: it toggles on any line
 *       whose content, after its container prefix (a leading blockquote `>`-run
 *       and/or list/task indentation) is removed, begins with a ``` fence.
 *   (b) L has a continuation line in the same paragraph-like block: line L+1
 *       exists and, after its own container prefix is removed, is non-empty.
 *       (Inline text carries no literal newlines and the serializer never escapes
 *       inline backslashes, so every within-block line break is a hard break and
 *       always carries the marker last — this makes the test grammar-exact.)
 *
 * A backslash that fails this test is preserved byte-for-byte: fenced content, a
 * block-final trailing backslash (RBD-1: literal content OR trailing hard break —
 * grammar-ambiguous, preserved), and any backslash not at end of line. Newlines are
 * never touched, so line counts are invariant (FR-006).
 *
 * @param {string} markdown - A full canonical markdown serialization.
 * @returns {string} The same string with all and only its hard-break markers removed.
 */
function stripHardBreakMarkers(markdown) {
  // Remove a leading container-continuation prefix: any run of blockquote `>`
  // markers and/or list/task indentation whitespace. Used both to detect fences
  // under a container prefix and to test whether a continuation line is non-empty.
  const stripContainerPrefix = (line) => line.replace(/^[\s>]+/, '');

  const lines = markdown.split('\n');
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const content = stripContainerPrefix(line);

    // Fence boundary (opening or closing). Fence lines never carry a marker, so
    // toggle and move on, leaving the line unchanged.
    if (content.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    // Inside a fenced block, a trailing backslash is verbatim content.
    if (inFence) continue;

    if (!line.endsWith('\\')) continue;

    // Continuation test: the next physical line must exist and be non-empty
    // after its container prefix is removed. A block-final backslash (next line
    // empty / a bare `>` separator / EOF) is preserved (RBD-1).
    const next = lines[i + 1];
    if (next === undefined) continue;
    if (stripContainerPrefix(next).length === 0) continue;

    // Strip exactly one trailing backslash (handles `text\\` → `text\`).
    lines[i] = line.slice(0, -1);
  }

  return lines.join('\n');
}

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

module.exports = { computeChatDiff, stripHardBreakMarkers };
