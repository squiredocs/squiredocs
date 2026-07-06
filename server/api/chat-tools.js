/**
 * AI SDK Tool Adapter
 *
 * Wraps existing MCP tool modules as AI SDK `tool()` definitions
 * so the chat endpoint can use them with streamText().
 *
 * Tool results are capped at a static size limit. Large documents can be
 * read in chunks via xpath, and the reactive compaction system handles
 * context overflow automatically.
 *
 * Imports from 'ai' are lazy-loaded (called from chat.js at request time).
 */
const Y = require('yjs');
const toolRegistry = require('../mcp/tools');
const { webFetch } = require('./web-fetch');
const { SNAPSHOT_TOOLS } = require('./chat-staleness');
const { getProviderConfig } = require('./ai-providers');
const documents = require('../documents');
const documentImages = require('../document-images');
const s3Images = require('../s3-images');
const documentService = require('../document-service');
const { buildYjsNode } = require('../mcp/yjs/node-builder');
const { parseAppImageUrl } = require('../image-url');

/**
 * Upload a chat-attached image into a document and insert the image node.
 * Returns a small result object (the tool's stored output); errors are returned
 * as { error } so the model can recover.
 */
async function insertChatImage({ args = {}, messageImages, chatDocGuid, userId, agentName }) {
  if (!s3Images.isEnabled()) return { error: 'Image storage is not configured.' };
  const docGuid = args.docGuid || chatDocGuid;
  if (!docGuid) return { error: 'No target document. Specify docGuid.' };
  if (!messageImages.length) {
    return { error: 'No image is attached to the current message. Ask the user to attach the image they want inserted.' };
  }
  const index = Number.isInteger(args.attachmentIndex) ? args.attachmentIndex : 0;
  const att = messageImages[index];
  if (!att) return { error: `No attachment at index ${index}; this message has ${messageImages.length} image(s).` };
  if (!(await documents.canEdit(docGuid, userId))) {
    return { error: 'You do not have permission to edit this document.' };
  }

  let stored;
  try {
    stored = await documentImages.storeImage({
      docId: docGuid, uploaderId: userId,
      data: Buffer.from(att.dataBase64, 'base64'), mimeType: att.mediaType, filename: att.filename,
    });
  } catch (e) {
    return { error: e.message };
  }

  const alt = args.alt || att.filename || null;
  const atStart = args.position === 'start';
  await documentService.updateDocument(docGuid, (ydoc) => {
    const frag = ydoc.get('default', Y.XmlFragment);
    frag.insert(atStart ? 0 : frag.length, [buildYjsNode({ type: 'image', src: stored.url, alt })]);
  }, { userId, agentName });

  return { inserted: true, id: stored.id, url: stored.url, alt };
}

// Static cap for any single tool result. Documents larger than this should
// be read in chunks via xpath. Reactive compaction handles overall context.
const MAX_RESULT_CHARS = 100_000;

// Tools that support xpath for reading documents in chunks
const XPATH_TOOLS = new Set(['read_document', 'read_document_version']);

/**
 * Build an error message for an oversized tool result.
 * For xpath-capable tools, includes paging instructions modeled on
 * Claude Code's large-result handling.
 */
function buildOversizedError(toolName, resultChars, maxChars, result) {
  const fmtResult = resultChars.toLocaleString();
  const fmtMax = maxChars.toLocaleString();

  if (XPATH_TOOLS.has(toolName)) {
    const blockCount = result?.blockCount;
    const blockInfo = blockCount ? ` The document has ${blockCount} blocks.` : '';
    return {
      error: `Error: ${toolName} result (${fmtResult} characters) exceeds available context `
        + `(~${fmtMax} characters remaining).${blockInfo}\n\n`
        + 'The document is too large to read in full. Use the xpath parameter to page through '
        + 'it in chunks of top-level blocks:\n'
        + '- Page 1: xpath: "/*[position() <= 50]"\n'
        + '- Page 2: xpath: "/*[position() > 50 and position() <= 100]"\n'
        + (blockCount
          ? `- Continue until all ${blockCount} blocks are covered\n`
          : '- Continue with successive ranges until all blocks are covered\n')
        + '\nYou can also search for specific content:\n'
        + '- xpath: "//heading" \u2014 get document structure\n'
        + '- xpath: "//paragraph[contains(., \'keyword\')]" \u2014 find specific text\n'
        + '\nREQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n'
        + '- You MUST read the content in sequential chunks until you have covered all blocks\n'
        + '- Before producing ANY summary or analysis, you MUST describe what portions you have read\n'
        + '- If you have not read the entire document, you MUST explicitly state this',
    };
  }

  return {
    error: `Tool result too large (${fmtResult} characters, ~${fmtMax} remaining). `
      + 'Try using more specific parameters to narrow the result.',
  };
}

