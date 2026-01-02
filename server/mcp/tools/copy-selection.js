/**
 * copy_selection MCP Tool
 *
 * Copy the currently selected content to clipboard.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition } = require('../yjs/cursor-operations');
const { toPlainText } = require('../yjs/serialization');

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
}

/**
 * Tool definition for MCP discovery
 */
const name = 'copy_selection';

const description = `Copy current selection to clipboard.

═══════════════════════════════════════════════════════════════════════════
COPY SELECTION
═══════════════════════════════════════════════════════════════════════════

Copies the currently selected content to a session-scoped clipboard,
preserving all formatting, structure, and nesting.

WHEN TO USE THIS:
- Duplicate content to paste elsewhere
- Copy formatted text
- Copy complex nested structures
- Backup content before making changes

WORKFLOW:
1. Create selection (using select, find, or move with extend)
2. Copy selection to clipboard
3. Navigate to destination
4. Paste content

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if operation completed
- hasSelection: true if selection exists and was copied
- copiedBlocks: Number of top-level blocks copied
- copiedLength: Character count
- contentPreview: First 100 characters of copied content
- clipboardId: Unique identifier for this clipboard entry

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Select and copy a word
await select({ docGuid: "abc-123", mode: "word" });
await copy_selection({ docGuid: "abc-123" });

// Select and copy entire block
await select({ docGuid: "abc-123", mode: "block" });
await copy_selection({ docGuid: "abc-123" });

// Copy multi-block selection
await select({ docGuid: "abc-123", mode: "block" });
await move({ docGuid: "abc-123", direction: "forward", unit: "block", count: 3, extend: true });
await copy_selection({ docGuid: "abc-123" });`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
  },
  required: ['docGuid'],
};

/**
 * Extract content between two cursor positions as Yjs binary data
 * @param {Y.XmlFragment} xmlFragment - Document fragment
 * @param {object} anchorPos - Start position (RelativePosition JSON)
 * @param {object} headPos - End position (RelativePosition JSON)
 * @returns {object} Object with clipboardDoc (Y.Doc) and metadata
 */
