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
const svgRender = require('../mcp/svg-render');
const agentPresence = require('../mcp/agent-presence');
const { importMarkdown, deriveImportTitle, ImportError } = require('../markdown-import');

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

/**
 * Import a markdown file the user attached to this chat message as a new
 * document. The byte channel in tool form: the file content moves from the
 * attachment store into the importer without ever entering model context —
 * the model only sees this tool's small result. Mirrors POST /api/docs/import
 * (create path), with the file name as the default title.
 */
async function importChatMarkdown({ args = {}, messageMarkdown, userId, agentName }) {
  if (!messageMarkdown.length) {
    return { error: 'No markdown file is attached to the current message. Ask the user to attach the file they want imported.' };
  }
  const index = Number.isInteger(args.attachmentIndex) ? args.attachmentIndex : 0;
  const att = messageMarkdown[index];
  if (!att) return { error: `No markdown attachment at index ${index}; this message has ${messageMarkdown.length} markdown file(s).` };

  const markdown = Buffer.from(att.dataBase64, 'base64').toString('utf-8');
  if (!markdown.trim()) return { error: 'The attached markdown file is empty.' };

  // Title precedence: explicit arg → file name (minus extension) → frontmatter/
  // first heading → Untitled.
  const fromFilename = (att.filename || '').replace(/\.(md|markdown)$/i, '').trim();
  const title = (typeof args.title === 'string' && args.title.trim())
    || fromFilename
    || deriveImportTitle(markdown).title
    || 'Untitled';

  const docGuid = await documentService.createSeededDocument({ userId, title, nodes: [], agentName });
  const ydoc = documentService.getSharedDoc(docGuid);
  try {
    const report = await importMarkdown(ydoc, markdown, {
      mode: 'append',
      actor: { userId, agentName },
      imageContext: { docId: docGuid },
    });
    return { imported: true, docGuid, title, url: `/d/${docGuid}`, blocks: report.blocks, images: report.images };
  } catch (error) {
    if (error instanceof ImportError && error.code === 'EMPTY_IMPORT') {
      // Nothing importable remained (e.g. image-only file, all dropped by the
      // image policy). The doc row already exists — seed the anchor paragraph
      // rather than leave an orphaned empty doc (docs-import F1 parity).
      await documentService.updateDocument(docGuid, (liveDoc) => {
        const frag = liveDoc.get('default', Y.XmlFragment);
        if (frag.length === 0) frag.insert(0, [buildYjsNode({ type: 'paragraph' })]);
      }, { userId, agentName });
      return { imported: true, docGuid, title, url: `/d/${docGuid}`, blocks: { imported: 0 }, images: error.images || undefined };
    }
    throw error;
  }
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
 *   - view_svg_blocks: rasterize the doc's SVG blocks and show the rendered
 *     results to the model (vision) — lets the agent see what it (or a
 *     collaborator) drew.
 * All run in-process against s3Images / documentImages / agentPresence.
 *
 * @param {object} agentToken - { userId, agentName }
 * @param {object} ctx - { messageImages, messageMarkdown, docGuid }
 */
function buildImageTools(agentToken, { messageImages = [], messageMarkdown = [], docGuid: chatDocGuid, supportsImages = true } = {}) {
  const { tool, jsonSchema } = require('ai');
  const tools = {};
  const userId = agentToken.userId;
  const agentName = agentToken.agentName;

  tools.import_markdown = tool({
    description:
      'Import a markdown file the user attached to the CURRENT chat message as a new document. '
      + 'The file content is piped directly into the importer — it is not part of this conversation. '
      + 'Reference the file by its 0-based index among the markdown attachments in this message '
      + '(attachmentIndex, default 0). The title defaults to the file name; pass title only to override. '
      + 'Returns the created document\'s docGuid, title, and url. Use read_document afterwards if you '
      + 'need the imported content.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        attachmentIndex: { type: 'integer', minimum: 0, description: '0-based index of the markdown attachment in this message (default 0).' },
        title: { type: 'string', description: 'Optional title override; defaults to the attached file name.' },
      },
      required: [],
    }),
    execute: async (args = {}) => {
      try {
        return await importChatMarkdown({ args, messageMarkdown, userId, agentName });
      } catch (error) {
        console.error('[chat-tools] import_markdown error:', error.message);
        return { error: error.message };
      }
    },
  });

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

  // Live document fragment via the same session path read_document uses —
  // always current (no persistence race) and access-checked.
  const getLiveFragment = async (docGuid) => {
    const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60);
    return session.provider.doc.get('default', Y.XmlFragment);
  };

  tools.view_svg_blocks = tool({
    description:
      'Render the document\'s SVG blocks to images so you can SEE the rendered results. '
      + 'Use it to check your own work after writing or editing an SVG block with modify, or '
      + 'to describe/critique an SVG a collaborator drew. By default ALL SVG blocks render '
      + '(up to 4); pass an xpath (same dialect as read_document, e.g. "//svg[2]") to narrow. '
      + 'Each image is labeled with its //svg[n] xpath for follow-up reads/edits. The render '
      + 'reflects what users actually see: the source is sanitized first, so stripped content '
      + '(scripts, external references) will not appear.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        docGuid: { type: 'string', description: 'Document UUID (defaults to the current document).' },
        xpath: { type: 'string', description: 'Optional XPath filter selecting which SVG blocks to render (e.g. "//svg[2]"). Omit to render all.' },
      },
      required: [],
    }),
    execute: async (args = {}) => {
      try {
        const docGuid = args.docGuid || chatDocGuid;
        if (!docGuid) return { error: 'No document in context. Specify docGuid.' };
        // Existence/xpath problems surface as a normal tool error now; bytes
        // are rendered in toModelOutput (kept out of stored chat history).
        const fragment = await getLiveFragment(docGuid);
        const blocks = svgRender.collectSvgBlocks(fragment, args.xpath);
        return {
          docGuid,
          xpath: args.xpath,
          blocks: blocks.map((b) => b.label),
          viewed: true,
        };
      } catch (error) {
        console.error('[chat-tools] view_svg_blocks error:', error.message);
        return { error: error.message };
      }
    },
    // Rasterize and send the PNGs to the model as a multimodal tool result; the
    // stored result (execute output) stays small (just metadata).
    toModelOutput: async ({ output }) => {
      if (!output || output.error) {
        return { type: 'error-text', value: output?.error || 'Could not render the SVG blocks.' };
      }
      try {
        const fragment = await getLiveFragment(output.docGuid);
        const { rendered, totalSvgBlocks, skipped } = await svgRender.renderSvgBlocks(
          fragment, output.xpath,
        );
        const value = [];
        for (const block of rendered) {
          if (block.error) {
            value.push({ type: 'text', text: `${block.label}: could not render — ${block.error}` });
          } else {
            value.push({
              type: 'text',
              text: `${block.label} (${block.width}×${block.height}px, sanitized as users see it):`,
            });
            value.push({
              type: 'image-data',
              data: block.png.toString('base64'),
              mediaType: 'image/png',
            });
          }
        }
        if (skipped.length > 0) {
          value.push({
            type: 'text',
            text: `Not rendered (max ${svgRender.MAX_BLOCKS_PER_CALL} per call): ${skipped.join(', ')} — call again with an xpath to view them.`,
          });
        }
        value.push({
          type: 'text',
          text: `The document has ${totalSvgBlocks} SVG block(s) in total.`,
        });
        return { type: 'content', value };
      } catch (err) {
        console.error('[chat-tools] view_svg_blocks render failed:', err.message);
        return { type: 'error-text', value: `The SVG blocks could not be rendered: ${err.message}` };
      }
    },
  });

  // A text-only model (GLM, supportsImages === false) can't accept image
  // content. The vision tools would let the agent 404 the whole turn by feeding
  // image bytes back through a tool result — view_image/view_svg_blocks resolve
  // to `image-data`/`image_url` content, which the provider rejects exactly like
  // an attached image ("No endpoints found that support image input"). This path
  // bypasses the message-level image guards entirely (the bytes come from a tool
  // result, not a message part), so gate it here. insert_image is also dead on a
  // text-only model — no image attachment ever reaches it. import_markdown stays:
  // it pipes bytes to the importer, never to the model.
  if (!supportsImages) {
    delete tools.insert_image;
    delete tools.view_image;
    delete tools.view_svg_blocks;
  }

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
function buildTools(syntheticAgentToken, { providerName, provider, pool, observedClockHolder, docGuid, messageImages, messageMarkdown, supportsImages = true } = {}) {
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
          // state (read_document result, modify success, or a modify conflict that
          // echoed the current content). Without this, the baseline stays frozen at
          // request start and a conflict can never clear mid-turn. A conflict WITHOUT
          // echoed content must NOT advance the baseline: the agent hasn't seen the
          // other author's edits, so a blind retry should re-trip the guard until it
          // calls read_document (which advances the clock).
          const sawContent = !(result?.conflict === true && result?.content === undefined);
          if (observedClockHolder?.byDoc && args?.docGuid && SNAPSHOT_TOOLS.has(name) && sawContent) {
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

  // Chat-only image tools (insert from chat attachment, view doc images,
  // render SVG blocks for vision).
  Object.assign(aiTools, buildImageTools(syntheticAgentToken, { messageImages, messageMarkdown, docGuid, supportsImages }));

  return aiTools;
}

module.exports = { buildTools, buildWebTools, buildImageTools, MAX_RESULT_CHARS, XPATH_TOOLS, buildOversizedError };