/**
 * Build provider-specific webSearch and universal webFetch tools.
 * @param {string} providerName - 'anthropic' or 'google'
 * @param {object} provider - AI SDK provider factory (e.g. google or anthropic)
 * @returns {object} { webSearch, webFetch } tool definitions
 */
function buildWebTools(providerName, provider) {
  const { tool, jsonSchema } = require('ai');
  const tools = {};

  // Provider-specific web search (delegated to the provider registry; the
  // builder returns null for providers without web search).
  if (providerName) {
    const webSearch = getProviderConfig(providerName).buildWebSearch(provider);
    if (webSearch) tools.webSearch = webSearch;
  }

  // Universal webFetch — works the same for all providers
  tools.webFetch = tool({
    description: 'Fetch and read the contents of a web page at a specific URL. Use this when the user asks you to read, review, or summarize a web page, or when you need to check a link.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch and read' },
      },
      required: ['url'],
    }),
    execute: async (args) => {
      const url = args.url || (typeof args === 'string' ? args : '');
      console.log('[Chat API] webFetch url:', url);
      try {
        const result = await webFetch(url);
        return result.truncated ? result.content + '\n\n[Content truncated]' : result.content;
      } catch (err) {
        console.error('[Chat API] webFetch error:', err.message);
        return 'Could not fetch the requested URL.';
      }
    },
  });

  return tools;
}

/**
 * Build chat-only image tools (not in the shared MCP registry, since external
 * agents have no chat attachments):
 *   - insert_image: place an image the user attached in THIS message into a doc.
 *   - view_image: fetch an image already in a doc and show it to the model (vision).
 * Both run in-process against s3Images / documentImages / documentService.
 *
 * @param {object} agentToken - { userId, agentName }
 * @param {object} ctx - { messageImages, docGuid }
 */
function buildImageTools(agentToken, { messageImages = [], docGuid: chatDocGuid } = {}) {
  const { tool, jsonSchema } = require('ai');
  const tools = {};
  const userId = agentToken.userId;
  const agentName = agentToken.agentName;

  tools.insert_image = tool({
    description:
      'Insert an image the user attached in the CURRENT chat message into a document. '
      + 'Use when the user asks to add/place/insert an image they attached. The image is '
      + 'referenced by its 0-based index among the attachments in this message '
      + '(attachmentIndex, default 0). Inserts at the end of the document by default. '
      + 'Only works for images attached in chat — to reference an image already in the '
      + 'document, use the modify tool instead.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        docGuid: { type: 'string', description: 'Target document UUID (defaults to the current document).' },
        attachmentIndex: { type: 'integer', minimum: 0, description: '0-based index of the attached image in this message (default 0).' },
        alt: { type: 'string', description: 'Alt text / caption describing the image.' },
        position: { type: 'string', enum: ['start', 'end'], description: 'Where to place it (default: end).' },
      },
      required: [],
    }),
    execute: async (args = {}) => {
      try {
        return await insertChatImage({ args, messageImages, chatDocGuid, userId, agentName });
      } catch (error) {
        console.error('[chat-tools] insert_image error:', error.message);
        return { error: error.message };
      }
    },
  });

  tools.view_image = tool({
    description:
      'View an image that is already in a document so you can see its actual contents '
      + '(e.g. to describe, critique, or answer questions about it). Pass the image\'s id '
      + 'or its app URL (/api/docs/:docId/images/:imageId), which appears as the src of '
      + 'image nodes when you read the document.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        docGuid: { type: 'string', description: 'Document UUID (defaults to the current document).' },
        imageId: { type: 'string', description: 'The image id, or the full app image URL.' },
      },
      required: ['imageId'],
    }),
    execute: async (args = {}) => {
      try {
        if (!s3Images.isEnabled()) return { error: 'Image storage is not configured.' };
        let docGuid = args.docGuid || chatDocGuid;
        let imageId = args.imageId;
        const parsed = parseAppImageUrl(imageId);
        if (parsed) {
          docGuid = parsed.docId;
          imageId = parsed.imageId;
        } else if (typeof imageId === 'string' && imageId.includes('/')) {
          return { error: 'Provide a bare image id or an app image URL (/api/docs/:docId/images/:imageId).' };
        }
        if (!docGuid || !imageId) return { error: 'Provide an imageId (or app image URL) and docGuid.' };
        if (!(await documents.hasAccess(docGuid, userId))) {
          return { error: 'You do not have access to this document.' };
        }
        const image = await documentImages.getImage(imageId, docGuid);
        if (!image) return { error: 'Image not found in this document.' };
        // Bytes are fetched in toModelOutput (kept out of stored chat history).
        return { imageId, docGuid, mediaType: image.mime_type, s3Key: image.s3_key, viewed: true };
      } catch (error) {
        console.error('[chat-tools] view_image error:', error.message);
        return { error: error.message };
      }
    },
    // Send the actual image bytes to the model as a multimodal tool result, while
    // the stored result (execute output) stays small (just metadata).
    toModelOutput: async ({ output }) => {
      if (!output || output.error) {
        return { type: 'error-text', value: output?.error || 'Could not view image.' };
      }
      try {
        const bytes = await s3Images.getObject(output.s3Key);
        return {
          type: 'content',
          value: [
            { type: 'text', text: `Image ${output.imageId} (${output.mediaType}):` },
            { type: 'image-data', data: bytes.toString('base64'), mediaType: output.mediaType },
          ],
        };
      } catch (err) {
        console.error('[chat-tools] view_image fetch failed:', err.message);
        return { type: 'error-text', value: 'The image could not be loaded.' };
      }
    },
  });

  return tools;
}

