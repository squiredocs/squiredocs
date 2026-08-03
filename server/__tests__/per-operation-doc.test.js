/**
 * Feature 048 — per-identity server docs.
 *
 * Two things are pinned here, and they are separate concerns that happen to
 * live in the same function:
 *
 * 1. THE BIND-READINESS GATE (FR-013, RBD-048-4). `getSharedDoc` CREATES the
 *    doc and fires an un-awaited `bindState`, so a write to a cold document
 *    used to race the load. The adversarial review reproduced the loss against
 *    this repo's own yjs: a title set lost 98/200 trials to Y.Map LWW, and an
 *    "append at the end" landed at index 0 — before the whole document. The
 *    H-class below is that reproduction, now asserting the gate closes it.
 *
 * 2. THE PER-OPERATION AUTHORSHIP INVARIANT (FR-002/FR-007). The shared server
 *    doc's own clientID must never author a content operation; everything
 *    reaching it is pre-encoded bytes from a fresh one-shot ephemeral doc. The
 *    G-class below reads insert sets exactly the way `resupply-resolution.js`
 *    does (`Y.parseUpdateMeta(update).to.keys()`), so the guard tests the
 *    precise property the resolver depends on.
 *
 * These drive document-service through its `init` seam with local Y.Docs — no
 * DB, no WebSocket — so they isolate the mechanism itself.
 */
const Y = require('yjs');
const documentService = require('../document-service');
const { BindFailedError } = require('../bind-failure');
const { parseOrigin } = require('../origin');

const DOC_GUID = '048-doc-under-test';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Count 'update' listeners currently attached to a Y.Doc. */
const updateListenerCount = (ydoc) => (ydoc._observers.get('update') || new Set()).size;

/** The insert-set clientIDs of an update — the resolver's own extraction. */
const insertClientIds = (update) => [...Y.parseUpdateMeta(update).to.keys()];

const paragraph = (text) => {
  const el = new Y.XmlElement('paragraph');
  el.insert(0, [new Y.XmlText(text)]);
  return el;
};

/** Text of each top-level child of the default fragment, in order. */
const fragmentTexts = (ydoc) => ydoc.get('default', Y.XmlFragment).toArray().map((n) => n.toString());

/**
 * A shared doc that behaves like a real cold one: it is handed out EMPTY and
 * absorbs its "persisted" state only after `delayMs`, then marks the bind
 * complete — exactly y-websocket's un-awaited `bindState`.
 *
 * Rows are recorded the way the real bindState listener records them: any
 * update carrying a parseable (user/agent) origin is a durable write.
 */
function makeColdDoc({ persistedTitle = null, persistedBodies = [], delayMs = 25, neverBinds = false } = {}) {
  const ydoc = new Y.Doc();
  const rows = [];
  ydoc.on('update', (update, origin) => {
    const parsed = parseOrigin(origin);
    if (!parsed) return;
    rows.push({ update, userId: parsed.userId, agentName: parsed.agentName });
  });

  if (!neverBinds) {
    setTimeout(() => {
      // The persisted state arrives from a DIFFERENT client, as it does in
      // production — that is what makes the Y.Map LWW race real.
      const persisted = new Y.Doc();
      if (persistedTitle !== null) persisted.getMap('meta').set('title', persistedTitle);
      if (persistedBodies.length > 0) {
        persisted.get('default', Y.XmlFragment).insert(0, persistedBodies.map(paragraph));
      }
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), 'db-load');
      ydoc._bindComplete = true;
    }, delayMs);
  }

  documentService.init(() => ydoc, (n) => (n.startsWith('s/') ? n.slice(2) : n));
  return { ydoc, rows };
}

/** A doc that is already fully loaded. */
function makeWarmDoc({ bodies = [] } = {}) {
  const ydoc = new Y.Doc();
  if (bodies.length > 0) ydoc.get('default', Y.XmlFragment).insert(0, bodies.map(paragraph));
  ydoc._bindComplete = true;
  const rows = [];
  ydoc.on('update', (update, origin) => {
    const parsed = parseOrigin(origin);
    if (!parsed) return;
    rows.push({ update, userId: parsed.userId, agentName: parsed.agentName });
  });
  documentService.init(() => ydoc, (n) => (n.startsWith('s/') ? n.slice(2) : n));
  return { ydoc, rows };
}

const USER = '11111111-1111-4111-8111-111111111111';
const ATTRIB = { userId: USER, agentName: 'Test Agent' };

afterEach(() => {
  documentService.init(null, null, null);
});

// ── THE HALF-LOADED CLASS (FR-013) ──────────────────────────────────────────

