import React, { useState, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';

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
  webSearch: 'Searching the web',
  webFetch: 'Fetching page',
};

function getToolLabel(toolName) {
  return TOOL_LABELS[toolName] || toolName;
}

function isToolPart(part) {
  return part.type?.startsWith('tool-') || part.type === 'dynamic-tool';
}

function getToolName(part) {
  if (part.toolName) return part.toolName;
  if (part.type?.startsWith('tool-')) return part.type.slice(5);
  return 'unknown';
}

/**
 * Group message parts into text segments and tool card groups
 * so they render as distinct visual blocks.
 */
function groupParts(parts) {
  const groups = [];
  let currentToolGroup = null;

  let currentReasoningText = '';

  for (const part of parts) {
    if (isToolPart(part)) {
      if (currentReasoningText) {
        groups.push({ type: 'reasoning', text: currentReasoningText });
        currentReasoningText = '';
      }
      if (!currentToolGroup) {
        currentToolGroup = [];
        groups.push({ type: 'tools', parts: currentToolGroup });
      }
      currentToolGroup.push(part);
    } else if (part.type === 'reasoning' && part.text) {
      currentToolGroup = null;
      currentReasoningText += part.text;
    } else if (part.type === 'text' && part.text) {
      if (currentReasoningText) {
        groups.push({ type: 'reasoning', text: currentReasoningText });
        currentReasoningText = '';
      }
      currentToolGroup = null;
      groups.push({ type: 'text', text: part.text });
    } else {
      currentToolGroup = null;
    }
  }

  if (currentReasoningText) {
    groups.push({ type: 'reasoning', text: currentReasoningText });
  }

  return groups;
}

function ThinkingBlock({ text }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="ai-thinking-block">
      <button
        className="ai-thinking-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        Thinking {expanded ? '\u25B4' : '\u25BE'}
      </button>
      {expanded && (
        <div className="ai-thinking-content">{text}</div>
      )}
    </div>
  );
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

/** Open links from assistant messages in a new tab. */
const markdownLinkRenderer = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

function AssistantBubble({ groups, isLoading }) {
  return (
    <div className="ai-chat-bubble ai-chat-bubble--assistant">
      {groups.length > 0
        ? groups.map((group, i) => {
            if (group.type === 'text') {
              return (
                <div key={i} className="ai-chat-markdown">
                  <Markdown components={markdownLinkRenderer}>{group.text}</Markdown>
                </div>
              );
            }
            if (group.type === 'reasoning') {
              return <ThinkingBlock key={i} text={group.text} />;
            }
            if (group.type === 'tools') {
              return (
                <div key={i} className="ai-tool-group">
                  {group.parts.map((part, j) => <ToolCard key={j} part={part} />)}
                </div>
              );
            }
            return null;
          })
        : isLoading && (
            <span className="ai-typing-indicator">
              <span className="ai-typing-dot" />
              <span className="ai-typing-dot" />
              <span className="ai-typing-dot" />
            </span>
          )}
    </div>
  );
}

function AiChatMessages({ messages, status }) {
  const scrollRef = useRef(null);
  const isLoading = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, status]);

  // Check if the last message is an assistant response with visible content
  const lastMsg = messages[messages.length - 1];
  const lastGroups = lastMsg?.role === 'assistant' ? groupParts(lastMsg.parts || []) : [];
  const needsTypingBubble = isLoading && lastMsg?.role !== 'assistant';

  return (
    <div className="ai-chat-messages" ref={scrollRef}>
      {messages.map((msg) => {
        if (msg.role === 'assistant') {
          const groups = msg === lastMsg ? lastGroups : groupParts(msg.parts || []);
          if (groups.length === 0 && !isLoading) return null;
          return <AssistantBubble key={msg.id} groups={groups} isLoading={msg === lastMsg && isLoading} />;
        }
        const text = msg.parts?.find(p => p.type === 'text')?.text || msg.content;
        return (
          <div key={msg.id} className={`ai-chat-bubble ai-chat-bubble--${msg.role}`}>
            {text}
          </div>
        );
      })}
      {needsTypingBubble && <AssistantBubble groups={[]} isLoading />}
    </div>
  );
}

export default AiChatMessages;
