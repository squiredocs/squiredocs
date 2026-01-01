/**
 * Cursor Operations for MCP V2 API
 *
 * Utilities for managing cursor positions using Yjs RelativePosition.
 * These positions automatically adjust when the document is edited concurrently.
 */

const Y = require('yjs');

/**
 * Create a cursor position from block index and character offset
 * @param {Y.XmlFragment} xmlFragment - The document fragment
 * @param {number} blockIndex - Block index (0-based)
 * @param {number} charOffset - Character offset within the block
 * @returns {object} JSON-serialized RelativePosition
 */
function createCursorPosition(xmlFragment, blockIndex, charOffset) {
  const blocks = xmlFragment.toArray();

  if (blockIndex < 0 || blockIndex >= blocks.length) {
    throw new Error(`Block index ${blockIndex} out of bounds (0-${blocks.length - 1})`);
  }

  const block = blocks[blockIndex];

  // Find the text node at the specified offset
  let currentOffset = 0;

  function findTextNodeAtOffset(node, targetOffset) {
    if (node instanceof Y.XmlText) {
      const textLength = node.length;
      if (currentOffset + textLength >= targetOffset) {
        // Found the text node containing this offset
        const offsetInNode = targetOffset - currentOffset;
        return { textNode: node, offset: offsetInNode };
      }
      currentOffset += textLength;
    } else if (node instanceof Y.XmlElement) {
      const children = node.toArray();
      for (const child of children) {
        const result = findTextNodeAtOffset(child, targetOffset);
        if (result) return result;
      }
    }
    return null;
  }

  const result = findTextNodeAtOffset(block, charOffset);

  if (!result) {
    // Offset is beyond the block - use the end of the last text node
    function getLastTextNode(node) {
      if (node instanceof Y.XmlText) {
        return node;
      } else if (node instanceof Y.XmlElement) {
        const children = node.toArray();
        if (children.length > 0) {
          return getLastTextNode(children[children.length - 1]);
        }
      }
      return null;
    }

    const lastTextNode = getLastTextNode(block);
    if (!lastTextNode) {
      throw new Error(`Block ${blockIndex} contains no text nodes`);
    }

    const relPos = Y.createRelativePositionFromTypeIndex(lastTextNode, lastTextNode.length);
    return Y.relativePositionToJSON(relPos);
  }

  const relPos = Y.createRelativePositionFromTypeIndex(result.textNode, result.offset);
  return Y.relativePositionToJSON(relPos);
}

/**
 * Resolve a RelativePosition to absolute block index and offset
 * @param {Y.XmlFragment} xmlFragment - The document fragment
 * @param {object} relativePos - JSON RelativePosition
 * @returns {object} { blockIndex, offset, blockType } or null if position is invalid
 */
function resolveCursorPosition(xmlFragment, relativePos) {
  try {
    // Convert JSON back to RelativePosition
    const relPos = Y.createRelativePositionFromJSON(relativePos);

    // Create absolute position
    const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, xmlFragment.doc);

    if (!absPos) {
      return null;  // Position was deleted
    }

    // Find which block and offset this position corresponds to
    const blocks = xmlFragment.toArray();
    let blockIndex = -1;
    let charOffset = 0;
    let blockType = null;

    // Traverse blocks to find the one containing this position
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      let foundInBlock = false;

      function traverse(node, depth = 0) {
        if (foundInBlock) return;

        if (node === absPos.type) {
          // Found the exact node
          blockIndex = i;
          charOffset += absPos.index;
          blockType = block.nodeName;
          foundInBlock = true;
          return;
        }

        if (node instanceof Y.XmlText) {
          if (!foundInBlock) {
            charOffset += node.length;
          }
        } else if (node instanceof Y.XmlElement) {
          const children = node.toArray();
          for (const child of children) {
            traverse(child, depth + 1);
            if (foundInBlock) break;
          }
        }
      }

      // Reset offset for each block
      const prevOffset = charOffset;
      charOffset = 0;
      traverse(block);

      if (foundInBlock) {
        break;
      }

      // This block doesn't contain the position, restore offset
      charOffset = prevOffset;
    }

    if (blockIndex === -1) {
      return null;  // Couldn't find position
    }

    return {
      blockIndex,
      offset: charOffset,
      blockType,
    };
  } catch (error) {
    console.error('[cursor-operations] Error resolving cursor position:', error);
    return null;
  }
}

