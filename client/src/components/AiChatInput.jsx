import React, { useState, useRef, useCallback, useEffect } from 'react';

function AiChatInput({ onSend, onStop, isStreaming, placeholder, autoFocus, draftText, onDraftConsumed }) {
  const [value, setValue] = useState('');
  const textareaRef = useRef(null);

  // Restore draft text on error
  useEffect(() => {
    if (draftText) {
      setValue(draftText);
      onDraftConsumed?.();
    }
  }, [draftText, onDraftConsumed]);

  const handleInput = useCallback((e) => {
    setValue(e.target.value);
    // Auto-resize
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setValue('');
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, isStreaming, onSend]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const isEmpty = value.trim() === '';

  return (
    <div className="ai-chat-input">
      <textarea
        ref={textareaRef}
        className="ai-chat-textarea"
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={2}
      />
      {isStreaming ? (
        <button
          className="ai-chat-send-btn ai-chat-stop-btn"
          onClick={onStop}
          aria-label="Stop"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </button>
      ) : (
        <button
          className="ai-chat-send-btn"
          onClick={handleSend}
          disabled={isEmpty}
          aria-label="Send message"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default AiChatInput;
