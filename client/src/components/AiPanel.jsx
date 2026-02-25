import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useMobile } from '../hooks/useMobile';
import { useResizeHandle } from '../hooks/useResizeHandle';
import AiChatMessages from './AiChatMessages';
import AiChatInput from './AiChatInput';
import WindowPortal from './WindowPortal';
import './AiPanel.css';

function getGreeting(name) {
  const h = new Date().getHours();
  const timeOfDay = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = name?.split(' ')[0];
  return firstName ? `${timeOfDay}, ${firstName}` : timeOfDay;
}

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const MIN_HEIGHT = 200;

function AiPanel({ aiPanel, aiChat }) {
  const {
    isOpen, close,
    position, setPosition,
    widthPx, updateWidth,
    heightPx, updateHeight,
    isPoppedOut, popOut, popIn, setPopupWindow,
  } = aiPanel;

  const { messages, sendMessage, status, stop } = aiChat || {};

  const { user } = useAuth();
  const isMobile = useMobile();
  const panelRef = useRef(null);

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
  const WrapperTag = isMobile ? 'div' : 'aside';
  const wrapperProps = isMobile
    ? { className: 'ai-panel-mobile' }
    : isPoppedOut
      ? { className: 'ai-panel ai-panel--popup' }
      : {
          className: `ai-panel ai-panel--${position}`,
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
    <WrapperTag ref={panelRef} {...wrapperProps}>
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
        <span className="ai-panel-title">Chat Panel</span>
        {isMobile ? closeButton : (
          <div className="ai-panel-header-actions">
            {isPoppedOut ? (
              /* Pop-in / dock back button */
              <button
                className="ai-panel-position-btn"
                onClick={popIn}
                aria-label="Dock panel"
                title="Dock panel"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 10 4 15 9 20" />
                  <path d="M20 4v7a4 4 0 01-4 4H4" />
                </svg>
              </button>
            ) : (
              <>
                {/* Pop-out button */}
                <button
                  className="ai-panel-popout-btn"
                  onClick={popOut}
                  aria-label="Pop out"
                  title="Pop out to window"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </button>
                {/* Position toggle */}
                <button
                  className="ai-panel-position-btn"
                  onClick={handlePositionToggle}
                  aria-label={isRight ? 'Move to bottom' : 'Move to right'}
                  title={isRight ? 'Move to bottom' : 'Move to right'}
                >
                  {isRight ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <line x1="3" y1="15" x2="21" y2="15" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <line x1="15" y1="3" x2="15" y2="21" />
                    </svg>
                  )}
                </button>
              </>
            )}
            {closeButton}
          </div>
        )}
      </div>
      {isEmpty ? (
        <div className="ai-panel-welcome">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
            <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z" />
          </svg>
          <p className="ai-chat-welcome-text">{getGreeting(user?.name)}</p>
        </div>
      ) : (
        <AiChatMessages messages={messages} status={status} />
      )}
      <AiChatInput onSend={sendMessage} disabled={isStreaming} placeholder={isEmpty ? 'How can I help you?' : 'Reply...'} />
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
