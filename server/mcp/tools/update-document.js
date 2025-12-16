/**
 * update_document MCP Tool
 *
 * Updates document content by applying text operations.
 */
const Y = require('yjs');
const documentService = require('../../document-service');

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
const name = 'update_document';

const description =
  'Update document content. Can replace all content or insert/delete at specific positions.';

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    operation: {
      type: 'string',
      enum: ['replace', 'insert', 'delete', 'append'],
      description:
        'Operation type: "replace" replaces all content, "insert" inserts at position, "delete" removes text, "append" adds to end',
    },
    content: {
      type: 'string',
      description: 'Text content to insert or replace with (not needed for delete)',
    },
    position: {
      type: 'integer',
      minimum: 0,
      description: 'Character position for insert/delete operations (0-indexed)',
    },
    length: {
      type: 'integer',
      minimum: 1,
      description: 'Number of characters to delete (only for delete operation)',
    },
  },
  required: ['docGuid', 'operation'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.operation - Operation type
 * @param {string} args.content - Text content
 * @param {number} args.position - Position for insert/delete
 * @param {number} args.length - Length for delete
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { success, message }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('update_document tool not initialized');

  const { docGuid, operation, content, position, length } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has edit access to the document
  const accessResult = await pool.query(
    `SELECT ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  const { role } = accessResult.rows[0];
  if (role !== 'owner' && role !== 'editor') {
    throw new Error('You do not have edit permission for this document');
  }

  // Apply changes through the application layer (document service)
  // This ensures updates are broadcast to all connected WebSocket clients
  // and persisted to the database with proper user attribution
  let message;

  await documentService.updateDocument(
    docGuid,
    (ydoc) => {
      const xmlFragment = ydoc.get('default', Y.XmlFragment);

      switch (operation) {
        case 'replace': {
          if (content === undefined) {
            throw new Error('content is required for replace operation');
          }

          // Clear existing content
          while (xmlFragment.length > 0) {
            xmlFragment.delete(0, 1);
          }

          // Insert new content as a paragraph
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, content);
          paragraph.insert(0, [text]);
          xmlFragment.insert(0, [paragraph]);

          message = `Replaced document content with ${content.length} characters`;
          break;
        }

        case 'append': {
          if (content === undefined) {
            throw new Error('content is required for append operation');
          }

          // Add a new paragraph at the end
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, content);
          paragraph.insert(0, [text]);
          xmlFragment.insert(xmlFragment.length, [paragraph]);

          message = `Appended ${content.length} characters to document`;
          break;
        }

        case 'insert': {
          if (content === undefined) {
            throw new Error('content is required for insert operation');
          }
          if (position === undefined) {
            throw new Error('position is required for insert operation');
          }

          // Find the text node and position to insert at
          const result = findTextPosition(xmlFragment, position);
          if (result) {
            result.textNode.insert(result.offset, content);
            message = `Inserted ${content.length} characters at position ${position}`;
          } else {
            // Position is beyond document end, append instead
            const paragraph = new Y.XmlElement('paragraph');
            const text = new Y.XmlText();
            text.insert(0, content);
            paragraph.insert(0, [text]);
            xmlFragment.insert(xmlFragment.length, [paragraph]);
            message = `Position ${position} exceeds document length, appended content instead`;
          }
          break;
        }

        case 'delete': {
          if (position === undefined) {
            throw new Error('position is required for delete operation');
          }
          if (length === undefined) {
            throw new Error('length is required for delete operation');
          }

          // Find the text node and position to delete from
          let remaining = length;
          let currentPos = position;

          while (remaining > 0) {
            const result = findTextPosition(xmlFragment, currentPos);
            if (!result) break;

            const textLength = result.textNode.toString().length;
            const availableToDelete = textLength - result.offset;
            const toDelete = Math.min(remaining, availableToDelete);

            result.textNode.delete(result.offset, toDelete);
            remaining -= toDelete;
          }

          const deleted = length - remaining;
          message = `Deleted ${deleted} characters starting at position ${position}`;
          break;
        }

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
    userId
  ); // Pass userId for attribution

  // Update document timestamp
  await pool.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docGuid]);

  return {
    success: true,
    message,
    docGuid,
  };
}

/**
 * Find the text node and offset for a character position
 */
function findTextPosition(xmlFragment, targetPos) {
  let currentPos = 0;

  function search(node) {
    if (node instanceof Y.XmlText) {
      const length = node.toString().length;
      if (currentPos + length > targetPos) {
        return { textNode: node, offset: targetPos - currentPos };
      }
      currentPos += length;
    } else if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      const children = node.toArray ? node.toArray() : [];
      for (const child of children) {
        const result = search(child);
        if (result) return result;
      }
      // Add newline for block elements
      if (node instanceof Y.XmlElement) {
        const tagName = node.nodeName;
        if (['paragraph', 'heading', 'codeBlock', 'listItem'].includes(tagName)) {
          currentPos += 1; // Count the newline
        }
      }
    }
    return null;
  }

  const children = xmlFragment.toArray();
  for (const child of children) {
    const result = search(child);
    if (result) return result;
  }

  return null;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
