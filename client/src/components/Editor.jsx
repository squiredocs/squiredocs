import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursorWithSelection from './CollaborationCursorWithSelection';
import { useMemo, useEffect, useRef, useCallback } from 'react';
import './Editor.css';

// Create cursor element with label
function renderCursor(user) {
  const cursor = document.createElement('span');
  cursor.classList.add('collaboration-cursor__caret');
  cursor.style.borderColor = user.color;

  const label = document.createElement('span');
  label.classList.add('collaboration-cursor__label');
  label.style.backgroundColor = user.color;
  label.textContent = user.name;
  cursor.appendChild(label);

  return cursor;
}

// Convert any color format to rgba with opacity
function colorToRgba(color, opacity) {
  // Create a temporary element to parse the color
  const temp = document.createElement('div');
  temp.style.color = color;
  document.body.appendChild(temp);
  const computed = getComputedStyle(temp).color;
  document.body.removeChild(temp);
  
  // computed is in format "rgb(r, g, b)" or "rgba(r, g, b, a)"
  const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${opacity})`;
  }
  // Fallback
  return `rgba(0, 0, 0, ${opacity})`;
}

// Create selection highlight - returns decoration ATTRIBUTES, not a DOM element
function renderSelection(user) {
  const bgColor = colorToRgba(user.color, 0.3);
  return {
    style: `background-color: ${bgColor};`,
    class: 'collaboration-cursor__selection',
  };
}

export default function Editor({ ydoc, awareness, provider, user: userInfo, synced, onEditorReady }) {
  const hideTimeoutRef = useRef(null);

  const user = useMemo(() => ({
    name: userInfo?.name || 'Anonymous',
    color: userInfo?.color || '#000000',
    picture: userInfo?.picture,
    email: userInfo?.email
  }), [userInfo]);

  // Show all cursor labels, then hide after 2 seconds
  const showCursorLabels = useCallback(() => {
    document.querySelectorAll('.collaboration-cursor__label')
      .forEach(label => label.classList.add('collaboration-cursor__label--visible'));

    // Clear existing timeout
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }

    // Hide after 2 seconds (query fresh elements)
    hideTimeoutRef.current = setTimeout(() => {
      document.querySelectorAll('.collaboration-cursor__label')
        .forEach(label => label.classList.remove('collaboration-cursor__label--visible'));
    }, 2000);
  }, []);

  const extensions = useMemo(() => {
    const baseExtensions = [
      StarterKit.configure({
        history: false // Disable built-in history, Yjs handles it
      }),
      Underline,
      Collaboration.configure({
        document: ydoc,
        field: 'default' // Field name in Yjs document for ProseMirror content
      })
    ];

    if (provider) {
      baseExtensions.push(
        CollaborationCursorWithSelection.configure({
          provider,
          user,
          render: renderCursor,
          selectionRender: renderSelection,
        })
      );
    }

    return baseExtensions;
  }, [ydoc, provider, user]);

  const editor = useEditor({
    extensions,
    // Don't set initial content - let Yjs Collaboration extension handle it
    // The Collaboration extension will sync content from Yjs
  });

  // Notify parent when editor is ready
  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  // Track cursor movements and selection changes via awareness, show labels
  useEffect(() => {
    if (!awareness) return;

    // Show all labels on initial load (slight delay for DOM to render cursors)
    const initTimeout = setTimeout(showCursorLabels, 100);

    const handleAwarenessChange = ({ added, updated }) => {
      // Show labels whenever any user's cursor/selection state changes
      // This catches all cases including double/triple click selections
      const changedIds = [...added, ...updated];
      
      // Check if any changed user has cursor data
      const hasCursorChange = changedIds.some(clientId => {
        const state = awareness.getStates().get(clientId);
        return state?.cursor != null;
      });

      if (hasCursorChange || added.length > 0) {
        showCursorLabels();
      }
    };

    awareness.on('change', handleAwarenessChange);

    return () => {
      clearTimeout(initTimeout);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      awareness.off('change', handleAwarenessChange);
    };
  }, [awareness, showCursorLabels]);

  if (!editor || !ydoc || !synced) {
    return <div className="editor-loading">Loading editor... {!synced ? '(syncing...)' : ''}</div>;
  }

  return (
    <div className="editor-container">
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}

