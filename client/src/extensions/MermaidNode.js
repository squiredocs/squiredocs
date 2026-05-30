import { createDiagramNode } from './diagramBlock';

let mermaidPromise = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        fontFamily: 'inherit',
        // Render labels as SVG <text> instead of <foreignObject> so the
        // rendered diagram can be drawn into a <canvas> without tainting
        // it (foreignObject SVGs throw SecurityError on toDataURL).
        flowchart: { htmlLabels: false },
        class: { htmlLabels: false },
        state: { htmlLabels: false },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let renderSeq = 0;

// Thin config over the shared diagram core (see diagramBlock.js). The clipboard
// round-trip, rasterization, and node-view shell are all shared; only the
// Mermaid-specific parse+render lives here. Emitted/parsed clipboard format
// ([mermaid-src], data-mermaid-source) is unchanged from the original.
export const MermaidNode = createDiagramNode({
  name: 'mermaid',
  fence: 'mermaid',
  placeholder: 'graph TD\n  A[Start] --> B[End]',
  loadRenderer: loadMermaid,
  render: async (source, mermaid) => {
    await mermaid.parse(source);
    const id = `mermaid-${++renderSeq}-${Math.random().toString(36).slice(2, 8)}`;
    const { svg } = await mermaid.render(id, source);
    return svg;
  },
  // Shown when a diagram is pasted back from Google Docs but its source was too
  // large to survive the round-trip. Valid Mermaid so it renders as a visible
  // node rather than a bare image.
  droppedPlaceholder:
    'graph TD\n' +
    '  dropped["⚠ Mermaid diagram source not preserved — too large for a Google Docs round-trip; re-create from the original"]\n' +
    '  style dropped fill:#fef3c7,stroke:#b45309,color:#92400e',
});

export default MermaidNode;
