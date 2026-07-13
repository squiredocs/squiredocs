/**
 * Shared TipTap editor extensions configuration
 *
 * This module provides the base extensions used by all editors in the application
 * to ensure schema consistency across:
 * - Main collaborative editor
 * - Version history preview
 * - Any other editor instances
 *
 * By centralizing the extension configuration, we avoid schema mismatches
 * that would cause errors when deserializing content with marks/nodes
 * that aren't registered in a particular editor instance.
 */

import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import Link from '@tiptap/extension-link';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import {
  TextStyle,
  Color,
  BackgroundColor,
  FontFamily,
  FontSize,
  LineHeight,
} from '@tiptap/extension-text-style';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { Mark } from '@tiptap/core';
import { MermaidNode } from './MermaidNode';
import { SvgNode } from './SvgNode';
import { ImageNode } from './ImageNode';
import { DiagramClipboard } from './DiagramClipboard';

/**
 * Get base extensions shared by all editors
 * @param {object} options - Configuration options
 * @param {boolean} options.openLinksOnClick - Whether links should open on click (default: false)
 * @param {{docId: string, api: object}|null} options.imageUpload - Enables image
 *   drag/drop + paste uploads when present (editable editors only). The ImageNode
 *   is always registered for schema consistency regardless of this option.
 * @returns {Array} Array of TipTap extensions
 */
/**
 * Coerce a taskItem `checked` attribute to a real boolean. New edits (editor
 * and the MCP appendBlocks helper) store a boolean, but documents created
 * before the fix persist the STRING 'true'/'false' in the Yjs attribute
 * channel. TipTap's TaskItem NodeView renders `checkbox.checked =
 * node.attrs.checked`, and the string 'false' is truthy — so legacy items all
 * rendered CHECKED. Parse the legacy strings back to booleans on the read side.
 */
function coerceCheckedNode(node) {
  const c = node.attrs.checked;
  if (c === 'true' || c === 'false') {
    return node.type.create({ ...node.attrs, checked: c === 'true' }, node.content, node.marks);
  }
  return node;
}

// GFM task items with a defensive read-side coercion of legacy string
// `checked` attributes. Wraps the base NodeView so it always sees a boolean.
const CoercedTaskItem = TaskItem.extend({
  addNodeView() {
    const parentNodeView = this.parent?.();
    if (!parentNodeView) return undefined;
    return (props) => {
      const view = parentNodeView({ ...props, node: coerceCheckedNode(props.node) });
      if (view && typeof view.update === 'function') {
        const baseUpdate = view.update.bind(view);
        view.update = (updatedNode, ...rest) => baseUpdate(coerceCheckedNode(updatedNode), ...rest);
      }
      return view;
    };
  },
});

const DiffInsert = Mark.create({
  name: 'diffInsert',
  parseHTML() { return [{ tag: 'ins' }]; },
  renderHTML() { return ['ins', 0]; },
});

const DiffDelete = Mark.create({
  name: 'diffDelete',
  parseHTML() { return [{ tag: 'del' }]; },
  renderHTML() { return ['del', 0]; },
});

export function getBaseExtensions({ openLinksOnClick = false, imageUpload = null } = {}) {
  return [
    StarterKit.configure({
      undoRedo: false, // Disable built-in undo/redo (Yjs handles it for collaborative editor)
      link: false, // Disable built-in Link, we configure it separately below
      // underline is included in StarterKit by default in v3
    }),
    // GFM task lists (feature 003): checked state is a normal Yjs attribute
    // edit, so attribution/undo/version history work like any edit.
    TaskList,
    CoercedTaskItem.configure({ nested: true }),
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
      openOnClick: openLinksOnClick,
    }),
    DiffInsert,
    DiffDelete,
    MermaidNode,
    SvgNode,
    ImageNode.configure({ imageUpload }),
    // Single shared copy/cut handler for all diagram blocks (registered once,
    // not per node — see DiagramClipboard).
    DiagramClipboard,
  ];
}
