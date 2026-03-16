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
const { webFetch } = require('./web-fetch');
const { getDocument } = require('../documents');
const chatStore = require('../chat-store');
const aiUsage = require('../ai-usage');
const { decrypt } = require('../crypto');

const router = express.Router();

/**
 * Check whether BYOK is fully configured and active for a user.
 * Requires the toggle on, a model selected, and the matching provider key stored.
 */
function isByokActive(settings) {
  if (!settings?.byok_enabled || !settings.byok_model_key) return false;
  const def = chatModels.MODEL_DEFS.find(d => d.key === settings.byok_model_key);
  if (!def) return false;
  const key = def.provider === 'anthropic' ? settings.byok_anthropic_key : settings.byok_google_key;
  return !!key;
}

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

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
You are the Squire Docs assistant. Refer to yourself as the "Squire Docs assistant".  Don't refer to yourself as a squire, since you are not a squire. You are the steward of the collaborative writing process. In any collaborative project, someone has to dedicate themselves to keeping things organized. That's you.

You follow up when the conversation dies down. You keep an eye out for collaborators who aren't participating. You track unresolved issues. You take notes and update the document to reflect decisions. You make sure ideas don't get lost.

You also help manage the discussion itself. You point out when it's going in circles. You identify miscommunication between collaborators. You intervene when the group gets sidetracked by unimportant details. When summarizing changes, you look for patterns — instead of just listing edits, you synthesize what's emerging: "The team seems to be shifting focus from X to Y based on the last few edits." You do all of this through the tools available to you — version history, collaborator awareness, document content — not through speculation.

When it's just you and one person working on a document, you're a hands-on writing partner. You bridge the gap between high-level thinking and meticulous operational work — formatting, restructuring, filling in boilerplate — so they can focus on the big picture.

Good writing comes down to three things: the author, the audience, and the intention. Who is writing this, and how do they want to present themselves? Who will read it, and what do they need? What is the document trying to accomplish — persuade, document, propose, remember? If any of these aren't clear, you ask. Every editing decision you make flows from the answers. When reviewing, read as the audience would — flag jargon, insider language, or logical leaps that would lose someone coming to the document fresh.

You pay attention to the through-line — if the document starts pulling in a different direction from the stated goal, you name it. If the document has problems — gaps in logic, inconsistent tone, a section that doesn't earn its place — you say so.

This is an enormous amount of work, and you take it seriously. You're not just a writing tool — you're the person in the room who keeps the project moving forward.
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
- When you need to gather information from multiple independent sources (e.g., reading several documents, searching and fetching), make all independent tool calls in a single response rather than one at a time. This executes them in parallel and is much faster. Tell the user you're doing this (e.g., "I'll read all three documents in parallel.").
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

// ── Cross-turn context compaction ─────────────────────────────────────────────

/**
 * Detect provider token-limit / context-length errors so we can compact and retry.
 */
function isTokenLimitError(error) {
  const msg = error?.message || error?.data?.error?.message || '';
  return /exceeds the maximum number of tokens|prompt is too long|context_length_exceeded/i.test(msg);
}

/**
 * Compact messages by summarizing older messages, preserving recent ones verbatim.
 * Always compacts when called — the caller decides when compaction is needed.
 * Uses gemini-2.5-flash for fast, cheap summarization regardless of chat model.
 * @param {Array} messages - Model-format messages
 * @returns {Array} Compacted messages (or original if nothing to compact / on error)
 */
async function compactMessages(messages) {
  const splitAt = Math.max(0, messages.length - 10);
  const oldMessages = messages.slice(0, splitAt);
  const recentMessages = messages.slice(splitAt);
  if (oldMessages.length === 0) return messages;

  try {
    const { generateText } = getAI();
    const { google } = require('@ai-sdk/google');
    const compactionModel = google('gemini-2.5-flash');

    const oldSerialized = JSON.stringify(oldMessages);
    const summaryResult = await generateText({
      model: compactionModel,
      maxTokens: 2048,
      prompt: `Summarize this conversation history concisely. Preserve:\n`
        + `- Key decisions made\n`
        + `- Document IDs (docGuid values) mentioned and what was done with them\n`
        + `- Tool calls made and their key results\n`
        + `- Any unresolved questions or pending tasks\n`
        + `Omit: raw document content, redundant exchanges, verbose tool outputs.\n\n`
        + `Conversation history:\n${oldSerialized}`,
    });

    const summaryText = summaryResult.text;
    if (!summaryText) return messages;

    const summaryMessage = {
      role: 'user',
      content: [{
        type: 'text',
        text: `[Earlier conversation summary — ${oldMessages.length} messages compacted]\n\n${summaryText}`,
      }],
    };

    console.log(
      `[Chat API] Compacted ${oldMessages.length} messages into summary `
      + `(${summaryText.length} chars), keeping ${recentMessages.length} recent`
    );

    return [summaryMessage, ...recentMessages];
  } catch (err) {
    console.error('[Chat API] Compaction failed, using full history:', err.message);
    return messages;
  }
}

