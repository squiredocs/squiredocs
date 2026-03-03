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
const { createAgentTokenPair } = require('../mcp/auth/agent-token-factory');
const { buildBaseUrl } = require('../url');
const chatTools = require('./chat-tools');
const chatModels = require('./chat-models');
const { getDocument } = require('../documents');
const chatStore = require('../chat-store');
const aiUsage = require('../ai-usage');

const router = express.Router();

// Map<chatId, { chunks: string[], done: boolean }>
// Buffers SSE chunks so reconnecting clients can replay + continue.
const activeStreams = new Map();

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
- You have a limit of 100 tool calls per response. At 95 tool calls you will be asked to wrap up — summarize progress and ask the user to continue if needed.
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
- If you find yourself in a response where tool use is unavailable but your task is incomplete, you have reached the tool call limit for this turn. You must write a closing message that: (1) summarizes what you accomplished, (2) lists what still needs to be done, and (3) asks the user to send a follow-up message to continue. Never silently stop mid-task.
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

    // Check AI usage quota before proceeding
    const quota = await aiUsage.checkQuota(req.user.userId);
    if (!quota.allowed) {
      return res.status(429).json({ error: 'AI usage limit reached' });
    }

    // Load previous messages from DB and append the new user message.
    // Filter out any messages with empty parts — these can occur when a
    // stream is interrupted before any content arrives, and the AI SDK
    // requires every message to have at least one part.
    const previousMessages = (await chatStore.loadChat(chatId))
      .filter(m => m.parts && m.parts.length > 0);
    const allMessages = [...previousMessages, message];

    // Persist user message immediately so it survives interrupted streams
    await chatStore.saveChat(chatId, allMessages);

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

    const baseUrl = buildBaseUrl(req);
    const { token: syntheticAgentToken } = createAgentTokenPair({
      userId: req.user.userId,
      agentId: 'in-app-chat',
      agentName: 'HeroDocs Assistant',
      scopes: ['read', 'write'],
      baseUrl,
    });

    const { streamText, convertToModelMessages, validateUIMessages, createIdGenerator, stepCountIs, pipeUIMessageStreamToResponse } = getAI();

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
      stopWhen: stepCountIs(100),
      prepareStep: ({ stepNumber }) => {
        if (stepNumber >= 95) {
          return { toolChoice: 'none' };
        }
      },
      // Stream Gemini thinking/reasoning to the client
      ...(def.provider === 'google' && {
        providerOptions: {
          google: { thinkingConfig: { includeThoughts: true } },
        },
      }),
      onError: ({ error }) => {
        console.error('[Chat API] Stream error:', error);
      },
      onFinish: async ({ usage }) => {
        if (!usage) return;
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const costCents = aiUsage.computeCostCents(def.key, inputTokens, outputTokens);
        aiUsage.recordUsage(req.user.userId, {
          chatId, modelKey: def.key,
          inputTokens, outputTokens, costCents,
        }).catch(err => console.error('[Chat API] Failed to record usage:', err));
      },
    });

    // Build the UI message stream with an onFinish callback for persistence.
    // We tee the stream so one branch is drained independently — this
    // guarantees both onFinish callbacks fire (streamText's for usage
    // tracking, toUIMessageStream's for message saving) even if the HTTP
    // response breaks (e.g. the user refreshes mid-stream).
    const uiStream = result.toUIMessageStream({
      originalMessages: validatedMessages,
      generateMessageId: createIdGenerator({ prefix: 'msg', size: 16 }),
      onFinish: ({ messages }) => {
        chatStore.saveChat(chatId, messages).catch((err) => {
          console.error('[Chat API] Failed to save chat:', err);
        });
      },
    });

    const [httpStream, saveStream] = uiStream.tee();
    saveStream.pipeTo(new WritableStream()).catch(() => {});

    // Buffer SSE for stream reconnection after page reload
    const entry = { chunks: [], done: false };
    activeStreams.set(chatId, entry);

    pipeUIMessageStreamToResponse({
      response: res,
      stream: httpStream,
      consumeSseStream: ({ stream: sseStream }) => {
        sseStream.pipeTo(new WritableStream({
          write(chunk) { entry.chunks.push(chunk); },
          close() {
            entry.done = true;
            setTimeout(() => activeStreams.delete(chatId), 30_000);
          },
          abort() {
            entry.done = true;
            setTimeout(() => activeStreams.delete(chatId), 5_000);
          },
        })).catch(() => {
          entry.done = true;
          setTimeout(() => activeStreams.delete(chatId), 5_000);
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

// ── Stream reconnection endpoint ─────────────────────────────────────────────
// AI SDK calls GET /api/chat/{chatId}/stream to reconnect after page reload.
// Returns 204 if no active stream, or replays buffered SSE chunks + tails for
// new ones so the client sees live tokens.

router.get('/:id/stream', requireAuth, async (req, res) => {
  const entry = activeStreams.get(req.params.id);
  if (!entry) {
    return res.status(204).end();
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-vercel-ai-ui-message-stream': 'v1',
    'x-accel-buffering': 'no',
  });

  // Replay buffered chunks
  for (const chunk of entry.chunks) {
    res.write(chunk);
  }

  if (entry.done) {
    res.end();
    return;
  }

  // Tail the buffer for new chunks
  let cursor = entry.chunks.length;
  const interval = setInterval(() => {
    while (cursor < entry.chunks.length) {
      res.write(entry.chunks[cursor++]);
    }
    if (entry.done) {
      clearInterval(interval);
      res.end();
    }
  }, 50);

  res.on('close', () => clearInterval(interval));
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
