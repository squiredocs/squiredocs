import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useMobile } from '../hooks/useMobile';
import { useResizeHandle } from '../hooks/useResizeHandle';
import AiChatMessages from './AiChatMessages';
import AiChatInput from './AiChatInput';
import './AiPanel.css';

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const MIN_HEIGHT = 200;

function AiPanel({ aiPanel }) {
  const {
    isOpen, setIsOpen,
    position, setPosition,
    widthPx, updateWidth,
    heightPx, updateHeight,
    messages, sendMessage,
  } = aiPanel;

  const isMobile = useMobile();
  const panelRef = useRef(null);
  const mobileRef = useRef(null);
  const [transitioning, setTransitioning] = useState(false);

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
      const el = mobileRef.current;
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

  // Desktop open/close transition class
  useEffect(() => {
    if (!isMobile) {
      setTransitioning(true);
      const el = panelRef.current;
      if (!el) {
        const t = setTimeout(() => setTransitioning(false), 250);
        return () => clearTimeout(t);
      }
      const onEnd = () => setTransitioning(false);
      el.addEventListener('transitionend', onEnd);
      return () => el.removeEventListener('transitionend', onEnd);
    }
  }, [isOpen, isMobile]);

  // Desktop max height is 80% of container
  const maxHeight = typeof window !== 'undefined'
    ? Math.floor(window.innerHeight * 0.8)
    : 600;

  // Resize handles
  const widthResize = useResizeHandle('horizontal', updateWidth, MIN_WIDTH, MAX_WIDTH);
  const heightResize = useResizeHandle('vertical', updateHeight, MIN_HEIGHT, maxHeight);

  const handlePositionToggle = useCallback(() => {
    setPosition(position === 'right' ? 'bottom' : 'right');
  }, [position, setPosition]);

  if (!isOpen) return null;

  const welcomeBlock = (
    <div className="ai-chat-welcome">
      <div className="ai-chat-welcome-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z" />
        </svg>
      </div>
      <p className="ai-chat-welcome-text">Your AI writing partner</p>
    </div>
  );

  // Mobile: full-screen takeover — input hugs content (not pinned to bottom)
  if (isMobile) {
    const mobileBody = isEmpty ? (
      <div className="ai-panel-body ai-panel-body--empty">
        {welcomeBlock}
        <AiChatInput onSend={sendMessage} disabled={isStreaming} />
      </div>
    ) : (
      <div className="ai-panel-body ai-panel-body--active">
        <AiChatMessages messages={messages} />
        <AiChatInput onSend={sendMessage} disabled={isStreaming} />
      </div>
    );

    return (
      <div className="ai-panel-mobile" ref={mobileRef}>
        <div className="ai-panel-header">
          <span className="ai-panel-title">AI Assistant</span>
          <button className="ai-panel-close-btn" onClick={() => setIsOpen(false)} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        {mobileBody}
      </div>
    );
  }

  // Desktop: inline panel
  const isRight = position === 'right';
  const cssVars = isRight
    ? { '--ai-panel-width': `${widthPx}px` }
    : { '--ai-panel-height': `${heightPx}px` };

  return (
    <aside
      ref={panelRef}
      className={`ai-panel ai-panel--${position}${transitioning ? ' ai-panel--transitioning' : ''}`}
      style={cssVars}
    >
      {/* Resize handle */}
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
      <div className="ai-panel-header">
        <span className="ai-panel-title">AI Assistant</span>
        <div className="ai-panel-header-actions">
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
          <button className="ai-panel-close-btn" onClick={() => setIsOpen(false)} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      </div>
      {/* Desktop: welcome or messages in the body, input always pinned to bottom */}
      {isEmpty ? (
        <div className="ai-panel-body ai-panel-body--empty">
          {welcomeBlock}
        </div>
      ) : (
        <div className="ai-panel-body ai-panel-body--active">
          <AiChatMessages messages={messages} />
        </div>
      )}
      <AiChatInput onSend={sendMessage} disabled={isStreaming} />
    </aside>
  );
}

export default AiPanel;
