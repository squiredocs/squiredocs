/**
 * Post-process diff lines for the AI chat inline diff view.
 *
 * Strips noisy <span style="..."> wrappers from all diff lines so the
 * rendered diff is human-readable, and detects formatting-only changes
 * (identical text, different formatting) so they can be collapsed into
 * a single annotated line instead of an unreadable -/+ pair.
 */

// ---------------------------------------------------------------------------
// Stripping helpers
// ---------------------------------------------------------------------------

/** Strip <span style="...">content</span> → content.  Keeps inner HTML. */
function stripSpanTags(line) {
  // Non-greedy: each span wraps a single text segment (toMarkdown never nests spans)
  return line.replace(/<span\s+style="[^"]*">([\s\S]*?)<\/span>/g, '$1');
}

/**
 * Strip ALL inline formatting to get plain text (for equality comparison).
 * Removes the diff prefix (first char), HTML tags, and markdown marks.
 */
function extractPlainText(diffLine) {
  return diffLine
    .slice(1)                        // remove -/+/space prefix
    .replace(/<[^>]*>/g, '')         // HTML tags (<u>, <mark>, <span>, etc.)
    .replace(/\*\*/g, '')            // bold
    .replace(/~~/g, '')              // strikethrough
    .replace(/`/g, '')               // code
    .replace(/(^|[^\\])_/g, '$1');   // italic (preserve escaped \_)
}

// ---------------------------------------------------------------------------
// Format description helpers
// ---------------------------------------------------------------------------

/**
 * Extract human-readable formatting descriptors from a raw markdown line.
 * Returns a deduplicated array like ['bold', 'italic', 'red'].
 */
function describeMarks(mdLine) {
  const marks = [];

  // Markdown-syntax marks
  if (/\*\*/.test(mdLine)) marks.push('bold');
  if (/(^|[^\\*])_[^_]/.test(mdLine)) marks.push('italic');
  if (/~~/.test(mdLine)) marks.push('strikethrough');
  if (/`[^`]/.test(mdLine)) marks.push('code');

  // HTML tag marks
  if (/<u>/i.test(mdLine)) marks.push('underline');
  if (/<mark>/i.test(mdLine)) marks.push('highlight');
  if (/<sub>/i.test(mdLine)) marks.push('subscript');
  if (/<sup>/i.test(mdLine)) marks.push('superscript');

  // Span style properties (skip line-height — it's never user-facing)
  // font-size IS included because actual size changes should be annotated;
  // the default 17px cancels out in describeFormattingDiff since both sides have it.
  const spanRe = /<span\s+style="([^"]+)">/g;
  let m;
  while ((m = spanRe.exec(mdLine)) !== null) {
    const style = m[1];
    const color = style.match(/(?<!background-)color:\s*([^;]+)/);
    if (color) marks.push(color[1].trim());
    const bg = style.match(/background-color:\s*([^;]+)/);
    if (bg) marks.push('bg:' + bg[1].trim());
    const font = style.match(/font-family:\s*([^;]+)/);
    if (font) marks.push('font:' + font[1].trim());
    const size = style.match(/font-size:\s*([^;]+)/);
    if (size) marks.push('size:' + size[1].trim());
  }

  return [...new Set(marks)];
}

/**
 * Build a human-readable annotation for a formatting-only change.
 * Shows only what actually changed (marks in old but not new, and vice versa).
 */
function describeFormattingDiff(oldRaw, newRaw) {
  const oldMarks = describeMarks(oldRaw);
  const newMarks = describeMarks(newRaw);

  const oldSet = new Set(oldMarks);
  const newSet = new Set(newMarks);

  const removed = oldMarks.filter(m => !newSet.has(m));
  const added = newMarks.filter(m => !oldSet.has(m));

  if (removed.length && added.length) return removed.join(', ') + ' \u2192 ' + added.join(', ');
  if (removed.length) return 'removed ' + removed.join(', ');
  if (added.length) return 'added ' + added.join(', ');
  return 'formatting changed';
}

// ---------------------------------------------------------------------------
// Main post-processor
// ---------------------------------------------------------------------------

/**
 * Post-process diff lines produced by structuredPatch().
 *
 * @param {string[]} lines - raw diff lines (prefixed with -, +, or space)
 * @param {Array<{index:number, oldStart:number, newStart:number}>} hunkStarts
 * @returns {{ lines: string[], hunkStarts: Array, formatAnnotations: Object|undefined }}
 */
function postProcessDiffLines(lines, hunkStarts) {
  const result = [];
  const formatAnnotations = {};
  const indexMap = []; // indexMap[oldIdx] = newIdx

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Pass separators through unchanged
    if (line === '~~~') {
      indexMap[i] = result.length;
      result.push(line);
      i++;
      continue;
    }

    // Check for a formatting-only -/+ pair
    if (line[0] === '-' && i + 1 < lines.length && lines[i + 1][0] === '+') {
      const plainOld = extractPlainText(line);
      const plainNew = extractPlainText(lines[i + 1]);

      if (plainOld === plainNew && plainOld.trim() !== '') {
        // Formatting-only change — collapse to annotated context line
        const annotation = describeFormattingDiff(line.slice(1), lines[i + 1].slice(1));
        const newIdx = result.length;
        result.push(' ' + stripSpanTags(lines[i + 1].slice(1)));
        formatAnnotations[newIdx] = annotation;
        indexMap[i] = newIdx;
        indexMap[i + 1] = newIdx;
        i += 2;
        continue;
      }
    }

    // Regular line — strip span tags, keep prefix
    indexMap[i] = result.length;
    result.push(line[0] + stripSpanTags(line.slice(1)));
    i++;
  }

  // Remap hunkStarts indices
  const remappedHunkStarts = hunkStarts.map(hs => ({
    ...hs,
    index: indexMap[hs.index] ?? hs.index,
  }));

  return {
    lines: result,
    hunkStarts: remappedHunkStarts,
    formatAnnotations: Object.keys(formatAnnotations).length > 0 ? formatAnnotations : undefined,
  };
}

module.exports = { postProcessDiffLines, stripSpanTags, extractPlainText, describeMarks };
