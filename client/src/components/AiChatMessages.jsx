import React, { useState, useEffect, useRef, useCallback, useContext, useMemo, createContext } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../contexts/AuthContext';
import { useAiChat } from '../contexts/AiChatContext';
import { isImageType } from '../utils/media';
import { spaNavigate, parseDocGuid } from '../utils/navigation';

// Remove the leading <referenced_passages>…</referenced_passages> block that
// "Add to Chat" prepends to a user turn (it's rendered as chips from metadata
// instead). Defensive against a missing/partial block.
function stripReferencedPassages(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/^<referenced_passages>[\s\S]*?<\/referenced_passages>\n*/, '');
}

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
const NON_DOC_TOOLS = new Set([
  'list_documents', 'webSearch', 'webFetch', '_compacting',
]);
const DOC_TOOLS = new Set(Object.keys(TOOL_LABELS).filter(k => !NON_DOC_TOOLS.has(k)));

function getToolLabel(toolName) {
  return TOOL_LABELS[toolName] || toolName;
}

// Context for intercepting doc link clicks (used by /chat page to open side pane)
const DocLinkContext = createContext(null);

// Holds the most recent completed `modify` part that actually changed a document.
// The undo/redo button is rendered only on that part: the agent's UndoManager is a
// single LIFO stack, so only the latest edit can be undone.
const LastModifyContext = createContext(null);

function isToolPart(part) {
  return part.type?.startsWith('tool-') || part.type === 'dynamic-tool';
}

function getToolName(part) {
  if (part.toolName) return part.toolName;
  if (part.type?.startsWith('tool-')) return part.type.slice(5);
  return 'unknown';
}

/**
 * Find the most recent completed `modify` tool part that actually changed a
 * document, scanning messages and their parts newest-first. Returns the part
 * object (used for reference-equality matching) or null.
 */
function findLastModifyPart(messages) {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m]?.parts;
    if (!parts) continue;
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p];
      if (getToolName(part) === 'modify'
        && part.state === 'output-available'
        && part.output?.changed
        && part.input?.docGuid) {
        return part;
      }
    }
  }
  return null;
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
    // source-url parts are handled by extractCitations, not rendered as groups
    if (part.type === 'source-url') continue;
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

// While a thinking block streams, poll the server for a cheap-model summary of
// the reasoning-so-far on this cadence, and show it in place of "Thinking".
const THINKING_SUMMARY_INTERVAL_MS = 3000;
// Don't bother summarizing until there's enough reasoning to say anything about.
const THINKING_SUMMARY_MIN_CHARS = 20;

// Summaries outlive component instances: the transcript remounts message
// components (stream settling, chat reloads), and a summary resolving against
// an unmounted instance would otherwise be lost \u2014 the remounted block would
// fall back to "Thinking" forever. Keyed by `${messageId}:${groupIndex}`.
const thinkingSummaryCache = new Map();
const THINKING_SUMMARY_CACHE_MAX = 500;

function rememberThinkingSummary(cacheId, summary) {
  thinkingSummaryCache.set(cacheId, summary);
  if (thinkingSummaryCache.size > THINKING_SUMMARY_CACHE_MAX) {
    thinkingSummaryCache.delete(thinkingSummaryCache.keys().next().value);
  }
}

