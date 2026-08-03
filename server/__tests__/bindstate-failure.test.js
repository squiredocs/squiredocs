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
    expect(result).toEqual({ paged: true, evicted: true, closedConnections: 2, destroyed: true });

    // Destroyed, not just evicted: closeConn's own destroy branch is
    // unreachable after conns.clear(), and an undestroyed WSSharedDoc is
    // pinned forever by its awareness heartbeat interval — a sustained outage
    // would leak one full doc copy per 1013 retry cycle (review H2).
    expect(ydoc.isDestroyed).toBe(true);

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

    // The stale doc is out of the registry either way, so it is still
    // destroyed; the live replacement must never be.
    expect(result.destroyed).toBe(true);
    expect(stale.isDestroyed).toBe(true);
    expect(fresh.isDestroyed).toBe(false);
  });

  test('never destroys a doc it cannot confirm is out of the registry', () => {
    // No `docs` handed in (the callers that only want the marking + close
    // behavior): the doc may still be what the registry serves to the next
    // connection, and handing out a destroyed doc is worse than the leak.
    const ydoc = makeDoc([makeConn()]);

    const result = refuseBind({
      docName: 's/doc-1',
      docGuid: 'doc-1',
      ydoc,
      error: new Error('boom'),
      notify: jest.fn(),
    });

    expect(result.destroyed).toBe(false);
    expect(ydoc.isDestroyed).toBe(false);
    expect(ydoc._bindFailed).toBe(true);
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

  // ── PIN: the bindState wiring ─────────────────────────────────────────────
  // These pins exist because index.js boots a live server on require, so its
  // bindState catch could only be checked by source inspection: the NEW DOC
  // framing must be gone and the persist path must be gated on the failure
  // marker.
  //
  // Feature 043 (X1) MOVED that code out of server/index.js into
  // server/collab-bind-state.js so it could be driven directly. The pins follow
  // the code to its new home — same regexes, byte for byte, read from the file
  // that now contains the subject. Nothing is relaxed: drift protection tracks
  // the code, not the filename. The absence pin below reads BOTH files, so a
  // re-inlined NEW DOC branch fails wherever it reappears.
  describe('PIN: bindState wiring (server/collab-bind-state.js after 043 X1)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const bindStateSource = fs.readFileSync(path.join(__dirname, '..', 'collab-bind-state.js'), 'utf8');

    test('the bind failure path no longer logs NEW DOC or BIND_STATE_NEW_DOC', () => {
      expect(source + bindStateSource).not.toMatch(/BIND_STATE_NEW_DOC/);
      expect(source + bindStateSource).not.toMatch(/\[bindState\] NEW DOC/);
    });

    test('the catch refuses the bind with the notifier and the y-websocket docs map', () => {
      expect(bindStateSource).toMatch(/refuseBind\(\{\s*docName,\s*docGuid,\s*ydoc,\s*error,\s*docs,\s*notify: notifyException\s*\}\)/);
    });

    test('the update listener drops updates on a doc whose bind failed', () => {
      expect(bindStateSource).toMatch(/if \(ydoc\._bindFailed\) return;/);
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

  /**
   * NEW-5 (feature 046): a SERVER-SIDE write into a refused doc must not report
   * success.
   *
   * The `_bindFailed` gate above is correct, and its comment's premise — "its
   * connections are closed and it is evicted, so nothing should arrive here" —
   * holds only for WebSocket traffic. `documentService.updateDocument` (agent
   * modify, import, document creation) reaches the same listener holding a doc
   * handle acquired BEFORE the refusal. It has no connection to close, so it
   * transacts, the gate silently drops the persist, and the call used to resolve
   * normally: an agent told "done" for content that exists nowhere, which it
   * then builds further work on.
   *
   * These drive the REAL listener from server/collab-bind-state.js and the REAL
   * refuseBind, so the gate under test is the shipped one.
   */
  describe('046 NEW-5: server-side writes into a refused doc fail loudly', () => {
    const { createUpdateListener } = require('../collab-bind-state');
    const { BindFailedError } = require('../bind-failure');
    const documentService = require('../document-service');

    const DOC_GUID = 'refused-doc-guid';

    let ydoc;
    let storeUpdate;

    beforeEach(() => {
      ydoc = new Y.Doc();
      ydoc.conns = new Map();
      storeUpdate = jest.fn().mockResolvedValue(1);

      // The real listener, wired the way createBindState wires it.
      ydoc.on('update', createUpdateListener({
        persistenceProvider: { storeUpdate, updateDocumentTitle: jest.fn().mockResolvedValue() },
        pendingWrites: new Set(),
        notifyException: () => {},
        searchIndexer: { markDirty: () => {} },
        collabGuardrail: { evaluateUpdate: () => Promise.resolve() },
        logPerf: () => {},
      }, DOC_GUID, ydoc));

      documentService.init(() => ydoc, (n) => (n.startsWith('s/') ? n.slice(2) : n));
    });

    afterEach(() => {
      documentService.init(null, null, null);
    });

    const write = () => documentService.updateDocument(
      DOC_GUID,
      (doc) => {
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText('agent content')]);
        doc.get('default', Y.XmlFragment).insert(0, [p]);
      },
      { userId: '11111111-1111-4111-8111-111111111111', agentName: 'Test Agent' }
    );

    test('the control: with a healthy bind the write persists and resolves', async () => {
      await expect(write()).resolves.toMatchObject({ update: expect.any(Uint8Array) });
      expect(storeUpdate).toHaveBeenCalledTimes(1);
    });

    test('a refusal that ALREADY landed makes the write throw, not resolve', async () => {
      refuseBind({ docName: `s/${DOC_GUID}`, docGuid: DOC_GUID, ydoc, error: new Error('load failed') });
      expect(ydoc._bindFailed).toBe(true);

      await expect(write()).rejects.toThrow(BindFailedError);
      // The loss itself: the gate dropped it, so nothing was ever written.
      expect(storeUpdate).not.toHaveBeenCalled();
    });

    test('a refusal landing DURING the call still throws (the window a pre-check misses)', async () => {
      // The refusal arrives between handle acquisition and the listener firing —
      // exactly the race that makes a check BEFORE the transaction useless. The
      // listener runs at transaction end and sees the flag, so it drops.
      await expect(documentService.updateDocument(
        DOC_GUID,
        (doc) => {
          refuseBind({ docName: `s/${DOC_GUID}`, docGuid: DOC_GUID, ydoc: doc, error: new Error('load failed mid-write') });
          const p = new Y.XmlElement('paragraph');
          p.insert(0, [new Y.XmlText('lost content')]);
          doc.get('default', Y.XmlFragment).insert(0, [p]);
        },
        { userId: '11111111-1111-4111-8111-111111111111', agentName: 'Test Agent' }
      )).rejects.toThrow(BindFailedError);

      expect(storeUpdate).not.toHaveBeenCalled();
    });

    test('the error names the document and asks for a retry (refuseBind evicts, so a retry rebinds)', async () => {
      refuseBind({ docName: `s/${DOC_GUID}`, docGuid: DOC_GUID, ydoc, error: new Error('load failed') });
      const err = await write().catch((e) => e);

      expect(err).toBeInstanceOf(BindFailedError);
      expect(err.docGuid).toBe(DOC_GUID);
      expect(err.message).toContain('was not saved');
      expect(err.message).toMatch(/retry/i);
    });

    test('a NO-CHANGE write into a refused doc throws too', async () => {
      // No update event fires, so nothing is dropped — but the updateFn computed
      // its "nothing to do" verdict against a document whose contents are
      // unknown. Reporting success would assert something this doc cannot back.
      refuseBind({ docName: `s/${DOC_GUID}`, docGuid: DOC_GUID, ydoc, error: new Error('load failed') });

      await expect(documentService.updateDocument(DOC_GUID, () => {}, { userId: null }))
        .rejects.toThrow(BindFailedError);
    });
  });
});
