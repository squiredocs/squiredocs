import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, NodeSelection } from '@tiptap/pm/state';
import { getBaseExtensions } from '../editorExtensions';

// Regression coverage for "a selected image won't delete". The image node is an
// `atom`; when it's node-selected, Backspace/Delete must remove it. ImageNode's
// addKeyboardShortcuts runs deleteSelection() in that case — these tests pin the
// schema-level behavior that makes that valid.

const schema = getSchema(getBaseExtensions());

// doc( paragraph(before), <image>, paragraph(after) )
function docWithImage() {
  const para = (t) => schema.nodes.paragraph.create(null, t ? schema.text(t) : null);
  const image = schema.nodes.image.create({ src: '/api/docs/d/images/i', alt: 'x' });
  return schema.nodes.doc.create(null, [para('before'), image, para('after')]);
}

function imagePos(doc) {
  let pos = null;
  doc.descendants((node, p) => {
    if (node.type.name === 'image') pos = p;
  });
  return pos;
}

function imageCount(doc) {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === 'image') n += 1;
  });
  return n;
}

describe('deleting a node-selected image', () => {
  it('removes the image and leaves the surrounding paragraphs', () => {
    const doc = docWithImage();
    const state = EditorState.create({ schema, doc });
    expect(imageCount(state.doc)).toBe(1);

    const pos = imagePos(doc);
    const tr = state.tr.setSelection(NodeSelection.create(state.doc, pos)).deleteSelection();
    const after = state.apply(tr);

    expect(imageCount(after.doc)).toBe(0);
    expect(after.doc.textContent).toBe('beforeafter');
  });

  it('clears an image that is the only block', () => {
    const image = schema.nodes.image.create({ src: '/api/docs/d/images/i' });
    const doc = schema.nodes.doc.create(null, [image]);
    const state = EditorState.create({ schema, doc });

    const pos = imagePos(doc);
    const tr = state.tr.setSelection(NodeSelection.create(state.doc, pos)).deleteSelection();
    const after = state.apply(tr);

    expect(imageCount(after.doc)).toBe(0);
  });
});
