import { createDiagramNode } from './diagramBlock';

let graphvizPromise = null;

// Singleton-promise lazy load of the Graphviz WASM. Dynamic import keeps the
// ~1.8 MB WASM out of the main bundle until a Graphviz block actually renders.
function loadGraphviz() {
  if (!graphvizPromise) {
    graphvizPromise = import('@hpcc-js/wasm-graphviz').then(({ Graphviz }) =>
      Graphviz.load(),
    );
  }
  return graphvizPromise;
}

// Graphviz emits plain SVG <text> (no <foreignObject>), so rasterization needs
// no special casing. dot() is synchronous, returns an SVG string, and throws a
// (verbose) Error on invalid DOT.
//
// Unlike Mermaid, Graphviz returns a full XML document — an `<?xml ?>` prolog
// and a `<!DOCTYPE svg>` ahead of the `<svg>` element. Those break the node
// view's `innerHTML = svg` (the HTML parser drops them and the diagram never
// renders), so strip everything before the opening `<svg` tag.
function toInlineSvg(out) {
  const start = out.indexOf('<svg');
  return start === -1 ? out : out.slice(start);
}

export const GraphvizNode = createDiagramNode({
  name: 'graphviz',
  fence: 'graphviz',
  acceptFences: ['graphviz', 'dot'],
  placeholder: 'digraph {\n  A -> B -> C\n}',
  loadRenderer: loadGraphviz,
  render: (source, graphviz) => toInlineSvg(graphviz.dot(source)),
  // Shown when a diagram is pasted back from Google Docs but its source was too
  // large to survive the round-trip (Google Docs strips data-* and caps alt
  // length). Valid DOT so it renders as a visible box rather than a bare image.
  droppedPlaceholder:
    'digraph {\n' +
    '  node [shape=box style="filled,dashed" fillcolor="#fef3c7" ' +
    'color="#b45309" fontcolor="#92400e"];\n' +
    '  dropped [label="⚠  Graphviz diagram source not preserved\\n' +
    'It was too large to survive a Google Docs round-trip.\\n' +
    'Re-create it from the original."];\n' +
    '}',
});

export default GraphvizNode;
