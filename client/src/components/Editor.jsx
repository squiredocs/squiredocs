import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursorWithSelection from './CollaborationCursorWithSelection';
import LinkPreview from './LinkPreview';
import { useMemo, useEffect, useRef, useCallback, useState } from 'react';
import { useMobile } from '../hooks/useMobile';
import { shouldUseBrowserLinkBehavior } from '../utils/linkBehavior';
import './EditorCommon.css';
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

export default function Editor({ ydoc, awareness, provider, onEditorReady, editable = true, synced = false }) {
  const hideTimeoutRef = useRef(null);
  const containerRef = useRef(null);
  const [linkPreview, setLinkPreview] = useState(null);
  const isMobile = useMobile();

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
      Link.configure({
        openOnClick: false,
      }),
      Collaboration.configure({
        document: ydoc,
        field: 'default' // Field name in Yjs document for ProseMirror content
      }),
      // Note: yUndoPlugin is automatically included by Collaboration extension
    ];

    if (provider) {
      baseExtensions.push(
        CollaborationCursorWithSelection.configure({
          provider,
          render: renderCursor,
          selectionRender: renderSelection,
        })
      );
    }

    return baseExtensions;
  }, [ydoc, provider]);

  const editor = useEditor({
    extensions,
    editable,
    // Don't set initial content - let Yjs Collaboration extension handle it
    // The Collaboration extension will sync content from Yjs
    editorProps: {
      // Keep cursor visible above the mobile format bar when scrolling into view
      scrollMargin: isMobile ? { top: 20, bottom: 100, left: 0, right: 0 } : 20,
      scrollThreshold: isMobile ? { top: 20, bottom: 100, left: 0, right: 0 } : 20,
    },
  }, [isMobile]);

  // Update editable state when prop changes
  useEffect(() => {
    if (editor && editor.setEditable) {
      editor.setEditable(editable);
    }
  }, [editor, editable]);

  // Notify parent when editor is ready
  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  // Scroll to top when document syncs to prevent browser scroll restoration
  useEffect(() => {
    if (synced && containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [synced]);

  // Scroll cursor into view when virtual keyboard appears (mobile)
  // We manually scroll the editor container rather than using scrollIntoView()
  // to avoid scrolling the entire page (which would hide the header)
  useEffect(() => {
    if (!isMobile || !editor || !containerRef.current || typeof window === 'undefined' || !window.visualViewport) {
      return;
    }

    const viewport = window.visualViewport;
    const container = containerRef.current;
    let lastHeight = viewport.height;

    const handleResize = () => {
      const heightDiff = lastHeight - viewport.height;
      lastHeight = viewport.height;

      // If viewport shrunk significantly (keyboard appeared), scroll cursor into view
      if (heightDiff > 100) {
        // Reset any page-level scroll that the browser may have triggered
        window.scrollTo(0, 0);

        // Wait for scroll reset to take effect, then adjust container scroll
        requestAnimationFrame(() => {
          try {
            // Get cursor position
            const { from } = editor.state.selection;
            const coords = editor.view.coordsAtPos(from);

            // The format bar is ~60px tall, positioned at bottom of visual viewport
            // Cursor should stay above it with some padding
            const maxVisibleY = viewport.height - 80;

            // If cursor is below the safe visible area, scroll container
            if (coords.bottom > maxVisibleY) {
              const scrollAmount = coords.bottom - maxVisibleY + 20;
              container.scrollTop += scrollAmount;
            }
          } catch (e) {
            // Ignore errors if editor state is unavailable
          }
        });
      }
    };

    viewport.addEventListener('resize', handleResize);
    return () => viewport.removeEventListener('resize', handleResize);
  }, [isMobile, editor]);

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

  // Handle clicks on links to show preview
  const handleClick = useCallback((event) => {
    // Don't close if clicking inside the link preview
    if (event.target.closest('.link-preview')) {
      return;
    }

    const link = event.target.closest('a');
    if (link) {
      // Allow standard browser behaviors (Cmd+Click, Ctrl+Click, middle-click, etc.)
      if (shouldUseBrowserLinkBehavior(event)) {
        return; // Let the browser handle it
      }

      // For normal clicks, show link preview instead of navigating
      event.preventDefault();
      const href = link.getAttribute('href');
      const text = link.textContent;
      const rect = link.getBoundingClientRect();
      setLinkPreview({
        href,
        text,
        top: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
      });
    } else {
      setLinkPreview(null);
    }
  }, []);

  const handleCopyLink = useCallback(() => {
    if (linkPreview?.href) {
      navigator.clipboard.writeText(linkPreview.href);
    }
    setLinkPreview(null);
  }, [linkPreview]);

  const handleEditLink = useCallback((newText, newUrl) => {
    if (newUrl === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      // Extend selection to cover the entire link, then replace it
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .command(({ tr, state }) => {
          const { $from, $to } = state.selection;
          const from = $from.pos;
          const to = $to.pos;
          
          // Delete the old link content
          tr.delete(from, to);
          
          // Insert new text with link mark
          const textToInsert = newText || newUrl;
          tr.insertText(textToInsert, from);
          
          // Apply link mark to the inserted text
          const linkMark = state.schema.marks.link.create({ href: newUrl });
          tr.addMark(from, from + textToInsert.length, linkMark);
          
          // Set cursor position after the link
          const newPos = from + textToInsert.length;
          tr.setSelection(state.selection.constructor.near(tr.doc.resolve(newPos)));
          
          return true;
        })
        .run();
    }
    setLinkPreview(null);
  }, [editor]);

  const handleRemoveLink = useCallback(() => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkPreview(null);
  }, [editor]);

  const handleOpenLink = useCallback(() => {
    if (linkPreview?.href) {
      window.open(linkPreview.href, '_blank', 'noopener,noreferrer');
    }
    setLinkPreview(null);
  }, [linkPreview]);

  if (!editor) {
    return null;
  }

  return (
    <div className="editor-common-container editor-container" ref={containerRef} onClick={handleClick}>
      <EditorContent editor={editor} className="editor-common-content editor-content" />
      {linkPreview && (
        <LinkPreview
          href={linkPreview.href}
          text={linkPreview.text}
          top={linkPreview.top}
          left={linkPreview.left}
          onCopy={handleCopyLink}
          onEdit={handleEditLink}
          onRemove={handleRemoveLink}
          onOpen={handleOpenLink}
          onClose={() => setLinkPreview(null)}
        />
      )}
    </div>
  );
}

