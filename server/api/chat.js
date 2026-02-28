/**
 * Chat API endpoint
 *
 * POST /api/chat — streaming AI chat with MCP tool access.
 * Uses AI SDK v6 streamText with a configurable model (see chat-models.js).
 *
 * AI SDK packages are loaded lazily on first request to avoid
 * slowing down server startup (they pull in OpenTelemetry, zod, etc.).
 */
const express = require('express');
const { requireAuth } = require('../auth');
const { extractBearerToken } = require('../auth/jwt');
const { buildBaseUrl } = require('../url');
const chatTools = require('./chat-tools');
const chatModels = require('./chat-models');
const { getDocument } = require('../documents');
const chatStore = require('../chat-store');

const router = express.Router();

// Lazy-loaded AI SDK core (heavy import — pulls in OpenTelemetry, zod, etc.)
let _ai = null;

function getAI() {
  if (!_ai) _ai = require('ai');
  return _ai;
}

const BASE_SYSTEM_PROMPT = `<identity>
You are the HeroDocs assistant — an AI helper embedded in a collaborative document editor. You help users create, edit, find, and manage their documents by taking action with your tools. You are concise and action-oriented: do things rather than explain what you could do.

When users are working on shared documents, you help manage the process of creating and editing docs in a team — organizing collaborative discussions, tracking unresolved issues, flagging miscommunication, and making sure ideas don't get lost. You do this through the tools available to you (version history, collaborator awareness, document content), not through speculation.
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

COLLABORATION REVIEW (triggered by "What changed?", "Catch me up", "Who's been editing?", etc.):
1. read_document → current content + recentAuthors + lastModifiedBy
2. get_collaborators → who's currently active
3. list_document_versions → edit timeline with author attribution
4. compare_document_versions → specific changes between versions

SYNTHESIZING EDITS INTO DECISIONS (triggered by "Summarize what we've decided", "Clean up conflicting sections", "Pull together feedback", etc.):
1. list_document_versions with includeSubversions → recent edit sessions
2. compare_document_versions → what each contributor changed
3. read_document → current state
4. modify → add summary section, decision log, or consolidate overlapping edits
</workflows>

<rules>
- Always use the correct docGuid. Never guess a document ID — ask the user or search for it.
- Read a document before editing it. Do not modify a document you haven't read in this conversation.
- Confirm destructive actions before executing: restoring versions, deleting large sections, sharing documents.
- After editing, briefly state what you changed (e.g., "Added three bullet points under Summary").
- If a tool call fails, explain the issue simply and suggest next steps.
- Before calling tools, write a brief one-sentence summary of what you're about to do and why (e.g., "Let me read the document first to see what's there."). When calling multiple tools in parallel, say so (e.g., "I'll search for that and read your document at the same time."). This keeps the user informed.
- Be direct. Do not apologize excessively or explain what you could hypothetically do.
- If you cannot finish in one turn due to tool limits, tell the user and ask them to send a follow-up message.
- When you need to gather information from multiple independent sources (e.g., reading several documents, searching and fetching), make all independent tool calls in a single response rather than one at a time. This executes them in parallel and is much faster.
- Be specific about attribution. Use author names from version history, not vague "someone made changes." Show concrete edits with attribution.
- Don't assume intentions. Report what changed; let the user interpret why. Flag contradictions neutrally: "Alice updated the budget to $50K, then Bob changed it to $40K."
- Briefly flag collaboration issues. Overlapping edits, unresolved TODOs, contradicting sections — mention them without lecturing. State the observation, ask if the user wants to address it.
- Be transparent about limitations. You cannot message other collaborators, see their chats, or send notifications. If asked, suggest sharing the document or handling coordination outside the app.
</rules>`;

function buildSystemPrompt(docGuid, docTitle) {
  if (!docGuid) return BASE_SYSTEM_PROMPT;
  const titleStr = docTitle ? ` "${docTitle}"` : '';
  return BASE_SYSTEM_PROMPT + `\n\n<active_document>
The user is currently viewing document${titleStr} (${docGuid}). When they refer to "this document", "the document", or "my document" without specifying which one, assume they mean this document. However, you are not limited to this document — the user may ask about or work on other documents too.
</active_document>`;
}

