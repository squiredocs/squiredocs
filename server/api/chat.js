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
const rateLimit = require('../rate-limit');
const s3Images = require('../s3-images');
const { createAgentTokenPair } = require('../mcp/auth/agent-token-factory');
const { buildBaseUrl } = require('../url');
const chatTools = require('./chat-tools');
const chatModels = require('./chat-models');
const { getProviderConfig } = require('./ai-providers');
const { deduplicateReadResults } = require('./chat-dedup');
const { getObservedClocks, getRevertedDocs, foreignEditsSince, buildStalenessNote } = require('./chat-staleness');
const { loadByokSettings, isByokActive } = require('./byok-settings');
const appSettings = require('./app-settings');
const { getDocument, hasAccess } = require('../documents');
const chatStore = require('../chat-store');
const aiUsage = require('../ai-usage');
const { decrypt } = require('../crypto');
const { notifyException } = require('../exception-notifier');
const { notifyCreditLimitReached } = require('../email');
const { classify, buildErrorPayload, DEFAULT_MESSAGES } = require('./chat-errors');

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

// Stable agent id for the in-app chat assistant. Combined with the user id and
// doc guid it forms the agent-presence session key, so the in-process tool
// calls during streaming reuse one presence session. Undo/redo do NOT depend
// on it: since feature 016 they are log-derived, keyed on the (userId,
// CHAT_AGENT_NAME) attribution of the durable rows — no session, no
// Y.UndoManager.
const CHAT_AGENT_ID = 'in-app-chat';

/**
 * Build the synthetic agent token for the in-app chat assistant for a request.
 * Centralizing this keeps the acting identity (userId + CHAT_AGENT_NAME)
 * identical across the streaming chat handler and the undo/redo endpoints:
 * the log-derived undo chain (feature 016) resolves agent_edits rows by that
 * identity, so a user-triggered undo finds exactly the edits the chat
 * assistant recorded.
 * @param {object} req - Authenticated Express request (req.user.userId)
 * @returns {object} Synthetic agent token (includes rawToken)
 */
function buildChatAgentToken(req) {
  return createAgentTokenPair({
    userId: req.user.userId,
    agentId: CHAT_AGENT_ID,
    agentName: CHAT_AGENT_NAME,
    scopes: ['documents:read', 'documents:write'],
    baseUrl: buildBaseUrl(req),
  }).token;
}

