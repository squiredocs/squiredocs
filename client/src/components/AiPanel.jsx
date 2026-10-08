import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useByok } from '../contexts/ByokContext';
import { useMobile } from '../hooks/useMobile';
import { useResizeHandle } from '../hooks/useResizeHandle';
import AiChatBody from './AiChatBody';
import AiChatInput from './AiChatInput';
import AiChatHistory from './AiChatHistory';
import AssistantSetupState from './AssistantSetupState';
import ChatFontSizeControl from './ChatFontSizeControl';
import { useChatFontScale } from '../hooks/useChatFontScale';
import { PlusIcon, ListIcon, ChevronLeftIcon, ChatBubbleIcon, CloseIcon, LayoutBottomIcon, LayoutRightIcon } from './icons';
import { getGreeting } from '../utils/greeting';
import { spaNavigate } from '../utils/navigation';
import './AiPanel.css';

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const MIN_HEIGHT = 200;

function AiPanel({ aiPanel, aiChat, onNavigateToChat, onNavigateToDoc, docGuid }) {
  const byok = useByok();
  const isByok = !!byok.settings?.enabled;
  const { accentColor } = byok;

  // Header title. For a BYOK user the parenthetical names the model they chose
  // (registry label, already carried by the BYOK settings payload) instead of the
  // old literal "(BYOK)" marker — the model name IS the BYOK signal, so there's no
  // second badge; the tooltip below is what still spells out "your own key".
  // Shared-key users keep the plain title with no parenthetical.
  // `activeModelLabel` is null while settings load and when the stored model key
  // isn't in the registry, so the plain title doubles as the graceful fallback —
  // we never render "(undefined)" or a guessed model.
  const byokModelLabel = isByok ? byok.activeModelLabel : null;
  const panelTitle = byokModelLabel
    ? `Squire Docs Assistant (${byokModelLabel})`
    : 'Squire Docs Assistant';
  // One tooltip does double duty: the full title when a long label is ellipsized
  // in the narrow docked panel, plus the BYOK explanation.
  const panelTitleTooltip = byokModelLabel
    ? `${panelTitle} — running on your own API key`
    : undefined;
  const {
    isOpen, close,
    position, setPosition,
    widthPx, updateWidth,
    heightPx, updateHeight,
  } = aiPanel;

  const { messages, sendMessage, status, stop, error, errorInfo, interruptionReason, usageLimitReached, reconnecting, draftText, clearDraft, draftFiles, clearDraftFiles, getChatDraft, saveChatDraft, currentChatId, chatList, messagesLoading, messagesError, retryLoadMessages, retryLastMessage, pendingRefs, removeSelectionRef } = aiChat || {};

  const currentChatTitle = chatList?.find((c) => c.id === currentChatId)?.title;

  const { user } = useAuth();
  const chatFont = useChatFontScale();
  const isMobile = useMobile();
  const panelRef = useRef(null);
  const chatInputRef = useRef(null);
  const [showHistory, setShowHistory] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Clicking a document link in the chat navigates to that doc. On mobile the
  // panel is a full-screen overlay, so close it too — otherwise the chat stays
  // on top of the document the user just asked to see.
  const handleDocLinkClick = useCallback((linkedDocGuid) => {
    if (onNavigateToDoc) {
      onNavigateToDoc(linkedDocGuid);
    } else {
      spaNavigate(`/d/${linkedDocGuid}`);
    }
    if (isMobile) close();
  }, [onNavigateToDoc, isMobile, close]);

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
    ? {
        className: `ai-panel-mobile${byokClass}`,
        style: { '--chat-font-scale': chatFont.fontScale },
      }
    : {
        className: `ai-panel ai-panel--${position}${byokClass}`,
        style: {
          '--chat-font-scale': chatFont.fontScale,
          ...(isRight
            ? { '--ai-panel-width': `${widthPx}px` }
            : { '--ai-panel-height': `${heightPx}px` }),
        },
      };

  const iconSize = isMobile ? 18 : 16;

  const panelJsx = (
    <WrapperTag ref={panelRef} {...wrapperProps} onDragOver={handleDragOver} onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isDragOver && <div className="ai-panel-drop-overlay">Drop files here</div>}
      {/* Resize handle (desktop only) */}
      {!isMobile && (
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
      <div className="panel-header ai-panel-header">
        <div className="ai-panel-title-group">
          <span className="ai-panel-title" title={panelTitleTooltip}>{panelTitle}</span>
          {currentChatTitle && (
            <span className="ai-panel-chat-title">{currentChatTitle}</span>
          )}
        </div>
        <div className="ai-panel-header-actions">
          {showHistory ? (
            <button className="icon-btn" onClick={() => setShowHistory(false)} aria-label="Back to chat" title="Back to chat">
              <ChevronLeftIcon size={iconSize} />
            </button>
          ) : (
            <>
              <button className="icon-btn" onClick={() => { aiChat.createChat(); chatInputRef.current?.focus(); }} aria-label="New chat" title="New chat">
                <PlusIcon size={iconSize} />
              </button>
              <button className="icon-btn" onClick={() => setShowHistory(true)} aria-label="Chat history" title="Chat history">
                <ListIcon size={iconSize} />
              </button>
              <ChatFontSizeControl {...chatFont} />
              {!isMobile && onNavigateToChat && (
                <button className="icon-btn" onClick={onNavigateToChat} aria-label="Open chat view" title="Open chat view">
                  <ChatBubbleIcon size={iconSize} />
                </button>
              )}
              {!isMobile && (
                <button className="icon-btn" onClick={handlePositionToggle} aria-label={isRight ? 'Move to bottom' : 'Move to right'} title={isRight ? 'Move to bottom' : 'Move to right'}>
                  {isRight ? <LayoutBottomIcon size={iconSize} /> : <LayoutRightIcon size={iconSize} />}
                </button>
              )}
            </>
          )}
          <button className="icon-btn" onClick={close} aria-label="Close">
            <CloseIcon size={iconSize} />
          </button>
        </div>
      </div>
      {showHistory ? (
        <AiChatHistory aiChat={aiChat} onBack={() => setShowHistory(false)} />
      ) : (
        <>
          {/* No usable key (self-hosted, no server key, no BYOK): the setup state
              replaces the composer, so nothing can be sent. Earlier messages, if
              any, stay readable above it. */}
          {(!byok.assistantUnavailable || !isEmpty) && (
            <AiChatBody
              messages={messages} status={status}
              messagesLoading={messagesLoading} messagesError={messagesError}
              retryLoadMessages={retryLoadMessages}
              usageLimitReached={usageLimitReached} error={error}
              errorInfo={errorInfo} interruptionReason={interruptionReason}
              onRetry={retryLastMessage} reconnecting={reconnecting}
              greeting={getGreeting(user?.name)} accentColor={accentColor}
              onDocLinkClick={handleDocLinkClick}
            />
          )}
          {byok.assistantUnavailable ? (
            <AssistantSetupState isAdmin={!!user?.isAdmin} compact={!isEmpty} onNavigate={isMobile ? close : undefined} />
          ) : (
            <AiChatInput key={currentChatId || '__new__'} ref={chatInputRef} onSend={sendMessage} onStop={stop} isStreaming={isStreaming} autoFocus placeholder={isEmpty ? 'How can I help you?' : 'Reply...'} draftText={draftText} onDraftConsumed={clearDraft} draftFiles={draftFiles} onDraftFilesConsumed={clearDraftFiles} chatId={currentChatId} getChatDraft={getChatDraft} saveChatDraft={saveChatDraft} pendingRefs={pendingRefs} onRemoveRef={removeSelectionRef} canAttachImages={byok.canAttachImages} imageModelLabel={byok.activeModelLabel} />
          )}
        </>
      )}
    </WrapperTag>
  );

  return panelJsx;
}

export default AiPanel;
