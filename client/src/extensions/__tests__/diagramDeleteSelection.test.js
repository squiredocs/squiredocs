import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, AllSelection, TextSelection } from '@tiptap/pm/state';
import { getBaseExtensions } from '../editorExtensions';

// Regression coverage for the "can't cut/delete across a diagram boundary" bug.
//
// The diagram nodes are `isolating: true`, which makes backspace/lift refuse to
// cross their edges. The worry was that this also blocks a range delete that
// SPANS a diagram (select-all → cut/delete leaving the diagram behind). It does
// not: a delete whose endpoints sit entirely OUTSIDE the diagram removes it
// cleanly. These tests pin that schema-level behavior, which is what makes the
// DiagramClipboard cut handler's deleteSelection() a valid fix — see
// DiagramClipboard.js (cut must delete the selection itself, because returning
// true from the DOM handler preempts ProseMirror's built-in cut).

const schema = getSchema(getBaseExtensions());

// doc( paragraph(before) , <diagram>(source) , paragraph(after) )
function docWithDiagram(name, { before = 'before', source = 'graph TD; A-->B', after = 'after' } = {}) {
  const para = (t) => schema.nodes.paragraph.create(null, t ? schema.text(t) : null);
  const diagram = schema.nodes[name].create(null, source ? schema.text(source) : null);
  return schema.nodes.doc.create(null, [para(before), diagram, para(after)]);
}

function stateFor(doc) {
  return EditorState.create({ schema, doc });
}

function diagramCount(doc, name) {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === name) n += 1;
  });
  return n;
}

describe('deleteSelection across an isolating diagram boundary', () => {
  for (const name of ['mermaid', 'svg']) {
    it(`select-all + delete clears a doc containing a ${name} diagram`, () => {
      const state = stateFor(docWithDiagram(name));
      expect(diagramCount(state.doc, name)).toBe(1);

      const tr = state.tr.setSelection(new AllSelection(state.doc)).deleteSelection();
      const after = state.apply(tr);

      // Diagram is gone and the document is reduced to an empty block.
      expect(diagramCount(after.doc, name)).toBe(0);
      expect(after.doc.textContent).toBe('');
    });

    it(`a range selection spanning a ${name} diagram deletes it`, () => {
      const doc = docWithDiagram(name);
      const state = stateFor(doc);
      // From inside the first paragraph to inside the last paragraph — the span
      // fully contains the diagram even though both endpoints are outside it.
      const from = 3; // inside "before"
      const to = doc.content.size - 3; // inside "after"
      const tr = state.tr
        .setSelection(TextSelection.create(state.doc, from, to))
        .deleteSelection();
      const after = state.apply(tr);

      expect(diagramCount(after.doc, name)).toBe(0);
    });
  }
});