describe('048 H — updateDocument never writes into a half-loaded document', () => {
  test('H1: a title set on a COLD doc always survives the late-arriving persisted title', async () => {
    // The pre-fix repro lost this ~half the time: the agent's set and the
    // persisted set were CONCURRENT Y.Map writes, resolved by clientID
    // comparison. 20 trials with a fresh persisted clientID each time would
    // have caught that with overwhelming probability.
    for (let i = 0; i < 20; i += 1) {
      const { ydoc } = makeColdDoc({ persistedTitle: `Persisted ${i}`, delayMs: 20 });

      await documentService.updateDocument(
        DOC_GUID,
        (doc) => doc.getMap('meta').set('title', 'Agent Title'),
        ATTRIB
      );

      // Let any straggling bind work land — it must not win.
      await tick(40);
      expect(ydoc.getMap('meta').get('title')).toBe('Agent Title');
      ydoc.destroy();
    }
  }, 20000);

  test('H2: an append lands AFTER the persisted content, never at index 0', async () => {
    const { ydoc } = makeColdDoc({ persistedBodies: ['persisted one', 'persisted two'], delayMs: 25 });

    await documentService.updateDocument(
      DOC_GUID,
      (doc) => {
        const frag = doc.get('default', Y.XmlFragment);
        // "Append at the end" — the index is computed from the doc the caller
        // is handed, which is precisely why it must be fully loaded.
        frag.insert(frag.length, [paragraph('appended by the agent')]);
      },
      ATTRIB
    );

    await tick(40);
    const texts = fragmentTexts(ydoc);
    expect(texts).toHaveLength(3);
    expect(texts[2]).toContain('appended by the agent');
    expect(texts[0]).toContain('persisted one');
  });

  test('H3: a bind refused WHILE the gate waits throws BindFailedError and writes nothing', async () => {
    const { ydoc, rows } = makeColdDoc({ persistedTitle: 'never gets here', delayMs: 10000 });
    const before = Y.encodeStateAsUpdate(ydoc);

    setTimeout(() => { ydoc._bindFailed = true; }, 20);

    await expect(documentService.updateDocument(
      DOC_GUID,
      (doc) => doc.getMap('meta').set('title', 'should not land'),
      ATTRIB
    )).rejects.toThrow(BindFailedError);

    expect(rows).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    expect(ydoc.getMap('meta').get('title')).toBeUndefined();
  });

  test('H4: a document that never binds times out and writes nothing', async () => {
    const { ydoc, rows } = makeColdDoc({ neverBinds: true });
    const before = Y.encodeStateAsUpdate(ydoc);

    await expect(documentService.updateDocument(
      DOC_GUID,
      (doc) => doc.getMap('meta').set('title', 'should not land'),
      ATTRIB
    )).rejects.toThrow(`Timed out waiting for document ${DOC_GUID} to load`);

    expect(rows).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
  }, 15000);

  test('H4b: the timeout message keeps the shape the route 500 mapping expects', async () => {
    const ydoc = new Y.Doc(); // never binds
    await expect(documentService.waitForDocReady(ydoc, 'some-guid', 30))
      .rejects.toThrow('Timed out waiting for document some-guid to load');
  });

  test('H5: a WARM doc takes the fast path — no timer, no observable wait', async () => {
    const ydoc = new Y.Doc();
    ydoc._bindComplete = true;

    // A macrotask scheduled before the gate must still be pending when the gate
    // resolves: the fast path involves no setTimeout at all.
    let macrotaskRan = false;
    setTimeout(() => { macrotaskRan = true; }, 0);

    await documentService.waitForDocReady(ydoc, DOC_GUID);
    expect(macrotaskRan).toBe(false);
  });

  test('H5b: a bind that ALREADY failed is refused immediately, not polled to timeout', async () => {
    const ydoc = new Y.Doc();
    ydoc._bindFailed = true;

    const started = Date.now();
    await expect(documentService.waitForDocReady(ydoc, DOC_GUID)).rejects.toThrow(BindFailedError);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

// ── THE AUTHORSHIP GUARDS (FR-002/FR-007) ───────────────────────────────────

describe('048 G — the shared doc never authors a content operation', () => {
  test('G1: a content insert emits an update whose insert set excludes the shared clientID', async () => {
    const { ydoc, rows } = makeWarmDoc();

    const { update } = await documentService.updateDocument(
      DOC_GUID,
      (doc) => doc.get('default', Y.XmlFragment).insert(0, [paragraph('agent content')]),
      ATTRIB
    );

    expect(insertClientIds(update)).not.toContain(ydoc.clientID);
    expect(insertClientIds(update)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(insertClientIds(rows[0].update)).not.toContain(ydoc.clientID);
  });

  test('G1: a meta title set emits an update whose insert set excludes the shared clientID', async () => {
    const { ydoc } = makeWarmDoc();

    const { update } = await documentService.updateDocument(
      DOC_GUID,
      (doc) => doc.getMap('meta').set('title', 'A Title'),
      ATTRIB
    );

    expect(insertClientIds(update)).not.toContain(ydoc.clientID);
    expect(ydoc.getMap('meta').get('title')).toBe('A Title');
  });

  test('G1: a seeded create (title + nodes in one transaction) excludes the shared clientID', async () => {
    // createSeededDocument's shape without its DB row: one transaction setting
    // the meta title and inserting the seed nodes.
    const { ydoc } = makeWarmDoc();

    const { update } = await documentService.updateDocument(
      DOC_GUID,
      (doc) => {
        doc.getMap('meta').set('title', 'Seeded');
        doc.get('default', Y.XmlFragment).insert(0, [paragraph('seed body')]);
      },
      ATTRIB
    );

    expect(insertClientIds(update)).not.toContain(ydoc.clientID);
  });

  test('G3: two consecutive calls author under two DISTINCT one-shot clientIDs', async () => {
    const { ydoc } = makeWarmDoc();

    const first = await documentService.updateDocument(
      DOC_GUID,
      (doc) => doc.get('default', Y.XmlFragment).insert(0, [paragraph('first')]),
      ATTRIB
    );
    const second = await documentService.updateDocument(
      DOC_GUID,
      (doc) => doc.get('default', Y.XmlFragment).insert(1, [paragraph('second')]),
      ATTRIB
    );

    const a = insertClientIds(first.update);
    const b = insertClientIds(second.update);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).not.toBe(b[0]);
    expect(a).not.toContain(ydoc.clientID);
    expect(b).not.toContain(ydoc.clientID);
  });

  test('G4: updateFn receives an EPHEMERAL doc, and its writes are invisible until the merge', async () => {
    const { ydoc } = makeWarmDoc();
    let handed = null;
    let sharedTextDuringTransaction = null;

    await documentService.updateDocument(
      DOC_GUID,
      (doc) => {
        handed = doc;
        doc.get('default', Y.XmlFragment).insert(0, [paragraph('written inside')]);
        // Read the SHARED doc from inside the transaction: it must not yet see
        // the change, because the transaction is not running on it.
        sharedTextDuringTransaction = fragmentTexts(ydoc);
      },
      ATTRIB
    );

    expect(handed).not.toBe(ydoc);
    expect(sharedTextDuringTransaction).toEqual([]);
    // After the merge the shared doc has it.
    expect(fragmentTexts(ydoc)[0]).toContain('written inside');
  });

  test('G4b: the ephemeral doc is destroyed and never announces awareness', async () => {
    const { ydoc } = makeWarmDoc();
    let handed = null;

    await documentService.updateDocument(
      DOC_GUID,
      (doc) => {
        handed = doc;
        doc.get('default', Y.XmlFragment).insert(0, [paragraph('x')]);
      },
      ATTRIB
    );

    // A destroyed Y.Doc emits 'destroy' and drops its observers. The ephemeral
    // doc is also never registered anywhere awareness could reach it: it has no
    // `conns`, no Redis handler, and is not in y-websocket's registry.
    expect(handed).not.toBe(ydoc);
    expect(handed.conns).toBeUndefined();
    expect(handed._redisUpdateHandler).toBeUndefined();
    expect(handed.awareness).toBeUndefined();
    expect(updateListenerCount(handed)).toBe(0);
  });

  test('G5: a throwing updateFn propagates, leaves the shared doc byte-identical, and writes no row', async () => {
    const { ydoc, rows } = makeWarmDoc({ bodies: ['existing'] });
    const beforeState = Y.encodeStateAsUpdate(ydoc);
    const beforeVector = Y.encodeStateVector(ydoc);
    const beforeListeners = updateListenerCount(ydoc);

    await expect(documentService.updateDocument(
      DOC_GUID,
      (doc) => {
        doc.get('default', Y.XmlFragment).insert(0, [paragraph('never lands')]);
        throw new Error('updateFn exploded');
      },
      ATTRIB
    )).rejects.toThrow('updateFn exploded');

    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(beforeState);
    expect(Y.encodeStateVector(ydoc)).toEqual(beforeVector);
    expect(rows).toHaveLength(0);
    // No armed listener survives the call.
    expect(updateListenerCount(ydoc)).toBe(beforeListeners);
  });

  test('G6: a no-change updateFn returns the zero value, writes no row, leaks no listener', async () => {
    const { ydoc, rows } = makeWarmDoc({ bodies: ['existing'] });
    const beforeListeners = updateListenerCount(ydoc);

    const result = await documentService.updateDocument(DOC_GUID, () => { /* nothing */ }, ATTRIB);

    expect(result).toEqual({ update: null, hadRedisHandler: false });
    expect(rows).toHaveLength(0);
    expect(updateListenerCount(ydoc)).toBe(beforeListeners);
  });
});
