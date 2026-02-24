import React, { useEffect, useRef } from 'react';

const TOOL_LABELS = {
  read_document: 'Reading document',
  modify: 'Editing document',
  list_documents: 'Listing documents',
  create_document: 'Creating document',
  share_document: 'Sharing document',
  set_document_title: 'Setting title',
  get_collaborators: 'Getting collaborators',
  undo: 'Undoing',
  redo: 'Redoing',
  list_document_versions: 'Listing versions',
  read_document_version: 'Reading version',
  set_document_version_name: 'Naming version',
  restore_document_version: 'Restoring version',
  compare_document_versions: 'Comparing versions',
};

function getToolLabel(toolName) {
  return TOOL_LABELS[toolName] || toolName;
}

/**
 * Check if a message part is a tool invocation.
 * In AI SDK v6, tool parts have type 'tool-<name>' or 'dynamic-tool'.
 */
function isToolPart(part) {
  return part.type?.startsWith('tool-') || part.type === 'dynamic-tool';
}

/**
 * Get the tool name from a tool part.
 */
function getToolName(part) {
  if (part.toolName) return part.toolName;
  // Static tool parts have type 'tool-<name>'
  if (part.type?.startsWith('tool-')) return part.type.slice(5);
  return 'unknown';
}

function ToolCard({ part }) {
  const toolName = getToolName(part);
  const label = getToolLabel(toolName);
  const isComplete = part.state === 'output-available' || part.state === 'output-error';

  return (
    <span className={`ai-tool-card ${isComplete ? 'ai-tool-card--complete' : 'ai-tool-card--running'}`}>
      {label}{isComplete ? ' \u2713' : '...'}
    </span>
  );
}

function TypingIndicator() {
  return (
    <div className="ai-chat-bubble ai-chat-bubble--assistant">
      <span className="ai-typing-indicator">
        <span className="ai-typing-dot" />
        <span className="ai-typing-dot" />
        <span className="ai-typing-dot" />
      </span>
    </div>
  );
}

function AiChatMessages({ messages, status }) {
  const scrollRef = useRef(null);

  // Auto-scroll when messages change or status updates
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, status]);

  return (
    <div className="ai-chat-messages" ref={scrollRef}>
      {messages.map((msg) => {
        // v6 messages have a `parts` array
        if (msg.parts && msg.parts.length > 0) {
          return (
            <div key={msg.id} className={`ai-chat-bubble ai-chat-bubble--${msg.role}`}>
              {msg.parts.map((part, i) => {
                if (part.type === 'text' && part.text) {
                  return <span key={i}>{part.text}</span>;
                }
                if (isToolPart(part)) {
                  return <ToolCard key={i} part={part} />;
                }
                // Skip step-start and other non-visual parts
                return null;
              })}
            </div>
          );
        }

        // Fallback for simple messages (user messages with just content)
        return (
          <div
            key={msg.id}
            className={`ai-chat-bubble ai-chat-bubble--${msg.role}`}
          >
            {msg.content}
          </div>
        );
      })}
      {status === 'submitted' && <TypingIndicator />}
    </div>
  );
}

export default AiChatMessages;
