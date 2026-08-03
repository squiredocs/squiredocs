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
        () => (doc) => doc.getMap('meta').set('title', 'Agent Title'),
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
      () => (doc) => {
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
      () => (doc) => doc.getMap('meta').set('title', 'should not land'),
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
      () => (doc) => doc.getMap('meta').set('title', 'should not land'),
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

    await documentService.updateDocument(DOC_GUID, () => (d) => {
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
        documentService.updateDocument(DOC_GUID, () => (d) => {
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
      () => (doc) => doc.get('default', Y.XmlFragment).insert(0, [paragraph('agent content')]),
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
      () => (doc) => doc.getMap('meta').set('title', 'A Title'),
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
      () => (doc) => {
        doc.getMap('meta').set('title', 'Seeded');
        doc.get('default', Y.XmlFragment).insert(0, [paragraph('seed body')]);
      },
      ATTRIB
    );

    expect(insertClientIds(update)).not.toContain(ydoc.clientID);
  });

  // RE-POINTED BY 049 (FR-011). WAS: "two consecutive calls author under two
  // DISTINCT one-shot clientIDs" — under 048 every operation minted a fresh id.
  //
  // WHY THAT CHANGED: FR-006 caches the borrowed id per (identity, document), so
  // two calls by the SAME identity now legitimately reuse ONE id. That is
  // deliberate — minting per operation grew the document's state vector without
  // bound (measured: 5,000 writes left a 30 KB vector, pushed to every browser
  // on every handshake).
  //
  // NOT A WEAKENING. The 048 guarantee was never "one id per operation"; it was
  // "no id is ever shared by two identities", which is what the resolver
  // depends on. That clause is now asserted DIRECTLY — every observed id is
  // mapped to the identity that used it and the mapping is checked to be
  // one-to-one — rather than inferred as a by-product of distinctness.
  test('G3: different identities use different ids, one identity reuses one id, and no id is ever shared', async () => {
    const { ydoc } = makeWarmDoc();
    const USER_B = '22222222-2222-4222-8222-222222222222';

    const identities = [
      { userId: USER, agentName: 'Test Agent' },
      { userId: USER, agentName: 'Test Agent' },   // same identity, twice
      { userId: USER, agentName: null },           // same user, NO agent — different principal
      { userId: USER_B, agentName: 'Test Agent' }, // different user
      { userId: USER_B, agentName: 'Test Agent' }, // same identity, twice
    ];

    const idToIdentity = new Map();
    const idsByIdentity = new Map();

    for (let i = 0; i < identities.length; i += 1) {
      const attrib = identities[i];
      const key = JSON.stringify([attrib.userId, attrib.agentName]);
      const { update } = await documentService.updateDocument(
        DOC_GUID,
        () => (doc) => doc.get('default', Y.XmlFragment).insert(i, [paragraph(`w${i}`)]),
        attrib
      );
      const ids = insertClientIds(update);
      expect(ids).toHaveLength(1);
      expect(ids).not.toContain(ydoc.clientID);

      const id = ids[0];
      // THE CLAUSE THAT MUST NOT WEAKEN: one id, one identity, always.
      if (idToIdentity.has(id)) expect(idToIdentity.get(id)).toBe(key);
      idToIdentity.set(id, key);
      if (!idsByIdentity.has(key)) idsByIdentity.set(key, new Set());
      idsByIdentity.get(key).add(id);
    }

    // The id -> identity map is one-to-one: no id was ever shared.
    expect(idToIdentity.size).toBe(new Set(idToIdentity.keys()).size);
    expect(new Set(idToIdentity.values()).size).toBe(idsByIdentity.size);

    // Each identity used exactly ONE id across all its writes (the cache).
    for (const [, ids] of idsByIdentity) expect(ids.size).toBe(1);

    // Three distinct principals wrote, so three distinct ids exist.
    expect(idsByIdentity.size).toBe(3);
    expect(new Set(idToIdentity.keys()).size).toBe(3);
  });

  test('N4: N writes by ONE identity add exactly ONE client entry; N identities add N (SC-005)', async () => {
    // The whole point of the cache: state-vector growth tracks PRINCIPALS, not
    // operations. Under 048 the left-hand number below would have been 12.
    {
      const { ydoc } = makeWarmDoc();
      const before = Y.decodeStateVector(Y.encodeStateVector(ydoc)).size;

      for (let i = 0; i < 12; i += 1) {
        await documentService.updateDocument(
          DOC_GUID,
          () => (doc) => doc.get('default', Y.XmlFragment).insert(i, [paragraph(`n${i}`)]),
          ATTRIB
        );
      }

      const after = Y.decodeStateVector(Y.encodeStateVector(ydoc)).size;
      expect(after - before).toBe(1);
      documentService.init(null, null, null);
    }

    // N distinct identities introduce N entries — the growth that is real.
    {
      const { ydoc } = makeWarmDoc();
      const before = Y.decodeStateVector(Y.encodeStateVector(ydoc)).size;

      for (let i = 0; i < 5; i += 1) {
        await documentService.updateDocument(
          DOC_GUID,
          () => (doc) => doc.get('default', Y.XmlFragment).insert(i, [paragraph(`m${i}`)]),
          { userId: USER, agentName: `Agent ${i}` }
        );
      }

      const after = Y.decodeStateVector(Y.encodeStateVector(ydoc)).size;
      expect(after - before).toBe(5);
    }
  });

  // RE-POINTED BY 049 (FR-011). WAS: "updateFn receives an EPHEMERAL doc, and
  // its writes are invisible until the merge" — it asserted `handed !== ydoc`
  // and that the shared doc could not see the change mid-transaction.
  //
  // WHY THAT CHANGED: 049 deleted the ephemeral copy. The mutate phase now runs
  // ON the shared document under a borrowed client id, so both of those old
  // assertions are false BY DESIGN — they described the plumbing, not the
  // guarantee. The guarantee was always about which client id signs the content
  // ops, and that is the third clause below, which is what keeps this guard
  // about ATTRIBUTION rather than about where the bytes were computed.
  test('G4: the mutate phase receives the SHARED doc, its writes are immediately visible, and only the borrowed id signs them', async () => {
    const { ydoc } = makeWarmDoc();
    let handed = null;
    let sharedTextDuringTransaction = null;
    const ownClientId = ydoc.clientID;

    const { update } = await documentService.updateDocument(
      DOC_GUID,
      () => (doc) => {
        handed = doc;
        doc.get('default', Y.XmlFragment).insert(0, [paragraph('written inside')]);
        // Read the SHARED doc from inside the transaction: it DOES see the
        // change now, because the transaction is running on it.
        sharedTextDuringTransaction = fragmentTexts(ydoc);
      },
      ATTRIB
    );

    // 1. The mutate phase is handed the shared document itself.
    expect(handed).toBe(ydoc);
    // 2. Its writes are visible on that document immediately, from inside the
    //    transaction — there is no merge step to wait for.
    expect(sharedTextDuringTransaction).toHaveLength(1);
    expect(sharedTextDuringTransaction[0]).toContain('written inside');
    expect(fragmentTexts(ydoc)[0]).toContain('written inside');
    // 3. THE PART THAT MUST NOT WEAKEN: the emitted update still carries exactly
    //    one client id, and it is never the document's own.
    expect(insertClientIds(update)).toHaveLength(1);
    expect(insertClientIds(update)).not.toContain(ownClientId);
    // And the document is wearing its own identity again afterwards.
    expect(ydoc.clientID).toBe(ownClientId);
  });

  // RE-POINTED BY 049 (FR-011). WAS: "the ephemeral doc is destroyed and never
  // announces awareness" — it asserted the handed doc was a separate object with
  // no `conns`, no Redis handler and no awareness.
  //
  // WHY THAT CHANGED: there is no ephemeral doc to destroy. The presence
  // question survives in a stronger form, because the borrowed id is installed
  // on the REAL document that awareness is attached to: does anything announce
  // it? This constructs a y-protocols Awareness on the shared document BEFORE
  // the call, which also directly exercises the construction-time
  // classification the FR-008 audit records for Awareness (awareness.js:49).
  test('G4b: the borrowed identity is never announced in awareness, and the doc\'s own clientID is restored', async () => {
    const { Awareness } = require('y-protocols/awareness');
    const { ydoc } = makeWarmDoc();
    const ownClientId = ydoc.clientID;

    // Constructed BEFORE the borrow, exactly as a real connection would be.
    const awareness = new Awareness(ydoc);
    awareness.setLocalState({ user: { name: 'a real participant' } });

    let borrowedDuringCall = null;
    const { update } = await documentService.updateDocument(
      DOC_GUID,
      () => (doc) => {
        borrowedDuringCall = doc.clientID; // the borrowed id, mid-transaction
        doc.get('default', Y.XmlFragment).insert(0, [paragraph('x')]);
      },
      ATTRIB
    );

    const borrowed = insertClientIds(update)[0];
    expect(borrowedDuringCall).toBe(borrowed);
    expect(borrowed).not.toBe(ownClientId);

    // Awareness captured the document's OWN id at construction and is untouched
    // by the borrow.
    expect(awareness.clientID).toBe(ownClientId);
    // No awareness state entry is keyed by the borrowed id — it signs content
    // ops only, so the 044 ownership guard never sees it.
    expect([...awareness.getStates().keys()]).not.toContain(borrowed);
    // The document is wearing its own identity again.
    expect(ydoc.clientID).toBe(ownClientId);

    awareness.destroy();
  });

  // RE-POINTED BY 049 (FR-011). WAS: "a throwing updateFn propagates, leaves the
  // shared doc byte-identical, and writes no row" — under 048 the throwing
  // function ran on the ephemeral copy, which was simply discarded.
  //
  // WHY THAT CHANGED: there is no copy to discard. Yjs does NOT roll a
  // transaction back when the function passed to it throws, so a throw from the
  // MUTATE phase leaves the mutation in place and broadcasts it. That is the
  // design's recorded residual, not something a guard can assert away.
  // Throwing now lives in the COMPUTE phase, which is exactly where this
  // property is still true — and is the reason the two-phase shape exists at
  // all. NOT A WEAKENING: the same document-unchanged property is asserted, in
  // the place the shape now puts failure, plus three additions (no update event
  // fired, the document's own clientID restored, and the ORIGINAL error object
  // propagated — error identity drives HTTP status).
  test('G5: a throwing COMPUTE phase propagates, leaves the shared doc byte-identical, and writes no row', async () => {
    const { ydoc, rows } = makeWarmDoc({ bodies: ['existing'] });
    const beforeState = Y.encodeStateAsUpdate(ydoc);
    const beforeVector = Y.encodeStateVector(ydoc);
    const beforeListeners = updateListenerCount(ydoc);
    const ownClientId = ydoc.clientID;
    let updateEvents = 0;
    const countEvents = () => { updateEvents += 1; };
    ydoc.on('update', countEvents);

    const boom = new Error('compute phase exploded');
    await expect(documentService.updateDocument(
      DOC_GUID,
      () => {
        // Everything that can fail happens HERE, before anything is touched.
        throw boom;
      },
      ATTRIB
    )).rejects.toBe(boom); // the ORIGINAL error object, never a wrapper

    ydoc.off('update', countEvents);

    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(beforeState);
    expect(Y.encodeStateVector(ydoc)).toEqual(beforeVector);
    expect(rows).toHaveLength(0);
    expect(updateEvents).toBe(0);
    // No armed listener survives the call.
    expect(updateListenerCount(ydoc)).toBe(beforeListeners);
    // The borrow was never installed, so the document's identity is untouched.
    expect(ydoc.clientID).toBe(ownClientId);
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
    const { update } = await documentService.updateDocument(DOC_GUID, () => anchor, ATTRIB);
    expect(fragmentTexts(empty.ydoc)).toHaveLength(1);
    expect(insertClientIds(update)).not.toContain(empty.ydoc.clientID);
    documentService.init(null, null, null);

    // On a doc that already has content the guard must hold: no second anchor,
    // and the zero return value (no row).
    const nonEmpty = makeWarmDoc({ bodies: ['already here'] });
    const result = await documentService.updateDocument(DOC_GUID, () => anchor, ATTRIB);
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

    const endResult = await documentService.updateDocument(DOC_GUID, () => insertImage(false, 'end.png'), ATTRIB);
    let texts = fragmentTexts(ydoc);
    expect(texts).toHaveLength(3);
    expect(texts[2]).toContain('end.png');

    const startResult = await documentService.updateDocument(DOC_GUID, () => insertImage(true, 'start.png'), ATTRIB);
    texts = fragmentTexts(ydoc);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain('start.png');

    // RE-POINTED BY 049, for the same reason as G3. WAS: "each insert authored
    // under its own one-shot identity" (`a[0] !== b[0]`). Both inserts here are
    // made by the SAME identity (ATTRIB), so under the per-(identity, document)
    // cache they legitimately share one borrowed id — that is the point of the
    // cache, and asserting distinctness would pin the thing 049 removes.
    // The part that must not weaken is unchanged and asserted below: the id is
    // never the document's own, and it is exactly one per update.
    const a = insertClientIds(endResult.update);
    const b = insertClientIds(startResult.update);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toBe(b[0]); // same identity, same borrowed id
    expect(a).not.toContain(ydoc.clientID);
    expect(b).not.toContain(ydoc.clientID);
  });

  test('G6: a no-change MUTATE phase returns the zero value, writes no row, leaks no listener', async () => {
    const { ydoc, rows } = makeWarmDoc({ bodies: ['existing'] });
    const beforeListeners = updateListenerCount(ydoc);

    const result = await documentService.updateDocument(DOC_GUID, () => () => { /* nothing */ }, ATTRIB);

    expect(result).toEqual({ update: null, hadRedisHandler: false });
    expect(rows).toHaveLength(0);
    expect(updateListenerCount(ydoc)).toBe(beforeListeners);
  });

  // EXTENDED BY 049 (T018b/FR-011). G6 above covers the path that existed under
  // 048: a mutate phase that runs and decides not to change anything. 049 adds a
  // SECOND way to reach the same zero value — a compute phase that returns
  // nullish, meaning "nothing to do". It short-circuits earlier than the first
  // path (no borrow, no transaction, no listener ever attached), so it needs its
  // own pin rather than riding on G6's.
  test('G6: a NULLISH compute return produces the same zero value, opens no transaction, installs no borrow', async () => {
    const { ydoc, rows } = makeWarmDoc({ bodies: ['existing'] });
    const beforeListeners = updateListenerCount(ydoc);
    const beforeState = Y.encodeStateAsUpdate(ydoc);
    const ownClientId = ydoc.clientID;
    let updateEvents = 0;
    const countEvents = () => { updateEvents += 1; };
    ydoc.on('update', countEvents);

    for (const nullish of [undefined, null]) {
      const result = await documentService.updateDocument(DOC_GUID, () => nullish, ATTRIB);
      expect(result).toEqual({ update: null, hadRedisHandler: false });
    }

    ydoc.off('update', countEvents);

    expect(rows).toHaveLength(0);
    expect(updateEvents).toBe(0);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(beforeState);
    expect(updateListenerCount(ydoc)).toBe(beforeListeners);
    expect(ydoc.clientID).toBe(ownClientId);
  });

  // ── NEW PINS ADDED BY 049 ────────────────────────────────────────────────

  test('N1: the document\'s own clientID is restored after EVERY call', async () => {
    // Success.
    {
      const { ydoc } = makeWarmDoc();
      const own = ydoc.clientID;
      await documentService.updateDocument(
        DOC_GUID, () => (d) => d.getMap('meta').set('title', 'ok'), ATTRIB
      );
      expect(ydoc.clientID).toBe(own);
      documentService.init(null, null, null);
    }

    // No-change (mutate phase runs, changes nothing).
    {
      const { ydoc } = makeWarmDoc();
      const own = ydoc.clientID;
      await documentService.updateDocument(DOC_GUID, () => () => {}, ATTRIB);
      expect(ydoc.clientID).toBe(own);
      documentService.init(null, null, null);
    }

    // No-change (nullish compute return).
    {
      const { ydoc } = makeWarmDoc();
      const own = ydoc.clientID;
      await documentService.updateDocument(DOC_GUID, () => null, ATTRIB);
      expect(ydoc.clientID).toBe(own);
      documentService.init(null, null, null);
    }

    // A throwing COMPUTE phase.
    {
      const { ydoc } = makeWarmDoc();
      const own = ydoc.clientID;
      await expect(documentService.updateDocument(
        DOC_GUID, () => { throw new Error('compute boom'); }, ATTRIB
      )).rejects.toThrow('compute boom');
      expect(ydoc.clientID).toBe(own);
      documentService.init(null, null, null);
    }

    // A throwing MUTATE phase — the borrow IS installed here, so this is the
    // case that actually exercises the `finally`. The partial edit is the
    // design's recorded residual; the identity restoration is not negotiable.
    {
      const { ydoc } = makeWarmDoc();
      const own = ydoc.clientID;
      await expect(documentService.updateDocument(
        DOC_GUID,
        () => (d) => {
          d.get('default', Y.XmlFragment).insert(0, [paragraph('partial')]);
          throw new Error('mutate boom');
        },
        ATTRIB
      )).rejects.toThrow('mutate boom');
      expect(ydoc.clientID).toBe(own);
      documentService.init(null, null, null);
    }

    // A refused bind (BindFailedError raised after the write).
    {
      const { ydoc } = makeWarmDoc();
      const own = ydoc.clientID;
      ydoc._bindFailed = true;
      await expect(documentService.updateDocument(
        DOC_GUID, () => (d) => d.getMap('meta').set('title', 'x'), ATTRIB
      )).rejects.toThrow(BindFailedError);
      expect(ydoc.clientID).toBe(own);
    }
  });

  test('N6: a compute phase that INSERTS is detected and fails loudly', async () => {
    const { ydoc, rows } = makeWarmDoc({ bodies: ['existing'] });
    const own = ydoc.clientID;

    // This is what a stale pre-049 caller looks like: a bare mutate function.
    // It mutates during the compute phase, where the mutation would escape the
    // transaction and land with NO origin object — an unattributed row.
    await expect(documentService.updateDocument(
      DOC_GUID,
      (doc) => { doc.get('default', Y.XmlFragment).insert(0, [paragraph('escaped')]); },
      ATTRIB
    )).rejects.toThrow(documentService.ComputePhaseMutationError);

    // The failure NAMES the document and the acting identity.
    await expect(documentService.updateDocument(
      DOC_GUID,
      (doc) => { doc.get('default', Y.XmlFragment).insert(0, [paragraph('escaped again')]); },
      ATTRIB
    )).rejects.toThrow(new RegExp(`${DOC_GUID}[\\s\\S]*${USER}`));

    expect(ydoc.clientID).toBe(own);

    // AND HERE IS WHY THE DETECTOR EXISTS, stated exactly. The detector reports
    // the escape; it cannot prevent it, because by the time the compute phase
    // returns, the mutation has already fired the document update event and
    // reached persistence. What escaped is the defect this feature was built to
    // end: rows carrying NO acting identity, because the mutation ran outside
    // the transaction and therefore outside the origin object.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.userId).toBeNull();
      expect(row.agentName).toBeNull();
    }
  });

  test('N7: a compute phase that ONLY DELETES is detected too (the state vector alone cannot see it)', async () => {
    const { ydoc } = makeWarmDoc({ bodies: ['doomed', 'kept'] });
    const own = ydoc.clientID;

    // MEASURED against yjs@13.6.30: a delete creates no struct in
    // `store.clients`, so the state vector is BYTE-IDENTICAL before and after.
    // The ratified state-vector detector cannot see this on its own — the
    // update-event tripwire is what catches it (PD-049-3). This guard exists
    // precisely to keep the tripwire from being "simplified away" later.
    const vectorBefore = Y.encodeStateVector(ydoc);
    const probe = new Y.Doc();
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(ydoc));
    probe.get('default', Y.XmlFragment).delete(0, 1);
    expect(Y.encodeStateVector(probe)).toEqual(vectorBefore); // the hole, demonstrated

    await expect(documentService.updateDocument(
      DOC_GUID,
      (doc) => { doc.get('default', Y.XmlFragment).delete(0, 1); },
      ATTRIB
    )).rejects.toThrow(documentService.ComputePhaseMutationError);

    expect(ydoc.clientID).toBe(own);
  });

  test('N9: the borrowed-identity mechanism fails BY NAME if struct signing or restoration regresses', async () => {
    // THE FR-012 LOUD GUARD. Its job is to be the test that goes red — with a
    // message naming this mechanism — when a yjs upgrade silently changes how
    // structs are signed, or when the borrow stops being restored. If this ever
    // fails, the cause is the borrowed-identity write path, NOT the assertion's
    // subject matter.
    const { ydoc } = makeWarmDoc();
    const ownClientId = ydoc.clientID;
    let observedInsideTransaction = null;

    const { update } = await documentService.updateDocument(
      DOC_GUID,
      () => (doc) => {
        observedInsideTransaction = doc.clientID;
        doc.get('default', Y.XmlFragment).insert(0, [paragraph('signed content')]);
      },
      ATTRIB
    );

    const signedBy = insertClientIds(update);

    // Jest's `expect` takes only one argument, so the naming is done by
    // rethrowing with the mechanism prepended. That is what makes this guard
    // fail BY NAME instead of as an anonymous id mismatch three layers away.
    const assertMechanism = (check, fn) => {
      try {
        fn();
      } catch (err) {
        err.message =
          '\n*** BORROWED-IDENTITY MECHANISM REGRESSION (feature 049, FR-012) ***\n' +
          `FAILED CHECK: ${check}\n\n` +
          'server/borrowed-identity.js installs a borrowed clientID on the shared\n' +
          'document for the duration of one synchronous transaction, relying on yjs\n' +
          'reading doc.clientID at STRUCT-CREATION TIME from the transaction\'s\n' +
          'document. That is not a documented guarantee. This failing means the\n' +
          'mechanism no longer behaves as verified — most likely a yjs, y-protocols\n' +
          'or y-websocket upgrade.\n\n' +
          'DO: re-run the FR-008 verification and re-date\n' +
          '    specs/049-constant-time-write-path/clientid-reader-audit.md\n' +
          '    (node specs/049-constant-time-write-path/fr008-probe.cjs)\n' +
          'DO NOT: "fix" this by relaxing the assertion. Every server-side write\'s\n' +
          '    attribution depends on it.\n\n' +
          `Original assertion failure:\n${err.message}`;
        throw err;
      }
    };

    // 1. The installed id is what the transaction saw.
    assertMechanism('the mutate phase did not observe the borrowed id', () => {
      expect(observedInsideTransaction).not.toBe(ownClientId);
    });
    // 2. yjs signed the created structs with the INSTALLED id, not the doc's own.
    assertMechanism('structs were not signed with the installed borrowed id', () => {
      expect(signedBy).toEqual([observedInsideTransaction]);
    });
    // 3. The document's own identity is restorable and was restored.
    assertMechanism("the document's own clientID was not restored", () => {
      expect(ydoc.clientID).toBe(ownClientId);
    });
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
