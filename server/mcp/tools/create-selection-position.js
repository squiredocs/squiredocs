/**
 * create_selection_position MCP Tool
 *
 * Helper tool to create Yjs relative position objects for use with set_agent_selection.
 * This tool helps agents create proper relative positions without needing direct Yjs access.
 */
const Y = require('yjs');

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
const name = 'create_selection_position';

const description = `Create Yjs relative position objects for use with set_agent_selection.

This helper tool creates proper relative position objects that can be used to set
selections in a document. Relative positions are stable references to locations in
a Yjs document that remain valid even as the document is edited by multiple users.

HOW IT WORKS:
Documents are structured as a series of elements (paragraphs, headings, etc.).
Each element has an index (0-based). Within each element, you can specify a
character offset (textOffset) to point to a specific position in the text.

PARAMETERS:
- docGuid: The document UUID (get this from list_documents)
- elementIndex: The index of the element in the document (0-based)
  * Element 0 is the first paragraph/heading
  * Element 1 is the second paragraph/heading, etc.
- textOffset: (Optional) Character offset within the element's text (default: 0)
  * 0 means the start of the element
  * 10 means 10 characters into the element's text

WORKFLOW TO HIGHLIGHT TEXT:
1. Call get_document with format="structured" to see document structure
2. Find the element indices you want to highlight
3. Use this tool to create the anchor position (start of selection)
4. Use this tool to create the head position (end of selection)
5. Pass both positions to set_agent_selection

EXAMPLE - Highlighting from element 0 to element 2:
Step 1: Create anchor at start of element 0
  create_selection_position({ docGuid: "abc-123", elementIndex: 0, textOffset: 0 })
  Returns: { success: true, position: {...} }

Step 2: Create head at end of element 2
  create_selection_position({ docGuid: "abc-123", elementIndex: 2, textOffset: 50 })
  Returns: { success: true, position: {...} }

Step 3: Set the selection
  set_agent_selection({
    docGuid: "abc-123",
    anchor: anchorPosition,
    head: headPosition,
    durationSeconds: 60
  })

RETURNS:
- success: true if position was created
- position: The Yjs relative position object (use this with set_agent_selection)
- elementIndex: The element index used
- textOffset: The text offset used
- message: Human-readable confirmation

NOTES:
- If textOffset exceeds the element's text length, it will be capped to the max length
- If elementIndex is out of bounds, an error is returned
- Relative positions remain valid even if the document is edited by other users`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    elementIndex: {
      type: 'integer',
      minimum: 0,
      description: 'Index of the element in the document (0-based)',
    },
    textOffset: {
      type: 'integer',
      minimum: 0,
      description: 'Optional offset within the element text (default: 0)',
    },
  },
  required: ['docGuid', 'elementIndex'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.elementIndex - Element index in the document
 * @param {number} [args.textOffset=0] - Offset within the element's text
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { success, position }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) {
    throw new Error('create_selection_position tool not initialized');
  }

  const { docGuid, elementIndex, textOffset = 0 } = args;
  const userId = agentToken.userId;

  // Check access permissions
  const pool = persistenceProvider.getPool();
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

  // Load the Yjs document
  const ydoc = await persistenceProvider.getYDoc(docGuid);
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Validate element index
  if (elementIndex >= xmlFragment.length) {
    throw new Error(
      `Element index ${elementIndex} is out of bounds (document has ${xmlFragment.length} elements)`
    );
  }

  // Get the element at the specified index
  const element = xmlFragment.get(elementIndex);

  if (!element) {
    throw new Error(`No element found at index ${elementIndex}`);
  }

  // Create relative position
  let relativePosition;

  // If textOffset is specified and element has text content, create position within text
  if (textOffset > 0 && element.length > 0) {
    // Try to find a text node within the element
    const textNode = findTextNode(element);

    if (textNode) {
      const offset = Math.min(textOffset, textNode.length);
      relativePosition = Y.createRelativePositionFromTypeIndex(textNode, offset);
    } else {
      // No text node, fall back to element position
      relativePosition = Y.createRelativePositionFromTypeIndex(xmlFragment, elementIndex);
    }
  } else {
    // Create position at element level
    relativePosition = Y.createRelativePositionFromTypeIndex(xmlFragment, elementIndex);
  }

  // Convert to JSON for serialization
  const positionJSON = Y.relativePositionToJSON(relativePosition);

  return {
    success: true,
    position: positionJSON,
    elementIndex,
    textOffset,
    message: `Created relative position at element ${elementIndex}${
      textOffset > 0 ? `, offset ${textOffset}` : ''
    }`,
  };
}

/**
 * Find the first text node within an element
 * @param {object} element - Yjs element
 * @returns {object|null} Text node or null
 */
function findTextNode(element) {
  if (element.constructor.name === 'XmlText') {
    return element;
  }

  if (element.constructor.name === 'XmlElement') {
    for (let i = 0; i < element.length; i++) {
      const child = element.get(i);

      if (child.constructor.name === 'XmlText') {
        return child;
      }

      // Recursively search child elements
      const textNode = findTextNode(child);
      if (textNode) {
        return textNode;
      }
    }
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
