import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import MermaidNodeView from '../components/MermaidNodeView.jsx';

const PLACEHOLDER = 'graph TD\n  A[Start] --> B[End]';

export const MermaidNode = Node.create({
  name: 'mermaid',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  isolating: true,

  parseHTML() {
    return [
      { tag: 'pre[data-type="mermaid"]', preserveWhitespace: 'full' },
    ];
  },

  renderHTML() {
    return ['pre', { 'data-type': 'mermaid' }, ['code', 0]];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidNodeView);
  },

  addCommands() {
    return {
      insertMermaid:
        (source = PLACEHOLDER) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContent({
              type: this.name,
              content: source ? [{ type: 'text', text: source }] : [],
            })
            .run(),
    };
  },
});

export default MermaidNode;
