import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import {
  PREVIEW_CLASS,
  PREVIEW_DATASET,
  cx,
  rasterizeSvg,
} from '../extensions/diagramShared';
import './DiagramNodeView.css';

function isCursorInside(editor, getPos, nodeSize) {
  if (!editor || !editor.isEditable) return false;
  if (!editor.isFocused) return false;
  const pos = getPos();
  if (typeof pos !== 'number') return false;
  const { from, to } = editor.state.selection;
  // Strict containment: selection lives entirely inside the node's text
  // content (pos+1 .. pos+nodeSize-1). A selection that *covers* the node
  // (e.g. Select All) does not count — we don't want to flip into edit
  // mode just because the user selected the whole document.
  return from > pos && to < pos + nodeSize;
}

export default function DiagramNodeView({ editor, node, getPos, extension }) {
  const config = extension.options.diagramConfig;
  const source = useMemo(() => node.textContent || '', [node]);
  const previewRef = useRef(null);
  const renderIdRef = useRef(0);
  const [editing, setEditing] = useState(false);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const readOnly = !editor.isEditable;

  useEffect(() => {
    if (readOnly) {
      setEditing(false);
      return undefined;
    }
    const update = () => {
      setEditing(isCursorInside(editor, getPos, node.nodeSize));
    };
    update();
    editor.on('selectionUpdate', update);
    editor.on('focus', update);
    editor.on('blur', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('focus', update);
      editor.off('blur', update);
    };
  }, [editor, getPos, node.nodeSize, readOnly]);

  useEffect(() => {
    if (editing) return;
    if (!source.trim()) {
      setSvg('');
      setError(null);
      return;
    }
    let cancelled = false;
    const renderId = ++renderIdRef.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const instance = await config.loadRenderer();
        if (cancelled || renderId !== renderIdRef.current) return;
        const rendered = await config.render(source, instance);
        if (cancelled || renderId !== renderIdRef.current) return;
        setSvg(rendered);
        setError(null);
      } catch (err) {
        if (cancelled || renderId !== renderIdRef.current) return;
        setSvg('');
        const format = config.formatError || ((e) => e?.message || String(e));
        setError(format(err));
      } finally {
        if (!cancelled && renderId === renderIdRef.current) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editing, source, config]);

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return undefined;
    el.innerHTML = svg;
    delete el.dataset[PREVIEW_DATASET.pngUrl];
    delete el.dataset[PREVIEW_DATASET.svgWidth];
    delete el.dataset[PREVIEW_DATASET.svgHeight];
    const box = el.parentElement;
    if (!svg) {
      // No diagram yet: let the source editor flow at its natural height.
      if (box) box.style.removeProperty('--diagram-preview-h');
      return undefined;
    }
    const svgEl = el.querySelector('svg');
    if (!svgEl) return undefined;

    // Cap the source editor to the rendered diagram's height: a source taller
    // than the graph should scroll inside the box, not pad the diagram out to
    // match it. The preview reflows with the editor width, so keep the
    // published height in sync via ResizeObserver. (No feedback loop: changing
    // the source's max-height affects row height, not the preview's width.)
    const syncHeight = () => {
      if (box) box.style.setProperty('--diagram-preview-h', `${el.offsetHeight}px`);
    };
    syncHeight();
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncHeight) : null;
    if (ro) ro.observe(el);

    let cancelled = false;
    rasterizeSvg(svgEl, { scale: config.exportScale || 2 })
      .then(({ pngUrl, width, height }) => {
        if (cancelled || !previewRef.current) return;
        const ds = previewRef.current.dataset;
        ds[PREVIEW_DATASET.pngUrl] = pngUrl;
        ds[PREVIEW_DATASET.svgWidth] = String(width);
        ds[PREVIEW_DATASET.svgHeight] = String(height);
        delete ds[PREVIEW_DATASET.rasterError];
      })
      .catch((err) => {
        // Leave SVG fallback in place but surface why rasterization failed.
        // Common culprit: canvas tainting from SVG features the browser
        // refuses to draw cleanly.
        console.warn('Diagram PNG rasterization failed:', err);
        if (previewRef.current) {
          previewRef.current.dataset[PREVIEW_DATASET.rasterError] =
            err?.message || String(err);
        }
      });
    return () => {
      cancelled = true;
      if (ro) ro.disconnect();
    };
  }, [svg, config]);

  // Always-rendered preview (when svg or loading) keeps the wrapper height
  // stable across the edit/blur toggle — CSS grid stacks preview and source
  // in the same cell, so the box sizes to max(preview, source).
  const renderPreview = Boolean(svg) && !error;
  const renderLoading = !renderPreview && loading && !error;

  const focusSource = () => {
    if (readOnly) return;
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.chain().focus().setTextSelection(pos + 1).run();
  };

  // The Edit/Done button drives the same selection-based edit state the cursor
  // does: "Edit" drops the caret into the source (→ editing), "Done" selects the
  // whole node as a block (caret no longer inside → preview), keeping focus in
  // the editor rather than jumping the cursor elsewhere.
  const toggleEdit = () => {
    if (readOnly) return;
    if (!editing) {
      focusSource();
      return;
    }
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.chain().focus().setNodeSelection(pos).run();
  };

  // A rendered diagram can be opened fullscreen. Close on Escape; the listener
  // only exists while expanded.
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded]);

  const hasOverlay = renderPreview || renderLoading;
  const canExpand = renderPreview; // something rendered and not in an error state

  return (
    <NodeViewWrapper
      className={cx(
        'diagram-node',
        editing && 'is-editing',
        readOnly && 'is-readonly',
        error && 'is-error',
      )}
      data-type={config.name}
    >
      {(canExpand || !readOnly) && (
        <div className="diagram-controls" contentEditable={false}>
          {canExpand && (
            <button
              type="button"
              className="diagram-control-btn"
              // Keep the editor's selection intact until our own handler runs.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setExpanded(true)}
              aria-label="Expand diagram to fullscreen"
            >
              Expand
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              className="diagram-control-btn diagram-edit-toggle"
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleEdit}
              aria-label={editing ? 'Finish editing diagram' : 'Edit diagram source'}
            >
              {editing ? 'Done' : 'Edit'}
            </button>
          )}
        </div>
      )}
      <div className={cx('diagram-content-box', hasOverlay && 'has-overlay')}>
        {renderPreview && (
          <div className={PREVIEW_CLASS} ref={previewRef} contentEditable={false} />
        )}
        {renderLoading && (
          <div
            className={cx(PREVIEW_CLASS, 'diagram-loading')}
            contentEditable={false}
          >
            Rendering diagram…
          </div>
        )}
        <NodeViewContent as="pre" className="diagram-source" />
      </div>
      {error && !editing && (
        <div
          className="diagram-error"
          contentEditable={false}
          onClick={focusSource}
        >
          <span className="diagram-error-label">Diagram error</span>
          <span className="diagram-error-message">{error}</span>
        </div>
      )}
      {expanded &&
        svg &&
        createPortal(
          <div
            className="diagram-fullscreen"
            role="dialog"
            aria-modal="true"
            aria-label="Expanded diagram"
            onClick={() => setExpanded(false)}
          >
            <button
              type="button"
              className="diagram-fullscreen-close"
              onClick={() => setExpanded(false)}
              aria-label="Close expanded diagram"
            >
              ✕
            </button>
            {/* Reuse the already-rendered SVG string; stop backdrop clicks on it.
                CSS sizes it to the viewport via its viewBox. */}
            <div
              className="diagram-fullscreen-canvas"
              onClick={(e) => e.stopPropagation()}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>,
          document.body,
        )}
    </NodeViewWrapper>
  );
}
