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
  const [showHistory, setShowHistory] = useState(false);

  const {
    messages, sendMessage, status, stop, error,
    usageLimitReached, draftText, clearDraft, draftFiles, clearDraftFiles,
    messagesLoading, messagesError, retryLoadMessages, retryLastMessage,
    setDocGuidOverride,
  } = aiChat;

  const isStreaming = status === 'submitted' || status === 'streaming';
  const isEmpty = messages.length === 0;

  // Side pane state — initialized from prop or restored from session
  const [sidePaneDocGuid, _setSidePaneDocGuid] = useState(
    () => initialDocGuid || sessionStorage.getItem('chat_side_pane_doc') || null
  );
  const setSidePaneDocGuid = useCallback((guid) => {
    _setSidePaneDocGuid(guid);
    if (guid) sessionStorage.setItem('chat_side_pane_doc', guid);
    else sessionStorage.removeItem('chat_side_pane_doc');
  }, []);

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

      <main className="chat-page-main">
        <div className="chat-page-toolbar">
          <button
            className="icon-btn"
            onClick={() => { aiChat.createChat(); setShowHistory(false); chatInputRef.current?.focus(); }}
            aria-label="New chat"
            title="New chat"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowHistory(h => !h)}
            aria-label="Chat history"
            title="Chat history"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
        </div>
        {showHistory ? (
          <AiChatHistory aiChat={aiChat} onBack={() => setShowHistory(false)} />
        ) : (
          <>
            <AiChatBody
              messages={messages} status={status}
              messagesLoading={messagesLoading} messagesError={messagesError}
              retryLoadMessages={retryLoadMessages}
              usageLimitReached={usageLimitReached} error={error}
              onRetry={retryLastMessage}
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
          </>
        )}
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
