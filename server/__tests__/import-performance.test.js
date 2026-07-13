/**
 * Import performance validation (feature 002, T033 — SC-005).
 *
 * SC-005: a 1 MB no-image import completes in < 5 s. The 10-image path is
 * exercised with a fake fetch for determinism (real-host timings are noted in
 * the PR/commit description — they depend on the network, not this code).
 *
 * Runs prepareImport (parse → transforms → materialize → image pass) — the
 * whole CPU-bound pipeline minus the live-doc transaction — so the timing is
 * hermetic and CI-stable.
 */
const Y = require('yjs');
const { prepareImport, setExternalImagePass } = require('../markdown-import');

describe('import performance (SC-005)', () => {
  afterEach(() => setExternalImagePass(null));

  test('1 MB no-image markdown imports in under 5 s', async () => {
    // Build ~1 MB of realistic mixed markdown (headings, lists, code, tables,
    // inline formatting) — not one pathological line.
    const section = [
      '## Section Heading',
      '',
      'A paragraph with **bold**, _italic_, `code`, and a [link](https://example.com/x).',
      '',
      '- bullet one with some length to it',
      '- bullet two **bold**',
      '  - nested bullet',
      '',
      '1. ordered one',
      '2. ordered two',
      '',
      '```js',
      'const value = compute(input);',
      'console.log(value);',
      '```',
      '',
      '| Col A | Col B |',
      '| --- | --- |',
      '| cell one | cell two |',
      '',
      '> a blockquote line',
      '',
    ].join('\n');
    let markdown = '# Performance Document\n\n';
    while (Buffer.byteLength(markdown) < 1024 * 1024) markdown += section;
    expect(Buffer.byteLength(markdown)).toBeGreaterThanOrEqual(1024 * 1024);

    const start = Date.now();
    const { nodes } = await prepareImport(markdown, { docId: 'perf-doc', userId: 'perf-user' });
    const elapsed = Date.now() - start;

    expect(nodes.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
    // Surface the number so the run records it (SC-005 evidence).
    console.log(`[SC-005] 1 MB no-image import: ${elapsed} ms (budget 5000 ms)`);
  }, 15000);

  test('10-image import path is exercised (fake fetch, deterministic)', async () => {
    // Ten distinct external images; fake the pass so the timing reflects the
    // pipeline, not the network. Real-host numbers go in the PR description.
    setExternalImagePass(async (fragment) => {
      const { findByNodeName } = require('../mcp/sandbox/helpers');
      const rehosted = [];
      for (const node of findByNodeName(fragment, 'image')) {
        const src = node.getAttribute('src');
        node.setAttribute('src', `/api/docs/perf-doc/images/${rehosted.length}`);
        rehosted.push({ src, url: `/api/docs/perf-doc/images/${rehosted.length}` });
      }
      return { rehosted, degraded: [] };
    });

    let markdown = '# Image Perf\n\n';
    for (let i = 0; i < 10; i++) {
      markdown += `![image ${i}](https://cdn.example.com/img-${i}.png)\n\n`;
    }

    const start = Date.now();
    const { nodes, images } = await prepareImport(markdown, { docId: 'perf-doc', userId: 'perf-user' });
    const elapsed = Date.now() - start;

    expect(images.rehosted).toHaveLength(10);
    expect(nodes.length).toBeGreaterThanOrEqual(10);
    console.log(`[SC-005] 10-image import (fake fetch): ${elapsed} ms`);
  }, 15000);
});
