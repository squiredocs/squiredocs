import React from 'react';
import AiChatMessages from './AiChatMessages';
import { MESSAGES, RETRYABLE_CODES } from '../utils/chatErrorMessages';
import './AiChatBody.css';

/**
 * Shared chat body: loading → error → empty welcome → messages, plus the
 * usage-limit / interruption / error banners beneath. Both surfaces (side panel +
 * full page) render error copy from the same code→message map (feature 012), so
 * they're identical by construction (SC-002).
 *
 * Every banner renders from the DURABLE turn-error props only (feature 025,
 * FR-008): `errorInfo` is the classified { code, provider, text }, `usageLimitReached`
 * and `interruptionReason` are derivations of the same state, and the transient
 * `reconnecting` flag is subordinate — it may show while a recovery attempt is in
 * flight but can never suppress a durable failure banner once the attempt concludes
 * (D7). SDK stream `status`/`error` are NEVER a render gate here.
 */
function AiChatBody({
  messages, status, messagesLoading, messagesError, retryLoadMessages,
  usageLimitReached, errorInfo, interruptionReason, onRetry, reconnecting,
  greeting, accentColor, iconSize = 40, onDocLinkClick,
}) {
  const isEmpty = messages.length === 0;
  // Retry only where retrying can plausibly help (D4); other codes point at the
  // fixing action instead. Unknown/absent code falls back to the generic message.
  const canRetry = !!(onRetry && errorInfo && RETRYABLE_CODES.has(errorInfo.code));

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
          {MESSAGES.app_usage_limit.text} <a href="/settings">View Usage</a>
        </div>
      ) : (
        <>
          {/* Interrupted partial reply: the notice sits ABOVE the failure banner
              (US5), both derived from the same durable record so they survive
              reloads. */}
          {interruptionReason && (
            <div className="ai-chat-body-interrupted">Response interrupted: {interruptionReason}</div>
          )}
          {/* The durable failure banner: rendered whenever a classified turn error
              exists, regardless of SDK stream status (FR-008). The reconnecting
              indicator only shows while an attempt is genuinely in flight (no
              durable error yet) and yields to the banner the moment it concludes
              with a failure (D7/M3). */}
          {errorInfo ? (
            <div className="ai-chat-body-error">
              {errorInfo.text || 'Something went wrong. Please try again.'}
              {MESSAGES[errorInfo.code]?.action === 'settings' ? (
                <a className="ai-chat-body-error-link" href="/settings">Open Settings</a>
              ) : null}
              {canRetry && <button className="ai-chat-body-retry-btn" onClick={onRetry}>Retry</button>}
            </div>
          ) : reconnecting ? (
            <div className="ai-chat-body-reconnecting">Reconnecting…</div>
          ) : null}
        </>
      )}
    </>
  );
}

export default AiChatBody;
