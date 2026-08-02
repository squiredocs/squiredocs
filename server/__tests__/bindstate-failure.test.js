/**
 * Feature 041 US2 (FR-010, SC-004): a document-load failure refuses the
 * collaboration bind instead of serving an empty document over an outage.
 *
 * Covers contracts/bind-failure.md: page + error log + eviction + close 1013,
 * never the `NEW DOC` info line — plus the PIN that the legitimate new-document
 * path (zero rows, no error) is untouched.
 */
const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const {
  refuseBind,
  resetPageThrottle,
  BIND_FAILED_CLOSE_CODE,
  PAGE_THROTTLE_MS,
} = require('../bind-failure');
const { createPersistence } = require('./helpers/db');

function makeConn() {
  return { close: jest.fn() };
}

function makeDoc(conns = []) {
  const ydoc = new Y.Doc();
  ydoc.conns = new Map(conns.map(c => [c, new Set()]));
  return ydoc;
}

/**
 * Mirror of the per-connection Redis cleanup registered in server/index.js's
 * `ws.on('close')` handler (index.js boots a live server on require, so the rule
 * is exercised here and PINNED by source below).
 *
 * The closure captures ONE doc instance for the life of the connection, while
 * `unsubscribeFromDocument` is keyed by NAME — hence the identity check.
 */
function makeCloseCleanup({ doc, wsDocName, docId, docs, redisPubSub }) {
  return () => {
    const isCurrentDoc = !docs.has(wsDocName) || docs.get(wsDocName) === doc;
    if (doc.conns.size === 0 && isCurrentDoc && redisPubSub.isEnabled()) {
      redisPubSub.unsubscribeFromDocument(docId);
      doc._redisSyncInitialized = false;
    }
  };
}

