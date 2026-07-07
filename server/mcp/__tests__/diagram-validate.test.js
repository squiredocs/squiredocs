/**
 * Tests for validateMermaidBlocks / validateSvgBlocks (server-side diagram
 * block validation).
 */
const Y = require('yjs');
const {
  validateMermaidBlocks,
  validateSvgBlocks,
  sanitizeSvgSource,
  shutdownDiagramWorker,
} = require('../diagram-validate');

// The first worker-spawning test pays a one-time cold start (jsdom + ESM mermaid
// import + initialize); give Jest room beyond its 5s default.
jest.setTimeout(20000);

/** Append a diagram block of the given type with the given source. */
function buildDiagram(xmlFragment, type, source) {
  const block = new Y.XmlElement(type);
  const textNode = new Y.XmlText();
  textNode.insert(0, source);
  block.insert(0, [textNode]);
  xmlFragment.insert(xmlFragment.length, [block]);
  return block;
}

/** Append a mermaid block with the given source to the fragment. */
function buildMermaid(xmlFragment, source) {
  return buildDiagram(xmlFragment, 'mermaid', source);
}

/** Append an svg block with the given source to the fragment. */
function buildSvg(xmlFragment, source) {
  return buildDiagram(xmlFragment, 'svg', source);
}

/** Append a plain paragraph so docs aren't only diagrams. */
function buildParagraph(xmlFragment, text) {
  const para = new Y.XmlElement('paragraph');
  const textNode = new Y.XmlText();
  textNode.insert(0, text);
  para.insert(0, [textNode]);
  xmlFragment.insert(xmlFragment.length, [para]);
}

describe('validateMermaidBlocks', () => {
  let ydoc;
  let xmlFragment;

  beforeEach(() => {
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);
  });

  afterAll(async () => {
    await shutdownDiagramWorker();
  });

  test('document with no mermaid blocks returns []', async () => {
    buildParagraph(xmlFragment, 'Just some prose.');
    const errors = await validateMermaidBlocks(xmlFragment);
    expect(errors).toEqual([]);
  });

  test('valid mermaid diagram reports no errors', async () => {
    buildMermaid(xmlFragment, 'graph TD\n  A[Start] --> B[End]');
    const errors = await validateMermaidBlocks(xmlFragment);
    expect(errors).toEqual([]);
  });

  test('invalid mermaid diagram is reported with block index and message', async () => {
    buildMermaid(xmlFragment, 'graph TD\n  A[Start] -->');
    const errors = await validateMermaidBlocks(xmlFragment);
    expect(errors).toHaveLength(1);
    expect(errors[0].block).toBe(1);
    expect(typeof errors[0].error).toBe('string');
    expect(errors[0].error.length).toBeGreaterThan(0);
    expect(errors[0].source).toContain('graph TD');
  });

  test('only the invalid block is reported when mixed with a valid one', async () => {
    buildMermaid(xmlFragment, 'graph TD\n  A --> B'); // valid -> block 1
    buildMermaid(xmlFragment, 'sequenceDiagram\n  Alice-->Bob Hi'); // invalid -> block 2
    const errors = await validateMermaidBlocks(xmlFragment);
    expect(errors).toHaveLength(1);
    expect(errors[0].block).toBe(2);
  });

  test('empty mermaid block is treated as valid (no error)', async () => {
    buildMermaid(xmlFragment, '   \n  ');
    const errors = await validateMermaidBlocks(xmlFragment);
    expect(errors).toEqual([]);
  });

  test('long source is truncated in the reported error', async () => {
    const longLabel = 'X'.repeat(500);
    buildMermaid(xmlFragment, `graph TD\n  A[${longLabel}] -->`);
    const errors = await validateMermaidBlocks(xmlFragment);
    expect(errors).toHaveLength(1);
    expect(errors[0].source.endsWith('…')).toBe(true);
    expect(errors[0].source.length).toBeLessThanOrEqual(201);
  });

  // Regression: jsdom setup must NOT leak onto the main-thread globals. When it
  // did, libraries that feature-detect `window` (gaxios, via google-auth-library
  // during OAuth) grabbed the nonexistent `window.fetch` and threw "fetchImpl is
  // not a function", breaking login. Mermaid now runs in a worker, so the main
  // thread must never see a `window`/`document`.
  test('validation does not pollute main-thread globals', async () => {
    buildMermaid(xmlFragment, 'graph TD\n  A --> B');
    await validateMermaidBlocks(xmlFragment);
    expect(global.window).toBeUndefined();
    expect(global.document).toBeUndefined();
  });
});

