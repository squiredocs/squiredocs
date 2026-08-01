/**
 * Post-process diff lines for the AI chat inline diff view.
 *
 * Strips noisy <span style="..."> wrappers from all diff lines so the
 * rendered diff is human-readable, and detects formatting-only changes
 * (identical text, different formatting) so they can be collapsed into
 * a single annotated line instead of an unreadable -/+ pair.
 */

// Namespace import on purpose (same rationale as server/diff/apply-word-marks.js):
// calling through the module namespace lets tests observe/inject the shared
// segmenter with jest.spyOn, which is how the two-surface parity suite proves
// both surfaces segment at the same granularity.
const wordDiff = require('../../shared/diff/word-diff');

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
  const inlineSegments = {}; // inlineSegments[outputLineIdx] = Segment[] (feature 022)
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

    // Collect a block of consecutive '-' lines followed by consecutive '+' lines
    // and match them pairwise for formatting-only detection.
    if (line[0] === '-') {
      const delStart = i;
      while (i < lines.length && lines[i][0] === '-') i++;
      const addStart = i;
      while (i < lines.length && lines[i][0] === '+') i++;
      const delLines = lines.slice(delStart, addStart);
      const addLines = lines.slice(addStart, i);

      // Try pairwise format-only matching when block sizes are equal
      if (delLines.length === addLines.length && delLines.length > 0) {
        let allFormatOnly = true;
        for (let j = 0; j < delLines.length; j++) {
          const plainOld = extractPlainText(delLines[j]);
          const plainNew = extractPlainText(addLines[j]);
          if (plainOld !== plainNew || plainOld.trim() === '') {
            allFormatOnly = false;
            break;
          }
        }
        if (allFormatOnly) {
          for (let j = 0; j < delLines.length; j++) {
            const annotation = describeFormattingDiff(delLines[j].slice(1), addLines[j].slice(1));
            const delIdx = result.length;
            result.push('-' + stripSpanTags(delLines[j].slice(1)));
            indexMap[delStart + j] = delIdx;
            const addIdx = result.length;
            result.push('+' + stripSpanTags(addLines[j].slice(1)));
            indexMap[addStart + j] = addIdx;
            if (annotation) formatAnnotations[addIdx] = annotation;
          }
          continue;
        }
      }

      // Not format-only — emit all lines normally, tracking each row's OUTPUT
      // index so we can attach word-level segments to the paired rows.
      const delOutIdx = [];
      for (let j = delStart; j < addStart; j++) {
        indexMap[j] = result.length;
        delOutIdx.push(result.length);
        result.push(lines[j][0] + stripSpanTags(lines[j].slice(1)));
      }
      const addOutIdx = [];
      for (let j = addStart; j < i; j++) {
        indexMap[j] = result.length;
        addOutIdx.push(result.length);
        result.push(lines[j][0] + stripSpanTags(lines[j].slice(1)));
      }

      // Word-level inline diff (feature 022, reworked in 039 FR-008..010).
      //
      // This used to pair rows POSITIONALLY — k-th removed against k-th added,
      // up to min(delCount, addCount) — which disagreed with the version-history
      // surface in two visible ways: a row inserted at the top of a block made
      // every following row compare against its neighbour and light up as
      // changed, and surplus rows past the shorter side got no emphasis at all.
      // Now the REGION is the unit on both surfaces: one segmentation over all
      // rows, split back out per row (SC-003 parity).
      //
      // Segment the SAME prefix- and span-stripped strings the rows render, so
      // the per-row rejoin invariant is a statement about displayed text (CS-2).
      const beforeLines = delOutIdx.map((_, k) => stripSpanTags(lines[delStart + k].slice(1)));
      const afterLines = addOutIdx.map((_, k) => stripSpanTags(lines[addStart + k].slice(1)));
      const perRow = wordDiff.computeLineWordSegments(beforeLines, afterLines);
      if (perRow) {
        // Every row on BOTH sides gets segments — no Math.min anywhere (LS-5).
        delOutIdx.forEach((outIdx, k) => { inlineSegments[outIdx] = perRow.before[k]; });
        addOutIdx.forEach((outIdx, k) => { inlineSegments[outIdx] = perRow.after[k]; });
      }
      // perRow === null → oversized or slow region: emit NO inlineSegments for
      // the whole region, row tint only (FR-010, fail-open). The guardrails now
      // apply to the joined region, exactly as they do on the version-history
      // side, so the two surfaces degrade together.
      continue;
    }

    // Context line — strip span tags, keep prefix
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
    inlineSegments: Object.keys(inlineSegments).length > 0 ? inlineSegments : undefined,
  };
}

module.exports = { postProcessDiffLines, stripSpanTags, extractPlainText, describeMarks };
