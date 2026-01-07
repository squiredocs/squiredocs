/**
 * Streaming Insert for MCP V2 API
 *
 * Provides chunked text insertion with visual streaming animation.
 * Text is divided into 5 chunks and inserted over 500ms (100ms between chunks).
 * This provides visual feedback without significantly blocking the agent.
 */

const Y = require('yjs');

/**
 * Insert text with streaming animation (5 chunks over 500ms)
 * @param {Y.Doc} ydoc - The Yjs document
 * @param {Y.XmlElement|Y.XmlText} targetNode - Node to insert text into
 * @param {number} position - Position within the node
 * @param {string} text - Text to insert
 * @param {Array} marks - Formatting marks to apply
 * @param {object} awareness - Awareness instance for cursor updates
 * @param {object} cursorStartPos - Initial cursor RelativePosition (JSON)
 * @param {number} delayMs - Delay between chunks (default: 100ms)
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
  delayMs = 100
) {
  if (!text || text.length === 0) {
    return { finalPosition: cursorStartPos, insertedLength: 0 };
  }

  // Divide text into 5 chunks for streaming (total time: ~500ms)
  const numChunks = 5;
  const chunkSize = Math.ceil(text.length / numChunks);

  // Timeout to prevent indefinite hanging (generous limit: 30 seconds)
  const TIMEOUT_MS = 30000;

  // Wrap all operations in a single transaction for atomic undo
  return new Promise((resolve, reject) => {
    let chunkIndex = 0;
    let currentPos = position;
    let timeoutId;

    // Set up timeout to prevent indefinite hanging
    timeoutId = setTimeout(() => {
      reject(new Error(`Streaming insert timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    // Insert chunks one at a time
    const insertChunk = () => {
      try {
        if (chunkIndex >= numChunks) {
          // All chunks inserted - clear timeout
          clearTimeout(timeoutId);

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

        // Calculate chunk boundaries
        const startIdx = chunkIndex * chunkSize;
        const endIdx = Math.min(startIdx + chunkSize, text.length);
        const chunk = text.substring(startIdx, endIdx);

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

        currentPos += chunk.length;
        chunkIndex++;

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

        // Schedule next chunk
        setTimeout(insertChunk, delayMs);
      } catch (err) {
        clearTimeout(timeoutId);
        reject(err);
      }
    };

    // Start insertion
    insertChunk();
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
