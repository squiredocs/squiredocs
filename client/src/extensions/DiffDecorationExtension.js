/**
 * TipTap Extension for Content-Based Diff Decorations
 *
 * This extension manages ProseMirror decorations for displaying content diffs.
 * Unlike y-prosemirror's snapshot diff which compares CRDT items,
 * this uses prosemirror-changeset to compare actual document content.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const diffDecorationPluginKey = new PluginKey('diffDecoration');

/**
 * Create decorations for diff changes.
 *
 * @param {Array<{type: string, fromB: number, toB: number, deleted?: string}>} changes - Diff changes
 * @param {import('prosemirror-model').Node} doc - Current document
 * @returns {DecorationSet} Decoration set
 */
function createDecorations(changes, doc) {
  if (!changes || changes.length === 0) {
    return DecorationSet.empty;
  }

  const decorations = [];

  for (const change of changes) {
    if (change.type === 'insert' && change.fromB < change.toB) {
      // Insertion: inline decoration with green highlight
      try {
        decorations.push(
          Decoration.inline(change.fromB, change.toB, {
            class: 'diff-insert',
          })
        );
      } catch (e) {
        console.warn('[DiffDecoration] Invalid insert range:', change, e);
      }
    } else if (change.type === 'delete' && change.deleted) {
      // Deletion: widget showing deleted text with strikethrough
      try {
        decorations.push(
          Decoration.widget(change.fromB, () => {
            const span = document.createElement('span');
            span.className = 'diff-delete';
            span.textContent = change.deleted;
            return span;
          }, { side: -1 })
        );
      } catch (e) {
        console.warn('[DiffDecoration] Invalid delete position:', change, e);
      }
    }
  }

  return DecorationSet.create(doc, decorations);
}

export const DiffDecorationExtension = Extension.create({
  name: 'diffDecoration',

  addOptions() {
    return {
      changes: [],
    };
  },

  addProseMirrorPlugins() {
    const extension = this;

    return [
      new Plugin({
        key: diffDecorationPluginKey,

        state: {
          init() {
            return {
              decorations: DecorationSet.empty,
              changes: [],
            };
          },
          apply(tr, value, oldState, newState) {
            // Check for meta to update decorations
            const meta = tr.getMeta(diffDecorationPluginKey);
            if (meta?.changes !== undefined) {
              return {
                decorations: createDecorations(meta.changes, newState.doc),
                changes: meta.changes,
              };
            }
            // Map decorations through document changes
            if (tr.docChanged) {
              return {
                decorations: value.decorations.map(tr.mapping, newState.doc),
                changes: value.changes,
              };
            }
            return value;
          },
        },

        props: {
          decorations(state) {
            return this.getState(state)?.decorations || DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

/**
 * Apply diff decorations to a TipTap editor.
 *
 * @param {import('@tiptap/react').Editor} editor - TipTap editor instance
 * @param {Array<{type: string, fromB: number, toB: number, deleted?: string}>} changes - Diff changes
 */
export function applyDiffDecorations(editor, changes) {
  if (!editor || !editor.view) {
    console.warn('[DiffDecoration] No editor available');
    return;
  }

  editor.view.dispatch(
    editor.view.state.tr.setMeta(diffDecorationPluginKey, { changes })
  );
}

/**
 * Clear diff decorations from a TipTap editor.
 *
 * @param {import('@tiptap/react').Editor} editor - TipTap editor instance
 */
export function clearDiffDecorations(editor) {
  if (!editor || !editor.view) {
    return;
  }

  editor.view.dispatch(
    editor.view.state.tr.setMeta(diffDecorationPluginKey, { changes: [] })
  );
}

export default DiffDecorationExtension;
