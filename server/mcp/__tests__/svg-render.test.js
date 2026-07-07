/**
 * Tests for server-side SVG block rasterization (svg-render.js) — the engine
 * behind the view_svg_blocks chat tool. DB-free: everything operates on an
 * in-memory fragment or raw source; the live-session path is covered in the
 * document-editing-workflow integration test.
 */
const Y = require('yjs');
const {
  collectSvgBlocks,
  renderSvgToPng,
  renderSvgBlocks,
} = require('../svg-render');
const { shutdownDiagramWorker } = require('../diagram-validate');

// First call pays the diagram worker's jsdom cold start.
jest.setTimeout(20000);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120">'
  + '<rect x="8" y="8" width="224" height="104" fill="#eef2ff"/>'
  + '<text x="20" y="66" font-size="16">hello</text></svg>';

function buildFragment(blocks) {
  const ydoc = new Y.Doc();
  const fragment = ydoc.get('default', Y.XmlFragment);
  for (const [type, source] of blocks) {
    const el = new Y.XmlElement(type);
    const t = new Y.XmlText();
    t.insert(0, source);
    el.insert(0, [t]);
    fragment.insert(fragment.length, [el]);
  }
  return fragment;
}

afterAll(async () => {
  await shutdownDiagramWorker();
});

describe('collectSvgBlocks', () => {
  test('collects all svg blocks with //svg[n] labels, skipping other blocks', () => {
    const fragment = buildFragment([
      ['paragraph', 'intro'],
      ['svg', '<svg>1</svg>'],
      ['mermaid', 'graph TD; A-->B'],
      ['svg', '<svg>2</svg>'],
    ]);
    const blocks = collectSvgBlocks(fragment);
    expect(blocks).toEqual([
      { label: '//svg[1]', source: '<svg>1</svg>' },
      { label: '//svg[2]', source: '<svg>2</svg>' },
    ]);
  });

  test('narrows by xpath while keeping canonical document-order labels', () => {
    const fragment = buildFragment([
      ['svg', '<svg>1</svg>'],
      ['svg', '<svg>2</svg>'],
    ]);
    const blocks = collectSvgBlocks(fragment, '//svg[2]');
    expect(blocks).toEqual([{ label: '//svg[2]', source: '<svg>2</svg>' }]);
  });

  test('throws when the document has no svg blocks', () => {
    const fragment = buildFragment([['paragraph', 'prose only']]);
    expect(() => collectSvgBlocks(fragment)).toThrow(/no SVG blocks/);
  });

  test('throws when the xpath matches no svg blocks, naming the valid range', () => {
    const fragment = buildFragment([
      ['svg', '<svg>1</svg>'],
      ['paragraph', 'text'],
    ]);
    expect(() => collectSvgBlocks(fragment, '//paragraph')).toThrow(/\/\/svg\[1\]/);
  });

  test('throws on an invalid xpath expression', () => {
    const fragment = buildFragment([['svg', '<svg>1</svg>']]);
    expect(() => collectSvgBlocks(fragment, '///')).toThrow(/Invalid XPath/);
  });
});

describe('renderSvgToPng', () => {
  test('renders clean SVG to a PNG buffer with dimensions', async () => {
    const { png, width, height } = await renderSvgToPng(CLEAN_SVG);
    expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    // fitTo width 800 preserves the 2:1 aspect ratio.
    expect(width).toBe(800);
    expect(height).toBe(400);
  });

  test('sanitizes before rendering (hostile SVG still renders, minus payload)', async () => {
    const { png } = await renderSvgToPng(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" onload="alert(1)">'
        + '<script>alert(2)</script><circle cx="25" cy="25" r="20" fill="green"/></svg>',
    );
    expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });

  test('rejects sources without an <svg> root', async () => {
    await expect(renderSvgToPng('not svg')).rejects.toThrow(/<svg>/);
  });

  test('renders an SVG lacking viewBox/width/height at resvg defaults', async () => {
    // resvg falls back to a default canvas rather than erroring; pin that so a
    // future resvg upgrade changing the behavior is caught.
    const { png, width, height } = await renderSvgToPng(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5" fill="red"/></svg>',
    );
    expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    expect(width).toBe(800);
    expect(height).toBe(800);
  });
});

describe('renderSvgBlocks', () => {
  test('renders every svg block, reporting per-block failures without failing the batch', async () => {
    const fragment = buildFragment([
      ['svg', CLEAN_SVG],
      ['svg', 'not really svg'],
    ]);
    const { rendered, totalSvgBlocks, skipped } = await renderSvgBlocks(fragment);
    expect(totalSvgBlocks).toBe(2);
    expect(skipped).toEqual([]);
    expect(rendered[0].label).toBe('//svg[1]');
    expect(rendered[0].png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    expect(rendered[1]).toMatchObject({ label: '//svg[2]' });
    expect(rendered[1].error).toMatch(/<svg>/);
    expect(rendered[1].png).toBeUndefined();
  });

  test('caps the batch and reports skipped labels', async () => {
    const fragment = buildFragment(
      Array.from({ length: 6 }, () => ['svg', CLEAN_SVG]),
    );
    const { rendered, skipped } = await renderSvgBlocks(fragment);
    expect(rendered).toHaveLength(4);
    expect(skipped).toEqual(['//svg[5]', '//svg[6]']);
  });
});
