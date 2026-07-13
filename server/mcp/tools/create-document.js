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
const { importMarkdown, deriveImportTitle } = require('../../markdown-import');

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

const description = `Create a new document, optionally seeded from markdown.

ONE-CALL CREATION FROM MARKDOWN (preferred when you already have content):
  create_document({ markdown: "# Title\\n\\nBody..." })
The markdown is imported as rich blocks (headings, lists, tables, code and
mermaid fences, links, inline formatting). Title precedence: explicit title
argument → frontmatter squire: title → first heading text → "Untitled"; a
heading used for the title stays in the body. External images are handled by
the import image policy and itemized in the returned images report.

At least one of title / markdown is required.

For an EMPTY document, pass just a title, then add content INCREMENTALLY via
multiple modify calls (sessions are created automatically when you call
modify or read_document):
1. create_document({ title: "My Doc" })     → Creates empty document
2. modify({ script: "add heading..." })     → Add title/heading first
3. modify({ script: "add section 1..." })   → Add first section

WHY INCREMENTAL (for authoring new content):
- User sees content appear progressively (better UX)
- Each change syncs immediately to all viewers
- Smaller scripts are more reliable
- Easier to recover from errors (partial content preserved)
- Natural undo boundaries (each modify = one undo step)`;


const inputSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'The title for the new document. Optional when markdown is '
        + 'given (title is then derived from frontmatter or the first heading).',
    },
    markdown: {
      type: 'string',
      description: 'Optional markdown to seed the document with. Imported as '
        + 'rich blocks via the shared import pipeline; the first heading stays '
        + 'in the body.',
    },
  },
  required: [],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.title - Document title
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { docGuid, title, message }
 */
async function handler(args, agentToken) {
  const { title: explicitTitle, markdown } = args;
  const userId = agentToken.userId;

  const hasMarkdown = typeof markdown === 'string' && markdown.trim() !== '';
  const hasTitle = typeof explicitTitle === 'string';
  if (!hasTitle && !hasMarkdown) {
    throw new Error('create_document requires at least one of: title, markdown');
  }

  // Title precedence (FR-008): explicit title → frontmatter squire: title →
  // first heading text → "Untitled". A title-donor heading stays in the body.
  // Title-only calls keep their legacy behavior exactly (including '' titles).
  const derived = hasMarkdown ? deriveImportTitle(markdown) : { title: null, hasBody: false };
  const title = hasMarkdown ? explicitTitle || derived.title || 'Untitled' : explicitTitle;

  // Seeding: with markdown, the imported content itself anchors the agent's
  // presence cursor. Without markdown (or when the markdown is frontmatter
  // only), seed a single empty paragraph — it isn't decorative: it gives the
  // presence cursor a text node to anchor to (an empty body has nowhere to
  // render a cursor) and lets the presence session finalize immediately
  // instead of waiting on the empty-document content timeout. A plain
  // paragraph — not a heading — keeps the body clear of the title, which
  // lives in `meta` and renders separately.
  const seedContent = hasMarkdown && derived.hasBody;
  const docGuid = await documentService.createSeededDocument({
    userId,
    title,
    nodes: seedContent ? [] : [buildYjsNode({ type: 'paragraph' })],
    agentName: agentToken.agentName,
  });

  // Import through the single module path (FR-001). The create + import
  // updates land in one version-history session (same author, same instant).
  let importReport = null;
  if (seedContent) {
    const ydoc = documentService.getSharedDoc(docGuid);
    importReport = await importMarkdown(ydoc, markdown, {
      mode: 'append',
      actor: { userId, agentName: agentToken.agentName || null },
      imageContext: { docId: docGuid },
    });
  }

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
  const result = {
    docGuid,
    title,
    url: `${baseUrl}/d/${docGuid}`,
    message: `Created document "${title}"`,
  };
  if (importReport) {
    result.blocks = importReport.blocks;
    result.images = importReport.images;
    result.message = `Created document "${title}" with ${importReport.blocks.imported} imported block(s)`;
  }
  return result;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
