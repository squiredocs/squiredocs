import { createContext, useContext, useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { DefaultChatTransport } from 'ai';
import { useChat, Chat } from '@ai-sdk/react';
import { useAuth } from './AuthContext';
import { isTokenExpiringSoon } from '../utils/jwt';
import { parseDocGuid } from '../utils/navigation';
import { useVisibilityPoll } from '../hooks/useVisibilityPoll';

const AiChatContext = createContext(null);

// Auto-generate a short title from the first user message
function generateTitle(text) {
  if (!text) return 'New Chat';
  return text.length > 50 ? text.slice(0, 50) + '...' : text;
}

// Onboarding "speak first" kickoff. Sent as a hidden user turn (tagged via
// metadata so the renderer omits it) to prompt the assistant's live greeting.
// The user's first name is woven in so the assistant can personalize the
// welcome sentence it writes into the doc (the agent isn't told the name
// otherwise).
export const WELCOME_KICKOFF_KIND = 'welcome-kickoff';

// Positive emojis the assistant chooses from when refreshing the welcome line's
// trailing emoji on a re-trigger (😊 is the initial default; the swap picks a
// different one from this list).
const WELCOME_EMOJIS = ['🎉', '🌟', '✨', '🙌', '😄', '🚀', '👋', '💫', '🌈', '🎊'];

const buildWelcomeKickoffPrompt = (firstName) => {
  const welcomeSentence = firstName
    ? `Welcome ${firstName}! We're glad you're here. 😊`
    : `Welcome! We're glad you're here. 😊`;
  return (
    "The user just opened their welcome document. Greet them warmly as the Squire Docs assistant. "
    + "Silently read this document for context first — do not mention or narrate that you're reading it. "
    + "Then make exactly one edit to the document: "
    + `if it does not already contain a "We're glad you're here" welcome line, insert "${welcomeSentence}" as a new paragraph immediately after the "Write with AI, right in your doc" heading (above the "What's Next?" section); `
    + `if that welcome line is already present, do not add another — instead replace only the emoji at its end with a different one chosen from this list, picking one that differs from the emoji currently shown: ${WELCOME_EMOJIS.join(' ')}. `
    + "Then focus on the main ask: invite them to tell you a topic they're interested in, and offer to research it and create a new "
    + "document with a learning brief to get them started. Keep it warm, brief, and concrete."
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

  // Usage limit error state
  const [usageLimitReached, setUsageLimitReached] = useState(false);

  // Track last sent text/files so we can restore them on error
  const lastSentTextRef = useRef('');
  const lastSentFilesRef = useRef(null);
  const [draftText, setDraftText] = useState('');
  const [draftFiles, setDraftFiles] = useState(null);

  // Guard: auto-retry on 401 at most once per send attempt
  const authRetryRef = useRef(false);

  // Shared error handler for every chat instance. Bound to the instance that
  // erred so an auth-retry resends on the right chat. (refreshAccessToken is a
  // stable useCallback, so the per-instance onError closures never go stale.)
  const handleChatError = useCallback((error, instance) => {
    // DefaultChatTransport throws Error(responseBody) on non-200.
    const msg = (error?.message || '').toLowerCase();

    // Auto-retry once on auth errors: refresh the token and resend
    const isAuth = msg.includes('401') || msg.includes('expired token') || msg.includes('unauthorized');
    if (isAuth && !authRetryRef.current) {
      authRetryRef.current = true;
      refreshAccessToken()
        .then(() => {
          instance.sendMessage({
            text: lastSentTextRef.current || ' ',
            files: lastSentFilesRef.current?.length ? lastSentFilesRef.current : undefined,
          });
        })
        .catch(() => {
          // Refresh failed — restore draft for manual retry
          if (lastSentTextRef.current) setDraftText(lastSentTextRef.current);
          if (lastSentFilesRef.current) setDraftFiles(lastSentFilesRef.current);
        });
      return;
    }

    // Non-auth error (or auth retry exhausted) — restore draft
    if (lastSentTextRef.current) setDraftText(lastSentTextRef.current);
    if (lastSentFilesRef.current) setDraftFiles(lastSentFilesRef.current);

    // Our 429 returns JSON: {"error":"AI usage limit reached"}
    if (msg.includes('usage limit')) {
      setUsageLimitReached(true);
    }
  }, [refreshAccessToken]);

  // One persistent Chat instance per chat id, cached and reused across switches.
  // This is what isolates streams (a stream started in chat A writes only to A's
  // instance, never bleeding into another chat after a switch) AND keeps a
  // mid-stream response alive when you switch away: the instance keeps streaming
  // in the background, so switching back simply re-attaches to it with the
  // message already there — no fragile reload/resume needed. The null draft gets
  // its own instance (keyed '__draft__').
  const DRAFT_KEY = '__draft__';
  const instancesRef = useRef(new Map());
  const getChatInstance = useCallback((id) => {
    const key = id || DRAFT_KEY;
    let inst = instancesRef.current.get(key);
    if (!inst) {
      inst = new Chat({
        id: id || undefined,
        transport,
        onError: (error) => handleChatError(error, inst),
      });
      instancesRef.current.set(key, inst);
    }
    return inst;
  }, [transport, handleChatError]);

  const chat = useChat({ chat: getChatInstance(currentChatId) });

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
      if (msgs[msgs.length - 1]?.role === 'user') {
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
    getChatInstance(null).setMessages([]);
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

  // Stable wrapper so callers can pass a plain string instead of { text }
  // Auto-creates a chat if none is selected
  const sendMessage = useCallback(
    async (text, files) => {
      authRetryRef.current = false;
      lastSentTextRef.current = text;
      lastSentFilesRef.current = files || null;
      const payload = { text: text || ' ', files: files?.length ? files : undefined };

      // Resolve the target chat id, creating a server row for a brand-new chat.
      let chatId = currentChatId;
      const isNewChat = !chatId;
      if (isNewChat) {
        chatId = await createChatOnServer();
        if (!chatId) return;
      }

      // Auto-title the chat on the first message
      if (!titleSetRef.current.has(chatId)) {
        titleSetRef.current.add(chatId);
        renameChat(chatId, generateTitle(text || 'Image'));
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
    [chat.sendMessage, currentChatId, createChatOnServer, renameChat, getChatInstance, refreshAccessToken],
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
      draftText,
      clearDraft: () => setDraftText(''),
      draftFiles,
      clearDraftFiles: () => setDraftFiles(null),
      setDocGuidOverride,
    }),
    [chat, sendMessage, sendWelcomeMessage, currentChatId, chatList, createChat, selectChat, deleteChat, renameChat, refreshChatList, loadMoreChats, hasMoreChats, messagesLoading, messagesError, retryLoadMessages, retryLastMessage, usageLimitReached, draftText, draftFiles, setDocGuidOverride],
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
