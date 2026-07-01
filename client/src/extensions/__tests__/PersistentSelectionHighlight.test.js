import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { getBaseExtensions } from '../editorExtensions';
import {
  persistentSelectionHighlightPlugin,
  persistentSelectionHighlightKey,
} from '../PersistentSelectionHighlight';

// Covers the decoration reducer that keeps the local selection highlighted after
// the editor blurs. We drive it at the ProseMirror-state level (no live editor):
// the plugin's DOM handlers (blur → paint, mouseup/keydown → clear) just
// dispatch these same `paint`/`clear` meta commands.

const schema = getSchema(getBaseExtensions());

// doc( paragraph("hello world") ) — "hello" spans positions 1..6.
function makeState() {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text('hello world')),
  ]);
  return EditorState.create({ schema, doc, plugins: [persistentSelectionHighlightPlugin()] });
}

const decoCount = (state) => persistentSelectionHighlightKey.getState(state).find().length;
const paint = (state, from, to) =>
  state.apply(state.tr.setMeta(persistentSelectionHighlightKey, { type: 'paint', from, to }));
const clear = (state) =>
  state.apply(state.tr.setMeta(persistentSelectionHighlightKey, { type: 'clear' }));

describe('PersistentSelectionHighlight', () => {
  it('starts with no decoration', () => {
    expect(decoCount(makeState())).toBe(0);
  });

  it('paints a decoration over a non-empty range', () => {
    const state = paint(makeState(), 1, 6);
    const decos = persistentSelectionHighlightKey.getState(state).find();
    expect(decos).toHaveLength(1);
    expect(decos[0].from).toBe(1);
    expect(decos[0].to).toBe(6);
  });

  it('paints nothing for an empty (collapsed) range', () => {
    expect(decoCount(paint(makeState(), 3, 3))).toBe(0);
  });

  it('clears the decoration on a clear command', () => {
    const painted = paint(makeState(), 1, 6);
    expect(decoCount(painted)).toBe(1);
    expect(decoCount(clear(painted))).toBe(0);
  });

  it('remaps the decoration through a document edit so it stays anchored', () => {
    const painted = paint(makeState(), 1, 6); // highlights "hello"
    // Insert 3 chars at the very start (before the highlighted range).
    const edited = painted.apply(painted.tr.insertText('ZZZ', 1));
    const decos = persistentSelectionHighlightKey.getState(edited).find();
    expect(decos).toHaveLength(1);
    // The range shifts right by the inserted length, not stale at 1..6.
    expect(decos[0].from).toBe(4);
    expect(decos[0].to).toBe(9);
  });
});
