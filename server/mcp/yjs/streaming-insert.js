/**
 * Streaming Insert for MCP V2 API
 *
 * Provides character-by-character text insertion with visual typing animation.
 * Other users see the text appear gradually, as if the AI is typing.
 */

const Y = require('yjs');

/**
 * Insert text with streaming animation (character-by-character)
 * @param {Y.Doc} ydoc - The Yjs document
 * @param {Y.XmlElement|Y.XmlText} targetNode - Node to insert text into
 * @param {number} position - Position within the node
 * @param {string} text - Text to insert
 * @param {Array} marks - Formatting marks to apply
 * @param {object} awareness - Awareness instance for cursor updates
 * @param {object} cursorStartPos - Initial cursor RelativePosition (JSON)
 * @param {number} delayMs - Delay between character batches (default: 40ms)
 * @returns {Promise<object>} { finalPosition, insertedLength }
 */
async function streamingInsert(
  ydoc,
  targetNode,
  position,
  text,
  marks = [],
  awareness = null,
  cursorStartPos = null,
  delayMs = 40
) {
  if (!text || text.length === 0) {
    return { finalPosition: cursorStartPos, insertedLength: 0 };
  }

  // Batch size: insert 1-3 characters at a time for smooth but not too slow animation
  const batchSize = text.length > 100 ? 3 : text.length > 20 ? 2 : 1;

  // Wrap all operations in a single transaction for atomic undo
  return new Promise((resolve) => {
    let inserted = 0;
    let currentPos = position;

    // Update loop
    const insertBatch = () => {
      if (inserted >= text.length) {
        // All text inserted
        // Create final cursor position
        const finalTextNode = targetNode instanceof Y.XmlText ? targetNode : findTextNodeAtPosition(targetNode, currentPos);
        if (finalTextNode) {
          const relPos = Y.createRelativePositionFromTypeIndex(finalTextNode, currentPos);
          const finalPosition = Y.relativePositionToJSON(relPos);

          // Update awareness with final cursor position
          if (awareness && finalPosition) {
            awareness.setLocalStateField('cursor', {
              anchor: finalPosition,
              head: finalPosition,
            });
          }

          resolve({ finalPosition, insertedLength: text.length });
        } else {
          resolve({ finalPosition: cursorStartPos, insertedLength: text.length });
        }
        return;
      }

      // Insert next batch
      const remaining = text.length - inserted;
      const chunkSize = Math.min(batchSize, remaining);
      const chunk = text.substring(inserted, inserted + chunkSize);

      // Perform insert in a transaction
      ydoc.transact(() => {
        if (targetNode instanceof Y.XmlText) {
          // Direct text node insertion
          targetNode.insert(currentPos, chunk, marks.length > 0 ? { marks } : undefined);
        } else if (targetNode instanceof Y.XmlElement) {
          // Find or create text node within element
          const textNode = findOrCreateTextNode(targetNode, currentPos);
          if (textNode) {
            const offsetInNode = currentPos - getOffsetBeforeNode(targetNode, textNode);
            textNode.insert(offsetInNode, chunk, marks.length > 0 ? { marks } : undefined);
          }
        }
      });

      inserted += chunkSize;
      currentPos += chunkSize;

      // Update awareness cursor to show typing progress
      if (awareness) {
        const currentTextNode = targetNode instanceof Y.XmlText ? targetNode : findTextNodeAtPosition(targetNode, currentPos);
        if (currentTextNode) {
          const relPos = Y.createRelativePositionFromTypeIndex(currentTextNode, currentPos);
          const cursorPos = Y.relativePositionToJSON(relPos);
          awareness.setLocalStateField('cursor', {
            anchor: cursorPos,
            head: cursorPos,
          });
        }
      }

      // Schedule next batch
      setTimeout(insertBatch, delayMs);
    };

    // Start insertion
    insertBatch();
  });
}

/**
 * Find text node at a specific position within an element
 * @param {Y.XmlElement} element - The element to search
 * @param {number} targetPos - Target position
 * @returns {Y.XmlText|null} Text node or null
 */
function findTextNodeAtPosition(element, targetPos) {
  let currentPos = 0;

  function traverse(node) {
    if (node instanceof Y.XmlText) {
      if (currentPos <= targetPos && targetPos <= currentPos + node.length) {
        return node;
      }
      currentPos += node.length;
    } else if (node instanceof Y.XmlElement) {
      const children = node.toArray();
      for (const child of children) {
        const result = traverse(child);
        if (result) return result;
      }
    }
    return null;
  }

  return traverse(element);
}

/**
 * Find or create a text node at a position
 * @param {Y.XmlElement} element - The element
 * @param {number} position - Position within the element
 * @returns {Y.XmlText|null} Text node
 */
function findOrCreateTextNode(element, position) {
  // Try to find existing text node first
  const existing = findTextNodeAtPosition(element, position);
  if (existing) return existing;

  // Check if element has any children
  const children = element.toArray();
  if (children.length === 0) {
    // Create a new text node
    const textNode = new Y.XmlText();
    element.insert(0, [textNode]);
    return textNode;
  }

  // Return first text node if exists
  function findFirstText(node) {
    if (node instanceof Y.XmlText) return node;
    if (node instanceof Y.XmlElement) {
      const kids = node.toArray();
      for (const kid of kids) {
        const result = findFirstText(kid);
        if (result) return result;
      }
    }
    return null;
  }

  return findFirstText(element);
}

/**
 * Get offset before a specific node within an element
 * @param {Y.XmlElement} element - The element
 * @param {Y.XmlText} targetNode - Target text node
 * @returns {number} Offset
 */
function getOffsetBeforeNode(element, targetNode) {
  let offset = 0;
  let found = false;

  function traverse(node) {
    if (found) return;
    if (node === targetNode) {
      found = true;
      return;
    }
    if (node instanceof Y.XmlText) {
      offset += node.length;
    } else if (node instanceof Y.XmlElement) {
      const children = node.toArray();
      for (const child of children) {
        traverse(child);
        if (found) break;
      }
    }
  }

  traverse(element);
  return offset;
}

module.exports = {
  streamingInsert,
};
