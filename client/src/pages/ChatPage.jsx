import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAiChat } from '../contexts/AiChatContext';
import { useAuth } from '../contexts/AuthContext';
import { useByok } from '../contexts/ByokContext';
import AiChatMessages from '../components/AiChatMessages';
import AiChatInput from '../components/AiChatInput';
import AiChatHistory from '../components/AiChatHistory';
import DocSidePane from '../components/DocSidePane';
import UserProfileBadge from '../components/UserProfileBadge';
import Logo from '../components/Logo';
import './ChatPage.css';

function ChatPage({ user, onNavigateHome, onNavigateToSettings }) {
  const aiChat = useAiChat();
  const { logout } = useAuth();
  const byok = useByok();
  const isByok = !!byok.settings?.enabled;
  const chatInputRef = useRef(null);

  const {
    messages, sendMessage, status, stop, error,
    usageLimitReached, draftText, clearDraft, draftFiles, clearDraftFiles,
    messagesLoading, messagesError, retryLoadMessages,
    setDocGuidOverride,
  } = aiChat;

  const isStreaming = status === 'submitted' || status === 'streaming';
  const isEmpty = messages.length === 0;

  // Side pane state
  const [sidePaneDocGuid, setSidePaneDocGuid] = useState(null);

  // Keep the AI context aware of which doc is in the side pane
  useEffect(() => {
    setDocGuidOverride(sidePaneDocGuid);
    return () => setDocGuidOverride(null);
  }, [sidePaneDocGuid, setDocGuidOverride]);

  const handleDocLinkClick = useCallback((docGuid) => {
    setSidePaneDocGuid(docGuid);
    // Also set synchronously for immediate sends
    setDocGuidOverride(docGuid);
  }, [setDocGuidOverride]);

  const handleCloseSidePane = useCallback(() => {
    setSidePaneDocGuid(null);
  }, []);

  const handleOpenFull = useCallback((docGuid) => {
    window.history.pushState({}, '', `/d/${docGuid}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);

  return (
    <div className={`chat-page${sidePaneDocGuid ? ' chat-page--with-doc' : ''}`}>
      <header className="chat-page-header">
        <div className="chat-page-header-left">
          <a href="/docs" className="chat-page-logo" onClick={(e) => { e.preventDefault(); onNavigateHome(); }}>
            <Logo size={24} color={isByok ? '#312e81' : '#7c3aed'} />
            <span className="chat-page-logo-text">Squire</span>
          </a>
        </div>
        <div className="chat-page-header-right">
          <UserProfileBadge user={user} onLogout={logout} onNavigateToSettings={onNavigateToSettings} />
        </div>
      </header>

      <aside className="chat-page-sidebar">
        <AiChatHistory aiChat={aiChat} onBack={() => {}} />
      </aside>

      <main className="chat-page-main">
        {messagesLoading ? (
          <div className="chat-page-welcome">
            <div className="ai-typing-indicator">
              <span className="ai-typing-dot" />
              <span className="ai-typing-dot" />
              <span className="ai-typing-dot" />
            </div>
          </div>
        ) : messagesError ? (
          <div className="chat-page-welcome">
            <p className="chat-page-welcome-text">{messagesError}</p>
            <button className="chat-page-retry-btn" onClick={retryLoadMessages}>Retry</button>
          </div>
        ) : isEmpty ? (
          <div className="chat-page-welcome">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={isByok ? '#312e81' : '#7c3aed'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
              <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z" />
            </svg>
            <p className="chat-page-welcome-text">How can I help you?</p>
          </div>
        ) : (
          <AiChatMessages messages={messages} status={status} onDocLinkClick={handleDocLinkClick} />
        )}
        {usageLimitReached ? (
          <div className="chat-page-usage-limit">
            You've reached your AI usage limit for this month. <a href="/settings">View Usage</a>
          </div>
        ) : status === 'error' && error && (
          <div className="chat-page-error">
            Something went wrong. Please try again.
          </div>
        )}
        <div className="chat-page-input-wrap">
          <AiChatInput
            ref={chatInputRef}
            onSend={sendMessage}
            onStop={stop}
            isStreaming={isStreaming}
            autoFocus
            placeholder={isEmpty ? 'How can I help you?' : 'Reply...'}
            draftText={draftText}
            onDraftConsumed={clearDraft}
            draftFiles={draftFiles}
            onDraftFilesConsumed={clearDraftFiles}
          />
        </div>
      </main>

      {sidePaneDocGuid && (
        <DocSidePane
          key={sidePaneDocGuid}
          docGuid={sidePaneDocGuid}
          user={user}
          onClose={handleCloseSidePane}
          onOpenFull={handleOpenFull}
        />
      )}
    </div>
  );
}

export default ChatPage;
