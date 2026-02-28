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

  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  // Chat ID & list state
  const [currentChatId, setCurrentChatId] = useState(null);
  const [chatList, setChatList] = useState([]);
  const [chatListLoaded, setChatListLoaded] = useState(false);
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
  useEffect(() => { chatIdRef.current = currentChatId; }, [currentChatId]);

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
  }), []);

  // Single Chat instance — never pass `id` so useChat doesn't recreate it
  const chat = useChat({ transport });

  // ── Load messages when chat changes ──────────────────────────────────────

  useEffect(() => {
    if (!currentChatId) {
      chat.setMessages([]);
      return;
    }
    let cancelled = false;
    apiFetch(`/api/chat/chats/${currentChatId}`).then(async (res) => {
      if (cancelled) return;
      if (res.ok) {
        const data = await res.json();
        chat.setMessages(data.messages || []);
      } else {
        chat.setMessages([]);
      }
    }).catch(() => {
      if (!cancelled) chat.setMessages([]);
    });
    return () => { cancelled = true; };
  }, [currentChatId, apiFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load chat list on mount (once we have a token)
  useEffect(() => {
    if (!accessToken || chatListLoaded) return;
    setChatListLoaded(true);
    refreshChatList().then((list) => {
      // Auto-select the most recent chat, or leave empty
      if (list.length > 0) {
        setCurrentChatId(list[0].id);
      }
    });
  }, [accessToken, chatListLoaded, refreshChatList]);

  // ── Auto-title on first assistant response ───────────────────────────────

  useEffect(() => {
    if (!currentChatId || titleSetRef.current.has(currentChatId)) return;
    // Find the first user message and check if there's at least one assistant message
    const userMsg = chat.messages?.find((m) => m.role === 'user');
    const assistantMsg = chat.messages?.find((m) => m.role === 'assistant');
    if (!userMsg || !assistantMsg) return;

    // Check if this chat already has a title in the list
    const existing = chatList.find((c) => c.id === currentChatId);
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
  }, [currentChatId, chat.messages, chatList, apiFetch, refreshChatList]);

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
    }),
    [chat, sendMessage, currentChatId, chatList, createChat, selectChat, deleteChat, renameChat, refreshChatList],
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
