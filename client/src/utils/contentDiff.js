/**
 * Content-based diff utility for ProseMirror documents.
 *
 * This module provides content-aware diffing that compares actual document content
 * rather than CRDT internal state. This solves the problem where Yjs snapshot diffs
 * show "everything changed" when different CRDT client IDs merge.
 *
 * Uses:
 * - y-prosemirror's yXmlFragmentToProseMirrorRootNode to convert Yjs → ProseMirror
 * - @manuscripts/prosemirror-recreate-steps to compute steps between docs
 * - prosemirror-changeset to convert steps into insertion/deletion ranges
 */

import * as Y from 'yjs';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { recreateTransform } from '@manuscripts/prosemirror-recreate-steps';
import { ChangeSet } from 'prosemirror-changeset';
import { Decoration, DecorationSet } from 'prosemirror-view';

/**
 * Build a ProseMirror document from a Yjs doc at a specific state.
 *
 * @param {Y.Doc} yDoc - Yjs document with updates applied
 * @param {import('prosemirror-model').Schema} schema - ProseMirror schema from TipTap editor
 * @returns {import('prosemirror-model').Node | null} ProseMirror document node
 */
export function yDocToProseMirrorDoc(yDoc, schema) {
  try {
    const fragment = yDoc.get('default', Y.XmlFragment);
    if (!fragment || fragment.length === 0) {
      // Return an empty doc with the schema's default content
      return schema.topNodeType.createAndFill();
    }
    return yXmlFragmentToProseMirrorRootNode(fragment, schema);
  } catch (error) {
    console.error('[contentDiff] Error converting Yjs to ProseMirror:', error);
    return null;
  }
}

/**
 * Extract text content from a ProseMirror document between positions.
 *
 * @param {import('prosemirror-model').Node} doc - ProseMirror document
 * @param {number} from - Start position
 * @param {number} to - End position
 * @returns {string} Text content
 */
function extractTextBetween(doc, from, to) {
  let text = '';
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      text += node.text;
    } else if (node.isBlock && text.length > 0) {
      text += ' '; // Add space between blocks
    }
  });
  return text;
}

/**
 * Compute the differences between two ProseMirror documents.
 * Returns an array of change objects describing insertions and deletions.
 *
 * @param {import('prosemirror-model').Node} oldDoc - Previous document state
 * @param {import('prosemirror-model').Node} newDoc - Current document state
 * @returns {Array<{type: 'insert'|'delete', from: number, to: number, deleted?: string}>} Array of changes
 */
export function computeDocumentDiff(oldDoc, newDoc) {
  if (!oldDoc || !newDoc) {
    return [];
  }

  try {
    // Recreate the transform steps needed to go from oldDoc to newDoc
    const tr = recreateTransform(oldDoc, newDoc, {
      complexSteps: true,
      wordDiffs: false
    });

    if (!tr || tr.steps.length === 0) {
      return [];
    }

    // Use ChangeSet to convert steps into insertion/deletion ranges
    const changeSet = ChangeSet.create(oldDoc).addSteps(newDoc, tr.mapping.maps);

    // Extract changes
    const changes = [];

    for (const change of changeSet.changes) {
      // Deletions are in oldDoc coordinate space
      if (change.deleted.length > 0) {
        const deletedLength = change.deleted.reduce((sum, span) => sum + span.length, 0);
        if (deletedLength > 0) {
          // Extract the actual deleted text from the old document
          const deletedText = extractTextBetween(oldDoc, change.fromA, change.toA);
          changes.push({
            type: 'delete',
            fromA: change.fromA,
            toA: change.toA,
            fromB: change.fromB,
            toB: change.fromB, // Deletions have no range in new doc
            deleted: deletedText, // Include the actual deleted text
          });
        }
      }

      // Insertions are in newDoc coordinate space
      if (change.inserted.length > 0) {
        const insertedLength = change.inserted.reduce((sum, span) => sum + span.length, 0);
        if (insertedLength > 0) {
          changes.push({
            type: 'insert',
            fromA: change.fromA,
            toA: change.fromA, // Insertions have no range in old doc
            fromB: change.fromB,
            toB: change.toB,
          });
        }
      }
    }

    return changes;
  } catch (error) {
    console.error('[contentDiff] Error computing document diff:', error);
    return [];
  }
}

