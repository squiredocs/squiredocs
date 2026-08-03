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
const { restoreVersion } = require('../version-history');
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

  /**
   * A y-websocket-shaped registry: the lookup CREATES (setIfUndefined) and
   * starts an un-awaited bind, so an evicted document is rebuilt by the next
   * lookup exactly as production does.
   */
  function makeEvictingRegistry({ delayMs = 30 } = {}) {
    const docs = new Map();
    const rows = [];
    const getYDoc = (name) => {
      let d = docs.get(name);
      if (!d) {
        d = new Y.Doc();
        d.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          rows.push({ doc: d, userId: parsed.userId });
        });
        docs.set(name, d);
        setTimeout(() => { d._bindComplete = true; }, delayMs);
      }
      return d;
    };
    documentService.init(getYDoc, (n) => (n.startsWith('s/') ? n.slice(2) : n), docs);
    return { docs, rows };
  }

  test('H6 (review H1): a document torn down mid-gate does not swallow the write', async () => {
    // The gate's cold path awaits across I/O turns, and the last connection
    // closing in one of them takes the doc with it: y-websocket's closeConn
    // deletes it from the registry, then destroys it a microtask later. A
    // destroyed doc still reports _bindComplete and no _bindFailed, so the gate
    // passes and a merge into it reaches nothing — no observers, no broadcast,
    // no row — while the call resolves as success.
    const { docs, rows } = makeEvictingRegistry({ delayMs: 30 });
    const first = documentService.getSharedDoc(DOC_GUID);

    setTimeout(() => {
      docs.delete(`s/${DOC_GUID}`);
      Promise.resolve().then(() => first.destroy());
    }, 10);

    await documentService.updateDocument(DOC_GUID, (d) => {
      d.get('default', Y.XmlFragment).insert(0, [paragraph('AGENT WROTE THIS')]);
    }, ATTRIB);

    // The content must live on the document the registry now serves, with a
    // durable row behind it — not only on the orphan the gate was waiting on.
    const live = docs.get(`s/${DOC_GUID}`);
    expect(live).toBeDefined();
    expect(live).not.toBe(first);
    expect(fragmentTexts(live).join(' ')).toContain('AGENT WROTE THIS');
    expect(rows.some((r) => r.doc === live && r.userId === USER)).toBe(true);
  });

  test('H6b: a document that keeps being torn down fails closed instead of spinning', async () => {
    const { docs } = makeEvictingRegistry({ delayMs: 5 });
    // Every doc this registry hands out is evicted and destroyed the moment it
    // finishes binding, so no attempt can ever find a live one.
    const evictOnBind = setInterval(() => {
      for (const [name, d] of [...docs]) {
        if (d._bindComplete) { docs.delete(name); d.destroy(); }
      }
    }, 2);

    try {
      await expect(
        documentService.updateDocument(DOC_GUID, (d) => {
          d.get('default', Y.XmlFragment).insert(0, [paragraph('never lands')]);
        }, ATTRIB)
      ).rejects.toThrow(BindFailedError);
    } finally {
      clearInterval(evictOnBind);
    }
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

  // ── The two converged paths that had no behavioral test of their own ──────
  // (analyze gate C1). Both are thin updateFn bodies at their call sites, so
  // what needs pinning is that they still place content correctly when the doc
  // they are handed is an ephemeral copy rather than the shared doc.

  test('C1: the empty-import anchor seeds a paragraph only into a genuinely empty doc', async () => {
    // server/api/docs-import.js, chat-tools.js and mcp/tools/create-document.js
    // all run this exact shape after an EMPTY_IMPORT.
    const anchor = (doc) => {
      const frag = doc.get('default', Y.XmlFragment);
      if (frag.length === 0) frag.insert(0, [paragraph('')]);
    };

    const empty = makeWarmDoc();
    const { update } = await documentService.updateDocument(DOC_GUID, anchor, ATTRIB);
    expect(fragmentTexts(empty.ydoc)).toHaveLength(1);
    expect(insertClientIds(update)).not.toContain(empty.ydoc.clientID);
    documentService.init(null, null, null);

    // On a doc that already has content the guard must hold: no second anchor,
    // and the zero return value (no row).
    const nonEmpty = makeWarmDoc({ bodies: ['already here'] });
    const result = await documentService.updateDocument(DOC_GUID, anchor, ATTRIB);
    expect(result).toEqual({ update: null, hadRedisHandler: false });
    expect(fragmentTexts(nonEmpty.ydoc)).toHaveLength(1);
    expect(nonEmpty.rows).toHaveLength(0);
  });

  test('C1: the chat image insert honours start/end position against the loaded body', async () => {
    // server/api/chat-tools.js insert_image: position 'start' → index 0, else
    // the fragment's current length. The index is read from the doc updateFn is
    // handed, which is why it must be a faithful copy of the loaded state.
    const imageNode = (src) => {
      const el = new Y.XmlElement('image');
      el.setAttribute('src', src);
      return el;
    };
    const insertImage = (atStart, src) => (doc) => {
      const frag = doc.get('default', Y.XmlFragment);
      frag.insert(atStart ? 0 : frag.length, [imageNode(src)]);
    };

    const { ydoc } = makeWarmDoc({ bodies: ['first para', 'second para'] });

    const endResult = await documentService.updateDocument(DOC_GUID, insertImage(false, 'end.png'), ATTRIB);
    let texts = fragmentTexts(ydoc);
    expect(texts).toHaveLength(3);
    expect(texts[2]).toContain('end.png');

    const startResult = await documentService.updateDocument(DOC_GUID, insertImage(true, 'start.png'), ATTRIB);
    texts = fragmentTexts(ydoc);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain('start.png');

    // Each insert authored under its own one-shot identity.
    const a = insertClientIds(endResult.update);
    const b = insertClientIds(startResult.update);
    expect(a[0]).not.toBe(b[0]);
    expect(a).not.toContain(ydoc.clientID);
    expect(b).not.toContain(ydoc.clientID);
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

// ── RESTORE AUTHORS ON AN EPHEMERAL DOC TOO (FR-004/FR-007a, G2) ────────────

describe('048 G2 — restoreVersion never authors under the shared doc clientID', () => {
  /** Two stored versions plus the in-memory persistence the restore reads. */
  function makeRestoreFixture() {
    const stored = [];
    let clock = 0;

    const setText = (doc, text) => {
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        while (fragment.length > 0) fragment.delete(0, fragment.length);
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, text);
        p.insert(0, [t]);
        fragment.insert(0, [p]);
      });
    };

    const persistence = {
      storeUpdate: jest.fn(async (docGuid, update, userId, agentName) => {
        clock += 1;
        stored.push({ clock, update: new Uint8Array(update), userId, agentName });
        return clock;
      }),
      getYDoc: jest.fn(async () => {
        const doc = new Y.Doc();
        for (const { update } of stored) Y.applyUpdate(doc, update);
        return doc;
      }),
      getUpdatesWithUsers: jest.fn(async () => stored.map((u) => ({
        clock: u.clock, createdAt: new Date().toISOString(), userId: u.userId, userName: 'Test User',
      }))),
      getVersionById: jest.fn(async () => null),
      getYDocAtClock: jest.fn(async (docGuid, targetClock) => {
        const doc = new Y.Doc();
        for (const { update, clock: c } of stored) if (c <= targetClock) Y.applyUpdate(doc, update);
        return doc;
      }),
    };

    return { persistence, stored, setText };
  }

  async function seedTwoVersions(fx) {
    const doc1 = new Y.Doc();
    fx.setText(doc1, 'Original content');
    await fx.persistence.storeUpdate('restore-doc', Y.encodeStateAsUpdate(doc1), 'user-1', null);

    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, fx.stored[0].update);
    fx.setText(doc2, 'Modified content');
    await fx.persistence.storeUpdate(
      'restore-doc', Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)), 'user-1', null
    );
  }

  /** A doc the trust predicate accepts: bind complete AND ≥1 live connection. */
  function makeTrustedLiveDoc(stored) {
    const liveDoc = new Y.Doc();
    for (const { update } of stored) Y.applyUpdate(liveDoc, update);
    liveDoc._bindComplete = true;
    liveDoc.conns = new Map([['fake-conn', new Set()]]);
    return liveDoc;
  }

  test('G2: the DURABLE-log seed emits a fresh one-shot clientID', async () => {
    const fx = makeRestoreFixture();
    await seedTwoVersions(fx);
    const before = fx.stored.length;

    await restoreVersion(fx.persistence, 'restore-doc', '1', 'user-1', { getSharedDoc: () => null });

    expect(fx.stored).toHaveLength(before + 1);
    const ids = insertClientIds(fx.stored[fx.stored.length - 1].update);
    expect(ids.length).toBeGreaterThan(0);
    // Never a clientID that already authored content in this document.
    const priorIds = new Set(fx.stored.slice(0, before).flatMap((r) => insertClientIds(r.update)));
    for (const id of ids) expect(priorIds.has(id)).toBe(false);
  });

  test("G2: the TRUSTED-LIVE seed emits a fresh clientID, never the live doc's", async () => {
    const fx = makeRestoreFixture();
    await seedTwoVersions(fx);
    const before = fx.stored.length;
    const liveDoc = makeTrustedLiveDoc(fx.stored);

    await restoreVersion(fx.persistence, 'restore-doc', '1', 'user-1', {
      getSharedDoc: (g) => (g === 'restore-doc' ? liveDoc : null),
    });

    expect(fx.stored).toHaveLength(before + 1);
    const ids = insertClientIds(fx.stored[fx.stored.length - 1].update);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(liveDoc.clientID);

    // The live doc still received the restore. It did NOT run the transaction,
    // so applyLiveUpdate is what put it there.
    expect(liveDoc.getXmlFragment('default').toString()).toContain('Original content');
  });

  test('G2: the stored bytes ARE the broadcast bytes (041 invariant)', async () => {
    const fx = makeRestoreFixture();
    await seedTwoVersions(fx);
    const liveDoc = makeTrustedLiveDoc(fx.stored);

    const published = [];
    const redisPubSub = { isEnabled: () => true, publishUpdate: (g, u) => published.push(u) };

    await restoreVersion(fx.persistence, 'restore-doc', '1', 'user-1', {
      getSharedDoc: (g) => (g === 'restore-doc' ? liveDoc : null),
      redisPubSub,
    });

    expect(published).toHaveLength(1);
    expect(new Uint8Array(published[0])).toEqual(fx.stored[fx.stored.length - 1].update);
  });

  test('G2: store happens BEFORE the broadcast (RBD-048-2 ordering)', async () => {
    const fx = makeRestoreFixture();
    await seedTwoVersions(fx);

    const order = [];
    const originalStore = fx.persistence.storeUpdate;
    fx.persistence.storeUpdate = jest.fn(async (...args) => {
      order.push('store');
      return originalStore(...args);
    });
    const redisPubSub = { isEnabled: () => true, publishUpdate: () => order.push('broadcast') };

    await restoreVersion(fx.persistence, 'restore-doc', '1', 'user-1', {
      getSharedDoc: () => null,
      redisPubSub,
    });

    expect(order).toEqual(['store', 'broadcast']);
  });
});