/**
 * Get text context around a cursor position
 * @param {Y.XmlFragment} xmlFragment - The document fragment
 * @param {object} cursorPos - JSON RelativePosition
 * @param {number} beforeChars - Characters before cursor
 * @param {number} afterChars - Characters after cursor
 * @returns {object} { before, after, blockType } or null if position is invalid
 */
function getCursorContext(xmlFragment, cursorPos, beforeChars = 200, afterChars = 200) {
  const resolved = resolveCursorPosition(xmlFragment, cursorPos);
  if (!resolved) {
    return null;
  }

  // Extract all text from the document
  let allText = '';
  let cursorAbsolutePos = 0;

  function extractText(node) {
    if (node instanceof Y.XmlText) {
      allText += node.toString();
    } else if (node instanceof Y.XmlElement) {
      const children = node.toArray();
      for (const child of children) {
        extractText(child);
      }
    }
  }

  const blocks = xmlFragment.toArray();
  for (let i = 0; i < blocks.length; i++) {
    if (i < resolved.blockIndex) {
      // Count characters in blocks before cursor block
      const tempText = allText;
      extractText(blocks[i]);
      cursorAbsolutePos += (allText.length - tempText.length);
    } else if (i === resolved.blockIndex) {
      // Add offset within current block
      cursorAbsolutePos += resolved.offset;
      extractText(blocks[i]);
    } else {
      // Blocks after cursor
      extractText(blocks[i]);
    }
  }

  const before = allText.substring(Math.max(0, cursorAbsolutePos - beforeChars), cursorAbsolutePos);
  const after = allText.substring(cursorAbsolutePos, cursorAbsolutePos + afterChars);

  return {
    before,
    after,
    blockType: resolved.blockType,
  };
}

/**
 * Move cursor by units (char, word, block)
 * @param {Y.XmlFragment} xmlFragment - The document fragment
 * @param {object} currentPos - Current JSON RelativePosition
 * @param {string} direction - "forward" or "backward"
 * @param {string} unit - "char", "word", or "block"
 * @param {number} count - Number of units to move
 * @returns {object} { newPos, movedCount } or null if current position is invalid
 */
function moveCursor(xmlFragment, currentPos, direction, unit, count) {
  const resolved = resolveCursorPosition(xmlFragment, currentPos);
  if (!resolved) {
    return null;
  }

  const blocks = xmlFragment.toArray();
  let { blockIndex, offset } = resolved;

  if (unit === 'block') {
    // Move by blocks
    const targetBlockIndex = direction === 'forward'
      ? Math.min(blockIndex + count, blocks.length - 1)
      : Math.max(blockIndex - count, 0);

    const actuallyMoved = Math.abs(targetBlockIndex - blockIndex);

    // Move to start or end of target block
    const targetOffset = direction === 'forward' ? 0 : Infinity;

    try {
      const newPos = createCursorPosition(xmlFragment, targetBlockIndex, targetOffset);
      return { newPos, movedCount: actuallyMoved };
    } catch (error) {
      return null;
    }
  }

  if (unit === 'char') {
    // Move by characters
    // Extract text and calculate new position
    let currentAbsPos = 0;

    // Calculate absolute position
    for (let i = 0; i < blockIndex; i++) {
      currentAbsPos += getBlockTextLength(blocks[i]);
    }
    currentAbsPos += offset;

    const totalLength = blocks.reduce((sum, block) => sum + getBlockTextLength(block), 0);

    const targetAbsPos = direction === 'forward'
      ? Math.min(currentAbsPos + count, totalLength)
      : Math.max(currentAbsPos - count, 0);

    const actuallyMoved = Math.abs(targetAbsPos - currentAbsPos);

    // Convert back to block/offset
    const newBlockPos = absolutePositionToBlockOffset(xmlFragment, targetAbsPos);
    if (!newBlockPos) return null;

    try {
      const newPos = createCursorPosition(xmlFragment, newBlockPos.blockIndex, newBlockPos.offset);
      return { newPos, movedCount: actuallyMoved };
    } catch (error) {
      return null;
    }
  }

  if (unit === 'word') {
    // Move by words using word boundaries
    // Extract all text
    const allText = getAllText(xmlFragment);

    // Calculate absolute position
    let currentAbsPos = 0;
    for (let i = 0; i < blockIndex; i++) {
      currentAbsPos += getBlockTextLength(blocks[i]);
    }
    currentAbsPos += offset;

    let targetAbsPos = currentAbsPos;
    let movedWords = 0;

    if (direction === 'forward') {
      // Move forward by words
      for (let i = 0; i < count; i++) {
        const nextBoundary = findNextWordBoundary(allText, targetAbsPos);
        if (nextBoundary === null || nextBoundary === targetAbsPos) break;
        targetAbsPos = nextBoundary;
        movedWords++;
      }
    } else {
      // Move backward by words
      for (let i = 0; i < count; i++) {
        const prevBoundary = findPrevWordBoundary(allText, targetAbsPos);
        if (prevBoundary === null || prevBoundary === targetAbsPos) break;
        targetAbsPos = prevBoundary;
        movedWords++;
      }
    }

    const newBlockPos = absolutePositionToBlockOffset(xmlFragment, targetAbsPos);
    if (!newBlockPos) return null;

    try {
      const newPos = createCursorPosition(xmlFragment, newBlockPos.blockIndex, newBlockPos.offset);
      return { newPos, movedCount: movedWords };
    } catch (error) {
      return null;
    }
  }

  return null;
}

