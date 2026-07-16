/**
 * Finding 3 (post-merge review, 2026-07-16) — content-bearing log call sites.
 *
 * The search indexer's "Indexed" log line previously quoted the document TITLE
 * verbatim (`Indexed <guid>: "<title>"`). Titles are forbidden in logs by the
 * observability design doc because every console line feeds the telemetry
 * pipeline through the pino shim. This drives a real index of a doc whose title
 * is a sentinel and asserts the sentinel appears in NO shim-captured log line,
 * while the doc GUID (a permitted identifier) and a length label are still logged.
 */
const capture = require('./helpers/telemetry-capture');
capture.installCapture();

const Y = require('yjs');
const searchIndexer = require('../search-indexer');

const SENTINEL_TITLE = 'SENTINEL_DOC_TITLE_IN_LOG_5e2a';

afterAll(async () => {
  await capture.shutdown();
});

beforeEach(() => capture.reset());

test('indexing a doc logs the title LENGTH, never the title text (Finding 3)', async () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  const persistence = {
    getPool: () => fakePool,
    getYDoc: async () => {
      const d = new Y.Doc();
      d.getMap('meta').set('title', SENTINEL_TITLE);
      return d; // empty default fragment → no embedding API call
    },
  };
  searchIndexer.init(persistence);

  await searchIndexer.indexDocument('doc-search-log-1');

  const lines = capture.getLogLines();
  // The sentinel title must not appear anywhere in the captured log stream.
  expect(JSON.stringify(lines)).not.toContain(SENTINEL_TITLE);

  // The "Indexed" line still fired, carrying the permitted doc GUID identifier
  // and a length label rather than the title text.
  const indexed = lines.find(
    (l) => typeof l.msg === 'string' && l.msg.includes('doc-search-log-1')
  );
  expect(indexed).toBeDefined();
  expect(indexed.msg).toContain('title');
  expect(indexed.msg).not.toContain(SENTINEL_TITLE);
});
