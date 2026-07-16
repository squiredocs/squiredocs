import { createContext, useContext, useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { DefaultChatTransport } from 'ai';
import { useChat, Chat } from '@ai-sdk/react';
import { useAuth } from './AuthContext';
import { isTokenExpiringSoon } from '../utils/jwt';
import { parseDocGuid } from '../utils/navigation';
import { useVisibilityPoll } from '../hooks/useVisibilityPoll';
import { parseChatError, FATAL_CODES } from '../utils/chatErrorMessages';

const AiChatContext = createContext(null);

// Map key for the not-yet-created chat (null currentChatId): its cached Chat
// instance and its unsent-input draft both live under this key.
const DRAFT_KEY = '__draft__';

// Transient-error recovery tuning. RECOVERY_TIMEOUT_MS bounds the DB re-fetch;
// RECONNECT_ESTABLISH_MS bounds how long we wait for a resumed stream to START
// (NOT its full duration — a healthy stream then continues uncapped). A genuine
// failure/204 falls through the establish window to the error fallback.
const RECOVERY_TIMEOUT_MS = 10_000;
const RECONNECT_ESTABLISH_MS = 5_000;
const RECONNECT_POLL_MS = 100;
const MAX_RECOVERY_ATTEMPTS = 2;

// Reject `promise` if it doesn't settle within `ms`.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('recovery timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The last persisted turn being the user's means the assistant's reply was never
// saved — so the server may still be streaming it and we should (re)attach.
const isAwaitingAssistant = (msgs) => msgs?.[msgs.length - 1]?.role === 'user';

// Reattach to an in-flight server stream. Fire-and-forget: resumeStream resolves
// only when the whole stream ends, and any re-error surfaces via the instance's
// onError, so the promise is swallowed here.
const reattachStream = (instance) => { instance.resumeStream?.().catch(() => {}); };

// Resolve true once a resumed stream is established (status moved to
// submitted/streaming, or an assistant message has landed); false if it never
// establishes within `ms`. Polls the instance so it works regardless of the
// SDK's internal subscription API.
function waitForEstablish(instance, ms) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const msgs = instance.messages;
      const lastRole = msgs?.[msgs.length - 1]?.role;
      if (instance.status === 'streaming' || instance.status === 'submitted' || lastRole === 'assistant') {
        return resolve(true);
      }
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, RECONNECT_POLL_MS);
    };
    tick();
  });
}

// Auto-generate a short title from the first user message
function generateTitle(text) {
  if (!text) return 'New Chat';
  return text.length > 50 ? text.slice(0, 50) + '...' : text;
}

// "Add to Chat" support. When the user selects text in a document and clicks the
// floating tag, the passage is captured as a "selection reference" and held here
// until the next message is sent. On send, the quoted passages are serialized
// into a delimited block prepended to the user's text so the assistant knows
// exactly which parts of the document the user means — no fragile position
// tracking needed (the literal quote lets it locate the passage via
// read_document if it wants surrounding context). The same refs ride along as
// message metadata so the transcript can render them as styled chips instead of
// showing the raw delimiter block.
let selectionRefIdSeq = 0;
function serializeSelectionRefs(refs) {
  const lines = refs.map((r, i) => {
    // Name the source document (and its id) so the assistant can tell passages
    // apart across multiple docs and locate them with read_document — the user
    // may be chatting about more than the active document.
    const where = [];
    if (r.docTitle || r.docId) {
      const label = r.docTitle ? `document "${r.docTitle}"` : 'a document';
      where.push(`from ${label}${r.docId ? ` (id ${r.docId})` : ''}`);
    }
    if (r.heading) where.push(`under heading "${r.heading}"`);
    const ctx = where.length ? ` (${where.join(', ')})` : '';
    return `[${i + 1}]${ctx} "${r.text}"`;
  });
  return `<referenced_passages>\n${lines.join('\n')}\n</referenced_passages>`;
}

// Onboarding "speak first" kickoff. Sent as a hidden user turn (tagged via
// metadata so the renderer omits it) to prompt the assistant's live greeting.
// The user's first name is woven in so the assistant can personalize the
// welcome sentence it writes into the doc (the agent isn't told the name
// otherwise).
export const WELCOME_KICKOFF_KIND = 'welcome-kickoff';

// Positive emojis the assistant chooses from when refreshing the welcome line's
// trailing emoji on a re-trigger. 😊 is the initial default and stays in the
// pool, so the rotation can cycle back to it; the swap just picks one that
// differs from whatever is currently shown.
const WELCOME_EMOJIS = ['😊', '🎉', '🌟', '✨', '🙌', '😄', '🚀', '👋', '💫', '🌈', '🎊'];

