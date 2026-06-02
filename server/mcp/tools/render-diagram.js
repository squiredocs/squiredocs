/**
 * render_diagram MCP Tool
 *
 * Renders a diagram-as-code block to an image the agent can actually see.
 * Diagrams are stored as source only (the browser renders them), so this tool
 * renders server-side and returns a PNG image block (and/or the SVG markup).
 *
 * Graphviz only for now — Mermaid needs a headless browser to render.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { renderDiagram, SUPPORTED_TYPES } = require('../diagram-render');
const { collectDiagrams } = require('../yjs/block-structure');

let persistenceProvider = null;
function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'render_diagram';

const description = `Render a diagram-as-code block to an image you can see.

Diagram blocks (graphviz, mermaid, d2) are stored as source text and only rendered
visually in the editor. Use this tool to see what a block actually renders to —
e.g. to verify a diagram you just inserted or edited.

Server-side rendering currently supports: ${SUPPORTED_TYPES.join(', ')}.
(Mermaid is not yet supported here — it requires a headless browser.)

PARAMETERS
- docGuid: Document UUID. Renders the diagram block(s) in the document.
- source: Render this diagram source directly instead of reading the document
  (useful to preview a diagram before inserting it). Mutually exclusive with docGuid.
- type: Diagram type for 'source' (default "graphviz").
- index: When reading a document, render only the Nth diagram block (0-based).
  Omit to render all graphviz blocks in the document.
- format: "png" (default — an image you can see), "svg" (markup as text), or "both".
- width: Target PNG width in px (default 1000).

RETURNS
An image block (PNG) per rendered diagram, with a text caption (type, index,
dimensions). With format "svg"/"both", also returns the SVG markup as text.

EXAMPLES
// See every graphviz diagram in a document
await render_diagram({ docGuid: "abc-123" });

// See a specific block
await render_diagram({ docGuid: "abc-123", index: 0 });

// Preview source before inserting it
await render_diagram({ source: "digraph { A -> B -> C }" });`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid', description: 'The document UUID' },
    source: { type: 'string', description: 'Render this source directly instead of reading a document' },
    type: { type: 'string', enum: SUPPORTED_TYPES.concat(['mermaid']), description: 'Diagram type for "source" (default "graphviz")' },
    index: { type: 'integer', minimum: 0, description: 'Render only the Nth diagram block (0-based)' },
    format: { type: 'string', enum: ['png', 'svg', 'both'], description: 'Output format (default "png")' },
    width: { type: 'integer', minimum: 1, description: 'Target PNG width in px (default 1000)' },
  },
};

// Diagram node types that exist in the schema (renderable or not).
const DIAGRAM_NODE_TYPES = ['graphviz', 'mermaid', 'd2'];
const MAX_DIAGRAMS = 10;

function imageBlock(pngBase64) {
  return { type: 'image', data: pngBase64, mimeType: 'image/png' };
}
function textBlock(text) {
  return { type: 'text', text };
}

// Render one diagram into MCP content blocks (caption + image/svg, or an error note).
async function renderToBlocks(diagram, label, format, width) {
  const blocks = [];
  if (!SUPPORTED_TYPES.includes(diagram.type)) {
    blocks.push(textBlock(`${label}: cannot render '${diagram.type}' server-side (needs a headless browser).`));
    return blocks;
  }
  if (!diagram.source.trim()) {
    blocks.push(textBlock(`${label}: empty diagram source.`));
    return blocks;
  }
  try {
    const { svg, pngBase64, width: w, height: h } = await renderDiagram(diagram.type, diagram.source, { width });
    blocks.push(textBlock(`${label}: ${diagram.type}, rendered ${w}×${h}px.`));
    if (format === 'svg' || format === 'both') blocks.push(textBlock(svg));
    if (format === 'png' || format === 'both') blocks.push(imageBlock(pngBase64));
  } catch (err) {
    blocks.push(textBlock(`${label}: render failed — ${err.message}`));
  }
  return blocks;
}

async function handler(args, agentToken) {
  const { docGuid, source, type = 'graphviz', index, format = 'png', width } = args;

  // Direct-source mode: render what the caller passed.
  if (source !== undefined) {
    const blocks = await renderToBlocks({ type, source }, 'source', format, width);
    return { __mcpContent: blocks };
  }

  if (!docGuid) {
    throw new Error('render_diagram requires either "source" or "docGuid".');
  }
  if (!persistenceProvider) throw new Error('render_diagram tool not initialized');

  // Document mode: render the diagram block(s) in the doc.
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  const diagrams = collectDiagrams(xmlFragment, DIAGRAM_NODE_TYPES);

  if (diagrams.length === 0) {
    return { __mcpContent: [textBlock('No diagram blocks found in this document.')] };
  }

  let selected;
  if (index !== undefined) {
    if (index < 0 || index >= diagrams.length) {
      throw new Error(`index ${index} out of range — document has ${diagrams.length} diagram block(s).`);
    }
    selected = [{ d: diagrams[index], label: `diagram #${index}` }];
  } else {
    // Default: all server-renderable blocks (skip mermaid, which we can't render here).
    selected = diagrams
      .map((d, i) => ({ d, label: `diagram #${i}` }))
      .filter(({ d }) => SUPPORTED_TYPES.includes(d.type));
    if (selected.length === 0) {
      return {
        __mcpContent: [
          textBlock(
            `Found ${diagrams.length} diagram block(s) but none are server-renderable ` +
              `(${SUPPORTED_TYPES.join(', ')} only). Mermaid needs a headless browser.`,
          ),
        ],
      };
    }
  }

  const truncated = selected.length > MAX_DIAGRAMS;
  const toRender = selected.slice(0, MAX_DIAGRAMS);

  const blocks = [];
  for (const { d, label } of toRender) {
    blocks.push(...(await renderToBlocks(d, label, format, width)));
  }
  if (truncated) {
    blocks.push(textBlock(`(${selected.length - MAX_DIAGRAMS} more diagram(s) not rendered; use "index" to target one.)`));
  }
  return { __mcpContent: blocks };
}

module.exports = { init, name, description, inputSchema, handler };