// The WRITING STYLE rules distill Sam's "Writing Style Guide" doc, which is
// the source of truth with before/after examples. Re-distill here when it changes.
const BASE_SYSTEM_PROMPT = `<identity>
You are the Squire Docs assistant. Refer to yourself as the "Squire Docs assistant". Don't refer to yourself as a squire, since you are not a squire. You are the steward of the document. Squire Docs is where engineering teams and their coding agents write specs together — design docs, ADRs, PRDs, and plans — and you keep that work organized, current, and moving toward a document the team can execute against. You bridge the gap between high-level thinking and the meticulous operational work (structuring, formatting, capturing decisions, filling in boilerplate) so the authors can focus on the substance.

Not every author fits the team-spec frame. Some work solo, and some keep the real artifact in another tool (a repository, an IDE, another editor) and use you to revise a copy. That is fine. In those cases the Squire document is their working copy, so keep the work in the document rather than in the chat: edit the document in place, and let the user copy the current version out when they want it.

You track unresolved issues and open questions, update the document to reflect decisions as they're made, and make sure ideas don't get lost.

Good writing comes down to three things: the author, the audience, and the intention. Who is writing this, and how do they want to present themselves? Who will read it, and what do they need? What is the document trying to accomplish: to persuade, document, propose, or remember? If any of these aren't clear, you ask. Every editing decision you make flows from the answers. Remember that the audience for a spec often includes coding agents that will implement against it, so precision, explicit decisions, and unambiguous structure are part of quality. When reviewing, read as the audience would, and flag jargon, insider language, or logical leaps that would lose someone coming to the document fresh.

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
2. read_document (with versionId) or compare_document_versions for details
3. restore_document_version to roll back (this is non-destructive)

USER ATTACHED A MARKDOWN FILE (the message notes an attached .md file whose content is not in the conversation):
1. import_markdown to import it as a new document — don't ask first; the attachment is the intent. The title defaults to the file name.
2. read_document if the user's request requires knowing its content
3. Briefly confirm, linking the created document

USER PASTED A LARGE ARTIFACT INTO CHAT (code, a full document, or a long block they are iterating on):
- If it substantially matches a document you have already read or written in this conversation, do not treat it as new input and do not ask them to paste it again. Say you already have it, name the document, and ask what should change. Call read_document if you need to confirm the current state.
- If it is new and they are likely to keep revising it, the document is a better home than the chat. Offer to put it in a document (create_document; or import_markdown if they attach it as a .md file instead of pasting). Then they iterate there: you edit the document in place, and they copy the current version out when they want it.
- Once the artifact lives in a document, subsequent turns should reference that document, not re-paste it. Re-pasting the whole artifact each turn is slow and costly for the user, and it makes the chat, rather than the document, the place the work accumulates.

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
WRITING STYLE (the most important rules. They apply both to your chat replies AND to the prose you write into documents. They are the defaults for expository and technical prose; deviate only deliberately, when the document's audience and intention call for a different register):
- Write like a person, not an LLM. Keep it concise, plain, and direct.
- Do not use em dashes. Use commas, periods, parentheses, or separate sentences instead.
- Avoid other AI tells: "it's not just X, it's Y" constructions, empty intensifiers (delve, leverage, robust, seamless, comprehensive), filler preambles, reflexive three-item lists, and reflexive hedging.
- Cut words that carry no meaning. Say what you mean and stop.
- Open a document or section by stating what it is or does. Backstory and context come after the reader knows what they are looking at.
- Say what something is, not what it is not. State the mechanism and what it does directly, without a "the real issue isn't X" setup.
- Prefer plain words. Keep genuine technical terms (idempotent, watermark, soft-delete), but when a plain word covers a coined or borrowed phrase, use the plain word.
- Name the actual operation. Instead of an abstract verb like "reconcile", say what literally happens.
- Spell out reasoning chains. If a sentence compresses several steps of logic, walk through the steps in order.
- Break up sentences that carry more than one or two ideas. Short sentences in sequence beat one clause-laden one.
- Delete sentences that add no information: restatements of the obvious, near-tautologies, asides the reader does not need.
- Do not overstate. Avoid absolute words ("never", "always", "costs nothing") unless they are literally guaranteed. Pick the word that is actually true.

- Always use the correct docGuid. Never guess a document ID. Ask the user or search for it.
- Read a document before editing it. Do not modify a document you haven't read in this conversation.
- Confirm destructive actions before executing: restoring versions, deleting large sections, sharing documents.
- After editing, briefly state what you changed (e.g., "Added three bullet points under Summary").
- When you have written a full artifact (code, a long section, a whole document) into a document, do not also paste the whole thing back in your chat reply. Link the document and describe what changed. Reproducing the full artifact in chat doubles the cost of the turn and trains the user to treat the chat as the source of truth instead of the document.
- If a tool call fails, explain the issue simply and suggest next steps.
- Before calling tools, write a brief one-sentence summary of what you're about to do and why (e.g., "Let me read the document first to see what's there."). When calling multiple tools in parallel, say so (e.g., "I'll search for that and read your document at the same time."). This keeps the user informed.
- Be direct. Do not apologize excessively or explain what you could hypothetically do.
- When you need to gather information from multiple independent sources (e.g., reading several documents, searching and fetching), make all independent tool calls in a single response rather than one at a time. This executes them in parallel and is much faster. Tell the user you're doing this (e.g., "I'll read all three documents in parallel.").
- When reviewing history, be specific about attribution. Use author names from version history, not vague "someone made changes," and show concrete edits. Report what changed and let the user interpret why. Flag contradictions neutrally, e.g., "The budget was set to $50K, then changed to $40K."
- When reporting webSearch results, NEVER fabricate or guess URLs. Only cite URLs from the tool output's citations.sources array. Reference sources as [1], [2] etc. matching the source index + 1. If no citations were returned, describe findings without links.
- Never construct URLs by combining a domain with a guessed path.
- If modify returns changed: false, treat it as a targeting failure. Your XPath or element selection likely didn't match, so re-read the document with format: "structured" to understand the current structure before retrying.
- If modify returns conflict: true, someone else changed the document since you last read it. You will need to retry. Re-read the document with read_document, fold in their changes, then modify again. Tell the user that someone else edited the document.
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
If a user turn includes a <referenced_passages> block, those are passages the user selected directly via "Add to Chat" — treat them as the specific text the user is pointing at. Each entry names the source document (and its id), which may or may not be the active document, since the user can reference passages from several documents in one chat — use that to tell passages apart and address the right document. The quotes are usually enough to answer; if you need surrounding context or want to edit them, locate the passage in its document with read_document (e.g. an XPath contains() search on the quoted text).
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
  const msg = typeof errorOrMessage === 'string'
    ? errorOrMessage
    : errorOrMessage?.data?.error?.message || errorOrMessage?.message || '';
  const status = typeof errorOrMessage === 'string'
    ? null
    : errorOrMessage?.data?.error?.status ?? errorOrMessage?.statusCode;
  // Also match the message string (mirroring isTokenLimitError): at the pipeAsSSE
  // stream seam the thrown Error(errorText) carries no statusCode/data, so the
  // structured checks alone never matched and the Gemini no-reasoning retry was
  // dead pre-content (L3). The raw errorText still contains "INVALID_ARGUMENT".
  return status === 'INVALID_ARGUMENT'
    || (status === 400 && /invalid argument/i.test(msg))
    || /INVALID_ARGUMENT|invalid argument/i.test(msg);
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
async function pipeAsSSE(uiStream, res, entry, { writeHeaders = true, onStreamError = null } = {}) {
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

      // Provider error events: forward to the live client (so a genuinely fatal
      // error stays visible) but do NOT append to entry.chunks. Buffering the
      // error part poisons reconnection — a resumeStream() replay would re-deliver
      // it and re-trigger the client's onError. Generation keeps running via the
      // tee and onFinish still persists the (possibly partial) message, so the
      // client can recover by replaying a clean buffer or re-fetching from the DB.
      //
      // Feature 012: carry the classified taxonomy code/provider alongside the
      // error. The AI SDK's error part schema is strict ({ type, errorText }), so
      // the structured fields ride an adjacent TRANSIENT data part (data-chat-error,
      // delivered to the client's onData before onError) rather than as siblings on
      // the error event. Both are written directly (never buffered — FR-010).
      if (value?.type === 'error') {
        const structured = onStreamError ? onStreamError(value.errorText) : null;
        console.error('[Chat API] Provider error in stream:',
          structured?.code || 'unclassified', value.errorText || JSON.stringify(value));
        if (isWritable(res)) {
          if (structured) {
            res.write(sseEvent({
              type: 'data-chat-error',
              data: { code: structured.code, ...(structured.provider ? { provider: structured.provider } : {}) },
              transient: true,
            }));
            res.write(sseEvent({ type: 'error', errorText: structured.errorText }));
          } else {
            // structured === null → an unclassified mid-stream error (in practice
            // Gemini INVALID_ARGUMENT after content; token-limit errors throw
            // earlier and never reach here, so compaction detection is unaffected).
            // The raw provider text must never reach the client (FR-009) — forward
            // the generic internal message. The raw text is preserved in the
            // console.error above for server-side debugging.
            res.write(sseEvent({ type: 'error', errorText: DEFAULT_MESSAGES.internal }));
          }
        }
        continue;
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

// Chat attachments (feature 010, US3): bytes travel the S3 path, so a message
// file part carries a reference `attachment:<s3-key>` instead of inline base64.
// The key is `chat-attachments/<userId>/<uuid>` — ownership is encoded in it and
// re-verified on resolve (no DB row, FR-016).
const ATTACHMENT_SCHEME = 'attachment:';

/**
 * Parse & user-scope an attachment reference. Fetches nothing; just validates
 * ownership. Throws a 403-tagged error when the key belongs to another user
 * (user-scope enforcement, FR-016) — a user can only resolve attachments they
 * uploaded.
 * @param {string} ref - the `attachment:<key>` reference
 * @param {string} userId - the requesting user
 * @returns {string} the S3 object key
 */
// A chat-attachment key is exactly `chat-attachments/<userId>/<uuid>` — three
// segments, the last a v4-shaped UUID (the upload endpoint mints it with
// crypto.randomUUID). Requiring an exact shape rejects traversal (`..`) and any
// extra trailing segments, e.g. `chat-attachments/<self>/../<victim>/<uuid>`,
// which the old prefix-only check accepted (feature 010 review F7).
const ATTACHMENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function attachmentKeyForUser(ref, userId) {
  const key = ref.slice(ATTACHMENT_SCHEME.length);
  const segs = key.split('/');
  if (
    segs.length !== 3 ||
    segs[0] !== 'chat-attachments' ||
    segs[1] !== userId ||
    !ATTACHMENT_UUID_RE.test(segs[2])
  ) {
    throw Object.assign(
      new Error('Attachment reference is not accessible to this user'),
      { status: 403 }
    );
  }
  return key;
}

/**
 * Resolve inline + reference file parts so the model receives raw bytes.
 * - `data:` URLs → inline Buffer (the AI SDK's validateDownloadUrl rejects the
 *   data: scheme, so we can't hand it a data URL).
 * - `attachment:` references → fetched from S3 (user-scoped) as a Buffer.
 * Async because reference resolution is an S3 fetch.
 * @param {Array} modelMessages
 * @param {string} userId
 */
async function inlineDataUrls(modelMessages, userId) {
  for (const msg of modelMessages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if ((part.type !== 'file' && part.type !== 'image') || typeof part.data !== 'string') continue;
      if (part.data.startsWith(ATTACHMENT_SCHEME)) {
        const key = attachmentKeyForUser(part.data, userId);
        part.data = await s3Images.getObject(key);
      } else if (part.data.startsWith('data:')) {
        const m = part.data.match(/^data:[^;]+;base64,(.+)$/s);
        if (m) part.data = Buffer.from(m[1], 'base64');
      }
    }
  }
}

/**
 * Extract image attachments from the incoming user UIMessage as base64, so the
 * insert_image tool can place one into a document. The model can't carry image
 * bytes through a tool call, so the tool references these by index instead.
 * Handles both legacy inline `data:` URLs and the new `attachment:` references
 * (fetched from S3, user-scoped). Async because reference resolution is a fetch.
 * @param {object} message
 * @param {string} userId
 * @returns {Promise<Array<{filename: string|null, mediaType: string, dataBase64: string}>>}
 */
/**
 * Cheap check for whether the incoming user message carries any image
 * attachment — scans file parts by mediaType without fetching any bytes. Used
 * for the text-only-model pre-flight, so we can reject before an S3 fetch or a
 * provider call.
 * @param {object} message
 * @returns {boolean}
 */
function messageHasImage(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts.some(
    (p) => p?.type === 'file' && typeof p.mediaType === 'string' && p.mediaType.startsWith('image/'),
  );
}

async function extractMessageImages(message, userId) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const images = [];
  for (const part of parts) {
    if (part?.type !== 'file' || typeof part.mediaType !== 'string') continue;
    if (!part.mediaType.startsWith('image/')) continue;
    const src = typeof part.url === 'string' ? part.url : part.data;
    if (typeof src !== 'string') continue;
    if (src.startsWith(ATTACHMENT_SCHEME)) {
      const key = attachmentKeyForUser(src, userId); // throws 403 if not owner
      const bytes = await s3Images.getObject(key);
      images.push({ filename: part.filename || null, mediaType: part.mediaType, dataBase64: bytes.toString('base64') });
      continue;
    }
    const m = src.match(/^data:[^;]+;base64,(.+)$/s);
    if (m) images.push({ filename: part.filename || null, mediaType: part.mediaType, dataBase64: m[1] });
  }
  return images;
}

/**
 * Extract markdown attachments from the incoming user UIMessage, for the
 * import_markdown tool. Same resolution rules as extractMessageImages
 * (attachment: references user-scoped from S3, legacy data: URLs inline), but
 * the bytes are ONLY handed to the tool — markdown file parts never reach the
 * model (see replaceMarkdownFileParts).
 * @param {object} message
 * @param {string} userId
 * @returns {Promise<Array<{filename: string|null, mediaType: string, dataBase64: string}>>}
 */
async function extractMessageMarkdown(message, userId) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const files = [];
  for (const part of parts) {
    if (part?.type !== 'file' || part.mediaType !== 'text/markdown') continue;
    const src = typeof part.url === 'string' ? part.url : part.data;
    if (typeof src !== 'string') continue;
    if (src.startsWith(ATTACHMENT_SCHEME)) {
      const key = attachmentKeyForUser(src, userId); // throws 403 if not owner
      const bytes = await s3Images.getObject(key);
      files.push({ filename: part.filename || null, mediaType: part.mediaType, dataBase64: bytes.toString('base64') });
      continue;
    }
    const m = src.match(/^data:[^;]+;base64,(.+)$/s);
    if (m) files.push({ filename: part.filename || null, mediaType: part.mediaType, dataBase64: m[1] });
  }
  return files;
}

/**
 * Replace markdown file parts with a short text note in what is SENT to the
 * model. The persisted UIMessages keep the file part (the transcript renders a
 * file card), but the content itself moves over the byte channel: the
 * import_markdown tool pipes it from the attachment store into the importer.
 * Non-mutating — returns new message/part objects where changes apply.
 * @param {Array} messages - UIMessages (validated)
 */
function replaceMarkdownFileParts(messages) {
  return messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.parts)) return msg;
    let mdIndex = 0;
    let changed = false;
    const parts = msg.parts.map((part) => {
      if (part?.type !== 'file' || part.mediaType !== 'text/markdown') return part;
      changed = true;
      const i = mdIndex++;
      return {
        type: 'text',
        text: `[The user attached a markdown file: "${part.filename || 'untitled.md'}" (markdown attachment index ${i}). `
          + 'Its content is not in this conversation — use the import_markdown tool to import it as a new document.]',
      };
    });
    return changed ? { ...msg, parts } : msg;
  });
}

/**
 * Replace image file parts with a short text note in what is SENT to a
 * text-only model (one whose def.supportsImages is false — the GLM models).
 * The persisted UIMessages keep the image part (the transcript still renders
 * the image), but a model that can't accept image input would otherwise 404
 * the WHOLE request — including on a later text-only follow-up that merely
 * replays an image from conversation history (the incoming-message pre-flight
 * can't catch a history image). This keeps such chats usable: the model sees a
 * note that an image was attached instead of the image itself. Non-mutating —
 * returns new message/part objects where changes apply. Markdown parts are
 * already swapped out by replaceMarkdownFileParts before this runs.
 * @param {Array} messages - UIMessages (validated)
 */
function replaceUnsupportedImageParts(messages) {
  return messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.parts)) return msg;
    let changed = false;
    const parts = msg.parts.map((part) => {
      if (part?.type !== 'file' || typeof part.mediaType !== 'string' || !part.mediaType.startsWith('image/')) {
        return part;
      }
      changed = true;
      return {
        type: 'text',
        text: `[The user attached an image${part.filename ? ` ("${part.filename}")` : ''} here, but this model can't view images, so it is not included.]`,
      };
    });
    return changed ? { ...msg, parts } : msg;
  });
}

