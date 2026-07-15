import React, { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { isImageType } from '../utils/media';

const ACCEPTED_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv',
];
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB
const MAX_FILES = 5;

// Markdown files are intercepted, not attached: on send the raw text goes to
// the REST importer (POST /api/docs/import) and the message carries only the
// returned document reference — the file content never rides model context.
// Browsers report .md as text/markdown, text/plain, or an empty string, so
// detection goes by extension first.
const MARKDOWN_EXTENSIONS = /\.(md|markdown)$/i;
const isMarkdownFile = (f) => MARKDOWN_EXTENSIONS.test(f.name || '') || f.type === 'text/markdown';
const MAX_MARKDOWN_SIZE = 5 * 1024 * 1024; // server-side import cap (MAX_IMPORT_BYTES)

const AiChatInput = forwardRef(function AiChatInput({ onSend, onStop, isStreaming, placeholder, autoFocus, draftText, onDraftConsumed, draftFiles, onDraftFilesConsumed, chatId, getChatDraft, saveChatDraft, pendingRefs, onRemoveRef }, ref) {
  // Seed from the persisted per-chat draft so unsent input survives a panel
  // close/reopen or a chat switch (this component unmounts in both cases). The
  // parent keys us by chatId, so each chat mounts its own instance and these
  // lazy initializers read that chat's saved draft.
  const [value, setValue] = useState(() => getChatDraft?.(chatId)?.text || '');
  const [pendingFiles, setPendingFiles] = useState(() => getChatDraft?.(chatId)?.files || []);
  const [fileError, setFileError] = useState(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  useImperativeHandle(ref, () => ({
    focus() {
      textareaRef.current?.focus();
    },
    addFiles(fileList) {
      processFiles(fileList);
    },
  }));

  // Restore draft text on error
  useEffect(() => {
    if (draftText) {
      setValue(draftText);
      onDraftConsumed?.();
    }
  }, [draftText, onDraftConsumed]);

  // Restore draft files on error
  useEffect(() => {
    if (draftFiles?.length) {
      setPendingFiles(draftFiles);
      onDraftFilesConsumed?.();
    }
  }, [draftFiles, onDraftFilesConsumed]);

  // Persist unsent input to the per-chat draft store on every change. Sending
  // clears value/pendingFiles, which writes an empty draft (i.e. forgets it).
  useEffect(() => {
    saveChatDraft?.(chatId, value, pendingFiles);
  }, [chatId, value, pendingFiles, saveChatDraft]);

  const processFiles = useCallback((fileList) => {
    setFileError(null);
    const files = Array.from(fileList);
    const accepted = files.filter(f => isMarkdownFile(f) || ACCEPTED_TYPES.includes(f.type));
    if (accepted.length === 0 && files.length > 0) {
      setFileError('Unsupported file type. Supported: Markdown, images, PDF, TXT, CSV.');
      return;
    }
    if (accepted.some(f => isMarkdownFile(f) && f.size > MAX_MARKDOWN_SIZE)) {
      setFileError('Markdown files must be under 5MB each.');
      return;
    }
    const oversized = accepted.filter(f => !isMarkdownFile(f) && f.size > MAX_FILE_SIZE);
    if (oversized.length > 0) {
      setFileError('Files must be under 15MB each.');
      return;
    }

    const toAdd = accepted.slice(0, MAX_FILES - pendingFiles.length);
    if (toAdd.length <= 0) {
      setFileError(`Maximum ${MAX_FILES} files per message.`);
      return;
    }
    if (toAdd.length < accepted.length) {
      setFileError(`Maximum ${MAX_FILES} files per message.`);
    }

    // Markdown is read as text for the importer; everything else as a data URL
    toAdd.forEach(file => {
      const reader = new FileReader();
      if (isMarkdownFile(file)) {
        reader.onload = () => {
          setPendingFiles(current => [
            ...current,
            { type: 'markdown-import', markdown: reader.result, filename: file.name },
          ]);
        };
        reader.readAsText(file);
      } else {
        reader.onload = () => {
          setPendingFiles(current => [
            ...current,
            { type: 'file', mediaType: file.type, url: reader.result, filename: file.name },
          ]);
        };
        reader.readAsDataURL(file);
      }
    });
  }, [pendingFiles.length]);

  const removeFile = useCallback((index) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
    setFileError(null);
  }, []);

  // Paste handler
  const handlePaste = useCallback((e) => {
    const files = e.clipboardData?.files;
    if (files?.length) {
      const hasAccepted = Array.from(files).some(f => isMarkdownFile(f) || ACCEPTED_TYPES.includes(f.type));
      if (hasAccepted) {
        e.preventDefault();
        processFiles(files);
      }
    }
  }, [processFiles]);

  const handleInput = useCallback((e) => {
    setValue(e.target.value);
    // Auto-resize
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, []);

  const hasRefs = (pendingRefs?.length || 0) > 0;

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    // Selection references (added via "Add to Chat") count as content, so a
    // message carrying only refs can still be sent.
    if ((!trimmed && pendingFiles.length === 0 && !hasRefs) || isStreaming) return;
    onSend(trimmed, pendingFiles.length > 0 ? pendingFiles : undefined);
    setValue('');
    setPendingFiles([]);
    setFileError(null);
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, pendingFiles, isStreaming, onSend, hasRefs]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const isEmpty = value.trim() === '' && pendingFiles.length === 0 && !hasRefs;

  return (
    <div className="ai-chat-input">
      <div className="ai-chat-input-inner">
        {hasRefs && (
          <div className="ai-chat-ref-strip">
            {pendingRefs.map((r) => (
              <div key={r.id} className="ai-chat-ref-chip" title={r.text}>
                <svg className="ai-chat-ref-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span className="ai-chat-ref-text">
                  {r.docTitle ? <span className="ai-chat-ref-doc">{r.docTitle}</span> : null}
                  {r.heading ? <span className="ai-chat-ref-heading">{r.heading}: </span> : null}
                  {r.text}
                </span>
                <button
                  type="button"
                  className="ai-chat-ref-remove"
                  onClick={() => onRemoveRef?.(r.id)}
                  aria-label="Remove reference"
                >&times;</button>
              </div>
            ))}
          </div>
        )}
        {pendingFiles.length > 0 && (
          <div className="ai-chat-preview-strip">
            {pendingFiles.map((file, i) => (
              <div key={i} className="ai-chat-preview-item">
                {isImageType(file.mediaType) ? (
                  <img src={file.url} alt={file.filename || 'preview'} className="ai-chat-preview-thumb" />
                ) : (
                  <div className="ai-chat-preview-file" title={file.type === 'markdown-import' ? 'Will be imported as a new document' : undefined}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="ai-chat-preview-filename">{file.filename || 'file'}</span>
                    {file.type === 'markdown-import' && <span className="ai-chat-preview-badge">import</span>}
                  </div>
                )}
                <button className="ai-chat-preview-remove" onClick={() => removeFile(i)} aria-label="Remove file">&times;</button>
              </div>
            ))}
          </div>
        )}
        {fileError && <div className="ai-chat-file-error">{fileError}</div>}
        <div className="ai-chat-input-row">
          <button
            className="ai-chat-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach file"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,.txt,.csv,.md,.markdown"
            multiple
            className="ai-chat-file-input"
            onChange={(e) => { processFiles(e.target.files); e.target.value = ''; }}
          />
          <textarea
            ref={textareaRef}
            className="ai-chat-textarea"
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            rows={2}
          />
          {isStreaming ? (
            <button
              className="ai-chat-send-btn ai-chat-stop-btn"
              onClick={onStop}
              aria-label="Stop"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className="ai-chat-send-btn"
              onClick={handleSend}
              disabled={isEmpty}
              aria-label="Send message"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

export default AiChatInput;
