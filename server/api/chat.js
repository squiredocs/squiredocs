/**
 * Chat API endpoint
 *
 * POST /api/chat — streaming AI chat with MCP tool access.
 * Uses AI SDK v6 streamText with Anthropic Claude.
 *
 * AI SDK packages are loaded lazily on first request to avoid
 * slowing down server startup (they pull in OpenTelemetry, zod, etc.).
 */
const express = require('express');
const { requireAuth } = require('../auth');
const { extractBearerToken } = require('../auth/jwt');
const { buildBaseUrl } = require('../url');
const chatTools = require('./chat-tools');
const { getDocument } = require('../documents');

const router = express.Router();

// Lazy-loaded AI SDK modules (heavy imports — pull in OpenTelemetry, zod, etc.)
let _ai = null;
let _anthropic = null;

function getAI() {
  if (!_ai) _ai = require('ai');
  return _ai;
}
function getAnthropic() {
  if (!_anthropic) _anthropic = require('@ai-sdk/anthropic');
  return _anthropic;
}

const BASE_SYSTEM_PROMPT = `<identity>
You are the HeroDocs assistant — an AI helper embedded in a collaborative document editor. You help users create, edit, find, and manage their documents by taking action with your tools. You are concise and action-oriented: do things rather than explain what you could do.
</identity>

<context>
- This is a real-time collaborative editor. Multiple users may be viewing or editing simultaneously. Your edits appear live as you make them.
- You operate on the user's behalf with their permissions. You can only access documents they have access to.
- The chat persists across pages. The user may navigate between documents or pages during the conversation. You are not limited to the active document — the user may ask about any document they have access to.
- You have a limit of 10 tool calls per response. Plan accordingly — for large documents, tell the user you'll continue in the next message.
</context>

<workflows>
Common workflows — follow these patterns:

EDITING AN EXISTING DOCUMENT:
1. read_document first to understand current structure
2. modify to make changes incrementally, one section at a time
3. Briefly confirm what you changed

CREATING A NEW DOCUMENT:
1. create_document with a title
2. modify to add content section by section across multiple calls
Never write an entire document in one modify call.

FINDING A DOCUMENT:
- If the user mentions a title: list_documents with search parameter
- If ambiguous: ask the user or list their recent documents

VERSION HISTORY:
1. list_document_versions to see the timeline
2. read_document_version or compare_document_versions for details
3. restore_document_version to roll back (this is non-destructive)

RESEARCH + WRITING:
1. webSearch or webFetch to gather information
2. Then create or edit the document with what you found
</workflows>

<rules>
- Always use the correct docGuid. Never guess a document ID — ask the user or search for it.
- Read a document before editing it. Do not modify a document you haven't read in this conversation.
- Confirm destructive actions before executing: restoring versions, deleting large sections, sharing documents.
- After editing, briefly state what you changed (e.g., "Added three bullet points under Summary").
- If a tool call fails, explain the issue simply and suggest next steps.
- Be direct. Do not apologize excessively or explain what you could hypothetically do.
- If you cannot finish in one turn due to tool limits, tell the user and ask them to send a follow-up message.
- When you need to gather information from multiple independent sources (e.g., reading several documents, searching and fetching), make all independent tool calls in a single response rather than one at a time. This executes them in parallel and is much faster.
</rules>`;

function buildSystemPrompt(docGuid, docTitle) {
  if (!docGuid) return BASE_SYSTEM_PROMPT;
  const titleStr = docTitle ? ` "${docTitle}"` : '';
  return BASE_SYSTEM_PROMPT + `\n\n<active_document>
The user is currently viewing document${titleStr} (${docGuid}). When they refer to "this document", "the document", or "my document" without specifying which one, assume they mean this document. However, you are not limited to this document — the user may ask about or work on other documents too.
</active_document>`;
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { messages, docGuid } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Look up document title if docGuid provided
    let docTitle = null;
    if (docGuid) {
      try {
        const doc = await getDocument(docGuid);
        docTitle = doc?.title || null;
      } catch (e) {
        // Non-critical — proceed without title
      }
    }

    // Extract the raw bearer token for agent presence
    const rawToken = extractBearerToken(req.headers.authorization);
    const baseUrl = buildBaseUrl(req);

    // Synthetic agent token for tool execution
    const syntheticAgentToken = {
      userId: req.user.userId,
      agentId: 'in-app-chat',
      agentName: 'Chat Assistant',
      scopes: ['read', 'write'],
      isAgent: true,
      rawToken,
      baseUrl,
    };

    const { streamText, convertToModelMessages, stepCountIs } = getAI();
    const { anthropic } = getAnthropic();

    const tools = {
      ...chatTools.buildTools(syntheticAgentToken),
      webSearch: anthropic.tools.webSearch_20250305(),
      webFetch: anthropic.tools.webFetch_20250910(),
    };

    // Convert UI messages (parts-based) to model messages (content-based) for streamText
    const modelMessages = await convertToModelMessages(messages);

    const result = streamText({
      model: anthropic('claude-haiku-4-5-20251001'),
      system: buildSystemPrompt(docGuid, docTitle),
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(10),
      onError: ({ error }) => {
        console.error('[Chat API] Stream error:', error);
      },
    });

    result.pipeUIMessageStreamToResponse(res);
  } catch (error) {
    console.error('[Chat API] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

module.exports = { router };