function extractContentBetweenPositions(xmlFragment, anchorPos, headPos) {
  const anchorResolved = resolveCursorPosition(xmlFragment, anchorPos);
  const headResolved = resolveCursorPosition(xmlFragment, headPos);

  if (!anchorResolved || !headResolved) {
    return { clipboardDoc: null, blockCount: 0, textLength: 0 };
  }

  // Determine selection direction
  const isForward = anchorResolved.blockIndex < headResolved.blockIndex ||
    (anchorResolved.blockIndex === headResolved.blockIndex && anchorResolved.offset < headResolved.offset);

  const startResolved = isForward ? anchorResolved : headResolved;
  const endResolved = isForward ? headResolved : anchorResolved;

  const blocks = xmlFragment.toArray();

  // Create a temporary document to hold the clipboard content
  const clipboardDoc = new Y.Doc();
  const clipboardFragment = clipboardDoc.get('clipboard', Y.XmlFragment);

  // Helper: Deep clone a Yjs XmlElement or XmlText
  function cloneYjsNode(node) {
    if (node instanceof Y.XmlText) {
      const clone = new Y.XmlText();
      const delta = node.toDelta();
      let offset = 0;
      for (const op of delta) {
        if (typeof op.insert === 'string') {
          clone.insert(offset, op.insert, op.attributes);
          offset += op.insert.length;
        }
      }
      return clone;
    } else if (node instanceof Y.XmlElement) {
      const clone = new Y.XmlElement(node.nodeName);

      // Copy attributes
      const attrs = node.getAttributes();
      for (const [key, value] of Object.entries(attrs)) {
        clone.setAttribute(key, value);
      }

      // Clone children recursively
      const children = node.toArray();
      const clonedChildren = children.map(child => cloneYjsNode(child));
      if (clonedChildren.length > 0) {
        clone.insert(0, clonedChildren);
      }

      return clone;
    }
    return null;
  }

  // Helper: Extract partial text from a block
  function extractPartialBlock(block, startOffset, endOffset) {
    const clone = cloneYjsNode(block);

    // Find and trim text nodes
    let currentOffset = 0;

    function trimTextNodes(node, trimStart, trimEnd) {
      if (node instanceof Y.XmlText) {
        const length = node.length;
        const nodeStart = currentOffset;
        const nodeEnd = currentOffset + length;

        // Calculate what portion of this text node is in range
        const keepStart = Math.max(0, trimStart - nodeStart);
        const keepEnd = Math.min(length, trimEnd - nodeStart);

        if (keepEnd <= keepStart) {
          currentOffset += length;
          return null;
        }

        // Create new text node with only the kept portion
        const newText = new Y.XmlText();
        const delta = node.toDelta();
        let offset = 0;
        let newOffset = 0;

        for (const op of delta) {
          if (typeof op.insert === 'string') {
            const opStart = offset;
            const opEnd = offset + op.insert.length;

            const overlapStart = Math.max(opStart, keepStart);
            const overlapEnd = Math.min(opEnd, keepEnd);

            if (overlapEnd > overlapStart) {
              const extractedText = op.insert.substring(
                overlapStart - opStart,
                overlapEnd - opStart
              );
              newText.insert(newOffset, extractedText, op.attributes);
              newOffset += extractedText.length;
            }

            offset += op.insert.length;
          }
        }

        currentOffset += length;
        return newText;
      } else if (node instanceof Y.XmlElement) {
        const newElement = new Y.XmlElement(node.nodeName);

        // Copy attributes
        const attrs = node.getAttributes();
        for (const [key, value] of Object.entries(attrs)) {
          newElement.setAttribute(key, value);
        }

        // Process children
        const children = node.toArray();
        const newChildren = [];

        for (const child of children) {
          const trimmed = trimTextNodes(child, trimStart, trimEnd);
          if (trimmed) {
            newChildren.push(trimmed);
          }
        }

        if (newChildren.length > 0) {
          newElement.insert(0, newChildren);
        }

        return newElement;
      }

      return null;
    }

    const trimmed = trimTextNodes(clone, startOffset, endOffset);
    return trimmed;
  }

  // Helper: Get total text length of a block
  function getBlockTextLength(block) {
    let length = 0;

    function traverse(node) {
      if (node instanceof Y.XmlText) {
        length += node.length;
      } else if (node instanceof Y.XmlElement) {
        for (const child of node.toArray()) {
          traverse(child);
        }
      }
    }

    traverse(block);
    return length;
  }

  // Extract blocks into clipboard document
  const nodesToCopy = [];

  if (startResolved.blockIndex === endResolved.blockIndex) {
    // Selection within a single block - do partial extraction
    const block = blocks[startResolved.blockIndex];
    const partialBlock = extractPartialBlock(block, startResolved.offset, endResolved.offset);
    if (partialBlock) {
      nodesToCopy.push(partialBlock);
    }
  } else {
    // Multi-block selection - copy complete blocks to avoid content loss
    // This is simpler and more reliable than partial extraction of complex nested structures
    for (let i = startResolved.blockIndex; i <= endResolved.blockIndex; i++) {
      const block = blocks[i];
      const clone = cloneYjsNode(block);
      if (clone) {
        nodesToCopy.push(clone);
      }
    }
  }

  // Insert all nodes into clipboard fragment in a single transaction
  clipboardDoc.transact(() => {
    if (nodesToCopy.length > 0) {
      clipboardFragment.insert(0, nodesToCopy);
    }
  });

  // Calculate text length for metadata
  const textLength = toPlainText(clipboardFragment).length;

  return {
    clipboardDoc,
    blockCount: nodesToCopy.length,
    textLength,
  };
}

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Copy result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('copy_selection tool not initialized');

  const { docGuid } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document
  const accessResult = await pool.query(
    `SELECT d.id, ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  // Get or create session (reuses existing WebSocket if available)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 3600);

  if (!session || !session.cursor) {
    throw new Error('Failed to get session');
  }

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  const anchorPos = session.cursor.anchor;
  const headPos = session.cursor.head;
  const hasSelection = JSON.stringify(anchorPos) !== JSON.stringify(headPos);

  if (!hasSelection) {
    // No selection - return success but indicate nothing was copied
    return {
      success: true,
      hasSelection: false,
      copiedBlocks: 0,
      copiedLength: 0,
      contentPreview: '',
    };
  }

  // Extract selected content as Yjs document
  const { clipboardDoc, blockCount, textLength } = extractContentBetweenPositions(xmlFragment, anchorPos, headPos);

  if (!clipboardDoc || blockCount === 0) {
    return {
      success: true,
      hasSelection: false,
      copiedBlocks: 0,
      copiedLength: 0,
      contentPreview: '',
    };
  }

  // Generate clipboard ID
  const clipboardId = `clipboard-${userId}-${Date.now()}`;

  // Encode the clipboard document as binary updates for storage
  const clipboardBinary = Y.encodeStateAsUpdate(clipboardDoc);

  // Get plain text for preview
  const clipboardFragment = clipboardDoc.get('clipboard', Y.XmlFragment);
  const plainText = toPlainText(clipboardFragment);
  const contentPreview = plainText.substring(0, 100);

  // Store in session
  session.clipboard = {
    id: clipboardId,
    binary: clipboardBinary, // Store as Uint8Array
    copiedAt: Date.now(),
  };

  return {
    success: true,
    hasSelection: true,
    copiedBlocks: blockCount,
    copiedLength: textLength,
    contentPreview: contentPreview + (plainText.length > 100 ? '...' : ''),
    clipboardId,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
