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
  const [currentChatId, setCurrentChatId] = useState(null);
  const [chatList, setChatList] = useState([]);
  const chatListLoadedRef = useRef(false);
  const titleSetRef = useRef(new Set()); // track which chats already have titles

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
  chatIdRef.current = currentChatId;

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

  // Track last sent text so we can restore it on error
  const lastSentTextRef = useRef('');
  const [draftText, setDraftText] = useState('');

  // Single Chat instance — never pass `id` so useChat doesn't recreate it
  const chat = useChat({
    transport,
    onError: (error) => {
      // Restore the user's message to the input
      if (lastSentTextRef.current) {
        setDraftText(lastSentTextRef.current);
        lastSentTextRef.current = '';
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
      // Auto-select the most recent chat, or leave empty
      if (list.length > 0) {
        setCurrentChatId(list[0].id);
      }
    });
  }, [accessToken, refreshChatList]);

  // ── Auto-title on first assistant response ───────────────────────────────
  // Fire only when a stream completes (status transitions to 'ready'),
  // not on every streaming token update. Messages and chatList are read
  // from refs so this effect doesn't re-run on every streaming token.

  const messagesRef = useRef(chat.messages);
  messagesRef.current = chat.messages;
  const chatListRef = useRef(chatList);
  chatListRef.current = chatList;

  const prevStatusRef = useRef(chat.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = chat.status;

    // Only act when stream just finished
    if (chat.status !== 'ready' || prev === 'ready') return;
    if (!currentChatId || titleSetRef.current.has(currentChatId)) return;

    const msgs = messagesRef.current;
    const userMsg = msgs?.find((m) => m.role === 'user');
    const assistantMsg = msgs?.find((m) => m.role === 'assistant');
    if (!userMsg || !assistantMsg) return;

    // Check if this chat already has a title in the list
    const existing = chatListRef.current.find((c) => c.id === currentChatId);
    if (existing?.title) {
      titleSetRef.current.add(currentChatId);
      return;
    }

    // Generate title from first user message text
    const firstText = userMsg.parts
      ?.filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join(' ') || '';
    const title = generateTitle(firstText);
    titleSetRef.current.add(currentChatId);

    apiFetch(`/api/chat/chats/${currentChatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }).then(() => refreshChatList()).catch(() => {});
  }, [currentChatId, chat.status, apiFetch, refreshChatList]);

  // ── CRUD operations ──────────────────────────────────────────────────────

  const createChat = useCallback(async () => {
    try {
      const res = await apiFetch('/api/chat/chats', { method: 'POST' });
      if (res.ok) {
        const { id } = await res.json();
        chat.setMessages([]);
        setCurrentChatId(id);
        await refreshChatList();
        return id;
      }
    } catch (e) {
      console.error('[AiChat] Failed to create chat:', e);
    }
    return null;
  }, [apiFetch, refreshChatList, chat.setMessages]);

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
    async (text) => {
      if (!currentChatId) {
        const id = await createChat();
        if (!id) return;
        // chatIdRef is updated synchronously via setCurrentChatId → useEffect,
        // but we need it immediately for the transport. Set it directly.
        chatIdRef.current = id;
      }
      lastSentTextRef.current = text;
      chat.sendMessage({ text });
    },
    [chat.sendMessage, currentChatId, createChat],
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
    }),
    [chat, sendMessage, currentChatId, chatList, createChat, selectChat, deleteChat, renameChat, refreshChatList, messagesLoading, messagesError, retryLoadMessages, usageLimitReached, draftText],
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
