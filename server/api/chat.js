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
const { createAgentTokenPair } = require('../mcp/auth/agent-token-factory');
const { buildBaseUrl } = require('../url');
const chatTools = require('./chat-tools');
const chatModels = require('./chat-models');
const { getProviderConfig } = require('./ai-providers');
const { deduplicateReadResults } = require('./chat-dedup');
const { getObservedClocks, foreignEditsSince, buildStalenessNote } = require('./chat-staleness');
const { loadByokSettings, isByokActive } = require('./byok-settings');
const { getDocument, hasAccess } = require('../documents');
const chatStore = require('../chat-store');
const aiUsage = require('../ai-usage');
const { decrypt } = require('../crypto');
const { notifyException } = require('../exception-notifier');
const { notifyCreditLimitReached } = require('../email');

const router = express.Router();

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  'connection': 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
};

let pool = null;
let persistence = null;

function init(persistenceProvider) {
  persistence = persistenceProvider;
  pool = persistenceProvider.getPool();
}

// Map<chatId, { chunks: string[], done: boolean, userId: string }>
// Buffers SSE chunks so reconnecting clients can replay + continue.
const activeStreams = new Map();
const MAX_STREAMS_PER_USER = 10;
const MAX_CHUNKS_PER_STREAM = 5000;

/** True while the client response can still accept writes. */
const isWritable = (res) => !res.writableEnded && !res.destroyed;

/** Format a value as a single SSE data event. */
const sseEvent = (value) => `data: ${JSON.stringify(value)}\n\n`;

/** Begin the SSE HTTP response (status + headers), if not already started. */
function writeSSEHead(res) {
  if (!res.headersSent && isWritable(res)) res.writeHead(200, SSE_HEADERS);
}

/**
 * Append a formatted SSE chunk to the replay buffer and write it to the client.
 *
 * The buffer is capped (MAX_CHUNKS_PER_STREAM) so a runaway stream can't grow it
 * without bound, and the write is skipped once the client response is no longer
 * writable — so generation that outlives a disconnected client keeps filling the
 * buffer for a reconnecting client without write-after-destroy errors. Every SSE
 * emission (live stream + compaction events) goes through here so both
 * invariants hold uniformly.
 */
function pushChunk(res, entry, chunk) {
  if (entry.chunks.length < MAX_CHUNKS_PER_STREAM) entry.chunks.push(chunk);
  if (isWritable(res)) res.write(chunk);
}

// Lazy-loaded AI SDK core (heavy import — pulls in OpenTelemetry, zod, etc.)
let _ai = null;

function getAI() {
  if (!_ai) _ai = require('ai');
  return _ai;
}

// Agent name attributed to the in-app chat assistant's edits in version
// history. Used to tell the agent's own edits apart from concurrent ones.
const CHAT_AGENT_NAME = 'Squire Docs Assistant';

