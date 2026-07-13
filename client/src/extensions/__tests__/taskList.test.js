/**
 * Task-list editor coverage (feature 003, T010, FR-001/FR-002).
 *
 * Drives a real headless TipTap editor built from getBaseExtensions() —
 * the exact extension set every editor instance shares — and proves:
 *   - task lists can be created, toggled, and nested via editor commands
 *   - the serialized editor JSON uses the same node/attr names as
 *     shared/prosemirror-schema.js (schema parity guard: the server schema
 *     accepts the editor's document verbatim)
 *   - the DOM contract (data-type / data-checked) matches what the shared
 *     schema's parseDOM expects
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { getBaseExtensions } from '../editorExtensions';
import { schema as sharedSchema } from '../../../../shared/prosemirror-schema';

let editor;

function createEditor(content) {
  editor = new Editor({
    extensions: getBaseExtensions(),
    content,
  });
  return editor;
}

/**
 * Build a Y.Doc whose taskItems carry `checked` values written straight into
 * the Yjs attribute channel — the real path by which existing documents hold
 * their state. Values may be booleans (what edits store now) or the legacy
 * strings 'true'/'false' that pre-fix documents persisted.
 */
function buildCheckedYDoc(values) {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('default');
  ydoc.transact(() => {
    const list = new Y.XmlElement('taskList');
    const items = values.map((checked, i) => {
      const item = new Y.XmlElement('taskItem');
      item.setAttribute('checked', checked); // boolean OR legacy string
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, `item ${i}`);
      para.insert(0, [text]);
      item.insert(0, [para]);
      return item;
    });
    list.insert(0, items);
    fragment.insert(0, [list]);
  });
  return ydoc;
}

function mountCollabEditor(ydoc) {
  editor = new Editor({
    extensions: [
      ...getBaseExtensions(),
      Collaboration.configure({ document: ydoc, field: 'default' }),
    ],
  });
  return editor;
}

afterEach(() => {
  if (editor) {
    editor.destroy();
    editor = null;
  }
});

const TASK_DOC = {
  type: 'doc',
  content: [
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'todo' }] }],
        },
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
        },
      ],
    },
  ],
};

describe('task lists in the shared editor extension set', () => {
  it('registers taskList/taskItem (accepts a task-list document)', () => {
    createEditor(TASK_DOC);
    const json = editor.getJSON();
    expect(json.content[0].type).toBe('taskList');
    expect(json.content[0].content.map((n) => n.type)).toEqual(['taskItem', 'taskItem']);
    expect(json.content[0].content.map((n) => n.attrs.checked)).toEqual([false, true]);
  });

  it('creates a task list from a paragraph via toggleTaskList', () => {
    createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'make me a task' }] }],
    });
    editor.chain().focus().toggleTaskList().run();
    const json = editor.getJSON();
    expect(json.content[0].type).toBe('taskList');
    expect(json.content[0].content[0].type).toBe('taskItem');
    expect(json.content[0].content[0].attrs.checked).toBe(false);
  });

  it('toggles checked state via updateAttributes', () => {
    createEditor(TASK_DOC);
    // Selection inside the first (unchecked) item
    editor.commands.setTextSelection(3);
    editor.commands.updateAttributes('taskItem', { checked: true });
    const json = editor.getJSON();
    expect(json.content[0].content[0].attrs.checked).toBe(true);
    // The second item is untouched
    expect(json.content[0].content[1].attrs.checked).toBe(true);
  });

  it('nests task items via sinkListItem (nested: true)', () => {
    createEditor(TASK_DOC);
    // Put the cursor in the second item and sink it under the first
    const secondItemPos = editor.state.doc.content.firstChild.firstChild.nodeSize + 3;
    editor.commands.setTextSelection(secondItemPos);
    const sank = editor.commands.sinkListItem('taskItem');
    expect(sank).toBe(true);
    const json = editor.getJSON();
    const firstItem = json.content[0].content[0];
    expect(json.content[0].content).toHaveLength(1);
    const nested = firstItem.content.find((n) => n.type === 'taskList');
    expect(nested).toBeTruthy();
    expect(nested.content[0].type).toBe('taskItem');
  });

  it('renders the data-type/data-checked DOM contract', () => {
    createEditor(TASK_DOC);
    const html = editor.getHTML();
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-type="taskItem"');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('data-checked="false"');
  });

  it('renders boolean AND legacy-string checked values from the Yjs channel correctly', () => {
    // Order: boolean true, legacy 'true', boolean false, legacy 'false'.
    // The legacy string 'false' is the regression: it is truthy, so the base
    // NodeView (`checkbox.checked = node.attrs.checked`) rendered it CHECKED.
    const ydoc = buildCheckedYDoc([true, 'true', false, 'false']);
    mountCollabEditor(ydoc);
    const checkboxes = [
      ...editor.view.dom.querySelectorAll('input[type="checkbox"]'),
    ];
    expect(checkboxes).toHaveLength(4);
    expect(checkboxes.map((c) => c.checked)).toEqual([true, true, false, false]);
    ydoc.destroy();
  });

  it('editor JSON is schema-parity with shared/prosemirror-schema (server accepts it verbatim)', () => {
    createEditor(TASK_DOC);
    editor.commands.setTextSelection(3);
    editor.commands.updateAttributes('taskItem', { checked: true });
    const json = editor.getJSON();
    // The shared server schema must accept the editor's document as-is —
    // node names, attr names, and content expressions all line up.
    expect(() => sharedSchema.nodeFromJSON(json).check()).not.toThrow();
  });
});