// ── Streaming chat endpoint ──────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  try {
    const { message, id: chatId, docGuid } = req.body;

    if (!message || !chatId) {
      return res.status(400).json({ error: 'message and id are required' });
    }

    // Load previous messages from DB and append the new user message
    const previousMessages = await chatStore.loadChat(chatId);
    const allMessages = [...previousMessages, message];

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

    const { streamText, convertToModelMessages, validateUIMessages, createIdGenerator, stepCountIs } = getAI();

    // Resolve configured model (env var or default)
    const modelKey = process.env.AI_CHAT_MODEL || chatModels.DEFAULT_MODEL_KEY;
    let resolved = chatModels.resolveModel(modelKey);
    if (!resolved) {
      console.error(`[Chat API] Unknown model key "${modelKey}", falling back to "${chatModels.DEFAULT_MODEL_KEY}"`);
      resolved = chatModels.resolveModel(chatModels.DEFAULT_MODEL_KEY);
      if (!resolved) {
        return res.status(500).json({ error: 'No valid chat model configured' });
      }
    }
    const { model, def, provider } = resolved;

    console.log(`[Chat API] Using model: ${def.key} (${def.modelId})`);

    // Build tool set with provider-appropriate web search
    const tools = chatTools.buildTools(syntheticAgentToken);
    if (def.provider === 'anthropic') {
      tools.webSearch = provider.tools.webSearch_20250305();
      tools.webFetch = provider.tools.webFetch_20250910();
    } else if (def.provider === 'google') {
      // Gemini can't combine googleSearch with function tools in one request,
      // so we wrap it as a function tool that makes a separate generateText call
      // with only googleSearch enabled. Uses flash for speed.
      const { tool, generateText, jsonSchema } = getAI();
      const searchModel = provider('gemini-2.5-flash');
      tools.webSearch = tool({
        description: 'Search the web for current information using Google Search. Returns a grounded summary of search results. You MUST provide a query.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query to look up on the web' },
          },
          required: ['query'],
        }),
        execute: async (args) => {
          const query = args.query || (typeof args === 'string' ? args : JSON.stringify(args));
          console.log('[Chat API] webSearch query:', query);
          const searchResult = await generateText({
            model: searchModel,
            maxTokens: 1024,
            tools: { googleSearch: provider.tools.googleSearch({}) },
            prompt: `Search the web and summarize what you find for: ${query}`,
          });
          return searchResult.text || 'No results found.';
        },
      });
    }

    // Validate and convert UI messages for streamText
    const validatedMessages = await validateUIMessages({ messages: allMessages, tools });
    const modelMessages = await convertToModelMessages(validatedMessages);

    const result = streamText({
      model,
      system: buildSystemPrompt(docGuid, docTitle),
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(10),
      // Stream Gemini thinking/reasoning to the client
      ...(def.provider === 'google' && {
        providerOptions: {
          google: { thinkingConfig: { includeThoughts: true } },
        },
      }),
      onError: ({ error }) => {
        console.error('[Chat API] Stream error:', error);
      },
    });

    // Ensure onFinish fires even if the client disconnects mid-stream
    result.consumeStream();

    result.pipeUIMessageStreamToResponse(res, {
      originalMessages: validatedMessages,
      generateMessageId: createIdGenerator({ prefix: 'msg', size: 16 }),
      onFinish: ({ messages }) => {
        chatStore.saveChat(chatId, messages).catch((err) => {
          console.error('[Chat API] Failed to save chat:', err);
        });
      },
    });
  } catch (error) {
    console.error('[Chat API] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ── Chat CRUD routes ─────────────────────────────────────────────────────────

// Create a new chat
router.post('/chats', requireAuth, async (req, res) => {
  try {
    const id = await chatStore.createChat(req.user.userId);
    res.json({ id });
  } catch (error) {
    console.error('[Chat API] Error creating chat:', error);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

// List user's chats
router.get('/chats', requireAuth, async (req, res) => {
  try {
    const chats = await chatStore.getChatsForUser(req.user.userId);
    res.json(chats);
  } catch (error) {
    console.error('[Chat API] Error listing chats:', error);
    res.status(500).json({ error: 'Failed to list chats' });
  }
});

// Load a specific chat's messages
router.get('/chats/:id', requireAuth, async (req, res) => {
  try {
    const messages = await chatStore.loadChat(req.params.id);
    res.json({ messages });
  } catch (error) {
    console.error('[Chat API] Error loading chat:', error);
    res.status(500).json({ error: 'Failed to load chat' });
  }
});

// Delete a chat
router.delete('/chats/:id', requireAuth, async (req, res) => {
  try {
    const deleted = await chatStore.deleteChat(req.params.id, req.user.userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Chat not found' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('[Chat API] Error deleting chat:', error);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

// Update chat title
router.patch('/chats/:id', requireAuth, async (req, res) => {
  try {
    const { title } = req.body;
    if (typeof title !== 'string') {
      return res.status(400).json({ error: 'title is required' });
    }
    await chatStore.updateChatTitle(req.params.id, title);
    res.json({ ok: true });
  } catch (error) {
    console.error('[Chat API] Error updating chat:', error);
    res.status(500).json({ error: 'Failed to update chat' });
  }
});

module.exports = { router };
