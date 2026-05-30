import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Fragment } from '@tiptap/pm/model';
import DiagramNodeView from '../components/DiagramNodeView.jsx';
import { altSourcePrefix, decodeSourceFromAlt } from './diagramShared';

// Factory for a diagram-as-code block (Mermaid, Graphviz, …). Each format is a
// thin config; the rendering shell (DiagramNodeView), rasterization, and the
// copy/cut clipboard handling (DiagramClipboard) are shared.
//
// config:
//   name          node name + data-type + capitalized into the insert command
//   fence         markdown fence label this block serializes to (server-side)
//   placeholder   default source inserted by the command
//   loadRenderer  () => Promise<instance>   (singleton-promise per format)
//   render        (source, instance) => Promise<svgString> | svgString  (throws on error)
//   formatError   (err) => string           optional error-panel formatter
//   exportScale   number                    optional rasterization DPI multiplier
export function createDiagramNode(config) {
  const { name, placeholder = '' } = config;
  const insertCommand = `insert${name.charAt(0).toUpperCase()}${name.slice(1)}`;

  const fragmentFromSource = (schema, source) => {
    const trimmed = (source || '').trim();
    if (!trimmed) return null;
    return Fragment.from(schema.text(trimmed));
  };
  const fromDataAttr = (domNode, schema) =>
    fragmentFromSource(schema, domNode.getAttribute(`data-${name}-source`));
  const fromAltAttr = (domNode, schema) =>
    fragmentFromSource(
      schema,
      decodeSourceFromAlt(
        name,
        domNode.getAttribute('alt') || domNode.getAttribute('aria-label'),
      ),
    );

  return Node.create({
    name,
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    isolating: true,

    addOptions() {
      // The generic node view reads this off `extension.options.diagramConfig`.
      return { diagramConfig: config };
    },

    parseHTML() {
      return [
        { tag: `pre[data-type="${name}"]`, preserveWhitespace: 'full' },
        // Round-trip fallbacks for pasted clipboard HTML.
        // Same-session/Squire-to-Squire: PM's slice metadata bypasses parseHTML.
        // Through HTML-preserving targets (Notion, etc.): data-<name>-source.
        // Through HTML-sanitizing targets (Google Docs): the alt prefix.
        { tag: `img[data-${name}-source]`, getContent: fromDataAttr },
        { tag: `svg[data-${name}-source]`, getContent: fromDataAttr },
        { tag: `img[alt^="${altSourcePrefix(name)}"]`, getContent: fromAltAttr },
      ];
    },

    renderHTML() {
      return ['pre', { 'data-type': name }, ['code', 0]];
    },

    addNodeView() {
      return ReactNodeViewRenderer(DiagramNodeView);
    },

    addCommands() {
      return {
        [insertCommand]:
          (source = placeholder) =>
          ({ chain }) =>
            chain()
              .focus()
              .insertContent({
                type: name,
                content: source ? [{ type: 'text', text: source }] : [],
              })
              .run(),
      };
    },
  });
}

export default createDiagramNode;
