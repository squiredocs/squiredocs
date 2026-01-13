import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { TextStyle, Color, BackgroundColor, FontFamily, FontSize, LineHeight } from '@tiptap/extension-text-style';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursorWithSelection from './CollaborationCursorWithSelection';
import LinkPreview from './LinkPreview';
import { useMemo, useEffect, useRef, useCallback, useState } from 'react';
import { useMobile } from '../hooks/useMobile';
import { shouldUseBrowserLinkBehavior } from '../utils/linkBehavior';
import { colorToRgba } from '../utils/colorUtils';
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

// Create selection highlight - returns decoration ATTRIBUTES, not a DOM element
function renderSelection(user) {
  const bgColor = colorToRgba(user.color, 0.3);
  return {
    style: `background-color: ${bgColor};`,
    class: 'collaboration-cursor__selection',
  };
}

export default function Editor({ ydoc, awareness, provider, onEditorReady, onShowLabelsReady, editable = true, synced = false }) {
  const hideTimeoutRef = useRef(null);
  const lastLocalLabelShowRef = useRef(0); // Track when labels were last shown due to local cursor movement
  const containerRef = useRef(null);
  const labelsVisibleRef = useRef(false); // Track if labels should currently be visible
  const mutationObserverRef = useRef(null); // Track MutationObserver
  const [linkPreview, setLinkPreview] = useState(null);
  const isMobile = useMobile();

  // Show all cursor labels, then hide after 2 seconds
  const showCursorLabels = useCallback(() => {
    // Set visibility state to true
    labelsVisibleRef.current = true;

    // Apply visibility to existing labels immediately
    document.querySelectorAll('.collaboration-cursor__label')
      .forEach(label => label.classList.add('collaboration-cursor__label--visible'));

    // Re-query after DOM updates to catch newly created cursor elements
    // This handles the race condition where yCursorPlugin creates new cursors
    // after the initial query (especially when moving to start of list items)
    requestAnimationFrame(() => {
      document.querySelectorAll('.collaboration-cursor__label')
        .forEach(label => label.classList.add('collaboration-cursor__label--visible'));
    });

    // Clear existing timeout
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }

    // Hide after 2 seconds (query fresh elements)
    hideTimeoutRef.current = setTimeout(() => {
      labelsVisibleRef.current = false;
      document.querySelectorAll('.collaboration-cursor__label')
        .forEach(label => label.classList.remove('collaboration-cursor__label--visible'));
    }, 2000);
  }, []);

  const extensions = useMemo(() => {
    const baseExtensions = [
      StarterKit.configure({
        undoRedo: false, // Disable built-in undo/redo, Yjs handles it
        link: false, // Disable built-in Link, we configure it separately below
        // underline is included in StarterKit by default in v3
      }),
      Highlight.configure({ multicolor: false }),
      Subscript,
      Superscript,
      TextStyle,
      Color,
      BackgroundColor,
      FontFamily,
      FontSize,
      LineHeight,
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      Link.configure({
        openOnClick: false, // Prevent default link navigation in editor
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
    shouldRerenderOnTransaction: true, // Enable rerendering for toolbar active states
    // Don't set initial content - let Yjs Collaboration extension handle it
    // The Collaboration extension will sync content from Yjs
    editorProps: {
      // Keep cursor visible above the mobile format bar when scrolling into view
      scrollMargin: isMobile ? { top: 20, bottom: 100, left: 0, right: 0 } : 20,
      scrollThreshold: isMobile ? { top: 20, bottom: 100, left: 0, right: 0 } : 20,
    },
  }, [isMobile, provider]); // Include provider so editor reinitializes with new CollaborationCursor after token refresh

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

  // Provide showCursorLabels function to parent
  useEffect(() => {
    if (onShowLabelsReady) {
      onShowLabelsReady(showCursorLabels);
    }
  }, [onShowLabelsReady, showCursorLabels]);

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

  // Set up MutationObserver to watch for newly created cursor labels
  // This catches cursors that are created/recreated by yCursorPlugin after we apply visibility
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new MutationObserver((mutations) => {
      // Only process if labels should be visible
      if (!labelsVisibleRef.current) return;

      // Check all added nodes for cursor labels
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          // Check if the added node is a cursor label
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node;

            // If it's a label itself
            if (element.classList?.contains('collaboration-cursor__label')) {
              element.classList.add('collaboration-cursor__label--visible');
            }

            // Or if it contains labels
            const labels = element.querySelectorAll?.('.collaboration-cursor__label');
            if (labels) {
              labels.forEach(label => label.classList.add('collaboration-cursor__label--visible'));
            }
          }
        }
      }
    });

    // Observe the editor container for added nodes
    observer.observe(containerRef.current, {
      childList: true,
      subtree: true, // Watch all descendants
    });

    mutationObserverRef.current = observer;

    return () => {
      observer.disconnect();
      mutationObserverRef.current = null;
    };
  }, []);

  // Track cursor movements and selection changes via awareness, show labels
  useEffect(() => {
    if (!awareness) return;

    // Show all labels on initial load (slight delay for DOM to render cursors)
    const initTimeout = setTimeout(showCursorLabels, 100);

    const handleAwarenessChange = ({ added, updated }) => {
      const localClientId = awareness.clientID;
      const now = Date.now();

      // Check for remote user changes
      const changedIds = [...added, ...updated];
      const hasRemoteChange = changedIds.some(clientId => {
        if (clientId === localClientId) {
          return false; // Skip local user
        }
        const state = awareness.getStates().get(clientId);
        return state?.cursor != null;
      });

      // Check if local user cursor changed
      const hasLocalCursorChange = updated.includes(localClientId) &&
        awareness.getStates().get(localClientId)?.cursor != null;

      // Show labels if:
      // 1. Remote users changed (always show)
      // 2. New users joined (always show)
      // 3. Local cursor changed AND it's been >60 seconds since last local show (debounced)
      if (hasRemoteChange || added.length > 0) {
        showCursorLabels();
        // Update timestamp when showing due to remote changes
        if (hasRemoteChange) {
          lastLocalLabelShowRef.current = now;
        }
      } else if (hasLocalCursorChange) {
        const timeSinceLastLocalShow = now - lastLocalLabelShowRef.current;
        if (timeSinceLastLocalShow > 60000) { // 60 seconds
          showCursorLabels();
          lastLocalLabelShowRef.current = now;
        }
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

    // Note: Clicks that move the cursor will trigger awareness changes
    // and go through the same debounced label logic as arrow key navigation
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