/**
 * Build AI SDK tool definitions from the MCP tool registry,
 * plus provider-specific web tools when provider info is given.
 * @param {object} syntheticAgentToken - Token object for tool execution context
 * @param {object} [opts] - Optional provider info for web tools
 * @param {string} [opts.providerName] - 'anthropic' or 'google'
 * @param {object} [opts.provider] - AI SDK provider factory
 * @returns {object} Map of tool name -> AI SDK tool definition
 */
function buildTools(syntheticAgentToken, { providerName, provider, pool, observedClockHolder, docGuid, messageImages } = {}) {
  const { tool, jsonSchema } = require('ai');
  const mcpTools = toolRegistry.getToolList();
  const aiTools = {};

  for (const { name, description, inputSchema } of mcpTools) {
    // Script tools (modify, compare_document_versions) ship a short MCP
    // description because clients truncate at 2KB, and carry the full API
    // reference in chatDescription; in-app chat has no such limit, so prefer
    // the full docs here.
    const chatDescription = toolRegistry.getTool(name)?.chatDescription;
    aiTools[name] = tool({
      description: chatDescription || description,
      inputSchema: jsonSchema(inputSchema),
      execute: async (args) => {
        try {
          // Tell modify the clock the agent last observed for this doc so it can
          // detect concurrent edits. Read lazily: the holder is populated after
          // the message history is parsed, before streaming begins.
          if (name === 'modify' && args?.docGuid && observedClockHolder?.byDoc) {
            const baseClock = observedClockHolder.byDoc.get(args.docGuid);
            if (typeof baseClock === 'number') args = { ...args, _baseClock: baseClock };
          }
          const result = await toolRegistry.executeTool(name, args, syntheticAgentToken);

          // Advance the observed-clock baseline as the agent sees fresh document
          // state. read_document and modify (success OR conflict) echo content at
          // result.clock, so after either the agent has "seen" that clock. Without
          // this, the baseline stays frozen at request start and a modify conflict
          // can never clear mid-turn: every retry resends the same stale _baseClock
          // and re-trips the same conflict. (Cross-turn, getObservedClocks recovers
          // it from history; this makes reconciliation work within a turn too.)
          if (observedClockHolder?.byDoc && args?.docGuid && SNAPSHOT_TOOLS.has(name)) {
            const clk = result?.clock;
            if (typeof clk === 'number') {
              const prev = observedClockHolder.byDoc.get(args.docGuid);
              if (prev === undefined || clk > prev) {
                observedClockHolder.byDoc.set(args.docGuid, clk);
              }
            }
          }

          const serialized = JSON.stringify(result);
          if (serialized.length > MAX_RESULT_CHARS) {
            console.warn(
              `[chat-tools] "${name}" result too large: ${serialized.length.toLocaleString()} chars `
              + `(limit: ${MAX_RESULT_CHARS.toLocaleString()})`
            );
            return buildOversizedError(name, serialized.length, MAX_RESULT_CHARS, result);
          }
          // Enrich doc-scoped tool results with title for chat UI labels
          if (pool && args.docGuid && result && typeof result === 'object' && !result.error) {
            try {
              const titleRow = await pool.query('SELECT title FROM documents WHERE id = $1', [args.docGuid]);
              result.docTitle = titleRow.rows[0]?.title || null;
            } catch (_) { /* best-effort */ }
          }
          return result;
        } catch (error) {
          return { error: error.message };
        }
      },
    });
  }

  if (providerName && provider) {
    Object.assign(aiTools, buildWebTools(providerName, provider));
  }

  // Chat-only image tools (insert from chat attachment, view doc images).
  Object.assign(aiTools, buildImageTools(syntheticAgentToken, { messageImages, docGuid }));

  return aiTools;
}

module.exports = { buildTools, buildWebTools, buildImageTools, MAX_RESULT_CHARS, XPATH_TOOLS, buildOversizedError };