/**
 * Pipe a UI message stream to an HTTP response as SSE events.
 *
 * Buffers initial metadata chunks (start, start-step) and only commits
 * HTTP headers once a content-bearing chunk arrives.  If an error chunk
 * arrives before any content (e.g. a token-limit error), it throws so the
 * caller can intercept and retry with compacted messages.
 */
async function pipeAsSSE(uiStream, res, entry, { writeHeaders = true } = {}) {
  const [httpStream, saveStream] = uiStream.tee();
  saveStream.pipeTo(new WritableStream()).catch(() => {});

  const reader = httpStream.getReader();
  const pending = [];
  let headersWritten = !writeHeaders;

  function commitHeaders() {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-vercel-ai-ui-message-stream': 'v1',
      'x-accel-buffering': 'no',
    });
    headersWritten = true;
    for (const p of pending) {
      const c = `data: ${JSON.stringify(p)}\n\n`;
      entry.chunks.push(c);
      res.write(c);
    }
    pending.length = 0;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Before headers are committed, check for error chunks so the caller
      // can intercept token-limit errors and retry with compacted messages.
      if (!headersWritten) {
        if (value?.type === 'error') {
          throw new Error(value.errorText || 'Stream error');
        }
        pending.push(value);
        // Buffer metadata-only events; commit on the first content chunk
        if (value?.type === 'start' || value?.type === 'start-step') continue;
        commitHeaders();
        continue;
      }

      const sseChunk = `data: ${JSON.stringify(value)}\n\n`;
      entry.chunks.push(sseChunk);
      res.write(sseChunk);
    }

    // Edge case: stream contained only buffered metadata (no content)
    if (!headersWritten && pending.length > 0) commitHeaders();

    // Signal end-of-stream (matches JsonToSseTransformStream behaviour)
    if (headersWritten) {
      const doneChunk = 'data: [DONE]\n\n';
      entry.chunks.push(doneChunk);
      res.write(doneChunk);
    }
  } catch (err) {
    reader.releaseLock();
    throw err;
  }
}

/** Write a single SSE event to both the response and the replay buffer. */
function writeSSEEvent(res, entry, data) {
  const chunk = `data: ${JSON.stringify(data)}\n\n`;
  entry.chunks.push(chunk);
  res.write(chunk);
}

