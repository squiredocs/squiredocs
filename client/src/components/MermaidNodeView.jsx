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

function isCursorInside(editor, getPos, nodeSize) {
  if (!editor || !editor.isEditable) return false;
  if (!editor.isFocused) return false;
  const pos = getPos();
  if (typeof pos !== 'number') return false;
  const { from, to } = editor.state.selection;
  return from >= pos && to <= pos + nodeSize;
}

export default function MermaidNodeView({ editor, node, getPos, selected }) {
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
      setEditing(isCursorInside(editor, getPos, node.nodeSize) || selected);
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
  }, [editor, getPos, node.nodeSize, selected, readOnly]);

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
    if (previewRef.current) previewRef.current.innerHTML = svg;
  }, [svg]);

  const hasRenderedSvg = !editing && Boolean(svg) && !error;
  const showPreview = !editing && (hasRenderedSvg || (loading && !error));
  const showSource = editing || !hasRenderedSvg;

  const focusSource = () => {
    if (readOnly) return;
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.chain().focus().setTextSelection(pos + 1).run();
  };

  return (
    <NodeViewWrapper
      className={`mermaid-node${editing ? ' is-editing' : ''}${readOnly ? ' is-readonly' : ''}${error ? ' is-error' : ''}`}
      data-type="mermaid"
    >
      {showPreview && hasRenderedSvg && (
        <div
          className="mermaid-preview"
          ref={previewRef}
          contentEditable={false}
          onClick={focusSource}
        />
      )}
      {showPreview && !hasRenderedSvg && loading && (
        <div className="mermaid-preview mermaid-loading" contentEditable={false}>
          Rendering diagram…
        </div>
      )}
      <NodeViewContent
        as="pre"
        className="mermaid-source"
        style={showSource ? undefined : { display: 'none' }}
      />
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