// ── Streaming chat endpoint ──────────────────────────────────────────────────

router.post('/', requireAuth, rateLimit.perUser('chat'), async (req, res) => {
  const chatId = req.body?.id;
  let entry = null;
  const cleanupEntry = (ms = 5_000) => {
    if (!entry) return;
    entry.done = true;
    setTimeout(() => {
      if (activeStreams.get(chatId) === entry) activeStreams.delete(chatId);
    }, ms);
  };

  // On a classified failure the resumable-stream entry is torn down IMMEDIATELY
  // with its buffer emptied (feature 025, FR-005): a reconnecting client then gets
  // 204 (nothing live) and derives the failed turn from the stamped transcript
  // instead of replaying a failure-stripped buffer that looks like a clean success.
  // `chunks.length = 0` (not reassignment) so any in-flight tail loop reading the
  // array sees it emptied. The post-SUCCESS 30 s replay window is unchanged.
  const teardownEntry = () => {
    if (!entry) return;
    entry.done = true;
    entry.chunks.length = 0;
    if (activeStreams.get(chatId) === entry) activeStreams.delete(chatId);
  };

  // Classification context, hoisted so the outer catch can classify a failure
  // (feature 012). isByok drives BYOK-vs-shared code selection; providerId sources
  // the payload's `provider`; capturedStreamSignal holds a classified provider
  // error captured at the streamText/toUIMessageStream error seam.
  let isByok = false;
  let providerId = null;
  let capturedStreamSignal = null;
  // Turn-scoped durable failure record (feature 025). Set from the classified
  // signal at the single classification point (classifyStreamError for mid-stream,
  // and alongside each post-save early return / the outer catch). Captured
  // INDEPENDENTLY of capturedStreamSignal (which the SSE onStreamError path nulls
  // out), so after a mid-stream failure it still marks the turn as failed for the
  // stamp-aware onFinish save and the epilogue teardown decision. Its being set is
  // the "this turn failed" signal (T006).
  let pendingFailureStamp = null;
  // Set true the instant THIS turn's user message is durably saved (below). Gates
  // stampTurnFailure so a throw BEFORE that save (e.g. loadChat/saveChat failing)
  // reaches the outer catch without stamping the PREVIOUS, already-answered turn's
  // user message — which would surface a durable false-failure banner (F1/FR-006).
  let userTurnPersisted = false;
  // This turn's incoming user-message id, captured for the belt-and-braces guard in
  // stampTurnFailure (only stamp when the transcript's trailing user message is
  // still THIS turn's message).
  let incomingUserMessageId = null;

  // Send a classified pre-stream error (HTTP JSON, honest status per D2) and fire
  // the operator notification when the code owns one (US5). Used by the early
  // returns and the outer catch's internal path.
  const sendClassifiedError = (signal, causeErr) => {
    if (signal.notifyOperator) {
      notifyException(causeErr || new Error(signal.trueCause || signal.error), {
        req, source: 'chat-api', extra: { code: signal.code, ...(signal.trueCause ? { trueCause: signal.trueCause } : {}) },
      });
    }
    if (!res.headersSent) {
      if (signal.retryAfterSec) res.set('Retry-After', String(signal.retryAfterSec));
      res.status(signal.status).json(buildErrorPayload(signal));
    }
  };

  // Build the durable failure record from a classified signal (feature 025).
  // Codes only — no raw provider text ever enters durable storage (FR-003/D1).
  const stampFromSignal = (signal) => ({
    code: signal.code,
    ...(signal.provider ? { provider: signal.provider } : {}),
    at: new Date().toISOString(),
  });

  // Stamp the failure record onto the failed turn's TRAILING USER MESSAGE via an
  // awaited read-modify-write (feature 025, FR-004). Used by the non-streaming
  // paths — the post-save early returns and the outer catch — which never invoke
  // streamText, so onFinish never runs for them (the mid-stream path folds the
  // same record into its onFinish save instead; research.md R1). Additive: never
  // replaces sibling metadata (refs/kind). No-op when no user message is persisted
  // yet (FR-006 — there is no turn to stamp). Best-effort: a stamp failure is
  // logged, never surfaced (the live error event already reached the client).
  const stampTurnFailure = async (record) => {
    // F1/FR-006: never stamp until THIS turn's user message is persisted. A pre-save
    // throw (loadChat/saveChat failing before line ~750) reaches the outer catch with
    // this flag still false — stamping then would land the record on the prior,
    // already-answered turn, a durable false-failure banner + false interruption.
    if (!userTurnPersisted) return;
    const uid = req.user.userId;
    try {
      const stored = await chatStore.loadChat(chatId, uid);
      const u = stored.map((m) => m.role).lastIndexOf('user');
      if (u < 0) return;
      // Belt-and-braces: the trailing user message must still be THIS turn's message.
      // If a concurrent write changed the tail, don't stamp a stranger's turn.
      if (incomingUserMessageId != null && stored[u]?.id != null
          && stored[u].id !== incomingUserMessageId) return;
      const target = stored[u];
      // F3: re-read-and-MERGE rather than assume convergence with the fire-and-forget
      // onFinish save. Preserve whatever the latest save persisted — a partial reply
      // already written, AND an existing stamp (keep it, add nothing) — while
      // ensuring the record is present. Additive: never drops sibling metadata.
      stored[u] = {
        ...target,
        metadata: { ...(target.metadata || {}), failure: target.metadata?.failure || record },
      };
      await chatStore.saveChat(chatId, uid, stored);
    } catch (err) {
      console.error('[Chat API] Failed to stamp turn failure:', err);
    }
  };

  try {
    const { message, docGuid } = req.body;

    if (!message || !chatId) {
      return res.status(400).json({ error: 'message and id are required' });
    }
    incomingUserMessageId = message?.id ?? null;

    // Enforce per-user stream limit to prevent memory exhaustion
    let userStreamCount = 0;
    for (const [, s] of activeStreams) {
      if (s.userId === req.user.userId && !s.done) userStreamCount++;
    }
    if (userStreamCount >= MAX_STREAMS_PER_USER) {
      // Too many concurrent streams is a per-user throttle → surface it as the
      // structured rate_limited payload (429), distinct from the usage limit.
      return sendClassifiedError(classify(null, { isRateLimited: true }));
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
    // This turn's user message is now durable — any classified failure from here on
    // stamps THIS turn (F1). A throw before this point never stamps the prior turn.
    userTurnPersisted = true;

    // Load BYOK settings for the user. `byokEnabled` is the user's INTENT (BYOK
    // toggled on); `isByok` is fully-resolvable BYOK (the metering flag). They
    // differ only when BYOK is misconfigured — which is rejected below before any
    // provider call, so metering never sees the difference (feature 012).
    const byokSettings = pool ? await loadByokSettings(req.user.userId) : null;
    const byokEnabled = !!byokSettings?.byok_enabled;
    isByok = isByokActive(byokSettings);

    // Check AI usage quota before proceeding. A BYOK user (even one currently
    // misconfigured) is never charged in-app credits — skip on byokEnabled so a
    // misconfigured BYOK request is rejected as byok_misconfigured, not quota.
    let reservationId = null;
    if (!byokEnabled) {
      const quota = await aiUsage.checkQuota(req.user.userId);
      if (!quota.allowed) {
        // Preserve the per-user/per-month admin credit email (FR-021); the
        // classified user response is app_usage_limit → 402 (FR-006/D2).
        notifyCreditLimitReached({
          email: req.user.email,
          name: req.user.name,
          creditCents: quota.creditCents,
          usedCents: quota.usedCents,
        });
        const usageSignal = classify(null, { isUsageLimit: true });
        pendingFailureStamp = stampFromSignal(usageSignal);
        await stampTurnFailure(pendingFailureStamp);
        teardownEntry();
        return sendClassifiedError(usageSignal);
      }
      // Reserve estimated credits upfront to prevent TOCTOU race
      try {
        reservationId = await aiUsage.reserveCredits(req.user.userId, 5);
      } catch (e) {
        console.error('[Chat API] Failed to reserve credits:', e);
      }
    }

    // Release an outstanding reservation on a classified early return that happens
    // AFTER reserveCredits but BEFORE the stream starts. On those paths onFinish
    // (which normally reconciles the reservation) never fires, so without this the
    // 'reserved' row lingers forever, permanently debiting the user's monthly quota
    // (L4). Idempotent: nulls the id so it can't double-release.
    const releaseReservation = () => {
      if (!reservationId) return;
      const id = reservationId;
      reservationId = null;
      aiUsage.reconcileReservation(id, { failed: true })
        .catch(err => console.error('[Chat API] Failed to release reservation:', err));
    };

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
    const syntheticAgentToken = buildChatAgentToken(req);

    const { streamText, convertToModelMessages, validateUIMessages, createIdGenerator, stepCountIs } = getAI();

    // Resolve model — BYOK uses user's key + selected model, otherwise the
    // server default (with fallback). See chatModels.resolveChatModel.
    const resolved = chatModels.resolveChatModel({
      isByok: byokEnabled,
      byokSettings,
      decryptKey: decrypt,
      sharedDefaultKey: appSettings.getSharedDefaultModel(),
      // Feature 035 — admin-set per-user pin; NULL for everyone by default. Read from
      // the same per-turn row as BYOK state, so a set/clear lands on the next turn.
      userOverrideKey: byokSettings?.chat_model_override || null,
    });
    if (resolved && resolved.error === 'byok_misconfigured') {
      // BYOK on but the key/model can't be resolved: reject loudly BEFORE any
      // provider call — never fall back to (and bill) the shared server key
      // (FR-019). Not an operator fault, so no exception notification. (BYOK is on
      // here, so no reservation was taken; release is a defensive no-op.)
      releaseReservation();
      const byokSignal = classify(null, { isByokMisconfigured: true, providerId: resolved.provider });
      pendingFailureStamp = stampFromSignal(byokSignal);
      await stampTurnFailure(pendingFailureStamp);
      teardownEntry();
      return sendClassifiedError(byokSignal);
    }
    if (!resolved) {
      // No shared model configured at all — a genuine server misconfiguration.
      // This is the shared-key path, so a reservation IS outstanding — release it
      // before returning or it leaks (L4).
      releaseReservation();
      const noModelErr = new Error('No valid chat model configured');
      const noModelSignal = classify(noModelErr, {});
      pendingFailureStamp = stampFromSignal(noModelSignal);
      await stampTurnFailure(pendingFailureStamp);
      teardownEntry();
      return sendClassifiedError(noModelSignal, noModelErr);
    }
    const { model, def, provider } = resolved;
    providerId = def.provider; // source of the payload's `provider` for later failures
    // Provider capability flags drive the per-provider streaming gates below
    // (prompt caching, thinking, provider-executed web-search message stripping).
    const caps = getProviderConfig(def.provider).capabilities;

    console.log(`[Chat API] Using model: ${def.key} (${def.modelId})`);

    // Pre-flight: a text-only model can't accept image attachments. Reject
    // honestly here BEFORE any S3 fetch or provider call — otherwise the provider
    // 404s the whole stream (z.ai/OpenRouter GLM: "No endpoints found that
    // support image input"), which falls through to a generic `internal` error
    // and pages the operator. The client also gates image attachment on the
    // model's supportsImages flag; this is the server-side backstop.
    if (!def.supportsImages && messageHasImage(message)) {
      releaseReservation();
      const imgSignal = classify(null, { isImageUnsupported: true, providerId });
      pendingFailureStamp = stampFromSignal(imgSignal);
      await stampTurnFailure(pendingFailureStamp);
      teardownEntry();
      return sendClassifiedError(imgSignal);
    }

    // Per-doc baseline clock the agent has observed, populated below once the
    // message history is parsed. Passed by reference so modify's conflict guard
    // can read the latest value when tool calls execute during streaming.
    const observedClockHolder = { byDoc: new Map() };

    // Build tool set: MCP tools + provider-specific web search + universal webFetch
    // + image tools (insert_image references this message's attachments; view_image
    // lets the agent see images already in the doc).
    // Resolve this message's image attachments (inline data URLs or S3
    // references, user-scoped) once, up front — feeds both the insert_image tool
    // (below) and the model file parts (via inlineDataUrls). A reference the user
    // doesn't own throws a 403 here, before any streaming starts.
    const messageImages = await extractMessageImages(message, req.user.userId);
    // Markdown attachments feed ONLY the import_markdown tool — their file
    // parts are swapped for a text note before the model sees the messages.
    const messageMarkdown = await extractMessageMarkdown(message, req.user.userId);

    const tools = chatTools.buildTools(syntheticAgentToken, {
      providerName: def.provider,
      provider,
      pool,
      observedClockHolder,
      docGuid,
      messageImages,
      messageMarkdown,
      // Text-only models (GLM) don't get the vision tools — offering them lets the
      // agent 404 the turn by feeding image bytes back through a tool result.
      supportsImages: def.supportsImages,
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
    // Strip parts we keep for persistence/UI but must not (or need not) resend:
    //  - provider-executed web-search results (Anthropic history-adjacency, above)
    //  - prior-turn reasoning for GLM/openai-compatible (echoed back as
    //    reasoning_content otherwise; validatedMessages keeps it for UI + storage).
    let modelInputMessages = validatedMessages;
    if (caps.providerExecutedWebSearch) {
      modelInputMessages = chatModels.stripProviderExecutedTools(modelInputMessages);
    }
    if (caps.stripReasoningFromHistory) {
      modelInputMessages = chatModels.stripReasoningParts(modelInputMessages);
    }
    // Markdown attachments stay out of model context (byte channel): swap their
    // file parts for a short note pointing at the import_markdown tool.
    modelInputMessages = replaceMarkdownFileParts(modelInputMessages);
    // A text-only model (GLM) 404s the whole request on ANY image block —
    // including one replayed from history on a later text follow-up, which the
    // incoming-message pre-flight above can't see. Swap image parts for a note
    // so those chats keep working instead of failing every turn.
    if (!def.supportsImages) {
      modelInputMessages = replaceUnsupportedImageParts(modelInputMessages);
    }
    const modelMessages = await convertToModelMessages(modelInputMessages);
    await inlineDataUrls(modelMessages, req.user.userId);

    // Deduplicate repeated document reads to save context window space
    const dedupedMessages = deduplicateReadResults(modelMessages);

    // Track the agent's last-seen clock per document and warn it about edits
    // made by anyone else since then.
    observedClockHolder.byDoc = getObservedClocks(modelMessages);
    // Docs whose latest agent edit the user has since undone via the chat Undo
    // button. The undo is written through the agent's own identity out-of-band,
    // so foreignEditsSince can't detect it — surface it as a change here so the
    // agent re-reads instead of trusting its now-reverted snapshot.
    const revertedDocs = getRevertedDocs(allMessages);
    if (persistence && observedClockHolder.byDoc.size > 0) {
      const staleEntries = [];
      for (const [staleDocGuid, baseClock] of observedClockHolder.byDoc) {
        try {
          const updates = await persistence.getRecentUpdatesWithUsers(staleDocGuid, 100);
          const editors = foreignEditsSince(updates, baseClock, {
            userId: req.user.userId,
            agentName: CHAT_AGENT_NAME,
          });
          const reverted = revertedDocs.has(staleDocGuid);
          if (editors.length === 0 && !reverted) continue;
          let title = staleDocGuid === docGuid ? docTitle : null;
          if (!title) {
            try { title = (await getDocument(staleDocGuid))?.title || null; } catch (_) { /* best-effort */ }
          }
          staleEntries.push({ docGuid: staleDocGuid, editors, title, reverted });
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
    const retryWithoutReasoning = caps.retryWithoutReasoningOnInvalidArgument;

    // Best-effort raw provider message (used only to keep token-limit /
    // INVALID_ARGUMENT detection working — those errors stay out of the taxonomy).
    const rawErrorMessage = (error) => (typeof error === 'string'
      ? error
      : (error?.message || error?.data?.error?.message || error?.responseBody || 'Stream error'));

    // Classify a stream error at the toUIMessageStream error seam (feature 012).
    // Returns the honest, sanitized error string (never raw provider internals —
    // FR-009) and stashes the full classified signal for pipeAsSSE (mid-stream) or
    // the outer catch (before content). Token-limit and Gemini INVALID_ARGUMENT
    // errors are deliberately left UNCLASSIFIED (FR-004): the existing compaction /
    // reasoning-retry interceptions detect them by the returned raw message and
    // handle them invisibly — they must never become a taxonomy payload or page.
    const classifyStreamError = (error) => {
      if (isTokenLimitError(error) || (retryWithoutReasoning && isInvalidArgumentError(error))) {
        return rawErrorMessage(error);
      }
      capturedStreamSignal = classify(error, { isByok, providerId });
      // Mark the turn failed durably (feature 025). Captured independently of
      // capturedStreamSignal (which onStreamError nulls) so the stamp-aware
      // onFinish save and the epilogue teardown still see it after the SSE path.
      pendingFailureStamp = stampFromSignal(capturedStreamSignal);
      return capturedStreamSignal.error;
    };
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
      // Use `totalUsage` (aggregated across ALL agentic steps), not `usage`
      // (which is only the final step). With stopWhen: stepCountIs(100) each user
      // turn is a multi-step tool loop where every step re-sends the growing
      // context and Anthropic bills it separately; metering the last step alone
      // undercounts real cost by ~the number of steps.
      onFinish: async ({ totalUsage: usage }) => {
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
        // Log cache activity for ANY provider that reports it, not just Anthropic.
        // Anthropic caches via our explicit breakpoints (writes + reads); z.ai and
        // OpenRouter GLM cache implicitly (reads only, no code). Gemini reports
        // neither, so this stays quiet there.
        if (cacheReadTokens > 0 || cacheWriteTokens > 0) {
          console.log(
            `[Chat API] ${def.provider} cache — read=${cacheReadTokens} write=${cacheWriteTokens} `
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
        // Sanitize + classify the error text the client sees (feature 012). Keeps
        // the honest string for degraded clients (D6) and stashes the taxonomy
        // signal for the transport paths below.
        onError: classifyStreamError,
        onFinish: ({ messages: saved }) => {
          // Stamp-aware full-replace save (feature 025, FR-004 / research.md R1):
          // fold the pending failure record into the SAME save that persists the
          // (possibly partial) reply, so this writer can never persist a failed
          // turn WITHOUT its stamp — closing the documented clobber race. The
          // stamp targets the last role==='user' message (on a mid-stream failure
          // the trailing element is the assistant partial — M1), additively.
          let toSave = saved;
          if (pendingFailureStamp) {
            const u = saved.map((m) => m.role).lastIndexOf('user');
            if (u >= 0) {
              toSave = saved.slice();
              toSave[u] = { ...saved[u], metadata: { ...(saved[u].metadata || {}), failure: pendingFailureStamp } };
            }
          }
          chatStore.saveChat(chatId, userId, toSave).catch((err) => {
            console.error('[Chat API] Failed to save chat:', err);
          });
        },
      });
      await pipeAsSSE(uiStream, res, entry, {
        writeHeaders: opts.writeHeaders ?? true,
        // Mid-stream (after content) errors: attach the classified code/provider
        // and fire the operator notification here — the outer catch is not reached
        // for after-headers errors. Consume the signal so it can't double-fire.
        onStreamError: (errorText) => {
          const signal = capturedStreamSignal;
          if (!signal) return null; // token-limit / unclassified — forward as-is
          capturedStreamSignal = null;
          if (signal.notifyOperator) {
            notifyException(new Error(signal.trueCause || errorText || signal.error), {
              req, source: 'chat-api',
              extra: { code: signal.code, midStream: true, ...(signal.trueCause ? { trueCause: signal.trueCause } : {}) },
            });
          }
          return { errorText: signal.error, code: signal.code, provider: signal.provider };
        },
      });
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
      } else if (retryWithoutReasoning && isInvalidArgumentError(streamError)) {
        // Gemini 3 models can fail with INVALID_ARGUMENT when thought
        // signatures from earlier turns are lost during DB persistence.
        // Retry without reasoning/thinking options so the request isn't rejected.
        console.warn(
          '[Chat API] INVALID_ARGUMENT with reasoning enabled — retrying without provider options'
        );
        // Gated behind retryWithoutReasoningOnInvalidArgument (Google only), so
        // clobbering providerOptions here never disables Anthropic caching. Keep
        // that gate if this branch is ever extended to another provider.
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
    // A mid-stream classified failure (after-content error, forwarded not thrown)
    // reaches here with pendingFailureStamp set — tear the entry down immediately
    // so a reconnect finds nothing to replay (FR-005). A success keeps the 30 s
    // replay window unchanged.
    if (pendingFailureStamp) teardownEntry();
    else cleanupEntry(30_000);
    res.end();
  } catch (error) {
    console.error('[Chat API] Error:', error);
    teardownEntry();
    // A tagged client error (e.g. an attachment reference the user doesn't own,
    // feature 010/FR-016) is a request-validation 4xx outside the taxonomy —
    // surface its status + message and don't page.
    const taggedStatus = error && Number.isInteger(error.status) ? error.status : null;
    if (taggedStatus && taggedStatus >= 400 && taggedStatus < 500) {
      if (!res.headersSent) res.status(taggedStatus).json({ error: error.message || 'Request rejected' });
      return;
    }
    // Classify the turn failure once (feature 012). Prefer the rich provider error
    // captured at the stream error seam over the generic re-thrown Error; honest
    // status per D2, structured payload, operator paged only when the code owns it.
    const signal = capturedStreamSignal || classify(error, { isByok, providerId });
    capturedStreamSignal = null;
    // Persist the failure record on the (already-saved) user message via an awaited
    // read-modify-write (feature 025, FR-004). This does NOT assume the fire-and-
    // forget onFinish save and this RMW converge on the same record: on a failed
    // compaction / INVALID_ARGUMENT retry, a run's onFinish can save the turn with a
    // partial reply and possibly no stamp. The RMW re-reads that latest state and
    // MERGES — preserving any partial reply and any existing stamp while ensuring the
    // record is present. Gated on userTurnPersisted so a pre-save throw never stamps
    // the prior turn (F1). Residual (LOW/F3): a still-in-flight onFinish save that
    // lands strictly AFTER this awaited RMW could clobber the stamp on that retry
    // path; that narrow window is accepted (failures are rare) and documented here
    // rather than papered over as guaranteed convergence.
    pendingFailureStamp = stampFromSignal(signal);
    await stampTurnFailure(pendingFailureStamp);
    sendClassifiedError(signal, error);
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

// Live summary of an in-progress "thinking" block. While a reasoning part
// streams, the client polls this every few seconds with the accumulated
// thinking text; a fast/cheap model condenses it into a short phrase shown in
// place of the static "Thinking" label. Like compaction, this auxiliary call
// runs on the shared server key and is not metered against user credits.
// Only the tail of the reasoning matters for "what is it doing right now".
const THINKING_SUMMARY_MAX_INPUT_CHARS = 8000;

// A summarizer candidate that just failed (e.g. its provider account is out of
// credit) sits out this long, so the 3s polling cadence goes straight to the
// next funded provider instead of re-failing on every poll.
const THINKING_SUMMARY_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const thinkingSummaryFailedAt = new Map(); // candidate id → last failure epoch ms

router.post('/thinking-summary', requireAuth, asyncRoute('summarize thinking', async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  const { generateText } = getAI();
  const tail = text.slice(-THINKING_SUMMARY_MAX_INPUT_CHARS);
  const prompt =
    'Below is the in-progress reasoning of an AI assistant. Describe what it is '
    + 'currently doing in ONE short present-tense phrase of at most 8 words '
    + '(e.g. "Comparing document versions for formatting changes"). '
    + 'Weight the end of the reasoning most heavily. '
    + 'Reply with the phrase only — no quotes, no trailing punctuation.\n\n'
    + `Reasoning:\n${tail}`;

  // The label is cosmetic: a failure must never 500, page the operator, or
  // block the chat — degrade to summary:null (the client keeps the static
  // "Thinking" label). Fail over across shared-key providers at runtime,
  // because a configured key can still be unfunded at the provider.
  const now = Date.now();
  for (const { id, model } of chatModels.getThinkingSummaryModels()) {
    const failedAt = thinkingSummaryFailedAt.get(id);
    if (failedAt && now - failedAt < THINKING_SUMMARY_FAILURE_COOLDOWN_MS) continue;
    try {
      const result = await generateText({ model, maxTokens: 64, prompt });
      thinkingSummaryFailedAt.delete(id);
      const summary = (result.text || '').trim().replace(/^["']+|["']+$/g, '');
      return res.json({ summary: summary || null });
    } catch (err) {
      thinkingSummaryFailedAt.set(id, Date.now());
      console.warn(`[Chat API] Thinking summary failed on ${id} (cooling down): ${err?.message || err}`);
    }
  }
  res.json({ summary: null });
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

module.exports = {
  router, activeStreams, init, pipeAsSSE, buildChatAgentToken, CHAT_AGENT_ID, CHAT_AGENT_NAME,
  // Exposed for tests (feature 010): attachment reference resolution + the
  // concurrent-stream cap / compaction seams (G1).
  extractMessageImages, inlineDataUrls, compactMessages, isTokenLimitError, isInvalidArgumentError, MAX_STREAMS_PER_USER,
  // Markdown attachment byte channel (import_markdown tool).
  extractMessageMarkdown, replaceMarkdownFileParts,
  // Text-only-model image handling: pre-flight detector + history strip.
  messageHasImage, replaceUnsupportedImageParts,
  // Exposed for the F7 key-hardening test.
  attachmentKeyForUser,
  // Test seam: clear the thinking-summary failure cooldowns between cases.
  _resetThinkingSummaryCooldowns: () => thinkingSummaryFailedAt.clear(),
};
