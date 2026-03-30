import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAiChat } from '../contexts/AiChatContext';
import { useAuth } from '../contexts/AuthContext';
import { useByok } from '../contexts/ByokContext';
import AiChatBody from '../components/AiChatBody';
import AiChatInput from '../components/AiChatInput';
import AiChatHistory from '../components/AiChatHistory';
import DocSidePane from '../components/DocSidePane';
import UserProfileBadge from '../components/UserProfileBadge';
import Logo from '../components/Logo';
import './ChatPage.css';

function ChatPage({ user, onNavigateHome, onNavigateToSettings }) {
  const aiChat = useAiChat();
  const { logout } = useAuth();
  const { accentColor } = useByok();
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
            <Logo size={24} color={accentColor} />
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
        <AiChatBody
          messages={messages} status={status}
          messagesLoading={messagesLoading} messagesError={messagesError}
          retryLoadMessages={retryLoadMessages}
          usageLimitReached={usageLimitReached} error={error}
          greeting="How can I help you?" accentColor={accentColor}
          iconSize={48} onDocLinkClick={handleDocLinkClick}
        />
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
