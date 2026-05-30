/**
 * Tests for the render_diagram tool's content-shaping logic.
 *
 * The real renderer (diagram-render) is mocked here: it pulls in
 * @hpcc-js/wasm-graphviz, an ESM/WASM package jest's VM can't load. The actual
 * DOT→SVG→PNG pipeline is exercised by the server at runtime (Node's
 * require(esm)); these tests cover the tool's block assembly and error handling.
 */

jest.mock('../../diagram-render', () => ({
  SUPPORTED_TYPES: ['graphviz'],
  renderDiagram: jest.fn(async (type, source) => {
    if (type !== 'graphviz') {
      const e = new Error(`unsupported ${type}`);
      e.code = 'DIAGRAM_UNSUPPORTED';
      throw e;
    }
    if (source.includes('BAD')) {
      const e = new Error('Graphviz syntax error');
      e.code = 'DIAGRAM_SYNTAX';
      throw e;
    }
    return {
      svg: '<svg>fake</svg>',
      pngBase64: Buffer.from('fake-png-bytes').toString('base64'),
      width: 120,
      height: 60,
    };
  }),
}));

const tool = require('../../tools/render-diagram');

describe('render_diagram tool (direct source)', () => {
  test('returns a PNG image block for valid graphviz source', async () => {
    const r = await tool.handler({ source: 'digraph { A -> B }', format: 'both' });
    const img = r.__mcpContent.find((b) => b.type === 'image');
    expect(img).toBeDefined();
    expect(img.mimeType).toBe('image/png');
    expect(img.data.length).toBeGreaterThan(0);
    // caption + svg markup present for 'both'
    expect(r.__mcpContent[0].text).toMatch(/graphviz, rendered 120×60px/);
    expect(r.__mcpContent.some((b) => b.type === 'text' && b.text === '<svg>fake</svg>')).toBe(true);
  });

  test('png is the default format (no svg text block)', async () => {
    const r = await tool.handler({ source: 'digraph { A -> B }' });
    expect(r.__mcpContent.some((b) => b.type === 'image')).toBe(true);
    expect(r.__mcpContent.some((b) => b.text === '<svg>fake</svg>')).toBe(false);
  });

  test('svg format returns markup only, no image', async () => {
    const r = await tool.handler({ source: 'digraph { A -> B }', format: 'svg' });
    expect(r.__mcpContent.some((b) => b.type === 'image')).toBe(false);
    expect(r.__mcpContent.some((b) => b.text === '<svg>fake</svg>')).toBe(true);
  });

  test('reports a render error as a text note (does not throw)', async () => {
    const r = await tool.handler({ source: 'digraph { A -> BAD }' });
    expect(r.__mcpContent[0].text).toMatch(/render failed.*Graphviz syntax error/i);
    expect(r.__mcpContent.some((b) => b.type === 'image')).toBe(false);
  });

  test('notes that mermaid is not server-renderable', async () => {
    const r = await tool.handler({ source: 'graph TD; A-->B', type: 'mermaid' });
    expect(r.__mcpContent[0].text).toMatch(/cannot render 'mermaid'/);
  });

  test('empty source is reported, not rendered', async () => {
    const r = await tool.handler({ source: '   ' });
    expect(r.__mcpContent[0].text).toMatch(/empty diagram source/);
  });

  test('requires source or docGuid', async () => {
    await expect(tool.handler({})).rejects.toThrow(/requires either/);
  });
});
