import React, { useEffect, useRef } from 'react';

function TypingIndicator() {
  return (
    <span className="ai-typing-indicator">
      <span className="ai-typing-dot" />
      <span className="ai-typing-dot" />
      <span className="ai-typing-dot" />
    </span>
  );
}

function AiChatMessages({ messages }) {
  const scrollRef = useRef(null);

  // Auto-scroll when messages change or streaming status updates
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="ai-chat-messages" ref={scrollRef}>
        <div className="ai-chat-empty">
          <div className="ai-chat-empty-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <circle cx="9" cy="9" r="1" fill="#9ca3af" stroke="none" />
              <circle cx="15" cy="9" r="1" fill="#9ca3af" stroke="none" />
            </svg>
          </div>
          <p>Ask about your document...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-chat-messages" ref={scrollRef}>
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`ai-chat-bubble ai-chat-bubble--${msg.role}`}
        >
          {msg.content}
          {msg.status === 'streaming' && msg.content === '' && <TypingIndicator />}
          {msg.status === 'streaming' && msg.content !== '' && (
            <TypingIndicator />
          )}
        </div>
      ))}
    </div>
  );
}

export default AiChatMessages;
