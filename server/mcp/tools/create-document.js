/**
 * create_document MCP Tool
 *
 * Creates a new document with a title.
 * Uses the same application logic as regular user document creation.
 * Content should be added separately via the modify tool.
 */
const Y = require('yjs');
const { randomUUID } = require('crypto');
const documentService = require('../../document-service');
const agentPresence = require('../agent-presence');

// Persistence provider and documents module - set by init function
let persistenceProvider = null;
let documents = null;

/**
 * Initialize the tool with a persistence provider and documents module
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
  // Import documents module here to avoid circular dependencies
  documents = require('../../documents');
}

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
  if (!persistenceProvider || !documents) throw new Error('create_document tool not initialized');

  const { title } = args;
  const userId = agentToken.userId;

  // Generate UUID (same approach as client-side, but using Node.js crypto)
  const docGuid = randomUUID();

  const pool = persistenceProvider.getPool();

  // Create the document using the same application logic as regular users
  // This ensures consistent behavior: creates document record and sets owner role
  await documents.createDocument(docGuid, userId);

  // Update the title in the database
  await pool.query('UPDATE documents SET title = $1 WHERE id = $2', [title, docGuid]);

  // Also set the document title in Yjs metadata for consistency
  // This ensures it goes through the normal Yjs update flow and persistence
  let blockCountAfterCreate = 0;
  await documentService.updateDocument(
    docGuid,
    (ydoc) => {
      const meta = ydoc.getMap('meta');
      meta.set('title', title);

      // Seed a single empty paragraph so the body isn't a zero-block void. This
      // gives the agent's presence cursor a text node to anchor to — an empty
      // XmlFragment has nowhere to render a cursor, so the agent would be
      // invisible in the doc it just created. It also lets the presence session
      // finalize immediately instead of waiting on the empty-document content
      // timeout. A plain paragraph (not a heading) keeps the body clear of the
      // title, which lives in `meta` and renders in its own field.
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      if (xmlFragment.length === 0) {
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText()]);
        xmlFragment.insert(0, [paragraph]);
      }
      blockCountAfterCreate = xmlFragment.toArray().length;
    },
    { userId, agentName: agentToken.agentName }
  );

  console.log(`[create_document:DIAGNOSTIC] docGuid=${docGuid}`);
  console.log(`[create_document:DIAGNOSTIC] blockCountAfterCreate=${blockCountAfterCreate}`);

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
