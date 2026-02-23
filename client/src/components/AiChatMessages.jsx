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

  return (
    <div className="ai-chat-messages" ref={scrollRef}>
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`ai-chat-bubble ai-chat-bubble--${msg.role}`}
        >
          {msg.content}
          {msg.status === 'streaming' && <TypingIndicator />}
        </div>
      ))}
    </div>
  );
}

export default AiChatMessages;
