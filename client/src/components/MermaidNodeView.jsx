import { useEffect, useMemo, useRef, useState } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
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

function getSourceText(node) {
  let text = '';
  node.descendants((child) => {
    if (child.isText) text += child.text;
  });
  return text;
}

async function rasterizeSvg(svgEl) {
  const clone = svgEl.cloneNode(true);
  // Make sure the standalone SVG has its namespace declared — XMLSerializer
  // doesn't always re-emit it when the element was attached to an HTML doc,
  // and an <img> loading SVG without xmlns will reject decode().
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  const viewBox = clone.viewBox && clone.viewBox.baseVal;
  const w = (viewBox && viewBox.width) || parseFloat(clone.getAttribute('width')) || 800;
  const h = (viewBox && viewBox.height) || parseFloat(clone.getAttribute('height')) || 600;
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.removeAttribute('style');

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
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { pngUrl: canvas.toDataURL('image/png'), width: w, height: h };
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
  const source = useMemo(() => getSourceText(node), [node]);
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
    delete el.dataset.pngUrl;
    delete el.dataset.svgWidth;
    delete el.dataset.svgHeight;
    if (!svg) return undefined;
    const svgEl = el.querySelector('svg');
    if (!svgEl) return undefined;
    let cancelled = false;
    rasterizeSvg(svgEl)
      .then(({ pngUrl, width, height }) => {
        if (cancelled || !previewRef.current) return;
        previewRef.current.dataset.pngUrl = pngUrl;
        previewRef.current.dataset.svgWidth = String(width);
        previewRef.current.dataset.svgHeight = String(height);
        delete previewRef.current.dataset.rasterError;
      })
      .catch((err) => {
        // Leave SVG fallback in place but surface why rasterization failed.
        // Common culprit: canvas tainting from SVG features the browser
        // refuses to draw cleanly.
        const message = err?.message || String(err);
        console.warn('Mermaid PNG rasterization failed:', err);
        if (previewRef.current) {
          previewRef.current.dataset.rasterError = message;
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
      className={`mermaid-node${editing ? ' is-editing' : ''}${readOnly ? ' is-readonly' : ''}${error ? ' is-error' : ''}`}
      data-type="mermaid"
    >
      <div className={`mermaid-content-box${hasOverlay ? ' has-overlay' : ''}`}>
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
