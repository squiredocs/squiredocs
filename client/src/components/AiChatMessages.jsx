import React, { useState, useEffect, useRef, useCallback, useContext, createContext } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Labels for tool badges. Doc-scoped tools (value ends with a preposition
// or single verb) get a linked document title appended automatically.
const TOOL_LABELS = {
  read_document: 'Reading',
  modify: 'Editing',
  list_documents: 'Listing documents',
  create_document: 'Creating',
  share_document: 'Sharing',
  set_document_title: 'Setting title of',
  get_collaborators: 'Getting collaborators for',
  undo: 'Undoing in',
  redo: 'Redoing in',
  list_document_versions: 'Listing versions of',
  read_document_version: 'Reading version of',
  set_document_version_name: 'Naming version of',
  restore_document_version: 'Restoring version of',
  compare_document_versions: 'Comparing versions of',
  webSearch: 'Searching the web',
  webFetch: 'Fetching page',
  _compacting: 'Compacting conversation',
};

// Non-doc tools use standalone labels; everything else is a doc-scoped tool
const NON_DOC_TOOLS = new Set(['list_documents', 'webSearch', 'webFetch', '_compacting']);
const DOC_TOOLS = new Set(Object.keys(TOOL_LABELS).filter(k => !NON_DOC_TOOLS.has(k)));

function getToolLabel(toolName) {
  return TOOL_LABELS[toolName] || toolName;
}

/** Push a path to the browser history and trigger SPA navigation. */
function spaNavigate(path) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// Context for intercepting doc link clicks (used by /chat page to open side pane)
const DocLinkContext = createContext(null);

const UUID_RE = /^\/d(?:oc)?\/([0-9a-f-]+)/i;

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
        <div className="ai-thinking-content ai-chat-markdown">
          <Markdown remarkPlugins={[remarkGfm]} components={markdownLinkRenderer}>{text}</Markdown>
        </div>
      )}
    </div>
  );
}

function ToolCardDetail({ toolName, input }) {
  if (toolName === 'modify' && input.script) {
    return <pre><code>{input.script}</code></pre>;
  }
  if (toolName === 'webSearch' && input.query) {
    return <p>{input.query}</p>;
  }
  if (toolName === 'webFetch' && input.url) {
    return <p>{input.url}</p>;
  }
  if (toolName === 'read_document') {
    return <p>{[input.docGuid, input.xpath].filter(Boolean).join(' — ')}</p>;
  }
  return <pre>{JSON.stringify(input, null, 2)}</pre>;
}

const DIFF_VISIBLE_LINES = 15;

