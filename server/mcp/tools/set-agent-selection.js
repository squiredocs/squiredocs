/**
 * set_agent_selection MCP Tool
 *
 * Allows AI agents to set a text selection in a document that is visible to all users.
 * The selection is displayed with the agent's color and name, just like human user selections.
 */
const agentPresence = require('../agent-presence');

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
const name = 'set_agent_selection';

const description = `Set a text selection in a document that is visible to all users.

This tool allows the AI agent to highlight a specific range of text in the document,
making it visible to all connected users in real-time, just like when a human user
selects text. The selection appears with the agent's name (e.g. "Claude (AI Agent)")
and a unique color.

USE CASES:
- Draw attention to specific parts of the document during analysis
- Highlight text being analyzed or referenced in explanations
- Show which section is being edited or reviewed
- Indicate focus areas during collaborative work
- Visual feedback during document processing

PARAMETERS:
- docGuid: The document UUID (get from list_documents)
- anchor: Start position of the selection (Yjs relative position object)
- head: End position of the selection (Yjs relative position object)
- durationSeconds: (Optional) How long to keep the selection visible (1-300 seconds, default: 60)

POSITION FORMAT:
Positions must be Yjs relative position objects. These are JSON objects that
represent stable positions in the document that remain valid even as other users
edit the document.

DO NOT try to create relative position objects manually. Instead, use the
create_selection_position helper tool which handles this for you.

COMPLETE WORKFLOW:
Step 1: Understand the document structure
  get_document({ docGuid: "abc-123", format: "structured" })
  This shows you elements and their indices

Step 2: Create anchor position (start of selection)
  create_selection_position({
    docGuid: "abc-123",
    elementIndex: 0,
    textOffset: 0
  })
  Save the returned "position" object

Step 3: Create head position (end of selection)
  create_selection_position({
    docGuid: "abc-123",
    elementIndex: 2,
    textOffset: 100
  })
  Save the returned "position" object

Step 4: Set the selection
  set_agent_selection({
    docGuid: "abc-123",
    anchor: anchorPositionFromStep2.position,
    head: headPositionFromStep3.position,
    durationSeconds: 60
  })

EXAMPLE - Highlighting the first two paragraphs:
// Step 1: Get document structure
const doc = get_document({ docGuid: "abc-123", format: "structured" });
// Shows: [{ type: "paragraph", content: "First..." }, { type: "paragraph", content: "Second..." }]

// Step 2: Create anchor at start of element 0
const anchor = create_selection_position({ docGuid: "abc-123", elementIndex: 0 });

// Step 3: Create head at end of element 1
const head = create_selection_position({ docGuid: "abc-123", elementIndex: 1 });

// Step 4: Set selection
set_agent_selection({
  docGuid: "abc-123",
  anchor: anchor.position,
  head: head.position,
  durationSeconds: 45
});

RETURNS:
- success: true if selection was set
- message: Confirmation message
- sessionId: Unique ID for this selection session
- expiresIn: Seconds until selection disappears
- selection: The anchor and head positions used
- agent: Object with name and color of the agent

IMPORTANT NOTES:
- The selection is visible to ALL users viewing the document
- Selections automatically disappear after the specified duration
- Multiple agents can have selections active simultaneously
- If the WebSocket connection drops, the selection will disappear
- Requires at least viewer access to the document
- The agent's name will be shown as "Your Name (AI Agent)"

VISIBILITY:
When you set a selection, users will see:
- Highlighted text in the document with the agent's color
- A cursor/label showing the agent's name
- The selection updates in real-time for all connected users`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    anchor: {
      type: 'object',
      description: 'Anchor position as a Yjs relative position JSON object',
    },
    head: {
      type: 'object',
      description: 'Head position as a Yjs relative position JSON object',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to keep the selection visible (1-300 seconds, default: 60)',
    },
  },
  required: ['docGuid', 'anchor', 'head'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {object} args.anchor - Anchor position (Yjs relative position object)
 * @param {object} args.head - Head position (Yjs relative position object)
 * @param {number} [args.durationSeconds=60] - Duration to keep selection visible
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { success, message, sessionId, expiresIn }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('set_agent_selection tool not initialized');

  const { docGuid, anchor, head, durationSeconds = 60 } = args;

  try {
    // Get or create a presence session (reuses existing WebSocket if available)
    const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);

    // Set cursor/selection on the existing awareness
    console.log('[set-agent-selection] Setting cursor field:', JSON.stringify({ anchor, head }, null, 2));
    session.awareness.setLocalStateField('cursor', {
      anchor,
      head,
    });

    // Log the full awareness state after setting
    console.log('[set-agent-selection] Full local awareness state:', JSON.stringify(session.awareness.getLocalState(), null, 2));

    if (session.reused) {
      console.log('[set-agent-selection] Reused existing WebSocket connection');
    } else {
      console.log('[set-agent-selection] Created new WebSocket connection');
    }

    return {
      success: true,
      message: `Agent selection set`,
      sessionId: session.sessionId,
      expiresIn: session.expiresIn,
      selection: { anchor, head },
      agent: {
        name: session.agentInfo.name,
        color: session.agentInfo.color,
      },
    };
  } catch (error) {
    throw new Error(`Failed to set agent selection: ${error.message}`);
  }
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
