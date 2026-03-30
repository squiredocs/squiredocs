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
import ViewToggleButton from '../components/ViewToggleButton';
import { shouldUseBrowserLinkBehavior } from '../utils/linkBehavior';
import { getGreeting } from '../utils/greeting';
import './ChatPage.css';

function ChatPage({ user, onNavigateHome, onNavigateToSettings, onNavigateToDoc, onNavigateBack, initialDocGuid }) {
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

  // Side pane state — initialized from prop (e.g. the last-viewed doc when toggling from editor)
  const [sidePaneDocGuid, setSidePaneDocGuid] = useState(initialDocGuid || null);

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
    onNavigateToDoc(docGuid);
  }, [onNavigateToDoc]);

  const handleHomeClick = (e) => {
    if (shouldUseBrowserLinkBehavior(e)) return;
    e.preventDefault();
    onNavigateHome();
  };

  return (
    <div className={`chat-page${sidePaneDocGuid ? ' chat-page--with-doc' : ''}`}>
      <header className="app-header">
        <div className="app-header-content">
          <div className="app-header-left">
            <a href="/docs" className="back-btn" onClick={handleHomeClick}>
              <Logo />
            </a>
            <h1>Squire Docs</h1>
          </div>
          <div className="app-header-right">
            <ViewToggleButton onClick={() => onNavigateBack(sidePaneDocGuid)} />
            <UserProfileBadge user={user} onLogout={logout} onNavigateToSettings={onNavigateToSettings} />
          </div>
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
          greeting={getGreeting(user?.name)} accentColor={accentColor}
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