const buildWelcomeKickoffPrompt = (firstName) => {
  const welcomeSentence = firstName
    ? `Welcome ${firstName}! We're glad you're here. 😊`
    : `Welcome! We're glad you're here. 😊`;
  return (
    "The user just opened their welcome document. Greet them warmly as the Squire Docs assistant. "
    + "Silently read this document for context first — do not mention or narrate that you're reading it. "
    + "Then make exactly one edit to the document: "
    + `if it does not already contain a "We're glad you're here" welcome line, insert "${welcomeSentence}" as a new paragraph immediately after the "Welcome to Squire Docs!" heading at the top (above the introductory paragraph); `
    + `if that welcome line is already present, do not add another — instead replace only the emoji at its end with a different one chosen from this list, picking one that differs from the emoji currently shown: ${WELCOME_EMOJIS.join(' ')}. `
    + "Then focus on the main ask: Squire works best when they bring the markdown they already have. "
    + "Invite them to drag a .md file into this chat (or paste markdown here) and it will be imported as a live, versioned document their whole team can edit. "
    + "Also mention that coding agents like Claude Code can connect over MCP and sync documents to and from the markdown in their repo — the \"Connect your coding agents\" section in this document shows how. "
    + "Keep it warm, brief, and concrete."
  );
};

export function AiChatProvider({ children }) {
  const { accessToken, refreshAccessToken, api, user } = useAuth();
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;

  // Chat ID & list state
  const [currentChatId, _setCurrentChatId] = useState(() => sessionStorage.getItem('ai_chat_id'));
  const setCurrentChatId = useCallback((id) => {
    _setCurrentChatId(id);
    if (id) sessionStorage.setItem('ai_chat_id', id);
    else sessionStorage.removeItem('ai_chat_id');
  }, []);
  const [chatList, setChatList] = useState([]);
  const chatListLoadedRef = useRef(false);
  const titleSetRef = useRef(new Set()); // track which chats already have titles
  const creatingChatRef = useRef(false); // skip load-messages effect after new-chat creation

  const [hasMoreChats, setHasMoreChats] = useState(false);
  const CHAT_PAGE_SIZE = 50;

  // ── Chat list ────────────────────────────────────────────────────────────

  const refreshChatList = useCallback(async () => {
    try {
      // Pass token explicitly so the request succeeds even before the
      // AuthContext interceptor effect has run (React fires child effects
      // before parent effects, creating a brief window with no interceptors).
      const headers = tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {};
      const { data: list } = await api.get(`/api/chat/chats?limit=${CHAT_PAGE_SIZE}`, { headers });
      list.forEach(c => { if (c.title) titleSetRef.current.add(c.id); });
      setChatList(list);
      setHasMoreChats(list.length >= CHAT_PAGE_SIZE);
      return list;
    } catch (e) {
      console.error('[AiChat] Failed to refresh chat list:', e);
    }
    return [];
  }, [api]);

  const loadMoreChats = useCallback(async () => {
    try {
      const last = chatList[chatList.length - 1];
      if (!last) return;
      const { data: older } = await api.get(`/api/chat/chats?limit=${CHAT_PAGE_SIZE}&before=${encodeURIComponent(last.updatedAt)}`);
      older.forEach(c => { if (c.title) titleSetRef.current.add(c.id); });
      setChatList(prev => [...prev, ...older]);
      setHasMoreChats(older.length >= CHAT_PAGE_SIZE);
    } catch (e) {
      console.error('[AiChat] Failed to load more chats:', e);
    }
  }, [api, chatList]);

  // ── Transport (sends single message + chat ID) ──────────────────────────

  const chatIdRef = useRef(currentChatId);
  // Guard: don't overwrite the ref during the new-chat creation window —
  // sendMessage sets it explicitly before the state update is processed.
  if (!creatingChatRef.current) {
    chatIdRef.current = currentChatId;
  }

  // Allow pages (e.g. /chat) to override the docGuid sent with messages
  const docGuidOverrideRef = useRef(null);
  const setDocGuidOverride = useCallback((guid) => {
    docGuidOverrideRef.current = guid;
  }, []);

  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/chat',
    // Surface the HTTP status to the error handler (feature 012, D8). The SDK's
    // transport otherwise throws only the response BODY, so handleChatError could
    // not key the app-auth path on status 401 (FR-005) without body-sniffing. On a
    // non-2xx response we read the body and throw an Error carrying both the body
    // text (which parseChatError reads for the taxonomy code) and the status.
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw Object.assign(new Error(bodyText), { status: response.status });
      }
      return response;
    },
    headers: () => {
      const token = tokenRef.current;
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    prepareSendMessagesRequest: ({ messages }) => {
      return {
        body: {
          message: messages[messages.length - 1],
          id: chatIdRef.current,
          docGuid: docGuidOverrideRef.current || parseDocGuid(window.location.pathname),
        },
      };
    },
    prepareReconnectToStreamRequest: () => ({
      api: `/api/chat/${chatIdRef.current}/stream`,
    }),
  }), []);

  // Shared helper: fetch a chat's messages from the server
  const fetchChatMessages = useCallback(async (id) => {
    const headers = tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {};
    const { data } = await api.get(`/api/chat/chats/${id}`, { headers });
    return data.messages || [];
  }, [api]);

  // Message loading state
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState(null);
  const [loadMessagesTick, setLoadMessagesTick] = useState(0);

  const retryLoadMessages = useCallback(() => {
    setLoadMessagesTick((t) => t + 1);
  }, []);

  // Usage limit error state (derived, not latched — cleared on each send attempt).
  const [usageLimitReached, setUsageLimitReached] = useState(false);

  // Classified error info per chat instance (feature 012), keyed by chat id
  // (DRAFT_KEY for the not-yet-created chat). { code, provider, text } drives the
  // banner in both surfaces from the shared map; an error on one chat never bleeds
  // into another. Session-scoped interruption notices (D5) are keyed the same way.
  const [errorInfoByChat, setErrorInfoByChat] = useState({});
  const [interruptedByChat, setInterruptedByChat] = useState({});
  // Structured code/provider captured from a mid-stream data-chat-error part
  // (delivered via onData before onError). Keyed by instance so handleChatError
  // can read the taxonomy code the bare error event can't carry.
  const midStreamErrorRef = useRef(new Map());

  const clearChatError = useCallback((chatKey) => {
    setErrorInfoByChat((m) => {
      if (!(chatKey in m)) return m;
      const next = { ...m }; delete next[chatKey]; return next;
    });
    setInterruptedByChat((m) => {
      if (!(chatKey in m)) return m;
      const next = { ...m }; delete next[chatKey]; return next;
    });
  }, []);

  // Track last sent text/files so we can restore them on error
  const lastSentTextRef = useRef('');
  const lastSentFilesRef = useRef(null);
  const [draftText, setDraftText] = useState('');
  const [draftFiles, setDraftFiles] = useState(null);

  // Pending "Add to Chat" selection references for the message being composed.
  // Ephemeral composing state (like pendingFiles in the input) — lives on the
  // always-mounted provider so it survives the input's per-chat remount, and is
  // cleared when the message sends.
  const [pendingRefs, setPendingRefs] = useState([]);
  const addSelectionRef = useCallback((ref) => {
    if (!ref?.text) return;
    setPendingRefs((prev) => [
      ...prev,
      { id: `sel-${++selectionRefIdSeq}`, text: ref.text, heading: ref.heading || null, docId: ref.docId || null, docTitle: ref.docTitle || null },
    ]);
  }, []);
  const removeSelectionRef = useCallback((id) => {
    setPendingRefs((prev) => prev.filter((r) => r.id !== id));
  }, []);
  const clearSelectionRefs = useCallback(() => setPendingRefs([]), []);

  // Per-chat unsent input drafts. Keeps a chat's typed-but-unsent text and
  // attachments alive across panel close/reopen and chat switches — the input
  // component unmounts in those cases, so its local state can't survive on its
  // own. Keyed by chat id (the not-yet-created chat uses DRAFT_KEY). Lives in a
  // ref on the always-mounted provider, so it outlives any input remount.
  const chatDraftsRef = useRef(new Map());
  const getChatDraft = useCallback((id) => chatDraftsRef.current.get(id || DRAFT_KEY) || null, []);
  const saveChatDraft = useCallback((id, text, files) => {
    const key = id || DRAFT_KEY;
    const hasText = !!(text && text.trim());
    const hasFiles = !!(files && files.length > 0);
    if (!hasText && !hasFiles) {
      chatDraftsRef.current.delete(key); // empty draft → forget it
    } else {
      chatDraftsRef.current.set(key, { text: text || '', files: hasFiles ? files : null });
    }
  }, []);

  // Guard: auto-retry on 401 at most once per send attempt
  const authRetryRef = useRef(false);

  // Transient-error recovery state. recoveringRef holds instances mid-recovery
  // (re-entry guard — also absorbs a re-fired onError during a resumed replay).
  // recoverAttemptsRef caps attempts per chat. reconnectingChatId drives the
  // "Reconnecting…" banner, scoped so a background recovery doesn't show it on a
  // chat you've switched to.
  const recoveringRef = useRef(new Set());
  const recoverAttemptsRef = useRef(new Map());
  const [reconnectingChatId, setReconnectingChatId] = useState(null);

  // Recover a chat whose stream hit a transient error, mirroring what a page
  // refresh does: re-fetch persisted messages; if the assistant turn already
  // saved, show it; otherwise reconnect to the live/buffered server stream.
  // Returns true if recovered, false to fall back to the error banner + draft.
  const recoverChat = useCallback(async (instance) => {
    const id = instance?.id;
    if (!id) return false; // the __draft__ instance has no server row
    let dbMsgs;
    try {
      dbMsgs = await withTimeout(fetchChatMessages(id), RECOVERY_TIMEOUT_MS);
    } catch {
      return false;
    }
    if (!dbMsgs || dbMsgs.length === 0) return false; // nothing saved (don't wipe the visible turn)

    // Reset the instance to the persisted state, dropping any partial assistant
    // turn it's holding (raw `messages` setter — same idiom as createChat).
    instance.messages = dbMsgs;
    if (!isAwaitingAssistant(dbMsgs)) {
      instance.clearError?.(); // complete response saved — clear the stale error
      return true;
    }

    // Assistant not persisted yet: reconnect to the in-flight stream. Detect that
    // it STARTED by polling (resumeStream only resolves when the whole stream
    // ends). Leave status at 'error' so the fallback banner still shows if it
    // never establishes; a re-error during the resumed replay surfaces via onError
    // separately (caught by the re-entry guard).
    reattachStream(instance);
    return waitForEstablish(instance, RECONNECT_ESTABLISH_MS);
  }, [fetchChatMessages]);

  // Shared error handler for every chat instance. Bound to the instance that
  // erred so an auth-retry / recovery acts on the right chat. (refreshAccessToken
  // and recoverChat are stable useCallbacks, so the per-instance onError closures
  // never go stale.)
  const handleChatError = useCallback((error, instance) => {
    const chatKey = instance?.id || DRAFT_KEY;

    // Prefer a mid-stream structured signal (data-chat-error, delivered via onData
    // before onError) — the bare SSE error event can't carry the taxonomy code.
    // Otherwise parse the transport error (JSON body → code; status → 401 branch).
    const midStream = midStreamErrorRef.current.get(instance);
    midStreamErrorRef.current.delete(instance);
    const parsed = midStream
      ? parseChatError({ code: midStream.code, provider: midStream.provider, error: error?.message })
      : parseChatError(error);

    // Restore the composed message so nothing typed is lost, and surface the
    // classified banner. The single place that gives up.
    const fallback = () => {
      if (lastSentTextRef.current) setDraftText(lastSentTextRef.current);
      if (lastSentFilesRef.current) setDraftFiles(lastSentFilesRef.current);
      if (parsed.code === 'app_usage_limit') setUsageLimitReached(true);
      setErrorInfoByChat((m) => ({ ...m, [chatKey]: parsed }));
    };

    // App-auth failure (expired app session) stays OUTSIDE the taxonomy (FR-005/D7):
    // keyed on HTTP status 401, not body text. Silent refresh + resend, unchanged.
    if (error?.status === 401 && !authRetryRef.current) {
      authRetryRef.current = true;
      refreshAccessToken()
        .then(() => {
          instance.sendMessage({
            text: lastSentTextRef.current || ' ',
            files: lastSentFilesRef.current?.length ? lastSentFilesRef.current : undefined,
          });
        })
        .catch(fallback); // refresh failed — restore draft for manual retry
      return;
    }

    // Fatal codes end the turn honestly (FR-015): render the banner immediately and
    // restore the draft; never enter reconnect-recovery ("Reconnecting…" for an
    // empty wallet is the dishonesty this feature removes). A mid-stream fatal error
    // that left a partial reply keeps a session-scoped "response interrupted" notice
    // beside it instead of silently swallowing the truncation (FR-016/D5).
    if (FATAL_CODES.has(parsed.code)) {
      const msgs = instance?.messages;
      const hasPartialReply = msgs?.[msgs.length - 1]?.role === 'assistant';
      if (hasPartialReply) {
        setInterruptedByChat((m) => ({ ...m, [chatKey]: parsed.text }));
      }
      fallback();
      return;
    }

    // Only `internal` / client-network failures reach reconnect-recovery: the
    // server often keeps streaming and persists the response, so try to
    // reconnect/recover before dumping the draft; fall back only if it fails.
    const id = instance?.id;
    if (recoveringRef.current.has(instance)) {
      fallback(); // already recovering (e.g. a re-fired error) — don't loop
      return;
    }
    const attempts = (id && recoverAttemptsRef.current.get(id)) || 0;
    if (attempts >= MAX_RECOVERY_ATTEMPTS) {
      fallback();
      return;
    }
    if (id) recoverAttemptsRef.current.set(id, attempts + 1);
    recoveringRef.current.add(instance);
    if (id) setReconnectingChatId(id);
    recoverChat(instance)
      .then((ok) => { if (!ok) fallback(); })
      .catch(fallback)
      .finally(() => {
        recoveringRef.current.delete(instance);
        setReconnectingChatId((cur) => (cur === id ? null : cur));
      });
  }, [refreshAccessToken, recoverChat]);

  // One persistent Chat instance per chat id, cached and reused across switches.
  // This is what isolates streams (a stream started in chat A writes only to A's
  // instance, never bleeding into another chat after a switch) AND keeps a
  // mid-stream response alive when you switch away: the instance keeps streaming
  // in the background, so switching back simply re-attaches to it with the
  // message already there — no fragile reload/resume needed. The null draft gets
  // its own instance (keyed '__draft__').
  const instancesRef = useRef(new Map());
  const getChatInstance = useCallback((id) => {
    const key = id || DRAFT_KEY;
    let inst = instancesRef.current.get(key);
    if (!inst) {
      inst = new Chat({
        id: id || undefined,
        transport,
        // Capture the mid-stream structured error (feature 012): the server emits a
        // transient data-chat-error part carrying the taxonomy code/provider just
        // before the SSE error event, so onData lands before onError. Stash it so
        // handleChatError renders from the code, not the bare error text.
        onData: (part) => {
          if (part?.type === 'data-chat-error' && part.data) {
            midStreamErrorRef.current.set(inst, part.data);
          }
        },
        onError: (error) => handleChatError(error, inst),
      });
      instancesRef.current.set(key, inst);
    }
    return inst;
  }, [transport, handleChatError]);

  const chat = useChat({ chat: getChatInstance(currentChatId) });

  // Re-sync an instance from the DB and re-attach to a still-live server stream.
  // Mirrors the load-messages effect's fetch body, but operates on a given
  // instance and bypasses the "already has messages / is streaming" guard — used
  // when the in-memory state is stale (e.g. a bfcache restore) and must be
  // refreshed even though the instance still looks populated/streaming.
  const reloadChatFromDb = useCallback(async (instance) => {
    const id = instance?.id;
    if (!id) return;
    let msgs;
    try {
      msgs = await fetchChatMessages(id);
    } catch {
      return; // leave the stale view in place rather than blanking it
    }
    instance.messages = msgs;       // raw setter — drops any partial assistant turn
    instance.clearError?.();
    if (isAwaitingAssistant(msgs)) reattachStream(instance); // server may still be streaming
  }, [fetchChatMessages]);

  // bfcache restore (Cmd+Shift+T, or back/forward) brings the page back from a
  // frozen snapshot WITHOUT re-mounting React, so the load-messages effect never
  // re-runs and the SSE connection that died when the tab closed is never
  // re-established — a chat that was mid-stream stays frozen on a partial. On a
  // persisted pageshow, re-sync the active chat and resume if the server is still
  // streaming. A real reload fires pageshow with persisted=false and is handled by
  // the normal mount/load path instead.
  useEffect(() => {
    const onPageShow = (e) => {
      if (!e.persisted || !currentChatId) return;
      const inst = getChatInstance(currentChatId);
      if (inst.status === 'streaming' || inst.status === 'submitted') {
        reloadChatFromDb(inst);
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [currentChatId, getChatInstance, reloadChatFromDb]);

  // ── Load messages when chat changes ──────────────────────────────────────

  // Identifies the (chat, retry-tick) we last loaded for. `accessToken` is a
  // dependency of the load effect below (we need a token before fetching and must
  // react when one first arrives), but it also changes on every mid-session token
  // refresh — the 5s chat-list poll hitting a 401, a cross-tab broadcast, or the
  // proactive pre-send refresh. Without this guard, such a refresh re-runs the
  // effect for the same chat and re-evaluates the load/reuse branch mid-stream.
  // Keying off this ref makes a token refresh (same chat, same tick) a no-op and
  // leaves the active instance untouched.
  const loadedKeyRef = useRef(null);

  useEffect(() => {
    // After new-chat creation the stream is already running and messages
    // are in the correct state — skip the stop/clear/reload cycle.
    if (creatingChatRef.current) {
      creatingChatRef.current = false;
      loadedKeyRef.current = `${currentChatId}:${loadMessagesTick}`;
      return;
    }

    // No chat selected → reset to a blank slate (once).
    if (!currentChatId) {
      if (loadedKeyRef.current !== null) {
        chat.stop();
        chat.setMessages([]);
        setMessagesLoading(false);
        setMessagesError(null);
        loadedKeyRef.current = null;
      }
      return;
    }

    // Need a token before we can fetch. The effect re-runs when accessToken
    // transitions from null to a value, at which point we proceed.
    if (!accessToken) return;

    // Only (re)load when the chat actually changed (or an explicit retry bumped
    // the tick). A re-run caused solely by a token refresh keeps the same key
    // and must leave any in-flight stream untouched.
    const key = `${currentChatId}:${loadMessagesTick}`;
    if (key === loadedKeyRef.current) return;
    loadedKeyRef.current = key;

    // The chat's instance persists across switches. If it already holds messages
    // or is mid-stream, it kept that state (and kept streaming) while we were
    // away — re-attach as-is instead of refetching and clobbering a live stream.
    // Only a fresh instance (first visit this session, or after a page refresh)
    // loads from the DB.
    if (chat.messages.length > 0 || chat.status === 'streaming' || chat.status === 'submitted') {
      setMessagesLoading(false);
      setMessagesError(null);
      return;
    }

    let cancelled = false;
    setMessagesLoading(true);
    setMessagesError(null);
    fetchChatMessages(currentChatId).then((msgs) => {
      if (cancelled) return;
      chat.setMessages(msgs);
      // If the last message is from the user, the server may still be streaming
      // a response started before a refresh or in another tab. resumeStream()
      // calls GET /api/chat/:id/stream — 204 (no-op) if nothing is live, or
      // reconnects to the live buffer.
      if (isAwaitingAssistant(msgs)) {
        chat.resumeStream();
      }
    }).catch(() => {
      if (!cancelled) setMessagesError('Failed to load messages');
    }).finally(() => {
      if (!cancelled) setMessagesLoading(false);
    });
    return () => { cancelled = true; };
  }, [currentChatId, accessToken, loadMessagesTick, fetchChatMessages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load chat list on mount (once we have a token)
  useEffect(() => {
    if (!accessToken || chatListLoadedRef.current) return;
    chatListLoadedRef.current = true;
    refreshChatList().then((list) => {
      // If we already have a chat restored from sessionStorage, keep it —
      // the messages-loading effect handles errors if the chat no longer exists.
      if (sessionStorage.getItem('ai_chat_id')) return;
      if (list.length === 0) return;
      // Open the most recent chat only if active within 5 minutes
      const msSinceUpdate = Date.now() - new Date(list[0].updatedAt).getTime();
      if (msSinceUpdate < 5 * 60 * 1000) {
        setCurrentChatId(list[0].id);
      }
    });
  }, [accessToken, refreshChatList]);

  // Poll chat list + refresh on tab visibility (once we have a token)
  useVisibilityPoll(refreshChatList, 5000, !!accessToken);

  // ── CRUD operations ──────────────────────────────────────────────────────

  // Create a chat row on the server (called lazily on first message).
  // Does NOT set currentChatId — the caller does that after sending.
  const createChatOnServer = useCallback(async () => {
    try {
      const { data } = await api.post('/api/chat/chats');
      await refreshChatList();
      return data.id;
    } catch (e) {
      console.error('[AiChat] Failed to create chat:', e);
    }
    return null;
  }, [api, refreshChatList]);

  // Reset UI to a blank chat (no server call — persisted on first message).
  // Clears the draft instance only; the outgoing chat's instance is preserved
  // (and keeps streaming) so switching back to it still shows its messages.
  const createChat = useCallback(async () => {
    // Raw Chat instances expose a `messages` setter, not setMessages() — that
    // helper lives only on the useChat() return value.
    getChatInstance(null).messages = [];
    setCurrentChatId(null);
    return null;
  }, [getChatInstance, setCurrentChatId]);

  const selectChat = useCallback((id) => {
    setCurrentChatId(id);
  }, []);

  const deleteChat = useCallback(async (id) => {
    try {
      await api.delete(`/api/chat/chats/${id}`);
      // Drop the cached instance (and stop any stream) for the deleted chat.
      const inst = instancesRef.current.get(id);
      if (inst) { inst.stop?.(); instancesRef.current.delete(id); }
      const newList = await refreshChatList();
      // If we deleted the active chat, switch to the most recent or clear
      if (id === currentChatId) {
        if (newList.length > 0) {
          setCurrentChatId(newList[0].id);
        } else {
          setCurrentChatId(null);
        }
      }
    } catch (e) {
      console.error('[AiChat] Failed to delete chat:', e);
    }
  }, [api, refreshChatList, currentChatId]);

  const renameChat = useCallback(async (id, title) => {
    try {
      await api.patch(`/api/chat/chats/${id}`, { title });
      await refreshChatList();
    } catch (e) {
      console.error('[AiChat] Failed to rename chat:', e);
    }
  }, [api, refreshChatList]);

  // Upload one chat attachment to S3 and swap its inline data: URL for the
  // returned reference (feature 010, US3): attachment bytes travel the S3 path,
  // so the chat body carries a short `attachment:<key>` reference instead of
  // base64. A file that isn't a data: URL (e.g. an already-uploaded reference on
  // a retry) is passed through untouched, keeping this idempotent.
  const uploadChatAttachment = useCallback(
    async (file) => {
      const src = typeof file?.url === 'string'
        ? file.url
        : (typeof file?.data === 'string' ? file.data : null);
      if (!src || !src.startsWith('data:')) return file;
      const { data } = await api.post('/api/chat/attachments', {
        data: src,
        mediaType: file.mediaType,
        filename: file.filename || file.name || null,
      });
      return { ...file, url: data.reference };
    },
    [api],
  );

  // Stable wrapper so callers can pass a plain string instead of { text }
  // Auto-creates a chat if none is selected
  const sendMessage = useCallback(
    async (text, files) => {
      authRetryRef.current = false;
      lastSentTextRef.current = text;

      // Usage-limit state is DERIVED, not latched (FR-017): clear it for every send
      // attempt — a top-up / BYOK-enable / month rollover resumes chat with no
      // reload, and it re-trips immediately if the limit is still in force. Also
      // clear any prior classified error / interruption notice for this chat so a
      // resend starts from a clean transcript.
      setUsageLimitReached(false);
      clearChatError(currentChatId || DRAFT_KEY);

      // Upload attachments first, replacing inline data: URLs with references so
      // the chat request body stays small (feature 010, US3). Store the uploaded
      // form for retry so a resend doesn't re-upload. Markdown files ride this
      // same path — server-side, the assistant imports them into documents via
      // the import_markdown tool; their content is never fed to the model.
      let files_ = files || null;
      if (files?.length) {
        files_ = await Promise.all(files.map(uploadChatAttachment));
      }
      lastSentFilesRef.current = files_;

      // Fold any pending "Add to Chat" selection references into this turn: a
      // delimited quote block prepended to the text (so the model reads it) plus
      // matching metadata (so the transcript renders chips, not raw delimiters).
      const refs = pendingRefs;
      const composedText = refs.length
        ? `${serializeSelectionRefs(refs)}\n\n${text || ''}`.trimEnd()
        : text;
      const payload = {
        text: composedText || ' ',
        files: files_?.length ? files_ : undefined,
        ...(refs.length ? { metadata: { refs: refs.map((r) => ({ text: r.text, heading: r.heading, docTitle: r.docTitle, docId: r.docId })) } } : {}),
      };
      if (refs.length) setPendingRefs([]); // consumed by this send

      // Resolve the target chat id, creating a server row for a brand-new chat.
      let chatId = currentChatId;
      const isNewChat = !chatId;
      if (isNewChat) {
        chatId = await createChatOnServer();
        if (!chatId) return;
      }

      // Fresh send → reset this chat's transient-recovery attempt budget.
      recoverAttemptsRef.current.delete(chatId);

      // Auto-title the chat on the first message
      if (!titleSetRef.current.has(chatId)) {
        titleSetRef.current.add(chatId);
        renameChat(chatId, generateTitle(text || (refs.length ? refs[0].text : 'Image')));
      }

      // Proactively refresh the token if it's expired or expiring soon so the
      // streaming transport sends a valid Authorization header on the first try.
      if (isTokenExpiringSoon(tokenRef.current)) {
        try { await refreshAccessToken(); } catch { /* onError will auto-retry on 401 */ }
      }

      if (isNewChat) {
        // Send on the new chat's own (cached) instance, then switch the view to
        // it. Because instances are cached by id, the instance we send on is the
        // exact one useChat renders after the switch — the stream shows up in the
        // new chat with no deferral needed.
        chatIdRef.current = chatId;        // transport targets the new id immediately
        creatingChatRef.current = true;    // load-messages effect skips its fetch for the new chat
        const inst = getChatInstance(chatId);
        inst.sendMessage(payload);
        setCurrentChatId(chatId);
        return;
      }

      chat.sendMessage(payload);
    },
    [chat.sendMessage, currentChatId, createChatOnServer, renameChat, getChatInstance, refreshAccessToken, pendingRefs, uploadChatAttachment, clearChatError],
  );

  // Start the onboarding greeting: always opens a fresh chat scoped to the
  // current (welcome) doc and sends a hidden kickoff so the assistant speaks
  // first. Mirrors sendMessage's new-chat branch, but the kickoff is tagged
  // (hidden in the UI) and the chat is titled "Welcome" instead of from the text.
  const sendWelcomeMessage = useCallback(async () => {
    const firstName = (user?.name || '').trim().split(/\s+/)[0] || '';
    const text = buildWelcomeKickoffPrompt(firstName);
    authRetryRef.current = false;
    lastSentTextRef.current = text;
    lastSentFilesRef.current = null;

    const chatId = await createChatOnServer();
    if (!chatId) return;
    recoverAttemptsRef.current.delete(chatId);

    // Skip auto-titling from the hidden prompt; give it a stable title.
    titleSetRef.current.add(chatId);
    renameChat(chatId, 'Welcome');

    if (isTokenExpiringSoon(tokenRef.current)) {
      try { await refreshAccessToken(); } catch { /* onError will auto-retry on 401 */ }
    }

    chatIdRef.current = chatId;       // transport targets the new id immediately
    creatingChatRef.current = true;   // load-messages effect skips its fetch for the new chat
    const inst = getChatInstance(chatId);
    inst.sendMessage({ text, metadata: { kind: WELCOME_KICKOFF_KIND } });
    setCurrentChatId(chatId);
  }, [user, createChatOnServer, renameChat, getChatInstance, refreshAccessToken, setCurrentChatId]);

  // Retry the last failed message (for the error-banner retry button)
  const retryLastMessage = useCallback(() => {
    if (!lastSentTextRef.current && !lastSentFilesRef.current) return;
    sendMessage(lastSentTextRef.current, lastSentFilesRef.current);
  }, [sendMessage]);

  const value = useMemo(
    () => ({
      ...chat,
      sendMessage,
      sendWelcomeMessage,
      currentChatId,
      chatList,
      createChat,
      selectChat,
      deleteChat,
      renameChat,
      refreshChatList,
      loadMoreChats,
      hasMoreChats,
      messagesLoading,
      messagesError,
      retryLoadMessages,
      retryLastMessage,
      usageLimitReached,
      // Classified error banner + session-scoped interruption notice for the
      // active chat (feature 012). Both surfaces render from the same errorInfo,
      // so they're identical by construction (SC-002).
      errorInfo: errorInfoByChat[currentChatId || DRAFT_KEY] || null,
      interruptionReason: interruptedByChat[currentChatId || DRAFT_KEY] || null,
      // Guard against null === null: a brand-new chat has currentChatId === null,
      // and the idle reconnecting state is also null — without this check every
      // new chat would falsely show the "Reconnecting…" banner.
      reconnecting: reconnectingChatId !== null && reconnectingChatId === currentChatId,
      draftText,
      clearDraft: () => setDraftText(''),
      draftFiles,
      clearDraftFiles: () => setDraftFiles(null),
      getChatDraft,
      saveChatDraft,
      setDocGuidOverride,
      pendingRefs,
      addSelectionRef,
      removeSelectionRef,
      clearSelectionRefs,
    }),
    [chat, sendMessage, sendWelcomeMessage, currentChatId, chatList, createChat, selectChat, deleteChat, renameChat, refreshChatList, loadMoreChats, hasMoreChats, messagesLoading, messagesError, retryLoadMessages, retryLastMessage, usageLimitReached, errorInfoByChat, interruptedByChat, reconnectingChatId, draftText, draftFiles, getChatDraft, saveChatDraft, setDocGuidOverride, pendingRefs, addSelectionRef, removeSelectionRef, clearSelectionRefs],
  );

  return (
    <AiChatContext.Provider value={value}>
      {children}
    </AiChatContext.Provider>
  );
}

export function useAiChat() {
  return useContext(AiChatContext);
}
