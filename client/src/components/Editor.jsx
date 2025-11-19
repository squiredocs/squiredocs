import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { useMemo, useEffect } from 'react';
import './Editor.css';

export default function Editor({ ydoc, awareness, provider, userName, userColor, synced, onEditorReady }) {
  const user = useMemo(() => ({
    name: userName || 'Anonymous',
    color: userColor || '#000000'
  }), [userName, userColor]);

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

    // Temporarily disabled CollaborationCursor due to timing issues
    // TODO: Re-enable once provider.awareness is guaranteed to be available
    // if (provider && provider.awareness) {
    //   baseExtensions.push(
    //     CollaborationCursor.configure({
    //       provider: provider,
    //       user: user
    //     })
    //   );
    // }

    return baseExtensions;
  }, [ydoc]);

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

  if (!editor || !ydoc || !synced) {
    return <div className="editor-loading">Loading editor... {!synced ? '(syncing...)' : ''}</div>;
  }

  return (
    <div className="editor-container">
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}

