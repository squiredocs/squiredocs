/**
 * Diff computation utilities for Yjs documents
 * Compares two Y.Doc states and generates diff information for visualization
 */

import { diffWords, diffChars } from 'diff';
import * as Y from 'yjs';

/**
 * Extract text content from a Y.XmlText node using toDelta() for accuracy
 * @param {Y.XmlText} xmlText - Yjs XML text node
 * @returns {string} Plain text content
 */
function extractTextFromXmlText(xmlText) {
  if (!(xmlText instanceof Y.XmlText)) return '';
  const delta = xmlText.toDelta();
  return delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');
}

/**
 * Recursively extract text from a Y.XmlElement
 * @param {Y.XmlElement|Y.XmlText} node - Yjs XML node
 * @returns {string} Plain text content
 */
function extractTextFromNode(node) {
  if (node instanceof Y.XmlText) {
    return extractTextFromXmlText(node);
  }
  if (node instanceof Y.XmlElement) {
    let text = '';
    for (let i = 0; i < node.length; i++) {
      text += extractTextFromNode(node.get(i));
    }
    return text;
  }
  return '';
}

/**
 * Extract blocks from a Y.Doc for comparison
 * @param {Y.Doc} ydoc - Yjs document
 * @returns {Array<{type: string, text: string, attrs: Object}>} Array of block objects
 */
export function extractBlocks(ydoc) {
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  const blocks = [];

  for (let i = 0; i < xmlFragment.length; i++) {
    const node = xmlFragment.get(i);
    if (node instanceof Y.XmlElement) {
      blocks.push({
        type: node.nodeName,
        text: extractTextFromNode(node),
        attrs: node.getAttributes(),
      });
    } else if (node instanceof Y.XmlText) {
      blocks.push({
        type: 'text',
        text: extractTextFromXmlText(node),
        attrs: {},
      });
    }
  }

  return blocks;
}

/**
 * Get full text content from a Y.Doc
 * @param {Y.Doc} ydoc - Yjs document
 * @returns {string} Full document text
 */
export function getDocumentText(ydoc) {
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  let text = '';

  for (let i = 0; i < xmlFragment.length; i++) {
    const node = xmlFragment.get(i);
    text += extractTextFromNode(node);
    // Add newline between blocks
    if (i < xmlFragment.length - 1) {
      text += '\n';
    }
  }

  return text;
}

/**
 * Compute diff between two Y.Doc states
 * @param {Uint8Array|null} prevContent - Previous version content (encoded state)
 * @param {Uint8Array} currentContent - Current version content (encoded state)
 * @returns {Object} Diff result with changes and summary
 */
export function computeDiff(prevContent, currentContent) {
  // Create Y.Docs from content
  const currentYdoc = new Y.Doc();
  Y.applyUpdate(currentYdoc, currentContent);
  const currentText = getDocumentText(currentYdoc);

  // If no previous content, everything is "added"
  if (!prevContent) {
    return {
      changes: [{
        type: 'added',
        value: currentText,
        from: 0,
        to: currentText.length,
      }],
      summary: {
        added: currentText.length,
        removed: 0,
        unchanged: 0,
      },
      prevText: '',
      currentText,
    };
  }

  const prevYdoc = new Y.Doc();
  Y.applyUpdate(prevYdoc, prevContent);
  const prevText = getDocumentText(prevYdoc);

  // Use diffWords for readable diffs
  const diffs = diffWords(prevText, currentText);

  // Convert diffs to positional changes in the current document
  const changes = [];
  let currentPos = 0;
  let prevPos = 0;
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  for (const part of diffs) {
    if (part.added) {
      changes.push({
        type: 'added',
        value: part.value,
        from: currentPos,
        to: currentPos + part.value.length,
      });
      currentPos += part.value.length;
      added += part.value.length;
    } else if (part.removed) {
      // For removed content, we track where it was in the previous doc
      // but show it at the current position as a "ghost" deletion
      changes.push({
        type: 'removed',
        value: part.value,
        from: currentPos,
        to: currentPos, // Same position since it doesn't exist in current
        originalFrom: prevPos,
        originalTo: prevPos + part.value.length,
      });
      prevPos += part.value.length;
      removed += part.value.length;
    } else {
      // Unchanged content
      changes.push({
        type: 'unchanged',
        value: part.value,
        from: currentPos,
        to: currentPos + part.value.length,
      });
      currentPos += part.value.length;
      prevPos += part.value.length;
      unchanged += part.value.length;
    }
  }

  return {
    changes,
    summary: { added, removed, unchanged },
    prevText,
    currentText,
  };
}

/**
 * Compute block-level diff between two Y.Doc states
 * More suitable for document structure comparison
 * @param {Uint8Array|null} prevContent - Previous version content
 * @param {Uint8Array} currentContent - Current version content
 * @returns {Object} Block-level diff result
 */