function DiffView({ diff }) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);

  if (!diff || !diff.lines || diff.lines.length === 0) return null;

  const { lines } = diff;
  const needsTruncation = lines.length > DIFF_VISIBLE_LINES && !showAll;
  const visibleLines = needsTruncation ? lines.slice(0, DIFF_VISIBLE_LINES) : lines;

  // Compute line numbers using hunk start offsets from the server
  const hunkStarts = diff.hunkStarts || [];
  const formatAnnotations = diff.formatAnnotations || {};
  let oldLine = 0;
  let newLine = 0;
  let hunkIdx = 0;
  const numberedLines = visibleLines.map((line, i) => {
    if (line === '~~~') {
      return { line, type: 'separator', num: null };
    }
    // Reset counters at each hunk boundary
    if (hunkIdx < hunkStarts.length && i === hunkStarts[hunkIdx].index) {
      oldLine = hunkStarts[hunkIdx].oldStart - 1;
      newLine = hunkStarts[hunkIdx].newStart - 1;
      hunkIdx++;
    }
    const prefix = line[0];
    let entry;
    if (prefix === '-') {
      oldLine++;
      entry = { line, type: 'removed', num: oldLine };
    } else if (prefix === '+') {
      newLine++;
      entry = { line, type: 'added', num: newLine };
    } else {
      oldLine++;
      newLine++;
      entry = { line, type: 'context', num: newLine };
    }
    // Formatting-only annotation from server (shown on the + line)
    if (formatAnnotations[String(i)]) {
      entry.formatAnnotation = formatAnnotations[String(i)];
    }
    return entry;
  });

  return (
    <div className="ai-diff-view">
      <button className="ai-diff-toggle" onClick={() => setExpanded(!expanded)}>
        Changes {expanded ? '\u25B4' : '\u25BE'}
      </button>
      {expanded && (
        <div className="ai-diff-content">
          <table className="ai-diff-table">
            <tbody>
              {numberedLines.map((entry, i) => {
                if (entry.type === 'separator') {
                  return (
                    <tr key={i} className="ai-diff-separator-row">
                      <td className="ai-diff-gutter"></td>
                      <td className="ai-diff-separator-text">...</td>
                    </tr>
                  );
                }
                return (
                  <tr key={i} className={`ai-diff-row ai-diff-row--${entry.type}`}>
                    <td className="ai-diff-gutter">{entry.num ?? ''}</td>
                    <td className="ai-diff-cell">
                      {entry.line}
                      {entry.formatAnnotation && (
                        <span className="ai-diff-format-annotation"> ({entry.formatAnnotation})</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {lines.length > DIFF_VISIBLE_LINES && (
            <button className="ai-diff-expand" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show less' : `Show all ${lines.length} lines`}
            </button>
          )}
          {diff.truncatedByServer && (
            <div className="ai-diff-truncated">Diff truncated (changes too large)</div>
          )}
        </div>
      )}
    </div>
  );
}

// Module-level cache so doc titles resolved from completed tool outputs
// are immediately available when subsequent tools for the same doc start running.
const docTitleCache = new Map();

function DocTitleLink({ docGuid, title }) {
  const onDocLinkClick = useContext(DocLinkContext);
  const handleClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onDocLinkClick) {
      onDocLinkClick(docGuid);
    } else {
      spaNavigate(`/d/${docGuid}`);
    }
  }, [docGuid, onDocLinkClick]);
  return (
    <>{'\u201c'}<a href={`/d/${docGuid}`} className="ai-tool-card-link" onClick={handleClick}>{title}</a>{'\u201d'}</>
  );
}

function ToolCard({ part }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = getToolName(part);
  const isComplete = part.state === 'output-available' || part.state === 'output-error';
  const input = part.input;
  const hasInput = input && typeof input === 'object' && Object.keys(input).length > 0;
  const isDocTool = DOC_TOOLS.has(toolName);
  const isModify = toolName === 'modify';
  const isCreate = toolName === 'create_document';

  // For create_document, docGuid comes from output; for others it's on input
  const docGuid = isDocTool && (isCreate ? part.output?.docGuid : input?.docGuid);

  // Resolve title: output enrichment first, then cache, then create_document input
  const outputTitle = isDocTool && isComplete && part.output?.docTitle;
  if (outputTitle && docGuid) docTitleCache.set(docGuid, outputTitle);
  // For create_document the server result includes `title` directly
  const createTitle = isCreate && isComplete && part.output?.title;
  if (createTitle && docGuid) docTitleCache.set(docGuid, createTitle);

  const docTitle = outputTitle || createTitle
    || (isDocTool && docGuid && docTitleCache.get(docGuid))
    || (isCreate && input?.title)
    || null;

  const showDetail = hasInput && !isModify && !isCreate;

  const diff = (isModify && isComplete && part.output?.diff) || null;
  const isFormatOnly = isModify && isComplete && part.output?.changed && !diff;

  const verb = getToolLabel(toolName);

  return (
    <div className="ai-tool-card">
      <button
        className={`ai-tool-card-toggle ${isComplete ? 'ai-tool-card--complete' : 'ai-tool-card--running'}`}
        onClick={showDetail ? () => setExpanded(!expanded) : undefined}
        style={showDetail ? undefined : { cursor: 'default' }}
      >
        {verb}{isDocTool && ' '}{isDocTool && (docTitle && docGuid
          ? <DocTitleLink docGuid={docGuid} title={docTitle} />
          : docTitle || 'document')}
        {isComplete ? ' \u2713' : '...'}{showDetail ? (expanded ? ' \u25B4' : ' \u25BE') : ''}
      </button>
      {expanded && showDetail && (
        <div className="ai-tool-card-detail">
          <ToolCardDetail toolName={toolName} input={input} />
        </div>
      )}
      {diff && <DiffView diff={diff} />}
      {isFormatOnly && (
        <div className="ai-diff-format-only">Formatting changes only</div>
      )}
    </div>
  );
}

/** SPA-navigate internal links; open external links in a new tab. */
function MarkdownLink({ href, children }) {
  const onDocLinkClick = useContext(DocLinkContext);
  const isInternal = href && (href.startsWith('/') || href.startsWith(window.location.origin));
  const handleClick = useCallback((e) => {
    if (!isInternal) return;
    e.preventDefault();
    const pathname = href.startsWith('/') ? href : new URL(href).pathname;
    // If a doc link handler is registered and this is a doc URL, use it
    if (onDocLinkClick) {
      const m = pathname.match(UUID_RE);
      if (m) { onDocLinkClick(m[1].toLowerCase()); return; }
    }
    spaNavigate(pathname);
  }, [href, isInternal, onDocLinkClick]);
  if (isInternal) {
    return <a href={href} onClick={handleClick}>{children}</a>;
  }
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}
const markdownLinkRenderer = { a: MarkdownLink };

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button className="ai-chat-copy-btn" onClick={handleCopy} title="Copy message" aria-label="Copy message">
      {copied ? '\u2713' : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function AssistantBubble({ groups, isLoading }) {
  const lastGroup = groups[groups.length - 1];
  const showDots = isLoading && (!lastGroup || lastGroup.type !== 'text');

  const fullText = groups.filter(g => g.type === 'text').map(g => g.text).join('\n\n');

  return (
    <div className="ai-chat-bubble-wrap ai-chat-bubble-wrap--assistant">
      <div className="ai-chat-bubble ai-chat-bubble--assistant">
        {groups.map((group, i) => {
          if (group.type === 'text') {
            return (
              <div key={i} className="ai-chat-markdown">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownLinkRenderer}>{group.text}</Markdown>
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
        })}
        {showDots && (
          <span className="ai-typing-indicator">
            <span className="ai-typing-dot" />
            <span className="ai-typing-dot" />
            <span className="ai-typing-dot" />
          </span>
        )}
      </div>
      {fullText && <CopyButton text={fullText} />}
    </div>
  );
}

function AiChatMessages({ messages, status, onDocLinkClick }) {
  const scrollRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const isLoading = status === 'submitted' || status === 'streaming';

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const lastMsg = messages[messages.length - 1];
    // Always scroll when the human sends a message; otherwise only scroll if
    // the user hasn't manually scrolled up.
    if (lastMsg?.role === 'user' || isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      isAtBottomRef.current = true;
    }
  }, [messages, status]);

  // Check if the last message is an assistant response with visible content
  const lastMsg = messages[messages.length - 1];
  const lastGroups = lastMsg?.role === 'assistant' ? groupParts(lastMsg.parts || []) : [];
  const needsTypingBubble = isLoading && lastMsg?.role !== 'assistant';

  return (
    <DocLinkContext.Provider value={onDocLinkClick || null}>
      <div className="ai-chat-messages" ref={scrollRef} onScroll={handleScroll}>
        {messages.map((msg) => {
          if (msg.role === 'assistant') {
            const groups = msg === lastMsg ? lastGroups : groupParts(msg.parts || []);
            if (groups.length === 0 && !isLoading) return null;
            return <AssistantBubble key={msg.id} groups={groups} isLoading={msg === lastMsg && isLoading} />;
          }
          const text = msg.parts?.find(p => p.type === 'text')?.text || msg.content;
          const fileParts = msg.parts?.filter(p => p.type === 'file') || [];
          return (
            <div key={msg.id} className="ai-chat-bubble-wrap ai-chat-bubble-wrap--user">
              <div className={`ai-chat-bubble ai-chat-bubble--${msg.role}`}>
                {fileParts.length > 0 && (
                  <div className="ai-chat-images">
                    {fileParts.map((fp, i) => (
                      <img key={i} src={fp.url} alt={fp.filename || 'Attached image'} className="ai-chat-image" onClick={() => window.open(fp.url)} />
                    ))}
                  </div>
                )}
                {text}
              </div>
              {text && <CopyButton text={text} />}
            </div>
          );
        })}
        {needsTypingBubble && <AssistantBubble groups={[]} isLoading />}
      </div>
    </DocLinkContext.Provider>
  );
}

export default AiChatMessages;