/**
 * Find text from cursor position
 * @param {Y.XmlFragment} xmlFragment - The document fragment
 * @param {object} startPos - Start JSON RelativePosition
 * @param {string} query - Text to search for
 * @param {object} options - Search options
 * @param {string} options.direction - "forward" or "backward"
 * @param {boolean} options.caseSensitive - Case-sensitive search
 * @param {boolean} options.regex - Treat query as regex
 * @param {boolean} options.wrap - Wrap around document
 * @returns {object} { found, position, matchText, matchLength } or null
 */
function findFromCursor(xmlFragment, startPos, query, options = {}) {
  const {
    direction = 'forward',
    caseSensitive = false,
    regex = false,
    wrap = true,
  } = options;

  const resolved = resolveCursorPosition(xmlFragment, startPos);
  if (!resolved) {
    return { found: false };
  }

  const allText = getAllText(xmlFragment);

  // Calculate start position in absolute terms
  const blocks = xmlFragment.toArray();
  let startAbsPos = 0;
  for (let i = 0; i < resolved.blockIndex; i++) {
    startAbsPos += getBlockTextLength(blocks[i]);
  }
  startAbsPos += resolved.offset;

  let searchText = allText;
  let searchPattern = query;

  if (!caseSensitive && !regex) {
    searchText = allText.toLowerCase();
    searchPattern = query.toLowerCase();
  }

  let matchIndex = -1;
  let matchLength = query.length;

  if (regex) {
    // Regex search
    try {
      const flags = caseSensitive ? 'g' : 'gi';
      const re = new RegExp(searchPattern, flags);

      if (direction === 'forward') {
        // Search forward from cursor
        const textFromCursor = searchText.substring(startAbsPos);
        const match = re.exec(textFromCursor);
        if (match) {
          matchIndex = startAbsPos + match.index;
          matchLength = match[0].length;
        } else if (wrap) {
          // Wrap around
          const textBeforeCursor = searchText.substring(0, startAbsPos);
          const matchWrapped = re.exec(textBeforeCursor);
          if (matchWrapped) {
            matchIndex = matchWrapped.index;
            matchLength = matchWrapped[0].length;
          }
        }
      } else {
        // Search backward from cursor
        const textBeforeCursor = searchText.substring(0, startAbsPos);
        const matches = [];
        let match;
        while ((match = re.exec(textBeforeCursor)) !== null) {
          matches.push(match);
        }
        if (matches.length > 0) {
          const lastMatch = matches[matches.length - 1];
          matchIndex = lastMatch.index;
          matchLength = lastMatch[0].length;
        } else if (wrap) {
          // Wrap around
          const textFromCursor = searchText.substring(startAbsPos);
          const matchesWrapped = [];
          while ((match = re.exec(textFromCursor)) !== null) {
            matchesWrapped.push(match);
          }
          if (matchesWrapped.length > 0) {
            const lastMatch = matchesWrapped[matchesWrapped.length - 1];
            matchIndex = startAbsPos + lastMatch.index;
            matchLength = lastMatch[0].length;
          }
        }
      }
    } catch (error) {
      console.error('[cursor-operations] Invalid regex:', error);
      return { found: false, error: 'Invalid regular expression' };
    }
  } else {
    // Simple text search
    if (direction === 'forward') {
      matchIndex = searchText.indexOf(searchPattern, startAbsPos);
      if (matchIndex === -1 && wrap) {
        // Wrap around
        matchIndex = searchText.indexOf(searchPattern);
      }
    } else {
      matchIndex = searchText.lastIndexOf(searchPattern, startAbsPos - 1);
      if (matchIndex === -1 && wrap) {
        // Wrap around
        matchIndex = searchText.lastIndexOf(searchPattern);
      }
    }
  }

  if (matchIndex === -1) {
    return { found: false };
  }

  // Convert absolute position to block/offset
  const matchBlockPos = absolutePositionToBlockOffset(xmlFragment, matchIndex);
  if (!matchBlockPos) {
    return { found: false };
  }

  try {
    const matchPos = createCursorPosition(xmlFragment, matchBlockPos.blockIndex, matchBlockPos.offset);
    const matchText = allText.substring(matchIndex, matchIndex + matchLength);

    return {
      found: true,
      position: matchPos,
      matchText,
      matchLength,
      block: matchBlockPos.blockIndex,
      offset: matchBlockPos.offset,
    };
  } catch (error) {
    return { found: false };
  }
}