/**
 * Create ProseMirror decorations for diff visualization.
 *
 * @param {Array<{type: string, fromB: number, toB: number}>} changes - Array of changes
 * @param {import('prosemirror-model').Node} doc - The new document (for decoration positions)
 * @returns {DecorationSet} Decoration set for the editor
 */
export function createDiffDecorations(changes, doc) {
  const decorations = [];

  for (const change of changes) {
    if (change.type === 'insert' && change.fromB < change.toB) {
      // Insertion: highlight in green
      decorations.push(
        Decoration.inline(change.fromB, change.toB, {
          class: 'diff-insert',
          nodeName: 'span',
        })
      );
    } else if (change.type === 'delete') {
      // For deletions, we insert a widget decoration showing deleted content
      // Since we're showing the new doc, we place it at the fromB position
      decorations.push(
        Decoration.widget(change.fromB, () => {
          const marker = document.createElement('span');
          marker.className = 'diff-delete-marker';
          marker.textContent = '⌫'; // Or could be empty, just a marker
          return marker;
        }, { side: -1 })
      );
    }
  }

  return DecorationSet.create(doc, decorations);
}

/**
 * Main function: Compute content-based diff between two Yjs document states.
 *
 * @param {Uint8Array[]} updates - Array of Yjs updates to apply (in order)
 * @param {number} previousClock - Clock value of previous state (-1 for empty)
 * @param {number} currentClock - Clock value of current state
 * @param {import('prosemirror-model').Schema} schema - ProseMirror schema
 * @returns {{changes: Array, oldDoc: Node|null, newDoc: Node|null}} Diff result
 */
export function computeContentDiff(updates, previousClock, currentClock, schema) {
  if (!updates || updates.length === 0 || !schema) {
    return { changes: [], oldDoc: null, newDoc: null };
  }

  try {
    // Build documents at both clock positions
    const oldYDoc = new Y.Doc({ gc: false });
    const newYDoc = new Y.Doc({ gc: false });

    // Apply updates to build both document states
    // Each update has an implicit clock based on its array index (0-based)
    // But server sends clock values, so we need to track which updates to apply

    // For now, apply all updates to newDoc to get current state
    // And apply updates up to previousClock for oldDoc
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];
      Y.applyUpdate(newYDoc, update);
      if (i <= previousClock) {
        Y.applyUpdate(oldYDoc, update);
      }
    }

    // Convert to ProseMirror docs
    const oldDoc = previousClock >= 0
      ? yDocToProseMirrorDoc(oldYDoc, schema)
      : schema.topNodeType.createAndFill();
    const newDoc = yDocToProseMirrorDoc(newYDoc, schema);

    if (!oldDoc || !newDoc) {
      return { changes: [], oldDoc: null, newDoc: null };
    }

    // Compute the diff
    const changes = computeDocumentDiff(oldDoc, newDoc);

    // Cleanup
    oldYDoc.destroy();
    newYDoc.destroy();

    return { changes, oldDoc, newDoc };
  } catch (error) {
    console.error('[contentDiff] Error in computeContentDiff:', error);
    return { changes: [], oldDoc: null, newDoc: null };
  }
}

/**
 * Simplified diff function for use with pre-built Yjs documents.
 *
 * @param {Y.Doc} oldYDoc - Yjs document at previous state
 * @param {Y.Doc} newYDoc - Yjs document at current state
 * @param {import('prosemirror-model').Schema} schema - ProseMirror schema
 * @returns {{changes: Array, decorations: DecorationSet|null}} Diff result with decorations
 */
export function diffYjsDocs(oldYDoc, newYDoc, schema) {
  if (!oldYDoc || !newYDoc || !schema) {
    return { changes: [], decorations: null };
  }

  try {
    const oldDoc = yDocToProseMirrorDoc(oldYDoc, schema);
    const newDoc = yDocToProseMirrorDoc(newYDoc, schema);

    if (!oldDoc || !newDoc) {
      return { changes: [], decorations: null };
    }

    const changes = computeDocumentDiff(oldDoc, newDoc);
    const decorations = createDiffDecorations(changes, newDoc);

    return { changes, decorations, oldDoc, newDoc };
  } catch (error) {
    console.error('[contentDiff] Error in diffYjsDocs:', error);
    return { changes: [], decorations: null };
  }
}

export default {
  yDocToProseMirrorDoc,
  computeDocumentDiff,
  createDiffDecorations,
  computeContentDiff,
  diffYjsDocs,
};
