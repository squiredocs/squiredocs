import { createContext, useContext, useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { DefaultChatTransport } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useAuth } from './AuthContext';

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
  const { accessToken } = useAuth();
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;

  // Chat ID & list state
  const [currentChatId, _setCurrentChatId] = useState(null);
  const setCurrentChatId = useCallback((id) => {
    _setCurrentChatId(id);
    if (id) sessionStorage.setItem('ai_chat_id', id);
    else sessionStorage.removeItem('ai_chat_id');
  }, []);
  const [chatList, setChatList] = useState([]);
  const chatListLoadedRef = useRef(false);
  const titleSetRef = useRef(new Set()); // track which chats already have titles
  const creatingChatRef = useRef(false); // skip load-messages effect after new-chat creation

  // Helper for authed API calls
  const apiFetch = useCallback((path, opts = {}) => {
    const token = tokenRef.current;
    return fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
    });
  }, []);

  // ── Chat list ────────────────────────────────────────────────────────────

  const refreshChatList = useCallback(async () => {
    try {
      const res = await apiFetch('/api/chat/chats');
      if (res.ok) {
        const list = await res.json();
        list.forEach(c => { if (c.title) titleSetRef.current.add(c.id); });
        setChatList(list);
        return list;
      }
    } catch (e) {
      console.error('[AiChat] Failed to refresh chat list:', e);
    }
    return [];
  }, [apiFetch]);

  // ── Transport (sends single message + chat ID) ──────────────────────────

  const chatIdRef = useRef(currentChatId);
  // Guard: don't overwrite the ref during the new-chat creation window —
  // sendMessage sets it explicitly before the state update is processed.
  if (!creatingChatRef.current) {
    chatIdRef.current = currentChatId;
  }

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
          docGuid: getActiveDocGuid(),
        },
      };
    },
    prepareReconnectToStreamRequest: () => ({
      api: `/api/chat/${chatIdRef.current}/stream`,
    }),
  }), []);

  // Shared helper: fetch a chat's messages from the server
  const fetchChatMessages = useCallback(async (id) => {
    const res = await apiFetch(`/api/chat/chats/${id}`);
    if (!res.ok) throw new Error('Failed to load messages');
    const data = await res.json();
    return data.messages || [];
  }, [apiFetch]);

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

  // Single Chat instance — never pass `id` so useChat doesn't recreate it
  const chat = useChat({
    transport,
    onError: (error) => {
      // Restore the user's message and files to the input
      if (lastSentTextRef.current || lastSentFilesRef.current) {
        if (lastSentTextRef.current) setDraftText(lastSentTextRef.current);
        if (lastSentFilesRef.current) setDraftFiles(lastSentFilesRef.current);
        lastSentTextRef.current = '';
        lastSentFilesRef.current = null;
      }
      // DefaultChatTransport throws Error(responseBody) on non-200.
      // Our 429 returns JSON: {"error":"AI usage limit reached"}
      if (error?.message?.includes('usage limit')) {
        setUsageLimitReached(true);
      }
    },
  });

  // ── Load messages when chat changes ──────────────────────────────────────

  useEffect(() => {
    // After new-chat creation the stream is already running and messages
    // are in the correct state — skip the stop/clear/reload cycle.
    if (creatingChatRef.current) {
      creatingChatRef.current = false;
      return;
    }

    // Disconnect any active stream from the previous chat so its tokens
    // don't spill into the new chat's view. The server-side tee ensures
    // the response is still saved even after the client disconnects.
    chat.stop();

    if (!currentChatId) {
      chat.setMessages([]);
      setMessagesLoading(false);
      setMessagesError(null);
      return;
    }
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
  }, [currentChatId, loadMessagesTick, fetchChatMessages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load chat list on mount (once we have a token)
  useEffect(() => {
    if (!accessToken || chatListLoadedRef.current) return;
    chatListLoadedRef.current = true;
    refreshChatList().then((list) => {
      if (list.length === 0) return;
      // Restore the chat from this tab session (e.g. page refresh)
      const savedId = sessionStorage.getItem('ai_chat_id');
      if (savedId && list.some((c) => c.id === savedId)) {
        setCurrentChatId(savedId);
        return;
      }
      // Otherwise open the most recent chat only if active within 5 minutes
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
      const res = await apiFetch('/api/chat/chats', { method: 'POST' });
      if (res.ok) {
        const { id } = await res.json();
        await refreshChatList();
        return id;
      }
    } catch (e) {
      console.error('[AiChat] Failed to create chat:', e);
    }
    return null;
  }, [apiFetch, refreshChatList]);

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
      const res = await apiFetch(`/api/chat/chats/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const newList = await refreshChatList();
        // If we deleted the active chat, switch to the most recent or clear
        if (id === currentChatId) {
          if (newList.length > 0) {
            setCurrentChatId(newList[0].id);
          } else {
            setCurrentChatId(null);
          }
        }
      }
    } catch (e) {
      console.error('[AiChat] Failed to delete chat:', e);
    }
  }, [apiFetch, refreshChatList, currentChatId]);

  const renameChat = useCallback(async (id, title) => {
    try {
      await apiFetch(`/api/chat/chats/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      });
      await refreshChatList();
    } catch (e) {
      console.error('[AiChat] Failed to rename chat:', e);
    }
  }, [apiFetch, refreshChatList]);

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

      lastSentTextRef.current = text;
      lastSentFilesRef.current = files || null;
      chat.sendMessage({ text: text || ' ', files: files?.length ? files : undefined });
    },
    [chat.sendMessage, currentChatId, createChatOnServer, renameChat],
  );

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
      messagesLoading,
      messagesError,
      retryLoadMessages,
      usageLimitReached,
      draftText,
      clearDraft: () => setDraftText(''),
      draftFiles,
      clearDraftFiles: () => setDraftFiles(null),
    }),
    [chat, sendMessage, currentChatId, chatList, createChat, selectChat, deleteChat, renameChat, refreshChatList, messagesLoading, messagesError, retryLoadMessages, usageLimitReached, draftText, draftFiles],
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
