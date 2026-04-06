import React, { useState, useRef, useEffect } from 'react';
import { PlusIcon } from './icons';
import './AiChatHistory.css';

function formatRelativeTime(dateStr) {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return 'Yesterday';
  if (diffD < 7) return `${diffD}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function AiChatHistory({ aiChat, onBack }) {
  const {
    chatList,
    currentChatId,
    createChat,
    selectChat,
    deleteChat,
    renameChat,
  } = aiChat;

  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const editInputRef = useRef(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const filtered = search
    ? chatList.filter((c) =>
        (c.title || 'New Chat').toLowerCase().includes(search.toLowerCase())
      )
    : chatList;

  const handleNewChat = async () => {
    await createChat();
    onBack();
  };

  const handleSelect = (id) => {
    selectChat(id);
    onBack();
  };

  const handleRenameStart = (e, chat) => {
    e.stopPropagation();
    setEditingId(chat.id);
    setEditTitle(chat.title || '');
  };

  const handleRenameSubmit = async (id) => {
    if (editTitle.trim()) {
      await renameChat(id, editTitle.trim());
    }
    setEditingId(null);
  };

  const handleRenameKeyDown = (e, id) => {
    if (e.key === 'Enter') {
      handleRenameSubmit(id);
    } else if (e.key === 'Escape') {
      setEditingId(null);
    }
  };

  const handleDeleteClick = (e, id) => {
    e.stopPropagation();
    setConfirmDeleteId(id);
  };

  const handleDeleteConfirm = async (e, id) => {
    e.stopPropagation();
    await deleteChat(id);
    setConfirmDeleteId(null);
  };

  const handleDeleteCancel = (e) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
  };

  return (
    <div className="ai-chat-history">
      <button className="ai-chat-history-new" onClick={handleNewChat}>
        <PlusIcon size={14} />
        New Chat
      </button>

      <div className="ai-chat-history-search">
        <input
          type="text"
          placeholder="Search chats..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ai-chat-history-search-input"
        />
      </div>

      <div className="ai-chat-history-list">
        {filtered.length === 0 && (
          <p className="ai-chat-history-empty">
            {search ? 'No matching chats' : 'No chats yet'}
          </p>
        )}
        {filtered.map((chat) => (
          <div
            key={chat.id}
            className={`ai-chat-history-item${chat.id === currentChatId ? ' ai-chat-history-item--active' : ''}`}
            onClick={() => handleSelect(chat.id)}
          >
            {editingId === chat.id ? (
              <input
                ref={editInputRef}
                className="ai-chat-history-rename-input"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={() => handleRenameSubmit(chat.id)}
                onKeyDown={(e) => handleRenameKeyDown(e, chat.id)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <div className="ai-chat-history-item-content">
                  <span className="ai-chat-history-item-title">
                    {chat.title || 'New Chat'}
                  </span>
                  <span className="ai-chat-history-item-time">
                    {formatRelativeTime(chat.updatedAt)}
                  </span>
                </div>
                <div className="ai-chat-history-item-actions">
                  {confirmDeleteId === chat.id ? (
                    <>
                      <button
                        className="ai-chat-history-action-btn ai-chat-history-action-btn--danger"
                        onClick={(e) => handleDeleteConfirm(e, chat.id)}
                        title="Confirm delete"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </button>
                      <button
                        className="ai-chat-history-action-btn"
                        onClick={handleDeleteCancel}
                        title="Cancel"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="ai-chat-history-action-btn"
                        onClick={(e) => handleRenameStart(e, chat)}
                        title="Rename"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      <button
                        className="ai-chat-history-action-btn"
                        onClick={(e) => handleDeleteClick(e, chat.id)}
                        title="Delete"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default AiChatHistory;