// ── Streaming chat endpoint ──────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const chatId = req.body?.id;
  let entry = null;
  const cleanupEntry = (ms = 5_000) => {
    if (!entry) return;
    entry.done = true;
    setTimeout(() => {
      if (activeStreams.get(chatId) === entry) activeStreams.delete(chatId);
    }, ms);
  };

  try {
    const { message, docGuid } = req.body;

    if (!message || !chatId) {
      return res.status(400).json({ error: 'message and id are required' });
    }

    // Register a stream entry immediately so a reconnecting client (page
    // refresh) can attach before the response actually starts streaming.
    // Replaces any stale entry from a previous completed stream.
    entry = { chunks: [], done: false };
    activeStreams.set(chatId, entry);

    // Load previous messages from DB and append the new user message.
    // Filter out any messages with empty parts — these can occur when a
    // stream is interrupted before any content arrives, and the AI SDK
    // requires every message to have at least one part.
    const previousMessages = (await chatStore.loadChat(chatId))
      .filter(m => m.parts && m.parts.length > 0);
    const allMessages = [...previousMessages, message];

    // Persist user message immediately so it survives interrupted streams
    await chatStore.saveChat(chatId, allMessages);

    // Load BYOK settings for the user
    let byokSettings = null;
    if (pool) {
      const byokResult = await pool.query(
        `SELECT byok_enabled, byok_anthropic_key, byok_google_key, byok_model_key FROM users WHERE id = $1`,
        [req.user.userId]
      );
      if (byokResult.rows.length > 0) {
        byokSettings = byokResult.rows[0];
      }
    }

    // BYOK is active when the toggle is on, a model is selected, and the
    // matching provider key is stored
    const isByok = isByokActive(byokSettings);

    // Check AI usage quota before proceeding (skip for BYOK users)
    if (!isByok) {
      const quota = await aiUsage.checkQuota(req.user.userId);
      if (!quota.allowed) {
        cleanupEntry();
        return res.status(429).json({ error: 'AI usage limit reached' });
      }
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

    const baseUrl = buildBaseUrl(req);
    const { token: syntheticAgentToken } = createAgentTokenPair({
      userId: req.user.userId,
      agentId: 'in-app-chat',
      agentName: 'Squire Docs Assistant',
      scopes: ['read', 'write'],
      baseUrl,
    });

    const { streamText, convertToModelMessages, validateUIMessages, createIdGenerator, stepCountIs } = getAI();

    // Resolve model — BYOK uses user's key + selected model, otherwise server default
    let resolved;
    if (isByok) {
      const def = chatModels.MODEL_DEFS.find(d => d.key === byokSettings.byok_model_key);
      const encryptedKey = def.provider === 'anthropic' ? byokSettings.byok_anthropic_key : byokSettings.byok_google_key;
      resolved = chatModels.resolveModelWithKey(byokSettings.byok_model_key, decrypt(encryptedKey));
    }
    if (!resolved) {
      const modelKey = process.env.AI_CHAT_MODEL || chatModels.DEFAULT_MODEL_KEY;
      resolved = chatModels.resolveModel(modelKey);
      if (!resolved) {
        console.error(`[Chat API] Unknown model key "${modelKey}", falling back to "${chatModels.DEFAULT_MODEL_KEY}"`);
        resolved = chatModels.resolveModel(chatModels.DEFAULT_MODEL_KEY);
        if (!resolved) {
          cleanupEntry();
          return res.status(500).json({ error: 'No valid chat model configured' });
        }
      }
    }
    const { model, def, provider } = resolved;

    console.log(`[Chat API] Using model: ${def.key} (${def.modelId})`);

    // Build tool set with provider-appropriate web search + universal webFetch
    const thinkingEnabled = def.provider === 'google';
    const tools = chatTools.buildTools(syntheticAgentToken);
    if (def.provider === 'anthropic') {
      tools.webSearch = provider.tools.webSearch_20250305();
    } else if (def.provider === 'google') {
      // Gemini can't combine googleSearch with function tools in one request,
      // so we wrap it as a function tool that makes a separate generateText call.
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

    // Universal webFetch — works the same for all providers
    {
      const { tool, jsonSchema } = getAI();
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
    }

    // Validate and convert UI messages for streamText
    const validatedMessages = await validateUIMessages({ messages: allMessages, tools });
    const modelMessages = await convertToModelMessages(validatedMessages);

    // Convert data-URL file parts to inline Buffers so the AI SDK doesn't
    // try to download them (validateDownloadUrl rejects data: scheme).
    for (const msg of modelMessages) {
      if (!Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if ((part.type === 'file' || part.type === 'image') &&
            typeof part.data === 'string' && part.data.startsWith('data:')) {
          const m = part.data.match(/^data:[^;]+;base64,(.+)$/s);
          if (m) part.data = Buffer.from(m[1], 'base64');
        }
      }
    }

    // Build streamText options (reusable for compaction retry)
    const streamTextOpts = {
      model,
      system: buildSystemPrompt(docGuid, docTitle),
      tools,
      stopWhen: stepCountIs(100),
      prepareStep: async ({ stepNumber }) => {
        if (stepNumber >= 95) return { toolChoice: 'none' };
      },
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
          inputTokens, outputTokens, costCents, isByok,
        }).catch(err => console.error('[Chat API] Failed to record usage:', err));
      },
    };

    /** Run streamText and pipe the resulting UI stream as SSE to the response. */
    async function runStream(messages, writeHeaders) {
      const result = streamText({ ...streamTextOpts, messages });
      const uiStream = result.toUIMessageStream({
        originalMessages: validatedMessages,
        generateMessageId: createIdGenerator({ prefix: 'msg', size: 16 }),
        onFinish: ({ messages: saved }) => {
          chatStore.saveChat(chatId, saved).catch((err) => {
            console.error('[Chat API] Failed to save chat:', err);
          });
        },
      });
      await pipeAsSSE(uiStream, res, entry, { writeHeaders });
    }

    try {
      await runStream(modelMessages, true);
      cleanupEntry(30_000);
      res.end();
    } catch (streamError) {
      if (isTokenLimitError(streamError) && !res.headersSent) {
        console.log('[Chat API] Token limit hit, compacting conversation…');

        // Write SSE headers + compacting badge
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-vercel-ai-ui-message-stream': 'v1',
          'x-accel-buffering': 'no',
        });
        writeSSEEvent(res, entry, {
          type: 'tool-input-available',
          toolCallId: 'compact-1',
          toolName: '_compacting',
          input: {},
        });

        const compacted = await compactMessages(modelMessages);

        writeSSEEvent(res, entry, {
          type: 'tool-output-available',
          toolCallId: 'compact-1',
          output: 'done',
        });

        // Retry with compacted messages (headers already sent)
        await runStream(compacted, false);
        cleanupEntry(30_000);
        res.end();
      } else {
        throw streamError; // re-throw for outer catch
      }
    }
  } catch (error) {
    console.error('[Chat API] Error:', error);
    cleanupEntry();
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

module.exports = { router, activeStreams, init };
