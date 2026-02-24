import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useMobile } from '../hooks/useMobile';
import { useResizeHandle } from '../hooks/useResizeHandle';
import AiChatMessages from './AiChatMessages';
import AiChatInput from './AiChatInput';
import WindowPortal from './WindowPortal';
import './AiPanel.css';

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const MIN_HEIGHT = 200;

function AiPanel({ aiPanel }) {
  const {
    isOpen, close,
    position, setPosition,
    widthPx, updateWidth,
    heightPx, updateHeight,
    messages, sendMessage,
    isPoppedOut, popOut, popIn, setPopupWindow,
  } = aiPanel;

  const isMobile = useMobile();
  const panelRef = useRef(null);

  // Streaming state: disable send when last message is streaming
  const lastMsg = messages[messages.length - 1];
  const isStreaming = lastMsg?.status === 'streaming';
  const isEmpty = messages.length === 0;

  // Mobile: shrink panel to visual viewport height so it stays above the keyboard
  useEffect(() => {
    if (!isMobile || !isOpen) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const el = panelRef.current;
      if (!el) return;
      // Keep panel full-screen but pad the bottom so content stays above keyboard
      const keyboardHeight = window.innerHeight - vv.height - vv.offsetTop;
      el.style.paddingBottom = keyboardHeight > 50 ? keyboardHeight + 'px' : '0px';
    };

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
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
        <span className="ai-panel-title">AI Assistant</span>
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
        <div className="ai-panel-body ai-panel-body--empty">
          <div className="ai-chat-welcome">
            <div className="ai-chat-welcome-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z" />
              </svg>
            </div>
            <p className="ai-chat-welcome-text">Your AI writing partner</p>
          </div>
          {isMobile && <AiChatInput onSend={sendMessage} disabled={isStreaming} />}
        </div>
      ) : (
        <div className="ai-panel-body ai-panel-body--active">
          <AiChatMessages messages={messages} />
          {isMobile && <AiChatInput onSend={sendMessage} disabled={isStreaming} />}
        </div>
      )}
      {!isMobile && <AiChatInput onSend={sendMessage} disabled={isStreaming} />}
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