/**
 * Get text between two cursor positions (selection)
 * @param {Y.XmlFragment} xmlFragment - The document fragment
 * @param {object} anchorPos - Anchor JSON RelativePosition
 * @param {object} headPos - Head JSON RelativePosition
 * @returns {string} Selected text
 */
function getTextInSelection(xmlFragment, anchorPos, headPos) {
  const anchorResolved = resolveCursorPosition(xmlFragment, anchorPos);
  const headResolved = resolveCursorPosition(xmlFragment, headPos);

  if (!anchorResolved || !headResolved) {
    return '';
  }

  // Calculate absolute positions
  const blocks = xmlFragment.toArray();

  let anchorAbs = 0;
  for (let i = 0; i < anchorResolved.blockIndex; i++) {
    anchorAbs += getBlockTextLength(blocks[i]);
  }
  anchorAbs += anchorResolved.offset;

  let headAbs = 0;
  for (let i = 0; i < headResolved.blockIndex; i++) {
    headAbs += getBlockTextLength(blocks[i]);
  }
  headAbs += headResolved.offset;

  const startPos = Math.min(anchorAbs, headAbs);
  const endPos = Math.max(anchorAbs, headAbs);

  const allText = getAllText(xmlFragment);
  return allText.substring(startPos, endPos);
}

// Helper functions

function getBlockTextLength(block) {
  let length = 0;

  function traverse(node) {
    if (node instanceof Y.XmlText) {
      length += node.length;
    } else if (node instanceof Y.XmlElement) {
      const children = node.toArray();
      for (const child of children) {
        traverse(child);
      }
    }
  }

  traverse(block);
  return length;
}

function getAllText(xmlFragment) {
  let text = '';

  function traverse(node) {
    if (node instanceof Y.XmlText) {
      text += node.toString();
    } else if (node instanceof Y.XmlElement) {
      const children = node.toArray();
      for (const child of children) {
        traverse(child);
      }
    }
  }

  const blocks = xmlFragment.toArray();
  for (const block of blocks) {
    traverse(block);
  }

  return text;
}

function absolutePositionToBlockOffset(xmlFragment, absPos) {
  const blocks = xmlFragment.toArray();
  let currentPos = 0;

  for (let i = 0; i < blocks.length; i++) {
    const blockLength = getBlockTextLength(blocks[i]);
    if (currentPos + blockLength >= absPos) {
      return {
        blockIndex: i,
        offset: absPos - currentPos,
      };
    }
    currentPos += blockLength;
  }

  // Position is at or beyond the end
  if (blocks.length > 0) {
    return {
      blockIndex: blocks.length - 1,
      offset: getBlockTextLength(blocks[blocks.length - 1]),
    };
  }

  return null;
}

function findNextWordBoundary(text, pos) {
  // Find next word boundary (start of next word or end of document)
  if (pos >= text.length) return null;

  // Skip current word
  while (pos < text.length && /\w/.test(text[pos])) {
    pos++;
  }

  // Skip whitespace
  while (pos < text.length && /\s/.test(text[pos])) {
    pos++;
  }

  return pos;
}

function findPrevWordBoundary(text, pos) {
  // Find previous word boundary (start of previous word or start of document)
  if (pos <= 0) return null;

  pos--;  // Move back at least one character

  // Skip whitespace
  while (pos > 0 && /\s/.test(text[pos])) {
    pos--;
  }

  // Skip to start of word
  while (pos > 0 && /\w/.test(text[pos - 1])) {
    pos--;
  }

  return pos;
}

module.exports = {
  createCursorPosition,
  resolveCursorPosition,
  getCursorContext,
  moveCursor,
  findFromCursor,
  getTextInSelection,
};
