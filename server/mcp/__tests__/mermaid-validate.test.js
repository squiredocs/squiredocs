/**
 * Tests for validateMermaidBlocks (server-side Mermaid syntax validation).
 */
const Y = require('yjs');
const { validateMermaidBlocks } = require('../mermaid-validate');

/** Append a mermaid block with the given source to the fragment. */
function buildMermaid(xmlFragment, source) {
  const block = new Y.XmlElement('mermaid');
  const textNode = new Y.XmlText();
  textNode.insert(0, source);
  block.insert(0, [textNode]);
  xmlFragment.insert(xmlFragment.length, [block]);
  return block;
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

  // Regression: setting up jsdom leaks global.window process-wide. Libraries
  // like gaxios (via google-auth-library during OAuth) detect `window` and
  // reach for `window.fetch`; if that's undefined they throw "fetchImpl is not
  // a function" and break login. The jsdom window must expose a real fetch.
  test('validation leaves a usable window.fetch (does not break gaxios fetch detection)', async () => {
    buildMermaid(xmlFragment, 'graph TD\n  A --> B');
    await validateMermaidBlocks(xmlFragment);
    expect(typeof global.window).toBe('object');
    expect(typeof global.window.fetch).toBe('function');
  });
});
