import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * PersistentSelectionHighlight
 *
 * Keeps the local user's text selection visibly highlighted after the editor
 * loses focus (e.g. when they click into the AI chat textarea). The native
 * browser selection is dropped on blur, so we paint our own inline decoration
 * over the range instead, and clear it when the editor regains focus (the native
 * selection then takes over).
 *
 * Decoration-only — it adds no schema and never mutates the document, so it's
 * collaboration-safe: the highlight maps through transactions (including remote
 * edits) and stays anchored to the right words while it's shown.
 *
 * The plugin is exported separately from the extension so it can be unit-tested
 * against a bare EditorState without spinning up a full TipTap editor.
 */
export const persistentSelectionHighlightKey = new PluginKey('persistentSelectionHighlight');

const PAINT_CLASS = 'persisted-selection';

// Clear the frozen highlight if one is currently shown (guarded so normal typing
// with no highlight present doesn't dispatch a no-op transaction every keystroke).
function clearHighlightIfPresent(view) {
  const deco = persistentSelectionHighlightKey.getState(view.state);
  if (deco && deco.find().length) {
    view.dispatch(view.state.tr.setMeta(persistentSelectionHighlightKey, { type: 'clear' }));
  }
}

export function persistentSelectionHighlightPlugin() {
  return new Plugin({
    key: persistentSelectionHighlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, deco) {
        const meta = tr.getMeta(persistentSelectionHighlightKey);
        if (meta?.type === 'clear') return DecorationSet.empty;
        if (meta?.type === 'paint') {
          const { from, to } = meta;
          if (from >= to) return DecorationSet.empty; // empty range → nothing to hold
          return DecorationSet.create(tr.doc, [
            Decoration.inline(from, to, { class: PAINT_CLASS }),
          ]);
        }
        // No command this tick — keep the highlight but remap it so it tracks
        // document changes (e.g. a collaborator typing) while we stay blurred.
        return deco.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return persistentSelectionHighlightKey.getState(state);
      },
      handleDOMEvents: {
        // On blur, freeze the current non-empty selection as a decoration.
        blur: (view) => {
          const { from, to } = view.state.selection;
          if (from < to) {
            view.dispatch(view.state.tr.setMeta(persistentSelectionHighlightKey, { type: 'paint', from, to }));
          }
          return false;
        },
        // Drop the frozen highlight as soon as the user interacts with the editor
        // again (clicks or types in it) — the live native selection takes over.
        //
        // We clear on interaction rather than on `focus` because `focus` is
        // unreliable here: when the chat panel is already open, adding a
        // selection to chat never blurs the editor (the tag preventDefaults its
        // mousedown, and nothing re-focuses the input), so no later `focus` event
        // ever fires to clear the highlight. A mouseup/keydown in the editor fires
        // regardless of whether focus actually changed.
        //
        // mouseup (not mousedown): dispatching mid-mousedown would run while
        // ProseMirror is starting its own click/drag-selection handling and can
        // interfere with it; mouseup fires after PM has finished.
        mouseup: (view) => { clearHighlightIfPresent(view); return false; },
        keydown: (view) => { clearHighlightIfPresent(view); return false; },
      },
    },
  });
}

export const PersistentSelectionHighlight = Extension.create({
  name: 'persistentSelectionHighlight',
  addProseMirrorPlugins() {
    return [persistentSelectionHighlightPlugin()];
  },
});

export default PersistentSelectionHighlight;
