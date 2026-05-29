import { useEffect, useMemo, useRef, useState } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import { PREVIEW_DATASET, cx, prepareSvgForExport } from '../extensions/mermaidShared';
import './MermaidNodeView.css';

let mermaidPromise = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        fontFamily: 'inherit',
        // Render labels as SVG <text> instead of <foreignObject> so the
        // rendered diagram can be drawn into a <canvas> without tainting
        // it (foreignObject SVGs throw SecurityError on toDataURL).
        flowchart: { htmlLabels: false },
        class: { htmlLabels: false },
        state: { htmlLabels: false },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

async function rasterizeSvg(svgEl) {
  const clone = svgEl.cloneNode(true);
  const { width, height } = prepareSvgForExport(clone);

  const xml = new XMLSerializer().serializeToString(clone);
  // Base64 data URL (more portable than blob: URLs — some browsers refuse to
  // draw blob:-sourced SVGs onto a canvas).
  const dataUrl =
    'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));

  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return { pngUrl: canvas.toDataURL('image/png'), width, height };
}

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

export default function MermaidNodeView({ editor, node, getPos }) {
  const source = useMemo(() => node.textContent || '', [node]);
  const previewRef = useRef(null);
  const renderIdRef = useRef(0);
  const [editing, setEditing] = useState(false);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

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
        const mermaid = await loadMermaid();
        if (cancelled || renderId !== renderIdRef.current) return;
        await mermaid.parse(source);
        const { svg: rendered } = await mermaid.render(
          `mermaid-${renderId}-${Math.random().toString(36).slice(2, 8)}`,
          source,
        );
        if (cancelled || renderId !== renderIdRef.current) return;
        setSvg(rendered);
        setError(null);
      } catch (err) {
        if (cancelled || renderId !== renderIdRef.current) return;
        setSvg('');
        setError(err?.message || String(err));
      } finally {
        if (!cancelled && renderId === renderIdRef.current) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editing, source]);

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return undefined;
    el.innerHTML = svg;
    delete el.dataset[PREVIEW_DATASET.pngUrl];
    delete el.dataset[PREVIEW_DATASET.svgWidth];
    delete el.dataset[PREVIEW_DATASET.svgHeight];
    if (!svg) return undefined;
    const svgEl = el.querySelector('svg');
    if (!svgEl) return undefined;
    let cancelled = false;
    rasterizeSvg(svgEl)
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
        console.warn('Mermaid PNG rasterization failed:', err);
        if (previewRef.current) {
          previewRef.current.dataset[PREVIEW_DATASET.rasterError] =
            err?.message || String(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [svg]);

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

  const hasOverlay = renderPreview || renderLoading;

  return (
    <NodeViewWrapper
      className={cx(
        'mermaid-node',
        editing && 'is-editing',
        readOnly && 'is-readonly',
        error && 'is-error',
      )}
      data-type="mermaid"
    >
      <div className={cx('mermaid-content-box', hasOverlay && 'has-overlay')}>
        {renderPreview && (
          <div
            className="mermaid-preview"
            ref={previewRef}
            contentEditable={false}
            onClick={focusSource}
          />
        )}
        {renderLoading && (
          <div className="mermaid-preview mermaid-loading" contentEditable={false}>
            Rendering diagram…
          </div>
        )}
        <NodeViewContent as="pre" className="mermaid-source" />
      </div>
      {error && !editing && (
        <div
          className="mermaid-error"
          contentEditable={false}
          onClick={focusSource}
        >
          <span className="mermaid-error-label">Diagram error</span>
          <span className="mermaid-error-message">{error}</span>
        </div>
      )}
    </NodeViewWrapper>
  );
}
