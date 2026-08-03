/**
 * Unit coverage for the "may I compute a durable artifact from this live doc?"
 * predicate, and for the bind-completion flag it reads (feature 046, NEW-2a/2b).
 *
 * The predicate is small on purpose. What matters is that it is TOTAL — every
 * shape a registry doc can be in has a defined answer, and every ambiguous one
 * answers "no" — because the callers that consult it (restore, undo) write rows
 * that are wrong forever if it says yes when it should not.
 */
const Y = require('yjs');

const { isTrustedLiveDoc, untrustedReason } = require('../live-doc-trust');
const { createBindState } = require('../collab-bind-state');

/** A doc shaped like y-websocket's WSSharedDoc: a `conns` map of connections. */
function docWithConns(count) {
  const doc = new Y.Doc();
  doc.conns = new Map();
  for (let i = 0; i < count; i += 1) doc.conns.set({ conn: i }, new Set());
  return doc;
}

describe('live-doc-trust: isTrustedLiveDoc', () => {
  test('a bound, connected doc is trusted', () => {
    const doc = docWithConns(1);
    doc._bindComplete = true;
    expect(isTrustedLiveDoc(doc)).toBe(true);
    expect(untrustedReason(doc)).toBeNull();
  });

  test('NEW-2a: a doc whose bind has not completed is NOT trusted', () => {
    // The registry entry exists and is fully readable — and totally empty,
    // because y-websocket does not await bindState. This is the shape that made
    // restore store the target clone alone and let the in-flight load merge the
    // old content back on top.
    const doc = docWithConns(1);
    expect(doc._bindComplete).toBeUndefined();
    expect(isTrustedLiveDoc(doc)).toBe(false);
    expect(untrustedReason(doc)).toBe('bind-incomplete');
  });

  test('NEW-2a: a doc whose bind FAILED is NOT trusted', () => {
    const doc = docWithConns(1);
    doc._bindFailed = true;
    expect(isTrustedLiveDoc(doc)).toBe(false);
  });

  test('NEW-2b: a bound but connection-less doc is NOT trusted (the leaked doc)', () => {
    // Server-created via the CREATING getSharedDoc: no Redis subscription is
    // ever wired for it and nothing evicts it, so it is frozen at whenever the
    // write that created it ran.
    const doc = docWithConns(0);
    doc._bindComplete = true;
    expect(isTrustedLiveDoc(doc)).toBe(false);
    expect(untrustedReason(doc)).toBe('no-connections');
  });

  test('a plain Y.Doc (no conns map at all) is NOT trusted', () => {
    const doc = new Y.Doc();
    doc._bindComplete = true;
    expect(isTrustedLiveDoc(doc)).toBe(false);
    expect(untrustedReason(doc)).toBe('no-connections');
  });

  test('null / undefined answer "not loaded" rather than throwing', () => {
    for (const value of [null, undefined]) {
      expect(isTrustedLiveDoc(value)).toBe(false);
      expect(untrustedReason(value)).toBe('not-loaded');
    }
  });

  test('a truthy non-doc never sneaks through', () => {
    for (const value of [{}, { conns: {} }, { conns: new Map(), _bindComplete: true }]) {
      expect(isTrustedLiveDoc(value)).toBe(false);
    }
  });

  test('a doc with several connections is trusted', () => {
    const doc = docWithConns(3);
    doc._bindComplete = true;
    expect(isTrustedLiveDoc(doc)).toBe(true);
  });
});

describe('collab-bind-state: the bind-completion flag (046, NEW-2a)', () => {
  const deps = (persistenceProvider) => ({
    persistenceProvider,
    pendingWrites: new Set(),
    notifyException: () => {},
    searchIndexer: { markDirty: () => {} },
    collabGuardrail: { evaluateUpdate: () => Promise.resolve() },
    logPerf: () => {},
  });

  test('is set once the persisted state has been applied', async () => {
    const persisted = new Y.Doc();
    persisted.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);

    const bindState = createBindState(deps({ getYDoc: async () => persisted }));
    const ydoc = new Y.Doc();
    expect(ydoc._bindComplete).toBeUndefined();

    await bindState('s/doc-1', ydoc);
    expect(ydoc._bindComplete).toBe(true);
  });

  test('is NOT set while the load is still in flight', async () => {
    let releaseLoad;
    const gate = new Promise((resolve) => { releaseLoad = resolve; });
    const bindState = createBindState(deps({
      getYDoc: async () => { await gate; return new Y.Doc(); },
    }));

    const ydoc = new Y.Doc();
    const binding = bindState('s/doc-2', ydoc);

    // The doc is already in a caller's hands here — this is exactly the window
    // in which a restore could peek it and find it empty.
    expect(ydoc._bindComplete).toBeUndefined();
    expect(isTrustedLiveDoc(Object.assign(ydoc, { conns: new Map([[{}, new Set()]]) }))).toBe(false);

    releaseLoad();
    await binding;
    expect(ydoc._bindComplete).toBe(true);
  });

  test('is NOT set when the load FAILS — the refusal path leaves it untrusted', async () => {
    const bindState = createBindState(deps({
      getYDoc: async () => { throw new Error('load failed'); },
    }));

    const ydoc = new Y.Doc();
    const errs = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await bindState('s/doc-3', ydoc);
    } finally {
      errs.mockRestore();
    }

    expect(ydoc._bindComplete).toBeUndefined();
    expect(ydoc._bindFailed).toBe(true);
    expect(isTrustedLiveDoc(ydoc)).toBe(false);
  });
});
