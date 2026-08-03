/**
 * Feature 023 US4 T015 — the shared meaningful-vs-noise classifier (FR-015).
 *
 * classifyByXml is the SINGLE predicate the write path (bindState) and the
 * backfill share, so write-time and replay-time classification cannot drift.
 * "Meaningful" == the update changed extractXml output — the exact test the
 * pre-023 filterMeaningfulUpdates applied (XML string, not plain text, so
 * formatting-only edits count as meaningful).
 */
const Y = require('yjs');
const { classifyByXml, extractXml, classificationDisabled, MAX_CLASSIFY_DOC_BYTES } = require('../update-classifier');

function newDoc() {
  const doc = new Y.Doc();
  return { doc, frag: doc.getXmlFragment('default') };
}

function para(text, attrs = {}) {
  const p = new Y.XmlElement('paragraph');
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
}

describe('update-classifier (023 T015)', () => {
  test('extractXml re-export is the same yjs-utils function', () => {
    expect(extractXml).toBe(require('../yjs-utils').extractXml);
  });

  test('a text change is meaningful', () => {
    const { doc, frag } = newDoc();
    const prevXml = extractXml(doc);
    doc.transact(() => frag.insert(0, [para('Hello')]));
    const nextXml = extractXml(doc);
    expect(classifyByXml(prevXml, nextXml)).toBe(true);
    doc.destroy();
  });

  test('a CRDT-only / no-op update (identical XML) is noise', () => {
    const { doc, frag } = newDoc();
    doc.transact(() => frag.insert(0, [para('Stable')]));
    const beforeXml = extractXml(doc);
    // Apply a new client-id state merge that changes no visible content: encode
    // the current state and re-apply it (idempotent) — XML is unchanged.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
    const afterXml = extractXml(doc);
    expect(afterXml).toBe(beforeXml);
    expect(classifyByXml(beforeXml, afterXml)).toBe(false);
    doc.destroy();
    other.destroy();
  });

  test('a formatting-only change is meaningful (XML differs, text may not)', () => {
    const { doc, frag } = newDoc();
    doc.transact(() => frag.insert(0, [para('Heading text')]));
    const prevXml = extractXml(doc);
    // Change the block type attribute only — same characters, different XML.
    doc.transact(() => frag.get(0).setAttribute('level', '1'));
    const nextXml = extractXml(doc);
    expect(prevXml).not.toBe(nextXml);
    expect(classifyByXml(prevXml, nextXml)).toBe(true);
    doc.destroy();
  });

  test('parity with the pre-023 replay filter over a mixed sequence', () => {
    // Reproduce filterMeaningfulUpdates: replay each update, keep those that
    // change extractXml. classifyByXml must agree row-for-row.
    const { doc, frag } = newDoc();
    const updates = [];
    const record = (fn) => {
      const sv = Y.encodeStateVector(doc);
      doc.transact(fn);
      updates.push(Y.encodeStateAsUpdate(doc, sv));
    };
    record(() => frag.insert(0, [para('one')]));       // meaningful
    record(() => frag.insert(1, [para('two')]));       // meaningful
    record(() => frag.get(1).setAttribute('x', '1'));  // meaningful (formatting)

    const replay = new Y.Doc();
    let prev = extractXml(replay);
    const viaClassifier = [];
    for (const u of updates) {
      Y.applyUpdate(replay, u);
      const next = extractXml(replay);
      viaClassifier.push(classifyByXml(prev, next));
      prev = next;
    }
    expect(viaClassifier).toEqual([true, true, true]);
    doc.destroy();
    replay.destroy();
  });
});

