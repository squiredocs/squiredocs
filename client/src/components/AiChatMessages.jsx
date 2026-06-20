import React, { useState, useEffect, useRef, useCallback, useContext, createContext } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../contexts/AuthContext';
import { useAiChat } from '../contexts/AiChatContext';

const isImageType = (t) => t?.startsWith('image/');

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
  export_to_google_docs: 'Exporting to Google Docs',
  import_from_google_docs: 'Importing from Google Docs',
  list_google_docs: 'Listing Google Docs',
  _compacting: 'Compacting conversation',
};

// Non-doc tools use standalone labels; everything else is a doc-scoped tool
const NON_DOC_TOOLS = new Set([
  'list_documents', 'webSearch', 'webFetch', '_compacting',
  'export_to_google_docs', 'import_from_google_docs', 'list_google_docs',
]);
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

// Holds the most recent completed `modify` part that actually changed a document.
// The undo/redo button is rendered only on that part: the agent's UndoManager is a
// single LIFO stack, so only the latest edit can be undone.
const LastModifyContext = createContext(null);

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

function GoogleDocsListView({ documents, pagination }) {
  if (!documents || documents.length === 0) return null;
  return (
    <ul className="ai-doc-list">
      {documents.map((doc) => (
        <li key={doc.id}>
          <a
            href={doc.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ai-tool-card-link"
          >
            {doc.title || 'Untitled'}
          </a>
          {doc.linkedSquireDocGuid && (
            <span className="ai-doc-list-role"> linked</span>
          )}
        </li>
      ))}
      {pagination && pagination.hasMore && (
        <li className="ai-doc-list-more">more available…</li>
      )}
    </ul>
  );
}

function GoogleDocResultView({ title, url, linkPrefix }) {
  if (!title || !url) return null;
  return (
    <ul className="ai-doc-list">
      <li>
        {linkPrefix && <span>{linkPrefix} </span>}
        <a href={url} target="_blank" rel="noopener noreferrer" className="ai-tool-card-link">
          {title}
        </a>
      </li>
    </ul>
  );
}

function WebSearchResultsView({ sources }) {
  if (!sources || sources.length === 0) return null;
  return (
    <ul className="ai-web-results-list">
      {sources.map((src) => {
        let hostname = '';
        try { hostname = new URL(src.url).hostname; } catch (_) {}
        return (
          <li key={src.url}>
            <a href={src.url} target="_blank" rel="noopener noreferrer" className="ai-source-link">
              {hostname && <img src={`https://www.google.com/s2/favicons?sz=16&domain=${hostname}`} alt="" className="ai-source-favicon" />}
              <span className="ai-source-title">{src.title || hostname || src.url}</span>
            </a>
          </li>
        );
      })}
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
  const isListGoogleDocs = toolName === 'list_google_docs';
  const isExportGoogleDocs = toolName === 'export_to_google_docs';
  const isImportGoogleDocs = toolName === 'import_from_google_docs';

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

  const showDetail = hasInput && !isModify && !isCreate && !isListDocs && !isWebSearch
    && !isListGoogleDocs && !isExportGoogleDocs && !isImportGoogleDocs;

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

  // Google Docs tool results
  const googleDocsList = (isListGoogleDocs && isComplete && part.output?.documents) || null;
  const googleDocsPagination = (isListGoogleDocs && isComplete && part.output?.pagination) || null;
  const googleExportResult = (isExportGoogleDocs && isComplete && !part.output?.error
    && part.output?.title && part.output?.url) ? {
    title: part.output.title,
    url: part.output.url,
    action: part.output.action,
  } : null;
  const googleImportResult = (isImportGoogleDocs && isComplete && !part.output?.error
    && part.output?.title && part.output?.url) ? {
    title: part.output.title,
    url: part.output.url,
    docGuid: part.output.docGuid,
    action: part.output.action,
  } : null;

  const diff = (isModify && isComplete && part.output?.diff) || null;
  const isFormatOnly = isModify && isComplete && part.output?.changed && !diff;

  const verb = getToolLabel(toolName);

  // Build inline summary for list_documents (e.g. "— search "Cheryl"")
  const listDocsSuffix = isListDocs && input
    ? [input.search && `search \u201c${input.search}\u201d`, input.filter && input.filter !== 'all' && input.filter]
        .filter(Boolean).join(', ')
    : '';
  const webSearchSuffix = isWebSearch && input?.query ? `\u201c${input.query}\u201d` : '';
  const listGoogleDocsSuffix = isListGoogleDocs && input?.query ? `\u201c${input.query}\u201d` : '';

  return (
    <div className="ai-tool-card">
      <div
        className={`ai-tool-card-toggle ${isComplete ? 'ai-tool-card--complete' : 'ai-tool-card--running'}${docList || webSearchSources || googleDocsList || googleExportResult || googleImportResult ? ' ai-tool-card--has-list' : ''}`}
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
          {listGoogleDocsSuffix && ` \u2014 ${listGoogleDocsSuffix}`}
          {isComplete ? ' \u2713' : '...'}{showDetail ? (expanded ? ' \u25B4' : ' \u25BE') : ''}
        </span>
        {docList && <DocumentListView documents={docList} pagination={docListPagination} />}
        {webSearchSources && <WebSearchResultsView sources={webSearchSources} />}
        {googleDocsList && <GoogleDocsListView documents={googleDocsList} pagination={googleDocsPagination} />}
        {googleExportResult && <GoogleDocResultView title={googleExportResult.title} url={googleExportResult.url} />}
        {googleImportResult && googleImportResult.docGuid && (
          <ul className="ai-doc-list">
            <li>
              <DocTitleLink docGuid={googleImportResult.docGuid} title={googleImportResult.title} />
              <span className="ai-doc-list-role"> from <a href={part.output?.googleDocUrl} target="_blank" rel="noopener noreferrer" className="ai-tool-card-link">Google Doc</a></span>
            </li>
          </ul>
        )}
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
          {sources.map((src, i) => {
            let hostname = '';
            try { hostname = new URL(src.url).hostname; } catch (_) {}
            return (
              <li key={src.url}>
                <a href={src.url} target="_blank" rel="noopener noreferrer" className="ai-source-link">
                  {hostname && <img src={`https://www.google.com/s2/favicons?sz=16&domain=${hostname}`} alt="" className="ai-source-favicon" />}
                  <span className="ai-source-title">{src.title || hostname || src.url}</span>
                  <span className="ai-source-index">[{i + 1}]</span>
                </a>
              </li>
            );
          })}
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

function AssistantBubble({ groups, isLoading, citations }) {
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
            return <ThinkingBlock key={i} text={group.text} />;
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

  // The most recent completed modify that changed a document — only this part
  // gets an undo/redo button (the agent's UndoManager is a single LIFO stack).
  const lastModifyPart = findLastModifyPart(messages);

  return (
    <DocLinkContext.Provider value={onDocLinkClick || null}>
    <LastModifyContext.Provider value={lastModifyPart}>
      <div className="ai-chat-messages" ref={scrollRef} onScroll={handleScroll}>
        {messages.map((msg) => {
          if (msg.role === 'assistant') {
            const groups = msg === lastMsg ? lastGroups : groupParts(msg.parts || []);
            const citations = extractCitations(msg.parts || []);
            if (groups.length === 0 && !isLoading) return null;
            return <AssistantBubble key={msg.id} groups={groups} isLoading={msg === lastMsg && isLoading} citations={citations} />;
          }
          const text = msg.parts?.find(p => p.type === 'text')?.text || msg.content;
          const fileParts = msg.parts?.filter(p => p.type === 'file') || [];
          return (
            <div key={msg.id} className="ai-chat-bubble-wrap ai-chat-bubble-wrap--user">
              <div className={`ai-chat-bubble ai-chat-bubble--${msg.role}`}>
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
        })}
        {needsTypingBubble && <AssistantBubble groups={[]} isLoading />}
      </div>
    </LastModifyContext.Provider>
    </DocLinkContext.Provider>
  );
}

export default AiChatMessages;