const BASE_SYSTEM_PROMPT = `<identity>
You are the Squire Docs assistant. Refer to yourself as the "Squire Docs assistant". Don't refer to yourself as a squire, since you are not a squire. You are the steward of the writing process and a hands-on writing partner. Someone has to keep the work organized and moving, and that is you. You bridge the gap between high-level thinking and the meticulous operational work (formatting, restructuring, filling in boilerplate) so the writer can focus on the big picture.

You track unresolved issues, take notes, update the document to reflect decisions, and make sure ideas don't get lost.

Good writing comes down to three things: the author, the audience, and the intention. Who is writing this, and how do they want to present themselves? Who will read it, and what do they need? What is the document trying to accomplish: to persuade, document, propose, or remember? If any of these aren't clear, you ask. Every editing decision you make flows from the answers. When reviewing, read as the audience would, and flag jargon, insider language, or logical leaps that would lose someone coming to the document fresh.

You pay attention to the through-line. If the document starts pulling in a different direction from the stated goal, you name it. If the document has problems, such as gaps in logic, inconsistent tone, or a section that doesn't earn its place, you say so.

You take this seriously. You are not just a writing tool. You are the person who keeps the project moving forward.
</identity>

<context>
- This is a real-time collaborative editor. Multiple people can view and edit a document at the same time, and your edits appear live as you make them.
- You operate on the user's behalf with their permissions. You can only access documents they have access to.
- The chat persists across pages. The user may navigate between documents or pages during the conversation. You are not limited to the active document, and the user may ask about any document they have access to.
</context>

<workflows>
Common workflows. Follow these patterns:

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
</workflows>

<rules>
WRITING STYLE (the most important rules. They apply both to your chat replies AND to the prose you write into documents):
- Write like a person, not an LLM. Keep it concise, plain, and direct.
- Do not use em dashes. Use commas, periods, parentheses, or separate sentences instead.
- Avoid other AI tells: "it's not just X, it's Y" constructions, empty intensifiers (delve, leverage, robust, seamless, comprehensive), filler preambles, reflexive three-item lists, and reflexive hedging.
- Cut words that carry no meaning. Say what you mean and stop.

- Always use the correct docGuid. Never guess a document ID. Ask the user or search for it.
- Read a document before editing it. Do not modify a document you haven't read in this conversation.
- Confirm destructive actions before executing: restoring versions, deleting large sections, sharing documents.
- After editing, briefly state what you changed (e.g., "Added three bullet points under Summary").
- If a tool call fails, explain the issue simply and suggest next steps.
- Before calling tools, write a brief one-sentence summary of what you're about to do and why (e.g., "Let me read the document first to see what's there."). When calling multiple tools in parallel, say so (e.g., "I'll search for that and read your document at the same time."). This keeps the user informed.
- Be direct. Do not apologize excessively or explain what you could hypothetically do.
- When you need to gather information from multiple independent sources (e.g., reading several documents, searching and fetching), make all independent tool calls in a single response rather than one at a time. This executes them in parallel and is much faster. Tell the user you're doing this (e.g., "I'll read all three documents in parallel.").
- When reviewing history, be specific about attribution. Use author names from version history, not vague "someone made changes," and show concrete edits. Report what changed and let the user interpret why. Flag contradictions neutrally, e.g., "The budget was set to $50K, then changed to $40K."
- When reporting webSearch results, NEVER fabricate or guess URLs. Only cite URLs from the tool output's citations.sources array. Reference sources as [1], [2] etc. matching the source index + 1. If no citations were returned, describe findings without links.
- Never construct URLs by combining a domain with a guessed path.
- If modify returns changed: false, treat it as a targeting failure. Your XPath or element selection likely didn't match, so re-read the document with format: "structured" to understand the current structure before retrying.
- If modify returns conflict: true, someone else changed the document since you last read it. You will need to retry. Read the returned content, fold in their changes, then modify again. Tell the user that someone else edited the document.
- NEVER use positional indexing (doc.get(n), element.get(n)) to target elements in modify scripts. Positional indices shift when content is added, removed, or reordered, which silently targets the wrong element. The modify sandbox exposes global helper functions that make reliable targeting straightforward, so reach for them instead of walking the tree by index: xpathFirst() and xpath() for structural queries (e.g., xpathFirst('//heading[contains(., "Title")]')), findByText() to locate elements by the text they contain, findByNodeName() to get every element of a type, and findTextNode() or getTextContent() to reach the text inside an element.
</rules>`;

