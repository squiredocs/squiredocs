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
 * Get the HTML element tag for a ProseMirror node type.
 */
function getElementForNode(nodeType, attrs) {
  switch (nodeType) {
    case 'paragraph': return 'p';
    case 'heading':
      const level = attrs?.level || 1;
      return `h${level}`;
    case 'bulletList': return 'ul';
    case 'orderedList': return 'ol';
    case 'listItem': return 'li';
    case 'blockquote': return 'blockquote';
    case 'codeBlock': return 'pre';
    case 'horizontalRule': return 'hr';
    case 'hardBreak': return 'br';
    case 'image': return 'img';
    case 'table': return 'table';
    case 'tableRow': return 'tr';
    case 'tableCell': return 'td';
    case 'tableHeader': return 'th';
    default: return null; // Unknown type - will be handled specially
  }
}

/**
 * Get the HTML element for a mark type.
 */
function getMarkElement(markType) {
  switch (markType) {
    case 'bold': return 'strong';
    case 'italic': return 'em';
    case 'underline': return 'u';
    case 'code': return 'code';
    case 'link': return 'a';
    case 'strike': return 's';
    case 'highlight': return 'mark';
    case 'subscript': return 'sub';
    case 'superscript': return 'sup';
    case 'textStyle': return 'span';
    default: return 'span';
  }
}

/**
 * Recursively render a ProseMirror node JSON to DOM.
 * Handles any nesting of blocks and inline content.
 *
 * @param {object} nodeJson - ProseMirror node JSON
 * @param {HTMLElement} container - Parent container to append to
 */
function renderNode(nodeJson, container) {
  if (!nodeJson) return;

  // Handle text nodes
  if (nodeJson.type === 'text') {
    let element = document.createTextNode(nodeJson.text);

    // Wrap in mark elements (innermost first)
    if (nodeJson.marks && nodeJson.marks.length > 0) {
      for (const mark of nodeJson.marks) {
        const wrapper = document.createElement(getMarkElement(mark.type));
        if (mark.type === 'link' && mark.attrs?.href) {
          wrapper.href = mark.attrs.href;
        }
        // Apply textStyle attributes
        if (mark.type === 'textStyle' && mark.attrs) {
          if (mark.attrs.color) wrapper.style.color = mark.attrs.color;
          if (mark.attrs.backgroundColor) wrapper.style.backgroundColor = mark.attrs.backgroundColor;
          if (mark.attrs.fontSize) wrapper.style.fontSize = mark.attrs.fontSize;
          if (mark.attrs.fontFamily) wrapper.style.fontFamily = mark.attrs.fontFamily;
          if (mark.attrs.lineHeight) wrapper.style.lineHeight = mark.attrs.lineHeight;
        }
        wrapper.appendChild(element);
        element = wrapper;
      }
    }

    // Wrap in diff-delete span for consistent styling with inserts
    const deleteSpan = document.createElement('span');
    deleteSpan.className = 'diff-delete';
    deleteSpan.appendChild(element);
    container.appendChild(deleteSpan);
    return;
  }

  // Handle hard breaks
  if (nodeJson.type === 'hardBreak') {
    container.appendChild(document.createElement('br'));
    return;
  }

  // Handle horizontal rules
  if (nodeJson.type === 'horizontalRule') {
    container.appendChild(document.createElement('hr'));
    return;
  }

  // Handle block and container nodes
  const tagName = getElementForNode(nodeJson.type, nodeJson.attrs);

  if (tagName) {
    const element = document.createElement(tagName);

    // Apply attributes for specific node types
    if (nodeJson.type === 'heading' && nodeJson.attrs?.level) {
      // Heading level is already in the tag name
    }
    if (nodeJson.type === 'orderedList' && nodeJson.attrs?.start && nodeJson.attrs.start !== 1) {
      element.start = nodeJson.attrs.start;
    }
    if (nodeJson.type === 'image' && nodeJson.attrs) {
      if (nodeJson.attrs.src) element.src = nodeJson.attrs.src;
      if (nodeJson.attrs.alt) element.alt = nodeJson.attrs.alt;
      if (nodeJson.attrs.title) element.title = nodeJson.attrs.title;
    }
    // Apply table cell attributes
    if ((nodeJson.type === 'tableCell' || nodeJson.type === 'tableHeader') && nodeJson.attrs) {
      if (nodeJson.attrs.colspan && nodeJson.attrs.colspan !== 1) {
        element.colSpan = nodeJson.attrs.colspan;
      }
      if (nodeJson.attrs.rowspan && nodeJson.attrs.rowspan !== 1) {
        element.rowSpan = nodeJson.attrs.rowspan;
      }
    }

    // Recursively render children
    if (nodeJson.content) {
      for (const child of nodeJson.content) {
        renderNode(child, element);
      }
    }

    container.appendChild(element);
  } else if (nodeJson.content) {
    // Unknown node type with content - just render children directly
    for (const child of nodeJson.content) {
      renderNode(child, container);
    }
  }
}

/**
 * Render deleted content preserving full document structure.
 * Handles any block types including nested lists.
 *
 * @param {Array<object>} deletedContent - Array of ProseMirror node JSON objects
 * @param {import('prosemirror-model').Schema} schema - ProseMirror schema
 * @returns {HTMLElement} Container with deleted block elements
 */
function renderDeletedContent(deletedContent, schema) {
  // Container uses display:contents so it doesn't affect layout
  const container = document.createElement('div');
  container.className = 'diff-delete-container';

  for (const nodeJson of deletedContent) {
    renderNode(nodeJson, container);
  }

  return container;
}

/**
 * Create decorations for diff changes.
 *
 * @param {Array<{type: string, fromB: number, toB: number, deletedContent?: Array}>} changes - Diff changes
 * @param {import('prosemirror-model').Node} doc - Current document
 * @returns {DecorationSet} Decoration set
 */
function createDecorations(changes, doc) {
  if (!changes || changes.length === 0) {
    return DecorationSet.empty;
  }

  const decorations = [];
  const schema = doc.type.schema;

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
    } else if (change.type === 'delete' && change.deletedContent) {
      // Deletion: widget showing formatted deleted content
      try {
        decorations.push(
          Decoration.widget(change.fromB, () => {
            return renderDeletedContent(change.deletedContent, schema);
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