describe('validateSvgBlocks', () => {
  let ydoc;
  let xmlFragment;

  const CLEAN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
    + '<circle cx="5" cy="5" r="4" fill="red"/></svg>';

  beforeEach(() => {
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);
  });

  afterAll(async () => {
    await shutdownDiagramWorker();
  });

  test('document with no svg blocks returns []', async () => {
    buildParagraph(xmlFragment, 'Just some prose.');
    const errors = await validateSvgBlocks(xmlFragment);
    expect(errors).toEqual([]);
  });

  test('clean svg reports no errors', async () => {
    buildSvg(xmlFragment, CLEAN_SVG);
    const errors = await validateSvgBlocks(xmlFragment);
    expect(errors).toEqual([]);
  });

  test('script-bearing svg reports what the sanitizer will strip', async () => {
    buildSvg(
      xmlFragment,
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">'
        + '<script>alert(2)</script><rect width="5" height="5"/></svg>',
    );
    const errors = await validateSvgBlocks(xmlFragment);
    expect(errors).toHaveLength(1);
    expect(errors[0].block).toBe(1);
    expect(errors[0].error).toContain('sanitizer will strip');
    expect(errors[0].error).toContain('onload');
    expect(errors[0].error).toContain('script');
  });

  test('external references are reported', async () => {
    buildSvg(
      xmlFragment,
      '<svg xmlns="http://www.w3.org/2000/svg">'
        + '<image href="https://evil.example/x.png" width="5" height="5"/></svg>',
    );
    const errors = await validateSvgBlocks(xmlFragment);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('external reference');
  });

  test('source without an <svg> root is reported', async () => {
    buildSvg(xmlFragment, '<div>not an svg</div>');
    const errors = await validateSvgBlocks(xmlFragment);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('<svg>');
  });

  test('malformed XML is reported', async () => {
    buildSvg(
      xmlFragment,
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"'
        + ' fill="red"/><circle</svg>',
    );
    const errors = await validateSvgBlocks(xmlFragment);
    expect(errors).toHaveLength(1);
    expect(typeof errors[0].error).toBe('string');
  });

  test('only the invalid block is reported when mixed with a valid one', async () => {
    buildSvg(xmlFragment, CLEAN_SVG); // valid -> block 1
    buildSvg(xmlFragment, '<svg><script>x</script><rect width="1" height="1"/></svg>'); // block 2
    const errors = await validateSvgBlocks(xmlFragment);
    expect(errors).toHaveLength(1);
    expect(errors[0].block).toBe(2);
  });

  test('empty svg block is treated as valid (no error)', async () => {
    buildSvg(xmlFragment, '   \n  ');
    const errors = await validateSvgBlocks(xmlFragment);
    expect(errors).toEqual([]);
  });

  test('long source is truncated in the reported error', async () => {
    const longComment = 'x'.repeat(500);
    buildSvg(xmlFragment, `<svg onload="a()"><desc>${longComment}</desc><rect width="1" height="1"/></svg>`);
    const errors = await validateSvgBlocks(xmlFragment);
    expect(errors).toHaveLength(1);
    expect(errors[0].source.endsWith('…')).toBe(true);
    expect(errors[0].source.length).toBeLessThanOrEqual(201);
  });

  test('mermaid and svg blocks are validated independently', async () => {
    buildMermaid(xmlFragment, 'graph TD\n  A --> B');
    buildSvg(xmlFragment, CLEAN_SVG);
    expect(await validateMermaidBlocks(xmlFragment)).toEqual([]);
    expect(await validateSvgBlocks(xmlFragment)).toEqual([]);
  });

  test('validation does not pollute main-thread globals', async () => {
    buildSvg(xmlFragment, CLEAN_SVG);
    await validateSvgBlocks(xmlFragment);
    expect(global.window).toBeUndefined();
    expect(global.document).toBeUndefined();
  });
});

describe('sanitizeSvgSource', () => {
  afterAll(async () => {
    await shutdownDiagramWorker();
  });

  test('returns clean markup unchanged in substance', async () => {
    const svg = await sanitizeSvgSource(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg>',
    );
    expect(svg).toContain('<circle');
    expect(svg).toContain('fill="red"');
    expect(svg).toContain('viewBox="0 0 10 10"');
  });

  test('strips hostile content from the returned markup', async () => {
    const svg = await sanitizeSvgSource(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>x</script><rect width="5" height="5"/></svg>',
    );
    expect(svg).not.toContain('script');
    expect(svg).not.toContain('onload');
    expect(svg).toContain('<rect');
  });

  test('rejects sources without an <svg> root', async () => {
    await expect(sanitizeSvgSource('plain text')).rejects.toThrow(/<svg>/);
  });

  test('rejects empty sources', async () => {
    await expect(sanitizeSvgSource('   ')).rejects.toThrow(/empty/i);
  });
});
