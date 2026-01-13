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

/**
 * Get base extensions shared by all editors
 * @param {object} options - Configuration options
 * @param {boolean} options.openLinksOnClick - Whether links should open on click (default: false)
 * @returns {Array} Array of TipTap extensions
 */
export function getBaseExtensions({ openLinksOnClick = false } = {}) {
  return [
    StarterKit.configure({
      undoRedo: false, // Disable built-in undo/redo (Yjs handles it for collaborative editor)
      link: false, // Disable built-in Link, we configure it separately below
      // underline is included in StarterKit by default in v3
    }),
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
  ];
}
