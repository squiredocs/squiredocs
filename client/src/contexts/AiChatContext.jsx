import { createContext, useContext, useRef, useEffect, useMemo } from 'react';
import { DefaultChatTransport } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useAuth } from './AuthContext';

const AiChatContext = createContext(null);

export function AiChatProvider({ children }) {
  const { accessToken } = useAuth();
  const tokenRef = useRef(accessToken);

  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/chat',
    headers: () => {
      const token = tokenRef.current;
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
  }), []);

  const chat = useChat({ transport });

  return (
    <AiChatContext.Provider value={chat}>
      {children}
    </AiChatContext.Provider>
  );
}

export function useAiChat() {
  return useContext(AiChatContext);
}
