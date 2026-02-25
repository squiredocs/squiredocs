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

const SYSTEM_PROMPT = `You are a helpful assistant embedded in a collaborative document editor called HeroDocs. You help users create, edit, and manage their documents.

You have access to document tools that let you:
- List, create, and share documents
- Read document content
- Edit documents using the modify tool (supports operations like insert, delete, replace, and set on document blocks)
- Manage document versions (list, read, compare, restore, name)
- Undo/redo changes
- View collaborators

When editing documents:
- Always read the document first to understand its current structure
- Use the modify tool with incremental edits rather than replacing entire documents
- Specify document IDs explicitly — do not guess or assume which document the user means unless clear from context
- After making edits, briefly confirm what you changed

Keep responses concise and helpful. Focus on taking action rather than explaining what you could do.`;

router.post('/', requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
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
      system: SYSTEM_PROMPT,
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
