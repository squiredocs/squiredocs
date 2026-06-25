import React from 'react';
import AiChatMessages from './AiChatMessages';
import './AiChatBody.css';

/**
 * Shared chat body: loading → error → empty welcome → messages,
 * plus usage-limit and error banners beneath.
 *
 * Used by both AiPanel (side panel) and ChatPage (full-page chat).
 */
function AiChatBody({
  messages, status, messagesLoading, messagesError, retryLoadMessages,
  usageLimitReached, error, errorMessage, onRetry, reconnecting,
  greeting, accentColor, iconSize = 40, onDocLinkClick,
}) {
  const isEmpty = messages.length === 0;

  return (
    <>
      {/* Only show the full-pane loading spinner on a cold load (no prior
          messages). When switching between chats that already have content,
          keep the previous list rendered until the new messages arrive so the
          heavy message DOM isn't torn down and rebuilt mid-switch. */}
      {messagesLoading && isEmpty ? (
        <div className="ai-chat-body-welcome">
          <div className="ai-typing-indicator">
            <span className="ai-typing-dot" />
            <span className="ai-typing-dot" />
            <span className="ai-typing-dot" />
          </div>
        </div>
      ) : messagesError ? (
        <div className="ai-chat-body-welcome">
          <p className="ai-chat-body-welcome-text">{messagesError}</p>
          <button className="ai-chat-body-retry-btn" onClick={retryLoadMessages}>Retry</button>
        </div>
      ) : isEmpty ? (
        <div className="ai-chat-body-welcome">
          <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
            <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z" />
          </svg>
          <p className="ai-chat-body-welcome-text">{greeting}</p>
        </div>
      ) : (
        <AiChatMessages messages={messages} status={status} onDocLinkClick={onDocLinkClick} />
      )}
      {usageLimitReached ? (
        <div className="ai-chat-body-usage-limit">
          You've reached your AI usage limit for this month. <a href="/settings">View Usage</a>
        </div>
      ) : reconnecting ? (
        <div className="ai-chat-body-reconnecting">Reconnecting…</div>
      ) : status === 'error' && error && (
        <div className="ai-chat-body-error">
          {errorMessage || 'Something went wrong. Please try again.'}
          {onRetry && <button className="ai-chat-body-retry-btn" onClick={onRetry}>Retry</button>}
        </div>
      )}
    </>
  );
}

export default AiChatBody;
