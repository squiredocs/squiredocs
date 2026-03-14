import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useMobile } from '../hooks/useMobile';
import { useResizeHandle } from '../hooks/useResizeHandle';
import AiChatMessages from './AiChatMessages';
import AiChatInput from './AiChatInput';
import AiChatHistory from './AiChatHistory';
import WindowPortal from './WindowPortal';
import './AiPanel.css';

function getGreeting(name) {
  const h = new Date().getHours();
  const timeOfDay = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = name?.split(' ')[0];
  return firstName ? `${timeOfDay}, ${firstName}` : timeOfDay;
}

const TypingDots = () => (
  <div className="ai-typing-indicator">
    <span className="ai-typing-dot" />
    <span className="ai-typing-dot" />
    <span className="ai-typing-dot" />
  </div>
);

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const MIN_HEIGHT = 200;

const PROVIDER_LABELS = { anthropic: 'Anthropic', google: 'Gemini' };

function AiPanel({ aiPanel, aiChat, isByok, byokProvider }) {
  const {
    isOpen, close,
    position, setPosition,
    widthPx, updateWidth,
    heightPx, updateHeight,
    isPoppedOut, popOut, popIn, setPopupWindow,
  } = aiPanel;

  const { messages, sendMessage, status, stop, error, usageLimitReached, draftText, clearDraft, draftFiles, clearDraftFiles, currentChatId, chatList, messagesLoading, messagesError, retryLoadMessages } = aiChat || {};

  const currentChatTitle = chatList?.find((c) => c.id === currentChatId)?.title;

  const { user } = useAuth();
  const isMobile = useMobile();
  const panelRef = useRef(null);
  const chatInputRef = useRef(null);
  const [showHistory, setShowHistory] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
  }, []);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer.files?.length) {
      chatInputRef.current?.addFiles(e.dataTransfer.files);
    }
  }, []);

  // Streaming state: disable send when AI is responding
  const isStreaming = status === 'streaming' || status === 'submitted';
  const isEmpty = !messages || messages.length === 0;

  // Mobile: shrink panel to the visual viewport height so content stays above
  // the on-screen keyboard.  A CSS ::before pseudo-element keeps a full-screen
  // white backdrop behind the shortened panel to hide the document through the
  // translucent iOS keyboard glass.
  // On Android, `interactive-widget=resizes-content` in the viewport meta tag
  // handles this via CSS, making these updates a no-op (keyboard height ≈ 0).
  useEffect(() => {
    if (!isMobile || !isOpen) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const sync = () => {
      const el = panelRef.current;
      if (!el) return;
      el.style.height = `${vv.height}px`;
      el.style.top = `${vv.offsetTop}px`;
    };

    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();

    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, [isMobile, isOpen]);

  // Desktop max height tracks window resize
  const [maxHeight, setMaxHeight] = useState(() =>
    typeof window !== 'undefined' ? Math.floor(window.innerHeight * 0.8) : 600
  );

  useEffect(() => {
    const onResize = () => setMaxHeight(Math.floor(window.innerHeight * 0.8));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Resize handles
  const widthResize = useResizeHandle('horizontal', updateWidth, MIN_WIDTH, MAX_WIDTH);
  const heightResize = useResizeHandle('vertical', updateHeight, MIN_HEIGHT, maxHeight);

  const handlePositionToggle = useCallback(() => {
    setPosition(position === 'right' ? 'bottom' : 'right');
  }, [position, setPosition]);

  if (!isOpen) return null;

  const isRight = position === 'right';
  const byokClass = isByok ? ' ai-panel--byok' : '';
  const WrapperTag = isMobile ? 'div' : 'aside';
  const wrapperProps = isMobile
    ? { className: `ai-panel-mobile${byokClass}` }
    : isPoppedOut
      ? { className: `ai-panel ai-panel--popup${byokClass}` }
      : {
          className: `ai-panel ai-panel--${position}${byokClass}`,
          style: isRight
            ? { '--ai-panel-width': `${widthPx}px` }
            : { '--ai-panel-height': `${heightPx}px` },
        };

  const closeSize = isMobile ? 18 : 16;
  const closeButton = (
    <button className="ai-panel-close-btn" onClick={close} aria-label="Close">
      <svg width={closeSize} height={closeSize} viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
      </svg>
    </button>
  );

  const panelJsx = (
    <WrapperTag ref={panelRef} {...wrapperProps} onDragOver={handleDragOver} onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isDragOver && <div className="ai-panel-drop-overlay">Drop image here</div>}
      {/* Resize handle (desktop only, not when popped out) */}
      {!isMobile && !isPoppedOut && (
        <div
          className={`ai-panel-resize-handle ai-panel-resize-handle--${isRight ? 'left' : 'top'}`}
          onMouseDown={(e) => isRight
            ? widthResize.handleMouseDown(e, widthPx)
            : heightResize.handleMouseDown(e, heightPx)
          }
          onTouchStart={(e) => isRight
            ? widthResize.handleTouchStart(e, widthPx)
            : heightResize.handleTouchStart(e, heightPx)
          }
        />
      )}
      <div className="ai-panel-header">
        <div className="ai-panel-title-group">
          <span className="ai-panel-title">{isByok ? 'Squire Docs Assistant (BYOK)' : 'Squire Docs Assistant'}</span>
          {currentChatTitle && (
            <span className="ai-panel-chat-title">{currentChatTitle}</span>
          )}
        </div>
        <div className="ai-panel-header-actions">
          {(() => {
            const iconSize = isMobile ? 18 : 16;
            return showHistory ? (
              <button
                className="ai-panel-position-btn"
                onClick={() => setShowHistory(false)}
                aria-label="Back to chat"
                title="Back to chat"
              >
                <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            ) : (
              <>
                <button
                  className="ai-panel-position-btn"
                  onClick={() => { aiChat.createChat(); chatInputRef.current?.focus(); }}
                  aria-label="New chat"
                  title="New chat"
                >
                  <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button
                  className="ai-panel-position-btn"
                  onClick={() => setShowHistory(true)}
                  aria-label="Chat history"
                  title="Chat history"
                >
                  <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                </button>
                {!isMobile && (isPoppedOut ? (
                  <button
                    className="ai-panel-position-btn"
                    onClick={popIn}
                    aria-label="Dock panel"
                    title="Dock panel"
                  >
                    <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 10 4 15 9 20" />
                      <path d="M20 4v7a4 4 0 01-4 4H4" />
                    </svg>
                  </button>
                ) : (
                  <>
                    <button
                      className="ai-panel-popout-btn"
                      onClick={popOut}
                      aria-label="Pop out"
                      title="Pop out to window"
                    >
                      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </button>
                    <button
                      className="ai-panel-position-btn"
                      onClick={handlePositionToggle}
                      aria-label={isRight ? 'Move to bottom' : 'Move to right'}
                      title={isRight ? 'Move to bottom' : 'Move to right'}
                    >
                      {isRight ? (
                        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <line x1="3" y1="15" x2="21" y2="15" />
                        </svg>
                      ) : (
                        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <line x1="15" y1="3" x2="15" y2="21" />
                        </svg>
                      )}
                    </button>
                  </>
                ))}
              </>
            );
          })()}
          {closeButton}
        </div>
      </div>
      {showHistory ? (
        <AiChatHistory aiChat={aiChat} onBack={() => setShowHistory(false)} />
      ) : (
        <>
          {messagesLoading ? (
            <div className="ai-panel-welcome">
              <TypingDots />
            </div>
          ) : messagesError ? (
            <div className="ai-panel-welcome">
              <p className="ai-chat-welcome-text">{messagesError}</p>
              <button className="ai-panel-retry-btn" onClick={retryLoadMessages}>Retry</button>
            </div>
          ) : isEmpty ? (
            <div className="ai-panel-welcome">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={isByok ? '#312e81' : '#7c3aed'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z" />
              </svg>
              <p className="ai-chat-welcome-text">{getGreeting(user?.name)}</p>
            </div>
          ) : (
            <AiChatMessages messages={messages} status={status} />
          )}
          {usageLimitReached ? (
            <div className="ai-panel-usage-limit">
              You've reached your AI usage limit for this month. <a href="/settings" className="ai-panel-usage-limit-link">View Usage</a>
            </div>
          ) : status === 'error' && error && (
            <div className="ai-panel-error">
              {isByok && error.message ? `${PROVIDER_LABELS[byokProvider] || 'API'} API error: ${error.message}` : 'Something went wrong. Please try again.'}
            </div>
          )}
          <AiChatInput ref={chatInputRef} onSend={sendMessage} onStop={stop} isStreaming={isStreaming} autoFocus placeholder={isEmpty ? 'How can I help you?' : 'Reply...'} draftText={draftText} onDraftConsumed={clearDraft} draftFiles={draftFiles} onDraftFilesConsumed={clearDraftFiles} />
        </>
      )}
    </WrapperTag>
  );

  if (isPoppedOut) {
    return (
      <WindowPortal onOpen={setPopupWindow} onClose={close}>
        {panelJsx}
      </WindowPortal>
    );
  }

  return panelJsx;
}

export default AiPanel;
