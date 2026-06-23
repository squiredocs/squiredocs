/**
 * create_document MCP Tool
 *
 * Creates a new document with a title.
 * Uses the same application logic as regular user document creation.
 * Content should be added separately via the modify tool.
 */
const documentService = require('../../document-service');
const agentPresence = require('../agent-presence');
const onboarding = require('../../onboarding');
const { buildYjsNode } = require('../yjs/node-builder');

// create_document delegates record creation + Yjs seeding to
// documentService.createSeededDocument (which uses the documents +
// document-service modules wired up at server bootstrap), so the tool holds no
// persistence handle of its own. init is kept only to satisfy the tool
// contract — the registry calls init on every tool.
function init() {}

/**
 * Tool definition for MCP discovery
 */
const name = 'create_document';

const description = `Create a new document with a title.

After creation, add content INCREMENTALLY via multiple modify calls.
Sessions are created automatically when you call modify or read_document.

RECOMMENDED WORKFLOW:
1. create_document({ title: "My Doc" })     → Creates empty document
2. modify({ script: "add heading..." })     → Add title/heading first
3. modify({ script: "add intro..." })       → Add introduction paragraph
4. modify({ script: "add section 1..." })   → Add first section
5. modify({ script: "add section 2..." })   → Add next section

WHY INCREMENTAL:
- User sees content appear progressively (better UX)
- Each change syncs immediately to all viewers
- Smaller scripts are more reliable
- Easier to recover from errors (partial content preserved)
- Natural undo boundaries (each modify = one undo step)

EFFICIENT PATTERNS:
- Author section by section (heading + content together)
- Build lists item by item for long lists
- Add all headings first, then fill in content
- Format similar items in batches (all TODOs, all links, etc.)`;


const inputSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'The title for the new document',
    },
  },
  required: ['title'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.title - Document title
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { docGuid, title, message }
 */
async function handler(args, agentToken) {
  const { title } = args;
  const userId = agentToken.userId;

  // Create the document and seed it with a single empty paragraph. The empty
  // paragraph isn't decorative: it gives the agent's presence cursor a text
  // node to anchor to (an empty body has nowhere to render a cursor) and lets
  // the presence session finalize immediately instead of waiting on the
  // empty-document content timeout. A plain paragraph — not a heading — keeps
  // the body clear of the title, which lives in `meta` and renders separately.
  const docGuid = await documentService.createSeededDocument({
    userId,
    title,
    nodes: [buildYjsNode({ type: 'paragraph' })],
    agentName: agentToken.agentName,
  });

  console.log(`[create_document] created docGuid=${docGuid}`);

  // The user (or an agent acting for them) just created a real, non-welcome
  // document — they're engaged. Stamp onboarded_at now instead of waiting for
  // their next login/_auth/me probe. Best-effort and not awaited: must never
  // delay or fail document creation.
  onboarding.markEngagedFromDocCreation(userId).catch(() => {});

  // Give the agent live presence (avatar + cursor) in the doc it just created,
  // the same WebSocket session modify/read_document use — so it shows up as
  // present, with a cursor anchored at the seeded paragraph above, and a
  // subsequent modify reuses this session (keyed by user+agent+doc).
  // Best-effort and deliberately NOT awaited: presence is purely visual and
  // must never fail or delay creation. Errors (e.g. no presence in a non-WS
  // context) are swallowed.
  agentPresence
    .getOrCreateSession(docGuid, agentToken, 60)
    .catch((err) => console.warn(`[create_document] presence setup failed for ${docGuid}: ${err.message}`));

  const baseUrl = agentToken.baseUrl || '';
  return {
    docGuid,
    title,
    url: `${baseUrl}/d/${docGuid}`,
    message: `Created document "${title}"`,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