export function computeBlockDiff(prevContent, currentContent) {
  const currentYdoc = new Y.Doc();
  Y.applyUpdate(currentYdoc, currentContent);
  const currentBlocks = extractBlocks(currentYdoc);

  if (!prevContent) {
    return {
      blocks: currentBlocks.map((block, i) => ({
        ...block,
        status: 'added',
        index: i,
      })),
      summary: {
        added: currentBlocks.length,
        removed: 0,
        modified: 0,
        unchanged: 0,
      },
    };
  }

  const prevYdoc = new Y.Doc();
  Y.applyUpdate(prevYdoc, prevContent);
  const prevBlocks = extractBlocks(prevYdoc);

  // Simple block comparison using LCS (longest common subsequence) approach
  const result = [];
  let prevIdx = 0;
  let currIdx = 0;
  let added = 0;
  let removed = 0;
  let modified = 0;
  let unchanged = 0;

  // Create maps for faster lookup
  const prevTextMap = new Map();
  prevBlocks.forEach((b, i) => {
    const key = `${b.type}:${b.text}`;
    if (!prevTextMap.has(key)) prevTextMap.set(key, []);
    prevTextMap.get(key).push(i);
  });

  // Track which prev blocks have been matched
  const matchedPrev = new Set();

  for (let i = 0; i < currentBlocks.length; i++) {
    const curr = currentBlocks[i];
    const key = `${curr.type}:${curr.text}`;
    const prevMatches = prevTextMap.get(key);

    if (prevMatches && prevMatches.length > 0) {
      // Find unmatched prev block
      const unmatchedIdx = prevMatches.find(idx => !matchedPrev.has(idx));
      if (unmatchedIdx !== undefined) {
        matchedPrev.add(unmatchedIdx);
        result.push({
          ...curr,
          status: 'unchanged',
          index: i,
          prevIndex: unmatchedIdx,
        });
        unchanged++;
        continue;
      }
    }

    // Check if block type matches but text differs (modified)
    let isModified = false;
    for (let j = 0; j < prevBlocks.length; j++) {
      if (!matchedPrev.has(j) && prevBlocks[j].type === curr.type) {
        // Similar position, different content = modified
        if (Math.abs(j - i) <= 2) {
          matchedPrev.add(j);
          result.push({
            ...curr,
            status: 'modified',
            index: i,
            prevIndex: j,
            prevText: prevBlocks[j].text,
          });
          modified++;
          isModified = true;
          break;
        }
      }
    }

    if (!isModified) {
      result.push({
        ...curr,
        status: 'added',
        index: i,
      });
      added++;
    }
  }

  // Find removed blocks (those not matched)
  for (let j = 0; j < prevBlocks.length; j++) {
    if (!matchedPrev.has(j)) {
      result.push({
        ...prevBlocks[j],
        status: 'removed',
        prevIndex: j,
        index: -1,
      });
      removed++;
    }
  }

  // Sort by index to maintain order
  result.sort((a, b) => {
    if (a.index === -1) return 1;
    if (b.index === -1) return -1;
    return a.index - b.index;
  });

  return {
    blocks: result,
    summary: { added, removed, modified, unchanged },
  };
}

/**
 * Create inline diff annotations for text content
 * @param {string} prevText - Previous text
 * @param {string} currentText - Current text
 * @returns {Array} Array of diff segments with types
 */
export function createInlineDiff(prevText, currentText) {
  const diffs = diffChars(prevText, currentText);
  const segments = [];
  let pos = 0;

  for (const part of diffs) {
    if (part.added) {
      segments.push({
        type: 'added',
        text: part.value,
        from: pos,
        to: pos + part.value.length,
      });
      pos += part.value.length;
    } else if (part.removed) {
      segments.push({
        type: 'removed',
        text: part.value,
        from: pos,
        to: pos,
      });
    } else {
      segments.push({
        type: 'unchanged',
        text: part.value,
        from: pos,
        to: pos + part.value.length,
      });
      pos += part.value.length;
    }
  }

  return segments;
}

/**
 * Get diff summary statistics
 * @param {Object} diff - Diff result from computeDiff
 * @returns {string} Human-readable summary
 */
export function getDiffSummary(diff) {
  const { added, removed, unchanged } = diff.summary;
  const parts = [];

  if (added > 0) parts.push(`+${added} chars`);
  if (removed > 0) parts.push(`-${removed} chars`);
  if (parts.length === 0) return 'No changes';

  return parts.join(', ');
}

export default {
  extractBlocks,
  getDocumentText,
  computeDiff,
  computeBlockDiff,
  createInlineDiff,
  getDiffSummary,
};