// Post-merge review F5: unbounded extractXml on every update of every origin.
// Above a doc-size ceiling, classification (and its extractXml baseline) must be
// skipped so the WS hot path is not O(doc size) per keystroke; `meaningful`
// stays null (unknown ⇒ meaningful, fail-visible D-3).
describe('classificationDisabled size guard (023 F5)', () => {
  test('accumulates applied-update bytes, flips to disabled past the ceiling, then stays disabled', () => {
    const doc = new Y.Doc();
    // Small updates: below the ceiling, classification stays on.
    expect(classificationDisabled(doc, 1000)).toBe(false);
    expect(classificationDisabled(doc, 1000)).toBe(false);
    // One update that pushes the running total past the ceiling flips it.
    expect(classificationDisabled(doc, MAX_CLASSIFY_DOC_BYTES)).toBe(true);
    expect(doc._classifyDisabled).toBe(true);
    // Stays disabled for the doc's lifetime regardless of further bytes.
    expect(classificationDisabled(doc, 0)).toBe(true);
    doc.destroy();
  });

  // Feature 043 (X1/FR-006a): this used to be a `runListener` re-implementation
  // of the bindState listener. It now drives the REAL listener from
  // server/collab-bind-state.js. Only the *dependencies* are test doubles
  // (persistence, the notifier, the indexer, the guardrail); every decision —
  // the size guard, the origin parse, the classification, what reaches
  // storeUpdate — is production code. Break the guard in
  // server/update-classifier.js and this fails.
  test('an oversized doc: the real listener skips extractXml entirely and persists meaningful=null', async () => {
    const actualClassifier = jest.requireActual('../update-classifier');
    // extractXml is destructured at import time inside collab-bind-state, so a
    // jest.spyOn on the module object would never be seen. Mock the module and
    // load the listener fresh against it instead.
    const extractSpy = jest.fn(actualClassifier.extractXml);

    let createUpdateListener;
    jest.isolateModules(() => {
      jest.doMock('../update-classifier', () => ({ ...actualClassifier, extractXml: extractSpy }));
      ({ createUpdateListener } = require('../collab-bind-state'));
    });

    const stored = [];
    const deps = {
      persistenceProvider: {
        storeUpdate: (docGuid, update, userId, agentName, _a, _b, opts) => {
          stored.push({ docGuid, userId, agentName, ...opts });
          return Promise.resolve();
        },
        updateDocumentTitle: () => Promise.resolve(),
      },
      pendingWrites: new Set(),
      notifyException: jest.fn(),
      searchIndexer: { markDirty: jest.fn() },
      collabGuardrail: { evaluateUpdate: () => Promise.resolve() },
      logPerf: () => {},
    };

    const ydoc = new Y.Doc();
    const docGuid = '11111111-2222-3333-4444-555555555555';
    const userId = '99999999-8888-7777-6666-555555555555';
    const listener = createUpdateListener(deps, docGuid, ydoc);

    const frag = ydoc.getXmlFragment('default');
    let captured;
    ydoc.on('update', (u) => { captured = u; });
    // One update larger than the whole-doc ceiling.
    ydoc.transact(() => frag.insert(0, [para('x'.repeat(MAX_CLASSIFY_DOC_BYTES + 4096))]));

    expect(captured.byteLength).toBeGreaterThan(MAX_CLASSIFY_DOC_BYTES);
    listener(captured, { userId, agentName: null });
    await Promise.all([...deps.pendingWrites]);

    expect(stored).toHaveLength(1);
    expect(stored[0].meaningful).toBeNull(); // persisted unknown ⇒ meaningful
    expect(stored[0].userId).toBe(userId); // identity still comes from the origin
    expect(extractSpy).not.toHaveBeenCalled(); // no O(doc size) serialization on the hot path

    ydoc.destroy();
  });

  test('a sentinel origin is never persisted, but still refreshes the baseline', async () => {
    // The other half of the invariant the mirror could only assert about itself:
    // baseline refresh happens BEFORE the sentinel early-return (023 T023/U1).
    const { createUpdateListener } = require('../collab-bind-state');
    const stored = [];
    const deps = {
      persistenceProvider: {
        storeUpdate: (...args) => { stored.push(args); return Promise.resolve(); },
        updateDocumentTitle: () => Promise.resolve(),
      },
      pendingWrites: new Set(),
      notifyException: jest.fn(),
      searchIndexer: { markDirty: jest.fn() },
      collabGuardrail: { evaluateUpdate: () => Promise.resolve() },
      logPerf: () => {},
    };

    const ydoc = new Y.Doc();
    const listener = createUpdateListener(deps, 'guid', ydoc);
    const frag = ydoc.getXmlFragment('default');
    let captured;
    ydoc.on('update', (u) => { captured = u; });
    ydoc.transact(() => frag.insert(0, [para('hello')]));

    listener(captured, 'db-load'); // a sentinel
    await Promise.all([...deps.pendingWrites]);

    expect(stored).toHaveLength(0);
    expect(typeof ydoc._lastClassifiedXml).toBe('string');
    expect(ydoc._lastClassifiedXml).toContain('hello');
    ydoc.destroy();
  });
});
