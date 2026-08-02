import { useState, useEffect } from 'react';
import { yUndoPluginKey } from '@tiptap/y-tiptap';

/**
 * Live undo/redo availability for a collaborative TipTap editor.
 *
 * The answer comes from the y-tiptap undo plugin's own UndoManager, not from
 * TipTap's `editor.can().undo()`: in a Yjs document the local undo stack is
 * per-client (you undo YOUR edits, not a collaborator's), and the plugin's
 * manager is the thing that knows. It is read on `selectionUpdate` and
 * `transaction` because either can change the stacks.
 *
 * The plugin may not be mounted yet on the first read, so a failure is silent
 * and simply leaves the last known answer in place — the next transaction
 * corrects it.
 *
 * Extracted from `MobileActionBar` in feature 042 (FR-015), where it was
 * entangled with that component's list-context state. The desktop toolbar has
 * no undo buttons today; if it ever grows them, this is the hook to use rather
 * than a second copy of the subscription.
 *
 * @param {import('@tiptap/react').Editor|null} editor
 * @returns {{canUndo: boolean, canRedo: boolean}}
 */
export function useYUndoState(editor) {
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    if (!editor) return undefined;

    const updateState = () => {
      try {
        const undoPluginState = yUndoPluginKey.getState(editor.state);
        if (undoPluginState?.undoManager) {
          setCanUndo(undoPluginState.undoManager.undoStack.length > 0);
          setCanRedo(undoPluginState.undoManager.redoStack.length > 0);
        }
      } catch {
        // Plugin may not be ready yet
      }
    };

    editor.on('selectionUpdate', updateState);
    editor.on('transaction', updateState);
    updateState();

    return () => {
      editor.off('selectionUpdate', updateState);
      editor.off('transaction', updateState);
    };
  }, [editor]);

  return { canUndo, canRedo };
}

export default useYUndoState;
