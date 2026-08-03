/**
 * Borrowed-identity performance shape (feature 049, N11 — SC-001/FR-013).
 *
 * WHAT THIS ASSERTS, AND WHAT IT DOES NOT. The claim 049 makes is about SHAPE,
 * not about a wall-clock number: `updateDocument`'s cost stops tracking document
 * size. Under 048 a metadata write serialized the whole document into a
 * throwaway `Y.Doc` and merged the bytes back, so a title set on a 3 MB document
 * paid for the whole 3 MB (design's measured table: 15.6 / 56.4 / 211.8 ms at
 * 79 KB / 794 KB / 3.2 MB). Borrowing an identity pays for none of it.
 *
 * The assertion is therefore a RATIO CEILING across three document sizes, not an
 * absolute budget — wall-clock budgets flake under CPU contention, and the guard's
 * job is catching an order-of-magnitude regression (the same reasoning, and the
 * same contention-tolerant posture, as `import-performance.test.js`). The real
 * per-operation numbers are logged so a human can read them; they are recorded in
 * `specs/049-constant-time-write-path/performance.md`.
 *
 * HERMETIC: driven through `documentService.init` with local `Y.Doc`s. No DB, no
 * WebSocket.
 *
 * ⚠️ HONEST SCOPE: this measures `updateDocument` itself. It is NOT the
 * end-to-end server-side write, which also runs the persistence listener's
 * `classifyByXml` (`server/update-classifier.js`) — O(document size) per applied
 * update, skipped only above a 500 KB ceiling. 049 does not change that, and does
 * not claim to. See performance.md.
 */
const Y = require('yjs');
const documentService = require('../document-service');

const DOC_GUID = '049-perf-doc';
const ATTRIB = { userId: '11111111-1111-4111-8111-111111111111', agentName: 'Perf Agent' };

const paragraph = (text) => {
  const el = new Y.XmlElement('paragraph');
  el.insert(0, [new Y.XmlText(text)]);
  return el;
};

/** A warm shared doc of roughly `targetBytes` encoded size. */
function makeDocOfSize(targetBytes) {
  const ydoc = new Y.Doc();
  const frag = ydoc.get('default', Y.XmlFragment);
  const chunk = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ';
  let i = 0;
  while (Y.encodeStateAsUpdate(ydoc).byteLength < targetBytes) {
    const batch = [];
    for (let k = 0; k < 50; k += 1) batch.push(paragraph(`${i++} ${chunk}`));
    frag.insert(frag.length, batch);
  }
  ydoc._bindComplete = true;
  return ydoc;
}

/** Median per-operation milliseconds for `n` metadata writes. */
async function timeWrites(ydoc, n) {
  documentService.init(() => ydoc, (name) => (name.startsWith('s/') ? name.slice(2) : name));
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const started = process.hrtime.bigint();
    await documentService.updateDocument(
      DOC_GUID,
      () => (doc) => doc.getMap('meta').set('title', `Title ${i}`),
      ATTRIB
    );
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe('049 N11 — per-operation cost does not scale with document size (SC-001)', () => {
  afterEach(() => documentService.init(null, null, null));

  test('a metadata write costs the same order of time at ~80 KB, ~800 KB and ~3 MB', async () => {
    const sizes = [
      ['~80 KB', 80 * 1024],
      ['~800 KB', 800 * 1024],
      ['~3 MB', 3 * 1024 * 1024],
    ];

    const results = [];
    for (const [label, bytes] of sizes) {
      const ydoc = makeDocOfSize(bytes);
      const actual = Y.encodeStateAsUpdate(ydoc).byteLength;
      // Warm up so the first sample does not carry JIT/alloc noise.
      await timeWrites(ydoc, 3);
      const median = await timeWrites(ydoc, 25);
      results.push({ label, actualBytes: actual, median });
      documentService.init(null, null, null);
    }

    // eslint-disable-next-line no-console
    console.log(
      '\n[049 N11] median per-operation time for one meta title set:\n' +
      results.map((r) =>
        `  ${r.label.padEnd(8)} (${String(r.actualBytes).padStart(9)} bytes encoded): ` +
        `${r.median.toFixed(4)} ms`
      ).join('\n') + '\n'
    );

    const smallest = results[0].median;
    const largest = results[results.length - 1].median;

    // THE SHAPE ASSERTION. The document grew ~40x from the first size to the
    // last. If cost tracked size, the ratio would grow with it — 048 measured
    // 15.6 ms -> 211.8 ms, a 13.6x rise. A generous 8x ceiling still fails that
    // decisively while tolerating the noise of a shared, contended test runner.
    const ratio = largest / Math.max(smallest, 1e-4);
    expect(ratio).toBeLessThan(8);

    // And an absolute sanity ceiling: a metadata write on a 3 MB document must
    // stay sub-10 ms. The design measured 0.17 ms; 10 ms is contention slack,
    // not a target. Under 048 this was 211.8 ms.
    expect(largest).toBeLessThan(10);
  }, 120000);
});