function ThinkingBlock({ text, active, cacheId }) {
  const [summary, setSummary] = useState(() => thinkingSummaryCache.get(cacheId) || null);
  const { api } = useAuth();
  // The interval callback reads the latest text through a ref so the effect
  // doesn't tear down and restart on every streamed token.
  const textRef = useRef(text);
  textRef.current = text;
  // Distinguishes a block the user just watched think (gets a completion
  // summary below) from one loaded out of history, and lets the completion
  // effect skip firing when a poll request is already in flight.
  const wasActiveRef = useRef(false);
  if (active) wasActiveRef.current = true;
  const requestedRef = useRef(false);

  // Effect keys on `ready` (not raw text) so the first summary fires the
  // moment enough reasoning has streamed, without tearing the interval down
  // on every token.
  const ready = text.length >= THINKING_SUMMARY_MIN_CHARS;
  useEffect(() => {
    if (!active || !ready) return undefined;
    let inFlight = false;
    let lastSummarized = '';
    const tick = async () => {
      const current = textRef.current;
      if (inFlight || current === lastSummarized) return;
      inFlight = true;
      lastSummarized = current;
      requestedRef.current = true;
      try {
        const { data } = await api.post('/api/chat/thinking-summary', { text: current });
        if (data.summary) {
          // Cache first: if this instance was unmounted while the request was
          // in flight, its remounted successor picks the summary up below.
          rememberThinkingSummary(cacheId, data.summary);
          setSummary(data.summary);
        }
      } catch {
        // Non-essential UI sugar \u2014 keep the previous label on failure.
      } finally {
        inFlight = false;
      }
    };
    tick();
    const interval = setInterval(tick, THINKING_SUMMARY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active, ready, api, cacheId]);

  // Completion catch-up: thinking that finished before ever reaching the
  // polling threshold still gets summarized once, so every block the user
  // watched think ends with a real label. Blocks loaded from history were
  // never active here and don't fire \u2014 reloading a long chat must not burst
  // summary requests.
  useEffect(() => {
    if (active || summary || !wasActiveRef.current || requestedRef.current || !textRef.current) return undefined;
    requestedRef.current = true;
    (async () => {
      try {
        const { data } = await api.post('/api/chat/thinking-summary', { text: textRef.current });
        if (data.summary) {
          rememberThinkingSummary(cacheId, data.summary);
          setSummary(data.summary);
        }
      } catch {
        // Keep the "Thinking" label on failure.
      }
    })();
    return undefined;
  }, [active, summary, api, cacheId]);

  // A request from a previous mount of this block may still be in flight when
  // we remount \u2014 check the cache shortly after settling to pick up its result.
  useEffect(() => {
    if (summary || active) return undefined;
    const t = setTimeout(() => {
      const cached = thinkingSummaryCache.get(cacheId);
      if (cached) setSummary(cached);
    }, 2000);
    return () => clearTimeout(t);
  }, [summary, active, cacheId]);

  // Label only \u2014 the full train of thought is deliberately not rendered.
  return (
    <div className="ai-thinking-block">
      <span className="ai-thinking-label">{summary || 'Thinking'}</span>
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

const DIFF_VISIBLE_LINES = 50;

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

function DocumentListView({ documents, pagination }) {
  if (!documents || documents.length === 0) return null;
  return (
    <ul className="ai-doc-list">
      {documents.map((doc) => (
        <li key={doc.id}>
          <DocTitleLink docGuid={doc.id} title={doc.title || 'Untitled'} />
          {doc.role && doc.role !== 'owner' && (
            <span className="ai-doc-list-role"> {doc.role}</span>
          )}
        </li>
      ))}
      {pagination && pagination.hasMore && (
        <li className="ai-doc-list-more">+ {pagination.total - documents.length} more</li>
      )}
    </ul>
  );
}

const faviconUrl = (hostname, size = 16) =>
  `https://www.google.com/s2/favicons?sz=${size}&domain=${hostname}`;

/** A web source rendered as a favicon + title link, with an optional [n] index. */
function SourceLink({ url, title, index }) {
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch (_) { /* leave blank */ }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="ai-source-link">
      {hostname && <img src={faviconUrl(hostname)} alt="" className="ai-source-favicon" />}
      <span className="ai-source-title">{title || hostname || url}</span>
      {index != null && <span className="ai-source-index">[{index}]</span>}
    </a>
  );
}

function WebSearchResultsView({ sources }) {
  if (!sources || sources.length === 0) return null;
  return (
    <ul className="ai-web-results-list">
      {sources.map((src) => (
        <li key={src.url}><SourceLink url={src.url} title={src.title} /></li>
      ))}
    </ul>
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

function ToolCard({ part, citations }) {
  const [expanded, setExpanded] = useState(false);
  // Whether this agent edit is currently reverted. Initialized from the persisted
  // flag on the part (set server-side on undo), so it survives chat reloads.
  const [reverted, setReverted] = useState(!!part.reverted);
  const lastModifyPart = useContext(LastModifyContext);
  const toolName = getToolName(part);
  const isComplete = part.state === 'output-available' || part.state === 'output-error';
  const input = part.input;
  const hasInput = input && typeof input === 'object' && Object.keys(input).length > 0;
  const isDocTool = DOC_TOOLS.has(toolName);
  const isModify = toolName === 'modify';
  const isCreate = toolName === 'create_document';
  const isListDocs = toolName === 'list_documents';
  const isWebSearch = toolName === 'webSearch';

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

  const showDetail = hasInput && !isModify && !isCreate && !isListDocs && !isWebSearch;

  // Cache titles from list_documents results for subsequent tool calls
  const docList = (isListDocs && isComplete && part.output?.documents) || null;
  const docListPagination = (isListDocs && isComplete && part.output?.pagination) || null;
  if (docList) {
    for (const doc of docList) {
      if (doc.id && doc.title) docTitleCache.set(doc.id, doc.title);
    }
  }

  const webSearchSources = (isWebSearch && isComplete
    && (part.output?.citations?.sources || citations?.sources)) || null;

  const diff = (isModify && isComplete && part.output?.diff) || null;
  const isFormatOnly = isModify && isComplete && part.output?.changed && !diff;

  const verb = getToolLabel(toolName);

  // Build inline summary for list_documents (e.g. "— search "Cheryl"")
  const listDocsSuffix = isListDocs && input
    ? [input.search && `search \u201c${input.search}\u201d`, input.filter && input.filter !== 'all' && input.filter]
        .filter(Boolean).join(', ')
    : '';
  const webSearchSuffix = isWebSearch && input?.query ? `\u201c${input.query}\u201d` : '';

  return (
    <div className="ai-tool-card">
      <div
        className={`ai-tool-card-toggle ${isComplete ? 'ai-tool-card--complete' : 'ai-tool-card--running'}${docList || webSearchSources ? ' ai-tool-card--has-list' : ''}`}
        onClick={showDetail ? () => setExpanded(!expanded) : undefined}
        style={showDetail ? undefined : { cursor: 'default' }}
        role={showDetail ? 'button' : undefined}
      >
        <span>
          {verb}{isDocTool && ' '}{isDocTool && (docTitle && docGuid
            ? <DocTitleLink docGuid={docGuid} title={docTitle} />
            : docTitle || 'document')}
          {listDocsSuffix && ` \u2014 ${listDocsSuffix}`}
          {webSearchSuffix && ` \u2014 ${webSearchSuffix}`}
          {isComplete ? ' \u2713' : '...'}{showDetail ? (expanded ? ' \u25B4' : ' \u25BE') : ''}
        </span>
        {docList && <DocumentListView documents={docList} pagination={docListPagination} />}
        {webSearchSources && <WebSearchResultsView sources={webSearchSources} />}
      </div>
      {expanded && showDetail && (
        <div className="ai-tool-card-detail">
          <ToolCardDetail toolName={toolName} input={input} />
        </div>
      )}
      {diff && (
        <div className={`ai-diff-wrap${reverted ? ' ai-diff-wrap--undone' : ''}`}>
          <DiffView diff={diff} />
        </div>
      )}
      {isModify && isComplete && part.output?.changed && docGuid && (
        <UndoEditButton
          docGuid={docGuid}
          toolCallId={part.toolCallId}
          isLatest={part === lastModifyPart}
          reverted={reverted}
          onRevertedChange={setReverted}
        />
      )}
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
      const guid = parseDocGuid(pathname);
      if (guid) { onDocLinkClick(guid); return; }
    }
    spaNavigate(pathname);
  }, [href, isInternal, onDocLinkClick]);
  if (isInternal) {
    return <a href={href} onClick={handleClick}>{children}</a>;
  }
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}
const markdownLinkRenderer = { a: MarkdownLink };

/**
 * Undo (↔ Redo) the agent's last edit directly from the chat. Drives the chat
 * assistant's server-side Y.UndoManager via the /undo and /redo endpoints — the
 * same manager its `modify` tool edited through — so it's a true surgical inverse
 * (unlike restore, it preserves edits made after the agent's).
 *
 * The reverted state is persisted on the chat message (server sets a `reverted`
 * flag on this tool part), so it survives reloads. The Undo/Redo *button*,
 * though, only appears while the edit is actually reversible: that UndoManager is
 * in-memory and lives only for the few-minute life of the assistant's session
 * (lost on disconnect/restart), so we poll /undo-status and hide the button when
 * it can no longer act. Because the stack is LIFO the button is also only shown
 * on the most recent edit (isLatest).
 *
 * Renders a single row: the "Reverted" label (left) and the action button
 * (right). Returns null when there's nothing to show.
 */
function UndoEditButton({ docGuid, toolCallId, isLatest, reverted, onRevertedChange }) {
  const { api } = useAuth();
  const chatId = useAiChat()?.currentChatId || null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null); // { canUndo, canRedo } | null until first load

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get(`/api/docs/${docGuid}/undo-status`);
      return { canUndo: !!res.data?.canUndo, canRedo: !!res.data?.canRedo };
    } catch {
      return { canUndo: false, canRedo: false };
    }
  }, [api, docGuid]);

  // Only the latest edit can be (un)done — poll its availability so the button
  // disappears once the assistant's session (and its undo stack) expires.
  useEffect(() => {
    if (!isLatest) { setStatus(null); return undefined; }
    let alive = true;
    const tick = async () => {
      const s = await fetchStatus();
      if (alive) setStatus(s);
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [isLatest, fetchStatus]);

  const handleClick = useCallback(async () => {
    setBusy(true);
    setError(null);
    const undoing = !reverted;
    try {
      const res = await api.post(
        `/api/docs/${docGuid}/${undoing ? 'undo' : 'redo'}`,
        { chatId, toolCallId },
      );
      const ok = undoing ? res.data?.undone : res.data?.redone;
      if (ok) onRevertedChange(undoing);
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong');
    } finally {
      setBusy(false);
      setStatus(await fetchStatus());
    }
  }, [api, docGuid, chatId, toolCallId, reverted, onRevertedChange, fetchStatus]);

  const canAct = reverted ? status?.canRedo : status?.canUndo;
  const showButton = isLatest && (canAct || busy);
  if (!reverted && !showButton) return null;

  const label = reverted ? 'Redo edit' : 'Undo edit';

  return (
    <div className="ai-diff-undo">
      {reverted && <span className="ai-diff-reverted">Reverted</span>}
      {showButton && (
        <button
          type="button"
          className="ai-diff-undo-btn"
          onClick={handleClick}
          disabled={busy}
          title={reverted ? 'Reapply this edit' : 'Revert this edit'}
        >
          {busy ? '…' : label}
        </button>
      )}
      {error && <span className="ai-diff-undo-error">{error}</span>}
    </div>
  );
}

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

/**
 * Extract citation data from an assistant message's parts.
 * Handles both Google (citations in webSearch tool output) and
 * Anthropic (source-url parts from native webSearch) paths.
 */
function extractCitations(parts) {
  const seen = new Set();
  const allSources = [];

  // Google path: citations embedded in webSearch tool results
  for (const part of parts) {
    if (isToolPart(part) && getToolName(part) === 'webSearch'
        && part.state === 'output-available' && part.output?.citations?.sources) {
      for (const src of part.output.citations.sources) {
        if (src.url && !seen.has(src.url)) {
          seen.add(src.url);
          allSources.push({ url: src.url, title: src.title });
        }
      }
    }
  }

  // Anthropic path: source-url parts from sendSources
  for (const part of parts) {
    if (part.type === 'source-url' && part.url && !seen.has(part.url)) {
      seen.add(part.url);
      allSources.push({ url: part.url, title: part.title });
    }
  }

  return allSources.length > 0 ? { sources: allSources } : null;
}

function SourcesPanel({ citations }) {
  const [expanded, setExpanded] = useState(false);
  if (!citations || citations.sources.length === 0) return null;

  const { sources } = citations;

  return (
    <div className="ai-sources-panel">
      <button className="ai-sources-toggle" onClick={() => setExpanded(!expanded)}>
        {sources.length} source{sources.length !== 1 ? 's' : ''} {expanded ? '\u25B4' : '\u25BE'}
      </button>
      {expanded && (
        <ol className="ai-sources-list">
          {sources.map((src, i) => (
            <li key={src.url}><SourceLink url={src.url} title={src.title} index={i + 1} /></li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Render [N] citation references as styled superscript badges. */
function CitationBadge({ index, onClick }) {
  return (
    <sup className="ai-citation-badge" onClick={onClick} role="button" tabIndex={0}>
      {index}
    </sup>
  );
}

/**
 * Build markdown components with citation badge support.
 * Matches [N] patterns in text nodes and renders them as superscript badges.
 */
function buildMarkdownComponents(citations) {
  const CITE_RE = /\[(\d+)\]/g;

  function processTextNode(text) {
    if (!citations || !CITE_RE.test(text)) return text;
    CITE_RE.lastIndex = 0;
    const parts = [];
    let lastIndex = 0;
    let match;
    while ((match = CITE_RE.exec(text)) !== null) {
      const num = parseInt(match[1], 10);
      if (num < 1 || num > citations.sources.length) continue;
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      parts.push(<CitationBadge key={match.index} index={num} />);
      lastIndex = match.index + match[0].length;
    }
    if (parts.length === 0) return text;
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return parts;
  }

  return {
    a: MarkdownLink,
    p: ({ children, ...props }) => {
      const processed = React.Children.map(children, child =>
        typeof child === 'string' ? processTextNode(child) : child
      );
      return <p {...props}>{processed}</p>;
    },
    li: ({ children, ...props }) => {
      const processed = React.Children.map(children, child =>
        typeof child === 'string' ? processTextNode(child) : child
      );
      return <li {...props}>{processed}</li>;
    },
  };
}

function AssistantBubble({ groups, isLoading, citations, messageId }) {
  const lastGroup = groups[groups.length - 1];
  const showDots = isLoading && (!lastGroup || lastGroup.type !== 'text');

  const fullText = groups.filter(g => g.type === 'text').map(g => g.text).join('\n\n');

  const mdComponents = citations ? buildMarkdownComponents(citations) : markdownLinkRenderer;

  return (
    <div className="ai-chat-bubble-wrap ai-chat-bubble-wrap--assistant">
      <div className="ai-chat-bubble ai-chat-bubble--assistant">
        {groups.map((group, i) => {
          if (group.type === 'text') {
            return (
              <div key={i} className="ai-chat-markdown">
                <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{group.text}</Markdown>
              </div>
            );
          }
          if (group.type === 'reasoning') {
            // Only the trailing reasoning group of the streaming message is
            // still being produced — that's the one worth live-summarizing.
            return (
              <ThinkingBlock
                key={i}
                text={group.text}
                active={isLoading && i === groups.length - 1}
                cacheId={`${messageId}:${i}`}
              />
            );
          }
          if (group.type === 'tools') {
            return (
              <div key={i} className="ai-tool-group">
                {group.parts.map((part, j) => <ToolCard key={j} part={part} citations={citations} />)}
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
      {citations && <SourcesPanel citations={citations} />}
      {fullText && <CopyButton text={fullText} />}
    </div>
  );
}

/**
 * A single chat message (assistant bubble or user bubble), memoized so that a
 * streaming token — which replaces only the last message's object — re-renders
 * just that message instead of re-parsing every message's markdown. The AI SDK
 * preserves the object identity of completed messages across streaming updates,
 * so `React.memo` skips them. `isLoading` is `false` for every message except
 * the actively streaming one, keeping completed messages stable as status flips.
 */
const MessageItem = React.memo(function MessageItem({ message, isLoading }) {
  const isAssistant = message.role === 'assistant';
  // Keyed on parts: a stable reference (completed message) returns the cached
  // result; only the streaming message's parts change, so only it recomputes.
  const groups = useMemo(
    () => (isAssistant ? groupParts(message.parts || []) : null),
    [isAssistant, message.parts],
  );
  const citations = useMemo(
    () => (isAssistant ? extractCitations(message.parts || []) : null),
    [isAssistant, message.parts],
  );

  if (isAssistant) {
    if (groups.length === 0 && !isLoading) return null;
    return <AssistantBubble groups={groups} isLoading={isLoading} citations={citations} messageId={message.id} />;
  }

  const rawText = message.parts?.find(p => p.type === 'text')?.text || message.content;
  const fileParts = message.parts?.filter(p => p.type === 'file') || [];
  // "Add to Chat" references ride along as metadata; show them as quote chips and
  // strip the raw <referenced_passages> delimiter block out of the visible text.
  const refs = message.metadata?.refs;
  const text = refs?.length ? stripReferencedPassages(rawText) : rawText;
  return (
    <div className="ai-chat-bubble-wrap ai-chat-bubble-wrap--user">
      <div className={`ai-chat-bubble ai-chat-bubble--${message.role}`}>
        {refs?.length > 0 && (
          <div className="ai-chat-msg-refs">
            {refs.map((r, i) => (
              <div key={i} className="ai-chat-msg-ref" title={r.text}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span className="ai-chat-msg-ref-text">
                  {r.docTitle ? <span className="ai-chat-msg-ref-doc">{r.docTitle}</span> : null}
                  {r.heading ? <span className="ai-chat-msg-ref-heading">{r.heading}: </span> : null}
                  {r.text}
                </span>
              </div>
            ))}
          </div>
        )}
        {fileParts.length > 0 && (
          <div className="ai-chat-images">
            {fileParts.map((fp, i) =>
              isImageType(fp.mediaType) ? (
                <img key={i} src={fp.url} alt={fp.filename || 'Attached image'} className="ai-chat-image" onClick={() => window.open(fp.url)} />
              ) : (
                <div key={i} className="ai-chat-file-badge">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span>{fp.filename || 'Attachment'}</span>
                </div>
              )
            )}
          </div>
        )}
        {text}
      </div>
      {text && <CopyButton text={text} />}
    </div>
  );
});

function AiChatMessages({ messages, status, onDocLinkClick }) {
  const scrollRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const isLoading = status === 'submitted' || status === 'streaming';

  // Hide the onboarding kickoff (a tagged user turn used only to prompt the
  // assistant's greeting) — it should never appear in the transcript.
  const visibleMessages = useMemo(
    () => messages.filter((m) => m.metadata?.kind !== 'welcome-kickoff'),
    [messages],
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const lastMsg = visibleMessages[visibleMessages.length - 1];
    // Always scroll when the human sends a message; otherwise only scroll if
    // the user hasn't manually scrolled up.
    if (lastMsg?.role === 'user' || isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      isAtBottomRef.current = true;
    }
  }, [visibleMessages, status]);

  const lastMsg = visibleMessages[visibleMessages.length - 1];
  const needsTypingBubble = isLoading && lastMsg?.role !== 'assistant';

  // The most recent completed modify that changed a document — only this part
  // gets an undo/redo button (the agent's UndoManager is a single LIFO stack).
  // Memoized so it isn't rescanned on renders unrelated to a message change.
  const lastModifyPart = useMemo(() => findLastModifyPart(visibleMessages), [visibleMessages]);

  return (
    <DocLinkContext.Provider value={onDocLinkClick || null}>
    <LastModifyContext.Provider value={lastModifyPart}>
      <div className="ai-chat-messages" ref={scrollRef} onScroll={handleScroll}>
        {visibleMessages.map((msg) => (
          <MessageItem key={msg.id} message={msg} isLoading={msg === lastMsg && isLoading} />
        ))}
        {needsTypingBubble && <AssistantBubble groups={[]} isLoading />}
      </div>
    </LastModifyContext.Provider>
    </DocLinkContext.Provider>
  );
}

export default AiChatMessages;