function buildSystemPrompt(docGuid, docTitle, baseUrl) {
  if (!docGuid) return BASE_SYSTEM_PROMPT;
  let sanitizedTitle = '';
  if (docTitle) {
    sanitizedTitle = docTitle.slice(0, 200).replace(/<[^>]*>/g, '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  const titleStr = sanitizedTitle ? ` "${sanitizedTitle}"` : '';
  const urlStr = baseUrl ? `\nURL: ${baseUrl}/d/${docGuid}` : '';
  return BASE_SYSTEM_PROMPT + `\n\n<active_document>
The user is currently viewing document${titleStr} (${docGuid}).${urlStr}
When they refer to "this document", "the document", or "my document" without specifying which one, assume they mean this document. However, you are not limited to this document, and the user may ask about or work on other documents too.
</active_document>`;
}

// ── Cross-turn context compaction ─────────────────────────────────────────────

/**
 * Detect provider token-limit / context-length errors so we can compact and retry.
 * Accepts an Error object or a plain error-message string.
 */
function isTokenLimitError(errorOrMessage) {
  const msg = typeof errorOrMessage === 'string'
    ? errorOrMessage
    : errorOrMessage?.message || errorOrMessage?.data?.error?.message || '';
  return /exceeds the maximum number of tokens|prompt is too long|context_length_exceeded/i.test(msg);
}

/**
 * Detect Google API INVALID_ARGUMENT errors (e.g. thought_signature issues
 * with Gemini 3 models when thinking is enabled with multi-turn tool calls).
 */
function isInvalidArgumentError(errorOrMessage) {
  const status = errorOrMessage?.data?.error?.status || errorOrMessage?.statusCode;
  const msg = errorOrMessage?.data?.error?.message || errorOrMessage?.message || '';
  return status === 'INVALID_ARGUMENT' || (status === 400 && /invalid argument/i.test(msg));
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
    const compactionModel = chatModels.getCompactionModel();

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
 *
 * Every chunk is appended to `entry.chunks` (the replay buffer) BEFORE it is
 * written to `res`, and writes to `res` are skipped once the client response is
 * no longer writable. So if the client disconnects mid-stream (page refresh,
 * navigation, dropped connection), the generation keeps running via the tee and
 * the buffer keeps filling — a reconnecting client (GET /:id/stream) can replay
 * what it missed and tail the rest. Generation completion (not client
 * disconnect) is what ends the stream; see cleanupEntry.
 */
async function pipeAsSSE(uiStream, res, entry, { writeHeaders = true } = {}) {
  const [httpStream, saveStream] = uiStream.tee();
  saveStream.pipeTo(new WritableStream()).catch(() => {});

  const reader = httpStream.getReader();
  const pending = [];
  let headersWritten = !writeHeaders;

  // The client response may go away mid-stream while generation continues.
  // pushChunk keeps buffering into entry.chunks regardless and only writes to
  // `res` while it can still accept writes, so the buffer keeps filling for a
  // reconnecting client without write-after-destroy errors aborting the loop.
  function commitHeaders() {
    writeSSEHead(res);
    headersWritten = true;
    for (const p of pending) pushChunk(res, entry, sseEvent(p));
    pending.length = 0;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Intercept token-limit error chunks at ANY point in the stream so
      // the caller can compact and retry — whether headers are sent or not.
      if (value?.type === 'error' && isTokenLimitError(value.errorText || '')) {
        throw new Error(value.errorText || 'Stream error');
      }

      // Before headers are committed, buffer metadata-only events and
      // commit on the first content chunk.
      if (!headersWritten) {
        if (value?.type === 'error') {
          throw new Error(value.errorText || 'Stream error');
        }
        pending.push(value);
        const isMetadata = value?.type === 'start' || value?.type === 'start-step'
          || value?.type === 'finish-step' || value?.type === 'finish';
        if (isMetadata) continue;
        commitHeaders();
        continue;
      }

      // Log error events from the AI provider so failures aren't silent
      if (value?.type === 'error') {
        console.error('[Chat API] Provider error in stream:', value.errorText || JSON.stringify(value));
      }

      pushChunk(res, entry, sseEvent(value));
    }

    // Edge case: stream contained only buffered metadata (no content)
    if (!headersWritten && pending.length > 0) commitHeaders();

    // Signal end-of-stream (matches JsonToSseTransformStream behaviour)
    if (headersWritten) {
      pushChunk(res, entry, 'data: [DONE]\n\n');
    }
  } catch (err) {
    reader.releaseLock();
    throw err;
  }
}

/**
 * Convert data-URL file parts to inline Buffers so the AI SDK doesn't
 * try to download them (validateDownloadUrl rejects data: scheme).
 */
function inlineDataUrls(modelMessages) {
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

    // Enforce per-user stream limit to prevent memory exhaustion
    let userStreamCount = 0;
    for (const [, s] of activeStreams) {
      if (s.userId === req.user.userId && !s.done) userStreamCount++;
    }
    if (userStreamCount >= MAX_STREAMS_PER_USER) {
      return res.status(429).json({ error: 'Too many concurrent chat streams' });
    }

    // Register a stream entry immediately so a reconnecting client (page
    // refresh) can attach before the response actually starts streaming.
    // Replaces any stale entry from a previous completed stream.
    entry = { chunks: [], done: false, userId: req.user.userId };
    activeStreams.set(chatId, entry);

    // NOTE: deliberately no cleanup on client disconnect. The generation keeps
    // running via the response tee, and a reconnecting client (GET /:id/stream)
    // needs the entry to stay alive with its buffer filling so it can replay +
    // tail the rest. Marking the stream done here (as this used to) made a
    // mid-stream page refresh reconnect to an already-"done" entry that ended
    // immediately instead of tailing. The entry is cleaned up when generation
    // actually finishes — see the cleanupEntry calls after runStream and in the
    // error paths, all of which are reached regardless of the client connection.

    // Load previous messages from DB and append the new user message.
    // Filter out any messages with empty parts — these can occur when a
    // stream is interrupted before any content arrives, and the AI SDK
    // requires every message to have at least one part.
    const userId = req.user.userId;
    const previousMessages = (await chatStore.loadChat(chatId, userId))
      .filter(m => m.parts && m.parts.length > 0);
    const allMessages = [...previousMessages, message];

    // Persist user message immediately so it survives interrupted streams
    await chatStore.saveChat(chatId, userId, allMessages);

    // Load BYOK settings for the user
    const byokSettings = pool ? await loadByokSettings(req.user.userId) : null;
    const isByok = isByokActive(byokSettings);

    // Check AI usage quota before proceeding (skip for BYOK users)
    let reservationId = null;
    if (!isByok) {
      const quota = await aiUsage.checkQuota(req.user.userId);
      if (!quota.allowed) {
        notifyCreditLimitReached({
          email: req.user.email,
          name: req.user.name,
          creditCents: quota.creditCents,
          usedCents: quota.usedCents,
        });
        cleanupEntry();
        return res.status(429).json({ error: 'AI usage limit reached' });
      }
      // Reserve estimated credits upfront to prevent TOCTOU race
      try {
        reservationId = await aiUsage.reserveCredits(req.user.userId, 5);
      } catch (e) {
        console.error('[Chat API] Failed to reserve credits:', e);
      }
    }

    // Look up document title if docGuid provided and user has access
    let docTitle = null;
    if (docGuid) {
      try {
        const canAccess = await hasAccess(docGuid, req.user.userId);
        if (canAccess) {
          const doc = await getDocument(docGuid);
          docTitle = doc?.title || null;
        }
      } catch (e) {
        // Non-critical — proceed without title
      }
    }

    const baseUrl = buildBaseUrl(req);
    const { token: syntheticAgentToken } = createAgentTokenPair({
      userId: req.user.userId,
      agentId: 'in-app-chat',
      agentName: CHAT_AGENT_NAME,
      scopes: ['documents:read', 'documents:write'],
      baseUrl,
    });

    const { streamText, convertToModelMessages, validateUIMessages, createIdGenerator, stepCountIs } = getAI();

    // Resolve model — BYOK uses user's key + selected model, otherwise the
    // server default (with fallback). See chatModels.resolveChatModel.
    const resolved = chatModels.resolveChatModel({ isByok, byokSettings, decryptKey: decrypt });
    if (!resolved) {
      cleanupEntry();
      return res.status(500).json({ error: 'No valid chat model configured' });
    }
    const { model, def, provider } = resolved;
    // Provider capability flags drive the per-provider streaming gates below
    // (prompt caching, thinking, provider-executed web-search message stripping).
    const caps = getProviderConfig(def.provider).capabilities;

    console.log(`[Chat API] Using model: ${def.key} (${def.modelId})`);

    // Per-doc baseline clock the agent has observed, populated below once the
    // message history is parsed. Passed by reference so modify's conflict guard
    // can read the latest value when tool calls execute during streaming.
    const observedClockHolder = { byDoc: new Map() };

    // Build tool set: MCP tools + provider-specific web search + universal webFetch
    const tools = chatTools.buildTools(syntheticAgentToken, {
      providerName: def.provider,
      provider,
      pool,
      observedClockHolder,
    });

    // Validate and convert UI messages for streamText.
    const validatedMessages = await validateUIMessages({ messages: allMessages, tools });
    // Anthropic rejects history where a provider-executed web-search result was
    // interleaved with a client tool call in the same assistant turn (the client
    // tool_use blocks stop being trailing, violating Anthropic's tool_use/tool_result
    // adjacency rule → 400, surfaced as a silently-swallowed message). Strip those
    // blocks from what we SEND while keeping validatedMessages (and thus the persisted
    // history + UI citations) intact. No-op on the Google path (its web search is a
    // client tool, not provider-executed).
    const modelInputMessages = caps.providerExecutedWebSearch
      ? chatModels.stripProviderExecutedTools(validatedMessages)
      : validatedMessages;
    const modelMessages = await convertToModelMessages(modelInputMessages);
    inlineDataUrls(modelMessages);

    // Deduplicate repeated document reads to save context window space
    const dedupedMessages = deduplicateReadResults(modelMessages);

    // Track the agent's last-seen clock per document and warn it about edits
    // made by anyone else since then.
    observedClockHolder.byDoc = getObservedClocks(modelMessages);
    if (persistence && observedClockHolder.byDoc.size > 0) {
      const staleEntries = [];
      for (const [staleDocGuid, baseClock] of observedClockHolder.byDoc) {
        try {
          const updates = await persistence.getRecentUpdatesWithUsers(staleDocGuid, 100);
          const editors = foreignEditsSince(updates, baseClock, {
            userId: req.user.userId,
            agentName: CHAT_AGENT_NAME,
          });
          if (editors.length === 0) continue;
          let title = staleDocGuid === docGuid ? docTitle : null;
          if (!title) {
            try { title = (await getDocument(staleDocGuid))?.title || null; } catch (_) { /* best-effort */ }
          }
          staleEntries.push({ docGuid: staleDocGuid, editors, title });
        } catch (e) {
          console.warn('[Chat API] staleness check failed for', staleDocGuid, e.message);
        }
      }
      const note = buildStalenessNote(staleEntries);
      if (note) {
        dedupedMessages.push({ role: 'user', content: [{ type: 'text', text: note }] });
      }
    }

    // Build streamText options (reusable for compaction/retry)
    const useThinking = caps.thinking;
    // Anthropic prompt caching: top-level cacheControl caches the large, static
    // tools+system prefix (re-sent on every agentic step). runStream additionally
    // tags the last message to extend the cache over the conversation history.
    const useAnthropicCache = caps.promptCache;
    const providerOptions = chatModels.buildProviderOptions(def);
    const streamTextOpts = {
      model,
      system: buildSystemPrompt(docGuid, docTitle, baseUrl),
      tools,
      stopWhen: stepCountIs(100),
      prepareStep: async ({ stepNumber }) => {
        if (stepNumber >= 95) return { toolChoice: 'none' };
      },
      ...(providerOptions && { providerOptions }),
      onError: ({ error }) => {
        // Log the provider's status + body explicitly so silent round-trip
        // rejections (e.g. Anthropic 400 invalid_request) aren't invisible.
        console.error('[Chat API] Stream error:',
          error?.statusCode, error?.data?.error?.type,
          error?.responseBody || error?.message || error);
      },
      onFinish: async ({ usage }) => {
        if (!usage) {
          // No usage data — release reservation
          if (reservationId) {
            aiUsage.reconcileReservation(reservationId, { failed: true })
              .catch(err => console.error('[Chat API] Failed to release reservation:', err));
          }
          return;
        }
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        // Cache reads/writes are a subset of inputTokens (AI SDK reports them in
        // inputTokenDetails). Naturally 0 for non-caching providers (e.g. Gemini).
        const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
        const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
        if (useAnthropicCache) {
          console.log(
            `[Chat API] Anthropic cache — read=${cacheReadTokens} write=${cacheWriteTokens} `
            + `noCache=${usage.inputTokenDetails?.noCacheTokens ?? 0} totalIn=${inputTokens}`
          );
        }
        const costCents = aiUsage.computeCostCents(def.key, inputTokens, outputTokens, {
          cacheReadTokens, cacheWriteTokens,
        });
        if (reservationId) {
          // Reconcile reservation with actual usage
          aiUsage.reconcileReservation(reservationId, {
            modelKey: def.key, inputTokens, outputTokens, costCents, isByok,
            cacheReadTokens, cacheWriteTokens,
          }).catch(err => console.error('[Chat API] Failed to reconcile reservation:', err));
        } else {
          // BYOK or reservation failed — record usage directly
          aiUsage.recordUsage(req.user.userId, {
            chatId, modelKey: def.key,
            inputTokens, outputTokens, costCents, isByok,
            cacheReadTokens, cacheWriteTokens,
          }).catch(err => console.error('[Chat API] Failed to record usage:', err));
        }
      },
    };

    /** Run streamText and pipe the resulting UI stream as SSE to the response. */
    async function runStream(messages, opts = {}) {
      // For Anthropic, tag a CLONE of the last message with an ephemeral cache
      // breakpoint so the conversation-history prefix is cached too (the top-level
      // providerOptions already caches tools+system). Cloning avoids leaking
      // providerOptions into the array that toUIMessageStream persists via saveChat.
      const streamMessages = useAnthropicCache
        ? chatModels.tagLastMessageWithCache(messages)
        : messages;
      const finalOpts = { ...streamTextOpts, ...opts, messages: streamMessages };
      const result = streamText(finalOpts);
      const uiStream = result.toUIMessageStream({
        originalMessages: validatedMessages,
        generateMessageId: createIdGenerator({ prefix: 'msg', size: 16 }),
        sendSources: true,
        onFinish: ({ messages: saved }) => {
          chatStore.saveChat(chatId, userId, saved).catch((err) => {
            console.error('[Chat API] Failed to save chat:', err);
          });
        },
      });
      await pipeAsSSE(uiStream, res, entry, { writeHeaders: opts.writeHeaders ?? true });
    }

    try {
      await runStream(dedupedMessages);
    } catch (streamError) {
      if (isTokenLimitError(streamError)) {
        console.log('[Chat API] Token limit hit, compacting conversation…');

        writeSSEHead(res);

        pushChunk(res, entry, sseEvent({
          type: 'tool-input-available',
          toolCallId: 'compact-1',
          toolName: '_compacting',
          input: {},
        }));

        const compacted = await compactMessages(dedupedMessages);

        pushChunk(res, entry, sseEvent({
          type: 'tool-output-available',
          toolCallId: 'compact-1',
          output: 'done',
        }));

        // Retry with compacted messages (headers already sent)
        await runStream(compacted, { writeHeaders: false });
      } else if (useThinking && isInvalidArgumentError(streamError)) {
        // Gemini 3 models can fail with INVALID_ARGUMENT when thought
        // signatures from earlier turns are lost during DB persistence.
        // Retry without thinkingConfig so the request isn't rejected.
        console.warn(
          '[Chat API] INVALID_ARGUMENT with thinking enabled — retrying without thinkingConfig'
        );
        // This retry is gated behind useThinking (Google only), so clobbering
        // providerOptions here never disables Anthropic caching. Keep that gate
        // if this branch is ever generalized.
        await runStream(dedupedMessages, {
          providerOptions: {},
          writeHeaders: !res.headersSent,
        });
      } else {
        throw streamError; // re-throw for outer catch
      }
    }
    // Common epilogue for the initial run OR a successful retry. A retry that
    // itself throws (or an unhandled error type) propagates to the outer catch.
    cleanupEntry(30_000);
    res.end();
  } catch (error) {
    console.error('[Chat API] Error:', error);
    notifyException(error, { req, source: 'chat-api' });
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
  if (!entry || entry.userId !== req.user.userId) {
    return res.status(204).end();
  }

  writeSSEHead(res);

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

/**
 * Wrap an async CRUD handler so a thrown error is logged, reported, and turned
 * into a 500 — collapsing the identical try/catch each route used to repeat.
 * `action` names the operation (e.g. "create chat") for the log + 500 message.
 */
function asyncRoute(action, handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      console.error(`[Chat API] Failed to ${action}:`, error);
      notifyException(error, { req, source: 'chat-api' });
      if (!res.headersSent) res.status(500).json({ error: `Failed to ${action}` });
    }
  };
}

// Create a new chat
router.post('/chats', requireAuth, asyncRoute('create chat', async (req, res) => {
  const id = await chatStore.createChat(req.user.userId);
  res.json({ id });
}));

// List user's chats (paginated)
router.get('/chats', requireAuth, asyncRoute('list chats', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const before = req.query.before || undefined;
  const chats = await chatStore.getChatsForUser(req.user.userId, { limit, before });
  res.json(chats);
}));

// Load a specific chat's messages
router.get('/chats/:id', requireAuth, asyncRoute('load chat', async (req, res) => {
  const messages = await chatStore.loadChat(req.params.id, req.user.userId);
  res.json({ messages });
}));

// Delete a chat
router.delete('/chats/:id', requireAuth, asyncRoute('delete chat', async (req, res) => {
  const deleted = await chatStore.deleteChat(req.params.id, req.user.userId);
  if (!deleted) {
    return res.status(404).json({ error: 'Chat not found' });
  }
  res.json({ ok: true });
}));

// Update chat title
router.patch('/chats/:id', requireAuth, asyncRoute('update chat', async (req, res) => {
  const { title } = req.body;
  if (typeof title !== 'string') {
    return res.status(400).json({ error: 'title is required' });
  }
  const updated = await chatStore.updateChatTitle(req.params.id, req.user.userId, title);
  if (!updated) {
    return res.status(404).json({ error: 'Chat not found' });
  }
  res.json({ ok: true });
}));

module.exports = { router, activeStreams, init, pipeAsSSE };
