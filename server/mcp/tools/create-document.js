/**
 * create_document MCP Tool
 *
 * Creates a new document with a title.
 * Uses the same application logic as regular user document creation.
 * Content should be added separately via the modify tool.
 */
const Y = require('yjs');
const documentService = require('../../document-service');
const agentPresence = require('../agent-presence');
const onboarding = require('../../onboarding');
const { buildYjsNode } = require('../yjs/node-builder');
const { importMarkdown, deriveImportTitle, ImportError } = require('../../markdown-import');

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

const description = `Create a new document from content you are authoring — NOT for syncing/importing an existing markdown file (use import_markdown_file for that).

IF THE MARKDOWN ALREADY EXISTS AS A FILE (or any bytes outside your context):
do NOT retype it through this tool's markdown parameter. Even if you have
already read the file, the file remains the source of truth — use the byte
channel: call import_markdown_file for a ready-to-run one-shot recipe, or
mint with create_access_token({ scopes: ["documents:read",
"documents:write"] }) and POST /api/docs/import (PUT /api/docs/:docId/import
for updates). It moves the bytes over HTTP without transiting model context,
returns a canonical-markdown receipt for exact verification, and with
frontmatter=true the receipt written back over your file makes the new doc
sync-ready from birth. See get_tool_documentation({ tool: "rest_api" }).

ONE-CALL CREATION FROM MARKDOWN (preferred when you are authoring the
content in-context):
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
Why incremental: progressive display, live sync to viewers, more reliable
small scripts, and natural undo boundaries (each modify = one undo step).`;


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
        + 'in the body. Do NOT retype markdown that already exists as a file — '
        + 'import the file over the REST byte channel instead '
        + '(import_markdown_file / POST /api/docs/import).',
    },
    allowRetyped: {
      type: 'boolean',
      description: 'Acknowledge deliberately retyping bulk markdown through '
        + 'model context. Only meaningful at/above the size-refusal threshold '
        + '(default 10,240 UTF-8 bytes), where it is always honored; ignored '
        + 'below it.',
    },
  },
  required: [],
};

// Teaching thresholds (feature 019, FR-017/RBD-3): the nudge and soft
// refusal trigger on the UTF-8 byte length of the markdown argument.
const TEACHING_DEFAULTS = { nudgeBytes: 2048, refusalBytes: 10240 };

/**
 * Resolve the teaching thresholds from the environment AT CALL TIME
 * (research R3 — testable without module-cache gymnastics). Pair-wise
 * validation: any invalid configuration (non-numeric, non-integer, <= 0, or
 * refusal <= nudge) falls back to BOTH defaults — a typo'd env var must
 * never turn the soft refusal into refuse-everything or disable teaching.
 */
function resolveTeachingThresholds() {
  const rawNudge = process.env.CREATE_DOCUMENT_NUDGE_BYTES;
  const rawRefusal = process.env.CREATE_DOCUMENT_REFUSAL_BYTES;
  if (rawNudge === undefined && rawRefusal === undefined) {
    return { ...TEACHING_DEFAULTS };
  }
  const nudgeBytes = rawNudge === undefined ? TEACHING_DEFAULTS.nudgeBytes : Number(rawNudge);
  const refusalBytes = rawRefusal === undefined ? TEACHING_DEFAULTS.refusalBytes : Number(rawRefusal);
  const valid =
    Number.isInteger(nudgeBytes) && nudgeBytes > 0 &&
    Number.isInteger(refusalBytes) && refusalBytes > nudgeBytes;
  return valid ? { nudgeBytes, refusalBytes } : { ...TEACHING_DEFAULTS };
}

/** The FR-018 success nudge appended to results at/above the nudge threshold. */
function buildNudge(markdownBytes) {
  return ` NOTE: ${markdownBytes} bytes of markdown passed through model context. `
    + 'If this content exists as a file, prefer the byte channel — '
    + 'POST /api/docs/import is byte-faithful and returns a canonical receipt '
    + 'for exact verification (receipt-verified). See import_markdown_file or '
    + 'get_tool_documentation({ tool: "rest_api" }).';
}

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

  // Teaching evaluation (feature 019, FR-017..FR-021): measured in UTF-8
  // BYTES, BEFORE any side effect — a refused call must create nothing. The
  // refusal is never unconditional: allowRetyped: true is honored for any
  // caller at any size (shell-less agents have no byte channel).
  const markdownBytes = hasMarkdown ? Buffer.byteLength(markdown, 'utf8') : 0;
  const { nudgeBytes, refusalBytes } = resolveTeachingThresholds();
  if (markdownBytes >= refusalBytes && args.allowRetyped !== true) {
    throw new Error(
      `create_document refused: the markdown argument is ${markdownBytes} UTF-8 bytes of retyped `
      + `content (soft-refusal threshold: ${refusalBytes}). Nothing was created. Markdown that `
      + 'already exists as a file should move over the byte channel instead — POST /api/docs/import '
      + '(byte-faithful, receipt-verified; call import_markdown_file for a ready-to-run recipe, or '
      + 'see get_tool_documentation({ tool: "rest_api" })). If you cannot use a shell or make HTTP '
      + 'requests, or you genuinely authored this content in-context, retry the identical call with '
      + 'allowRetyped: true — it is always honored.'
    );
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
    try {
      importReport = await importMarkdown(ydoc, markdown, {
        mode: 'append',
        actor: { userId, agentName: agentToken.agentName || null },
        imageContext: { docId: docGuid },
      });
    } catch (error) {
      if (!(error instanceof ImportError && error.code === 'EMPTY_IMPORT')) throw error;
      // deriveImportTitle counted image block(s) BEFORE the image policy;
      // prepareImport then dropped them all. The doc was already created with an
      // empty body — rather than throw and orphan an empty untitled doc (F1),
      // seed the anchor paragraph (frontmatter-only shape) and report the
      // dropped image(s) so nothing vanishes silently.
      // Two-phase (feature 049). The emptiness guard stays inside the mutate
      // phase: it is a read that must observe the state the insert runs on.
      await documentService.updateDocument(
        docGuid,
        () => (liveDoc) => {
          const liveFragment = liveDoc.get('default', Y.XmlFragment);
          if (liveFragment.length === 0) {
            liveFragment.insert(0, [buildYjsNode({ type: 'paragraph' })]);
          }
        },
        { userId, agentName: agentToken.agentName || null }
      );
      importReport = {
        blocks: { imported: 0 },
        images: error.images || { rehosted: [], copied: [], degraded: [], rejected: [] },
      };
    }
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
  // FR-018/FR-020: at/above the nudge threshold (including allowRetyped
  // creations) the SUCCESS result points at the byte channel. Below it the
  // result is byte-identical to the pre-019 shape (FR-021).
  if (markdownBytes >= nudgeBytes) {
    result.message += buildNudge(markdownBytes);
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
