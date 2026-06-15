import { createContext, useContext, useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { DefaultChatTransport } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useAuth } from './AuthContext';
import { isTokenExpiringSoon } from '../utils/jwt';

const AiChatContext = createContext(null);

// Extract docGuid from the current URL (e.g., /d/{uuid} or /doc/{uuid})
function getActiveDocGuid() {
  const match = window.location.pathname.match(/^\/d(?:oc)?\/([0-9a-f-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

// Auto-generate a short title from the first user message
function generateTitle(text) {
  if (!text) return 'New Chat';
  return text.length > 50 ? text.slice(0, 50) + '...' : text;
}

export function AiChatProvider({ children }) {
  const { accessToken, refreshAccessToken, api } = useAuth();
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
          docGuid: docGuidOverrideRef.current || getActiveDocGuid(),
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

  // Single Chat instance — never pass `id` so useChat doesn't recreate it
  const chat = useChat({
    transport,
    onError: (error) => {
      // DefaultChatTransport throws Error(responseBody) on non-200.
      const msg = (error?.message || '').toLowerCase();

      // Auto-retry once on auth errors: refresh the token and resend
      const isAuth = msg.includes('401') || msg.includes('expired token') || msg.includes('unauthorized');
      if (isAuth && !authRetryRef.current) {
        authRetryRef.current = true;
        refreshAccessToken()
          .then(() => {
            chat.sendMessage({
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
    },
  });

  // ── Load messages when chat changes ──────────────────────────────────────

  // Identifies the (chat, retry-tick) we last tore down + loaded for. `accessToken`
  // is a dependency of the load effect below (we need a token before fetching and
  // must react when one first arrives), but it also changes on every mid-session
  // token refresh — the 5s chat-list poll hitting a 401, a cross-tab broadcast, or
  // the proactive pre-send refresh. Without this guard, such a refresh re-runs the
  // effect and calls chat.stop() on an in-flight stream, aborting the client's view
  // of it. The server keeps streaming via its response tee, so the turn still
  // completes and persists, but the spinner vanishes and nothing renders until a
  // manual page refresh. Keying off this ref means a token refresh (same chat, same
  // tick) is a no-op and leaves any active stream untouched.
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

    // Only tear down + reload when the chat actually changed (or an explicit
    // retry bumped the tick). A re-run caused solely by a token refresh keeps
    // the same key and must leave any in-flight stream untouched.
    const key = `${currentChatId}:${loadMessagesTick}`;
    if (key === loadedKeyRef.current) return;
    loadedKeyRef.current = key;

    // Disconnect any active stream from the previous chat so its tokens
    // don't spill into the new chat's view. The server-side tee ensures
    // the response is still saved even after the client disconnects.
    chat.stop();

    let cancelled = false;
    setMessagesLoading(true);
    setMessagesError(null);
    chat.setMessages([]);
    fetchChatMessages(currentChatId).then((msgs) => {
      if (cancelled) return;
      chat.setMessages(msgs);
      // If the last message is from the user, the server may still be
      // streaming a response. resumeStream() calls GET /api/chat/:id/stream —
      // returns 204 (no-op) if no active stream, or reconnects live if still
      // generating.
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

  // Poll chat list + refresh on tab visibility (mirrors DocList pattern)
  useEffect(() => {
    if (!accessToken) return;
    const POLL_INTERVAL = 5000;
    const id = setInterval(() => {
      if (!document.hidden) refreshChatList();
    }, POLL_INTERVAL);
    const onVisibility = () => { if (!document.hidden) refreshChatList(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [accessToken, refreshChatList]);

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

  // Reset UI to a blank chat (no server call — persisted on first message)
  const createChat = useCallback(async () => {
    chat.setMessages([]);
    setCurrentChatId(null);
    return null;
  }, [chat.setMessages]);

  const selectChat = useCallback((id) => {
    setCurrentChatId(id);
  }, []);

  const deleteChat = useCallback(async (id) => {
    try {
      await api.delete(`/api/chat/chats/${id}`);
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
      let chatId = currentChatId;
      const isNewChat = !chatId;
      if (isNewChat) {
        chatId = await createChatOnServer();
        if (!chatId) return;
        chatIdRef.current = chatId;
        // Flag so the load-messages useEffect skips its stop/clear cycle
        // when currentChatId changes — the stream is about to start.
        creatingChatRef.current = true;
        setCurrentChatId(chatId);
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

      authRetryRef.current = false;
      lastSentTextRef.current = text;
      lastSentFilesRef.current = files || null;
      chat.sendMessage({ text: text || ' ', files: files?.length ? files : undefined });
    },
    [chat.sendMessage, currentChatId, createChatOnServer, renameChat, refreshAccessToken],
  );

  // Retry the last failed message (for the error-banner retry button)
  const retryLastMessage = useCallback(() => {
    if (!lastSentTextRef.current && !lastSentFilesRef.current) return;
    sendMessage(lastSentTextRef.current, lastSentFilesRef.current);
  }, [sendMessage]);

  const value = useMemo(
    () => ({
      ...chat,
      sendMessage,
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
    [chat, sendMessage, currentChatId, chatList, createChat, selectChat, deleteChat, renameChat, refreshChatList, loadMoreChats, hasMoreChats, messagesLoading, messagesError, retryLoadMessages, retryLastMessage, usageLimitReached, draftText, draftFiles, setDocGuidOverride],
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
