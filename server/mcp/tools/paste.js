/**
 * paste MCP Tool
 *
 * Paste clipboard content at the current cursor position.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition, createCursorPosition } = require('../yjs/cursor-operations');
const { buildYjsNode } = require('../yjs/node-builder');
const { deleteText, getElementTextLength } = require('../yjs/text-operations');

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
const name = 'paste';

const description = `Paste clipboard content at current cursor position.

═══════════════════════════════════════════════════════════════════════════
PASTE
═══════════════════════════════════════════════════════════════════════════

Inserts clipboard content at the current cursor position, preserving all
formatting, structure, and nesting.

WHEN TO USE THIS:
- Insert previously copied content
- Duplicate sections of a document
- Move content by cutting and pasting
- Reorganize document structure

MODES:
- "replace": Delete current selection and insert (default if selection exists)
- "after": Insert after cursor/selection end (default if no selection)
- "before": Insert before cursor/selection start

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- mode: Paste mode (optional)
  - "before" | "after" | "replace"

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if operation completed
- clipboardEmpty: true if nothing was in clipboard
- pastedBlocks: Number of top-level blocks pasted
- pastedLength: Character count
- replacedSelection: true if replaced existing selection
- cursor: New cursor position after paste

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Copy and paste at end of document
await select({ docGuid: "abc-123", mode: "block" });
await copy_selection({ docGuid: "abc-123" });
await goto({ docGuid: "abc-123", target: { type: "document_end" } });
await paste({ docGuid: "abc-123", mode: "after" });

// Replace selection with clipboard
await select({ docGuid: "abc-123", mode: "word" });
await paste({ docGuid: "abc-123", mode: "replace" });

// Paste before current position
await paste({ docGuid: "abc-123", mode: "before" });`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    mode: {
      type: 'string',
      enum: ['before', 'after', 'replace'],
      description: 'Paste mode (default: "replace" if selection exists, "after" if not)',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.mode - Paste mode
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Paste result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('paste tool not initialized');

  const { docGuid, mode } = args;
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

  if (accessResult.rows[0].role === 'viewer') {
    throw new Error('Permission denied: viewers cannot edit documents');
  }

  // Get or create session (reuses existing WebSocket if available)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 3600);

  if (!session || !session.cursor) {
    throw new Error('Failed to get session');
  }

  // Check if clipboard has content
  if (!session.clipboard || !session.clipboard.content || session.clipboard.content.length === 0) {
    return {
      success: true,
      clipboardEmpty: true,
      pastedBlocks: 0,
      pastedLength: 0,
    };
  }

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  const undoManager = session.undoManager;

  const anchorPos = session.cursor.anchor;
  const headPos = session.cursor.head;
  const hasSelection = JSON.stringify(anchorPos) !== JSON.stringify(headPos);

  // Determine actual paste mode
  let actualMode = mode;
  if (!actualMode) {
    actualMode = hasSelection ? 'replace' : 'after';
  }

  const clipboardContent = session.clipboard.content;
  let replacedSelection = false;
  let pastePosition;

  // Handle replace mode
  if (actualMode === 'replace' && hasSelection) {
    // Delete selection first
    const anchorResolved = resolveCursorPosition(xmlFragment, anchorPos);
    const headResolved = resolveCursorPosition(xmlFragment, headPos);

    if (!anchorResolved || !headResolved) {
      throw new Error('Could not resolve selection positions');
    }

    const isForward = anchorResolved.blockIndex < headResolved.blockIndex ||
      (anchorResolved.blockIndex === headResolved.blockIndex && anchorResolved.offset < headResolved.offset);

    const startResolved = isForward ? anchorResolved : headResolved;
    const endResolved = isForward ? headResolved : anchorResolved;

    const blocks = xmlFragment.toArray();

    ydoc.transact(() => {
      if (startResolved.blockIndex === endResolved.blockIndex) {
        // Single-block deletion
        const block = blocks[startResolved.blockIndex];
        deleteText(block, startResolved.offset, endResolved.offset);
      } else {
        // Multi-block deletion
        const startBlock = blocks[startResolved.blockIndex];
        const startBlockLength = getElementTextLength(startBlock);
        if (startResolved.offset < startBlockLength) {
          deleteText(startBlock, startResolved.offset, startBlockLength);
        }

        // Delete complete blocks in between
        for (let i = startResolved.blockIndex + 1; i < endResolved.blockIndex; i++) {
          xmlFragment.delete(startResolved.blockIndex + 1, 1);
        }

        // Delete from start of last block to end position
        const adjustedEndBlockIndex = startResolved.blockIndex + 1;
        if (adjustedEndBlockIndex < xmlFragment.length) {
          const endBlock = xmlFragment.get(adjustedEndBlockIndex);
          if (endResolved.offset > 0) {
            deleteText(endBlock, 0, endResolved.offset);
          }
        }
      }
    }, undoManager);

    replacedSelection = true;
    pastePosition = isForward ? anchorPos : headPos;
  } else if (actualMode === 'before') {
    // Use anchor position (start of selection or cursor)
    pastePosition = anchorPos;
  } else {
    // mode === 'after' or default
    // Use head position (end of selection or cursor)
    pastePosition = headPos;
  }

  const pasteResolved = resolveCursorPosition(xmlFragment, pastePosition);

  if (!pasteResolved) {
    throw new Error('Could not resolve paste position');
  }

  // Determine if we're pasting inline or as blocks
  const isInlineContent = clipboardContent.length === 1 &&
    (clipboardContent[0].type === 'paragraph' || clipboardContent[0].type === 'heading') &&
    pasteResolved.offset > 0 &&
    pasteResolved.offset < getElementTextLength(xmlFragment.toArray()[pasteResolved.blockIndex]);

  let newCursorPos;
  let pastedLength = 0;

  // Calculate pasted text length
  function calculateTextLength(nodes) {
    let length = 0;
    for (const node of nodes) {
      if (node.content) {
        if (typeof node.content === 'string') {
          length += node.content.length;
        } else if (Array.isArray(node.content)) {
          for (const item of node.content) {
            if (typeof item === 'string') {
              length += item.length;
            } else if (item.text) {
              length += item.text.length;
            }
          }
        }
      }
      if (node.children) {
        length += calculateTextLength(node.children);
      }
    }
    return length;
  }

  pastedLength = calculateTextLength(clipboardContent);

  if (isInlineContent) {
    // Paste inline: insert text content into current block
    const block = xmlFragment.toArray()[pasteResolved.blockIndex];
    const pasteContent = clipboardContent[0].content;

    // Build text to insert
    let textToInsert = '';
    if (typeof pasteContent === 'string') {
      textToInsert = pasteContent;
    } else if (Array.isArray(pasteContent)) {
      for (const item of pasteContent) {
        if (typeof item === 'string') {
          textToInsert += item;
        } else if (item.text) {
          textToInsert += item.text;
        }
      }
    }

    // Insert text at cursor position
    ydoc.transact(() => {
      let currentOffset = 0;

      function insertAtOffset(node, targetOffset, text) {
        if (node instanceof Y.XmlText) {
          const length = node.length;
          if (currentOffset + length >= targetOffset) {
            const offsetInNode = targetOffset - currentOffset;
            node.insert(offsetInNode, text);
            return true;
          }
          currentOffset += length;
        } else if (node instanceof Y.XmlElement) {
          for (const child of node.toArray()) {
            if (insertAtOffset(child, targetOffset, text)) {
              return true;
            }
          }
        }
        return false;
      }

      insertAtOffset(block, pasteResolved.offset, textToInsert);
    }, undoManager);

    // Move cursor to end of pasted text
    newCursorPos = createCursorPosition(xmlFragment, pasteResolved.blockIndex, pasteResolved.offset + textToInsert.length);
  } else {
    // Paste as blocks: insert new blocks at cursor position
    const blocks = xmlFragment.toArray();
    const currentBlock = blocks[pasteResolved.blockIndex];

    // Build Yjs nodes from clipboard content
    const nodesToInsert = clipboardContent.map(node => buildYjsNode(node));

    ydoc.transact(() => {
      if (pasteResolved.offset === 0 && actualMode === 'before') {
        // Insert before current block
        xmlFragment.insert(pasteResolved.blockIndex, nodesToInsert);
      } else {
        // Insert after current block
        xmlFragment.insert(pasteResolved.blockIndex + 1, nodesToInsert);
      }
    }, undoManager);

    // Move cursor to start of first pasted block
    const newBlockIndex = (pasteResolved.offset === 0 && actualMode === 'before')
      ? pasteResolved.blockIndex
      : pasteResolved.blockIndex + 1;

    newCursorPos = createCursorPosition(xmlFragment, newBlockIndex, 0);
  }

  // Update session cursor
  agentPresence.updateSessionCursor(session.sessionId, newCursorPos, newCursorPos);

  const newResolved = resolveCursorPosition(xmlFragment, newCursorPos);

  return {
    success: true,
    clipboardEmpty: false,
    pastedBlocks: clipboardContent.length,
    pastedLength,
    replacedSelection,
    cursor: {
      block: newResolved.blockIndex,
      offset: newResolved.offset,
      blockType: newResolved.blockType,
    },
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