describe('041 FR-010: bind refusal on document load failure', () => {
  let errorSpy;
  let logSpy;

  beforeEach(() => {
    resetPageThrottle();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('pages the notifier, evicts the doc, and closes every connection with 1013', () => {
    const notify = jest.fn();
    const connA = makeConn();
    const connB = makeConn();
    const ydoc = makeDoc([connA, connB]);
    const docs = new Map([['s/doc-1', ydoc]]);
    const error = new Error('connection terminated unexpectedly');

    const result = refuseBind({
      docName: 's/doc-1',
      docGuid: 'doc-1',
      ydoc,
      error,
      docs,
      notify,
    });

    // Paged with the contract's source + context.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe(error);
    expect(notify.mock.calls[0][1]).toEqual({ source: 'bindState', extra: { docGuid: 'doc-1' } });

    // Marked, evicted, closed.
    expect(ydoc._bindFailed).toBe(true);
    expect(docs.has('s/doc-1')).toBe(false);
    expect(connA.close).toHaveBeenCalledWith(BIND_FAILED_CLOSE_CODE, expect.any(String));
    expect(connB.close).toHaveBeenCalledWith(BIND_FAILED_CLOSE_CODE, expect.any(String));
    expect(result).toEqual({ paged: true, evicted: true, closedConnections: 2 });

    // Error-level log, never the info-level NEW DOC line.
    expect(errorSpy).toHaveBeenCalled();
    const infoLines = logSpy.mock.calls.map(c => String(c[0]));
    expect(infoLines.some(l => l.includes('NEW DOC'))).toBe(false);
  });

  test('never evicts a doc that a later bind already replaced in the registry', () => {
    const stale = makeDoc();
    const fresh = makeDoc();
    const docs = new Map([['s/doc-1', fresh]]);

    const result = refuseBind({
      docName: 's/doc-1',
      docGuid: 'doc-1',
      ydoc: stale,
      error: new Error('boom'),
      docs,
      notify: jest.fn(),
    });

    expect(result.evicted).toBe(false);
    expect(docs.get('s/doc-1')).toBe(fresh);
  });

  test('a sustained outage pages once per document per window, never unbounded', () => {
    const notify = jest.fn();
    const t0 = 1_000_000;

    for (let i = 0; i < 5; i++) {
      refuseBind({
        docName: 's/doc-1',
        docGuid: 'doc-1',
        ydoc: makeDoc(),
        error: new Error('boom'),
        docs: new Map(),
        notify,
        now: t0 + i * 1000,
      });
    }
    expect(notify).toHaveBeenCalledTimes(1);

    // A different document is its own signal, not suppressed by the first.
    refuseBind({
      docName: 's/doc-2',
      docGuid: 'doc-2',
      ydoc: makeDoc(),
      error: new Error('boom'),
      docs: new Map(),
      notify,
      now: t0 + 1000,
    });
    expect(notify).toHaveBeenCalledTimes(2);

    // ...and the window eventually reopens for the first document.
    refuseBind({
      docName: 's/doc-1',
      docGuid: 'doc-1',
      ydoc: makeDoc(),
      error: new Error('boom'),
      docs: new Map(),
      notify,
      now: t0 + PAGE_THROTTLE_MS + 1,
    });
    expect(notify).toHaveBeenCalledTimes(3);
  });

  test('a failing notifier never prevents eviction or connection close', () => {
    const conn = makeConn();
    const ydoc = makeDoc([conn]);
    const docs = new Map([['s/doc-1', ydoc]]);

    const result = refuseBind({
      docName: 's/doc-1',
      docGuid: 'doc-1',
      ydoc,
      error: new Error('boom'),
      docs,
      notify: () => { throw new Error('notifier down'); },
    });

    expect(result.paged).toBe(false);
    expect(docs.has('s/doc-1')).toBe(false);
    expect(conn.close).toHaveBeenCalledWith(BIND_FAILED_CLOSE_CODE, expect.any(String));
  });

  // ── Review M1: a straggler close must not unsubscribe the RE-BOUND doc ────
  // refuseBind closes the connections and CLEARS `doc.conns`, so a delayed close
  // from an already-dead connection observes `size === 0` on the OLD doc. By then
  // a reconnect has bound a fresh doc under the same name and subscribed it. The
  // name-keyed unsubscribe would kill the live doc's channels, and nothing ever
  // re-subscribes (the fresh doc already has `_redisSyncInitialized`), so it goes
  // silently deaf to every other instance's updates.
  describe('Review M1: Redis cleanup after a refused bind is identity-checked', () => {
    const wsDocName = 's/doc-1';
    const docId = 'doc-1';

    test('a stale close after a rebind does NOT unsubscribe the live doc', () => {
      const redisPubSub = { isEnabled: () => true, unsubscribeFromDocument: jest.fn() };

      // The original doc: two clients, subscribed to Redis.
      const connA = makeConn();
      const connB = makeConn();
      const stale = makeDoc([connA, connB]);
      stale._redisSyncInitialized = true;
      const docs = new Map([[wsDocName, stale]]);

      // Each connection registered its own close cleanup, capturing THIS doc.
      const cleanupB = makeCloseCleanup({ doc: stale, wsDocName, docId, docs, redisPubSub });

      // DB blip: the bind is refused — conns closed and cleared, doc evicted.
      refuseBind({ docName: wsDocName, docGuid: docId, ydoc: stale, error: new Error('db blip'), docs, notify: jest.fn() });
      expect(stale.conns.size).toBe(0);

      // Client A reconnects: a fresh doc binds under the same name and subscribes.
      const fresh = makeDoc([makeConn()]);
      fresh._redisSyncInitialized = true;
      docs.set(wsDocName, fresh);

      // ...and only now does dead client B's close land.
      cleanupB();

      expect(redisPubSub.unsubscribeFromDocument).not.toHaveBeenCalled();
      expect(fresh._redisSyncInitialized).toBe(true); // still live, still subscribed
    });

    test('the ordinary last-connection close still tears the subscription down', () => {
      const redisPubSub = { isEnabled: () => true, unsubscribeFromDocument: jest.fn() };
      const doc = makeDoc();
      doc._redisSyncInitialized = true;
      const docs = new Map([[wsDocName, doc]]);

      makeCloseCleanup({ doc, wsDocName, docId, docs, redisPubSub })();

      expect(redisPubSub.unsubscribeFromDocument).toHaveBeenCalledWith(docId);
      expect(doc._redisSyncInitialized).toBe(false);
    });

    test('a doc already gone from the registry still cleans up (no leaked subscription)', () => {
      const redisPubSub = { isEnabled: () => true, unsubscribeFromDocument: jest.fn() };
      const doc = makeDoc();
      doc._redisSyncInitialized = true;

      makeCloseCleanup({ doc, wsDocName, docId, docs: new Map(), redisPubSub })();

      expect(redisPubSub.unsubscribeFromDocument).toHaveBeenCalledWith(docId);
    });
  });

  // ── PIN: the legitimate new-document path is untouched ────────────────────
  // The whole refusal rests on this: `getYDoc` does NOT throw for a document
  // with no rows, so the bindState catch is reachable only on a REAL failure.
  test('PIN: persistence.getYDoc resolves an empty doc for zero rows instead of throwing', async () => {
    const persistence = createPersistence();
    try {
      const guid = require('crypto').randomUUID();
      const ydoc = await persistence.getYDoc(guid);
      expect(ydoc).toBeInstanceOf(Y.Doc);
      expect(ydoc.getXmlFragment('default').length).toBe(0);
    } finally {
      await persistence.destroy?.();
    }
  });

  // ── PIN: the wiring in server/index.js ────────────────────────────────────
  // index.js boots a live server on require, so its bindState catch is pinned by
  // source inspection: the NEW DOC framing must be gone and the persist path
  // must be gated on the failure marker.
  describe('PIN: server/index.js bindState wiring', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

    test('the bind failure path no longer logs NEW DOC or BIND_STATE_NEW_DOC', () => {
      expect(source).not.toMatch(/BIND_STATE_NEW_DOC/);
      expect(source).not.toMatch(/\[bindState\] NEW DOC/);
    });

    test('the catch refuses the bind with the notifier and the y-websocket docs map', () => {
      expect(source).toMatch(/refuseBind\(\{\s*docName,\s*docGuid,\s*ydoc,\s*error,\s*docs,\s*notify: notifyException\s*\}\)/);
    });

    test('the update listener drops updates on a doc whose bind failed', () => {
      expect(source).toMatch(/if \(ydoc\._bindFailed\) return;/);
    });

    test('the close-time Redis cleanup is identity-checked against the registry (review M1)', () => {
      expect(source).toMatch(
        /const isCurrentDoc = !docs\.has\(wsDocName\) \|\| docs\.get\(wsDocName\) === doc;/
      );
      expect(source).toMatch(
        /if \(doc\.conns\.size === 0 && isCurrentDoc && redisPubSub\.isEnabled\(\)\)/
      );
    });
  });
});
