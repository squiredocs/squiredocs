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

const description = `ADVANCED: Set a custom text selection visible to all users in real-time.

═══════════════════════════════════════════════════════════════════════════
WHEN TO USE THIS TOOL
═══════════════════════════════════════════════════════════════════════════

NOTE: You usually DON'T need this tool! The read_document_block and
update_document_block tools automatically highlight blocks for you.

Use this ADVANCED tool only when you need to:
- Highlight a specific text range WITHIN a block (not the whole block)
- Draw attention to multiple blocks at once
- Create custom selection ranges for analysis

For most editing workflows, use the simpler block-based tools instead.

═══════════════════════════════════════════════════════════════════════════
ABOUT SELECTIONS IN THIS COLLABORATIVE EDITOR
═══════════════════════════════════════════════════════════════════════════

This is a real-time collaborative editor where multiple users work together:
- Your selections appear to ALL connected users instantly
- Each agent/user has a unique color
- Selections show your agent name (e.g., "Claude (AI Agent)")
- Users can see exactly what you're highlighting in real-time

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS
═══════════════════════════════════════════════════════════════════════════

You provide:
- anchor: Start position (Yjs relative position object)
- head: End position (Yjs relative position object)
- durationSeconds: How long to show the selection

The selection is rendered in the document and visible to everyone.

POSITION OBJECTS:
These are special Yjs relative position objects that remain stable even as
other users edit the document. They're created by looking at the document
structure from get_document_structure.

WARNING: Creating position objects manually is complex. This is an advanced
tool - consider using read_document_block instead for most use cases.

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- anchor: Yjs relative position object (start of selection)
- head: Yjs relative position object (end of selection)
- durationSeconds: How long to display (1-300 seconds, default: 60)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if selection was set
- message: Confirmation message
- sessionId: Unique ID for this selection session
- expiresIn: Seconds until selection disappears
- selection: The anchor and head positions used
- agent: Object with your agent name and color

═══════════════════════════════════════════════════════════════════════════
VISIBILITY & BEHAVIOR
═══════════════════════════════════════════════════════════════════════════

- Selection is visible to ALL users viewing the document
- Shows your agent name and color
- Automatically disappears after durationSeconds
- Multiple agents can have selections active simultaneously
- Survives document edits (positions are relative)
- Disappears if WebSocket connection drops
- Requires at least viewer access to the document

═══════════════════════════════════════════════════════════════════════════
RECOMMENDATION
═══════════════════════════════════════════════════════════════════════════

For most editing workflows, use these simpler tools instead:
1. get_document_structure - See block layout
2. read_document_block - Read and auto-highlight a block
3. update_document_block - Update and auto-highlight a block

Use set_agent_selection only for advanced custom highlighting needs.`;

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
