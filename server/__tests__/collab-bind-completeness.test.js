/**
 * Feature 057 US3 — incomplete loads are refused, never memoized as trusted
 * (FR-003/FR-004, contracts/bind-completeness.md).
 *
 * THE DEFECT: `bindState` called `getYDoc` with no completeness option at all,
 * so a load that came back torn — an interior clock gap, or rows that stopped
 * short of the committed tail — looked exactly like a successful one. The
 * binder then set `_bindComplete`, and from that moment every consumer of
 * `isTrustedLiveDoc` (restore, undo, the import path) treated a document known
 * to be missing content as the trustworthy live copy, for the life of the pod.
 *
 * 041 already refuses a load that THREW. This closes the other half: a load
 * that succeeded and is wrong.
 */
const Y = require('yjs');
const {
  refuseBind,
  resetPageThrottle,
  BIND_FAILED_CLOSE_CODE,
  PAGE_THROTTLE_MS,
  BIND_REFUSAL_REASONS,
} = require('../bind-failure');
const { createBindState } = require('../collab-bind-state');
const { ORIGIN_REDIS } = require('../origin');
const { docs } = require('y-websocket/bin/utils');
const telemetryMetrics = require('../telemetry/metrics');

describe('057 US3 — bind completeness', () => {
  let errorSpy;
  let logSpy;
  let warnSpy;

  const deps = (persistenceProvider, extra = {}) => ({
    persistenceProvider,
    pendingWrites: new Set(),
    notifyException: () => {},
    searchIndexer: { markDirty: () => {} },
    collabGuardrail: { evaluateUpdate: () => Promise.resolve() },
    logPerf: () => {},
    ...extra,
  });

  /** A document with `count` paragraphs, as the persisted load would return. */
  function persistedDoc(count) {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    for (let i = 0; i < count; i++) {
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, `para-${i}`);
      el.insert(0, [t]);
      frag.push([el]);
    }
    return doc;
  }

  /** A doc shaped like y-websocket's WSSharedDoc. */
  function wsDoc(connCount = 1) {
    const doc = new Y.Doc();
    doc.conns = new Map();
    for (let i = 0; i < connCount; i++) doc.conns.set({ close: jest.fn() }, new Set());
    return doc;
  }

  beforeEach(() => {
    resetPageThrottle();
    docs.clear();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    docs.clear();
  });

  // ── Acceptance 1: an interior gap past the retry budget ───────────────────
  test('a gapped load is REFUSED and never memoized as trusted', async () => {
    const refusalSpy = jest.spyOn(telemetryMetrics, 'recordBindRefusal');
    const persistence = {
      getClockRange: jest.fn().mockResolvedValue({ minClock: 0, maxClock: 9 }),
      getYDoc: jest.fn().mockResolvedValue({ ydoc: persistedDoc(2), gapped: true }),
    };
    const ydoc = wsDoc(2);
    docs.set('s/gap-doc', ydoc);

    await createBindState(deps(persistence))('s/gap-doc', ydoc);

    expect(ydoc._bindComplete).toBeUndefined();   // never trusted
    expect(ydoc._verifiedClock).toBeUndefined();  // and nothing claimed
    expect(ydoc._bindFailed).toBe(true);
    expect(docs.has('s/gap-doc')).toBe(false);    // evicted for a fresh attempt
    for (const conn of ydoc.conns.keys()) {
      expect(conn.close).toHaveBeenCalledWith(BIND_FAILED_CLOSE_CODE, expect.any(String));
    }
    expect(refusalSpy).toHaveBeenCalledWith(BIND_REFUSAL_REASONS.INCOMPLETE_LOAD);
  });

  test('the expected tail is captured BEFORE the fetch, never derived from it', async () => {
    const order = [];
    const persistence = {
      getClockRange: jest.fn(async () => { order.push('range'); return { minClock: 0, maxClock: 7 }; }),
      getYDoc: jest.fn(async () => { order.push('fetch'); return { ydoc: persistedDoc(3), gapped: false }; }),
    };
    const ydoc = wsDoc();

    await createBindState(deps(persistence))('s/order-doc', ydoc);

    // Deriving the target from the rows the fetch returned is circular and
    // always "complete" — the whole check would be vacuous.
    expect(order).toEqual(['range', 'fetch']);
    expect(persistence.getYDoc).toHaveBeenCalledWith('s/order-doc'.slice(2), {
      withGap: true,
      expectedTailClock: 7,
    });
  });

  // ── Acceptance 2: a read short of the captured tail ───────────────────────
  test('a load that stopped SHORT of the committed tail is refused identically', async () => {
    // The choke point reports this through the same `gapped` flag once the
    // caller opts in with expectedTailClock — rows 0..5 present, tail is 9.
    const persistence = {
      getClockRange: jest.fn().mockResolvedValue({ minClock: 0, maxClock: 9 }),
      getYDoc: jest.fn().mockResolvedValue({ ydoc: persistedDoc(6), gapped: true }),
    };
    const ydoc = wsDoc(1);
    docs.set('s/short-doc', ydoc);

    await createBindState(deps(persistence))('s/short-doc', ydoc);

    expect(ydoc._bindComplete).toBeUndefined();
    expect(ydoc._bindFailed).toBe(true);
    expect(docs.has('s/short-doc')).toBe(false);
  });

  // ── Acceptance 3: a load that healed within the budget ────────────────────
  test('a complete load binds cleanly, verified clock first and trust flag last', async () => {
    const persistence = {
      getClockRange: jest.fn().mockResolvedValue({ minClock: 0, maxClock: 12 }),
      getYDoc: jest.fn().mockResolvedValue({ ydoc: persistedDoc(4), gapped: false }),
    };
    const ydoc = wsDoc();
    const refusalSpy = jest.spyOn(telemetryMetrics, 'recordBindRefusal');

    await createBindState(deps(persistence))('s/clean-doc', ydoc);

    expect(ydoc._verifiedClock).toBe(12);   // the tail captured before the fetch
    expect(ydoc._bindComplete).toBe(true);
    expect(ydoc._bindFailed).toBeUndefined();
    expect(refusalSpy).not.toHaveBeenCalled();
    expect(ydoc.getXmlFragment('default').toString()).toContain('para-3');
  });

  // ── The verified clock is MONOTONE, including across the bind itself ──────
  // `expectedTailClock` is captured BEFORE the load, so by the time the binder
  // assigns it, it is already old. The doc is live throughout — fan-out lands in
  // it, and reconciliation can reach it mid-bind (read-document's `fireRepair`
  // calls `reconcileDoc` on the registry doc with no bind guard at all). A plain
  // assignment would overwrite a HIGHER, genuinely proven clock with the older
  // pre-load tail, walking `_verifiedClock` backwards and breaking the one
  // invariant every consumer reads it under (verified-clock.js: monotone
  // non-decreasing for the life of the instance).
  describe('monotone verified clock across bind completion', () => {
    /** A doc holding `label`, plus the update bytes that put it there. */
    function contentAndBytes(label) {
      const source = new Y.Doc();
      const before = Y.encodeStateVector(source);
      source.transact(() => {
        const el = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, label);
        el.insert(0, [t]);
        source.getXmlFragment('default').push([el]);
      });
      return { source, bytes: Y.encodeStateAsUpdate(source, before) };
    }

    test('a REAL reconcile landing mid-bind is not undone by bind completion', async () => {
      const { reconcileDoc } = require('../collab-reconcile');
      const ydoc = wsDoc();
      const { source, bytes } = contentAndBytes('committed-while-binding');

      // Row 20 is newer than anything the binder's pre-load probe saw. The doc
      // already holds its content (fan-out delivered it), so the reconcile
      // PROVES clock 20 without applying anything.
      const reconcilePersistence = {
        getUpdatesInRange: jest.fn().mockResolvedValue([{ clock: 20, update_data: bytes }]),
      };

      const persistence = {
        getClockRange: jest.fn().mockResolvedValue({ minClock: 0, maxClock: 12 }),
        getYDoc: jest.fn(async () => {
          // Mid-bind, exactly where the race lives: the load is in flight and
          // fan-out is already delivering into the doc (ORIGIN_REDIS — applied,
          // not persisted, because the publishing pod already wrote the row).
          Y.applyUpdate(ydoc, bytes, ORIGIN_REDIS);
          await reconcileDoc('race-doc', ydoc, { persistence: reconcilePersistence });
          expect(ydoc._verifiedClock).toBe(20);
          return { ydoc: persistedDoc(2), gapped: false };
        }),
      };

      await createBindState(deps(persistence))('s/race-doc', ydoc);

      expect(ydoc._bindComplete).toBe(true);
      expect(ydoc._verifiedClock).toBe(20); // NOT 12 — the proof survives
      source.destroy();
    });

    test('a pre-load tail BELOW an already-proven clock never lowers it', async () => {
      const ydoc = wsDoc();
      const persistence = {
        getClockRange: jest.fn().mockResolvedValue({ minClock: 0, maxClock: 3 }),
        getYDoc: jest.fn(async () => {
          ydoc._verifiedClock = 41;
          return { ydoc: persistedDoc(1), gapped: false };
        }),
      };

      await createBindState(deps(persistence))('s/lower-tail-doc', ydoc);

      expect(ydoc._verifiedClock).toBe(41);
    });

    test('a zero-row bind does not lower a clock something else already proved', async () => {
      // The `?? -1` branch: with no rows the binder claims -1, which must not
      // erase a clock proven while the (empty) load was running.
      const ydoc = wsDoc();
      const persistence = {
        getClockRange: jest.fn().mockResolvedValue({ minClock: null, maxClock: null }),
        getYDoc: jest.fn(async () => {
          ydoc._verifiedClock = 6;
          return { ydoc: new Y.Doc(), gapped: false };
        }),
      };

      await createBindState(deps(persistence))('s/empty-race-doc', ydoc);

      expect(ydoc._bindComplete).toBe(true);
      expect(ydoc._verifiedClock).toBe(6);
    });

    test('the tail still WINS when it is ahead — the bind is not a no-op', async () => {
      const ydoc = wsDoc();
      const persistence = {
        getClockRange: jest.fn().mockResolvedValue({ minClock: 0, maxClock: 15 }),
        getYDoc: jest.fn(async () => {
          ydoc._verifiedClock = 2;
          return { ydoc: persistedDoc(1), gapped: false };
        }),
      };

      await createBindState(deps(persistence))('s/ahead-doc', ydoc);

      expect(ydoc._verifiedClock).toBe(15);
    });
  });

  test('the trust flag is never set over a half-applied load — order matters', async () => {
    // If _bindComplete were set first, a consumer peeking between the two lines
    // would find a trusted doc with no verified clock.
    const observed = [];
    const persistence = {
      getClockRange: jest.fn().mockResolvedValue({ minClock: 0, maxClock: 4 }),
      getYDoc: jest.fn().mockResolvedValue({ ydoc: persistedDoc(2), gapped: false }),
    };
    const ydoc = wsDoc();
    let bindComplete;
    Object.defineProperty(ydoc, '_bindComplete', {
      configurable: true,
      get: () => bindComplete,
      set: (v) => { observed.push(['bindComplete', ydoc._verifiedClock]); bindComplete = v; },
    });

    await createBindState(deps(persistence))('s/order2-doc', ydoc);

    expect(observed).toEqual([['bindComplete', 4]]); // clock already set
  });

  // ── Acceptance 4: a genuinely new document ───────────────────────────────
  test('a document with zero rows binds normally with a verified clock of -1', async () => {
    const persistence = {
      getClockRange: jest.fn().mockResolvedValue({ minClock: null, maxClock: null }),
      getYDoc: jest.fn().mockResolvedValue({ ydoc: new Y.Doc(), gapped: false }),
    };
    const ydoc = wsDoc();

    await createBindState(deps(persistence))('s/new-doc', ydoc);

    // No tail to reach, so an empty load is a new document and not a torn read.
    expect(persistence.getYDoc).toHaveBeenCalledWith('new-doc', {
      withGap: true,
      expectedTailClock: null,
    });
    expect(ydoc._bindComplete).toBe(true);
    expect(ydoc._verifiedClock).toBe(-1);
    expect(ydoc._bindFailed).toBeUndefined();
  });

  // ── The 041 load-error path is byte-identical ────────────────────────────
  test('a load that THROWS still refuses with the 041 reason and behavior', async () => {
    const refusalSpy = jest.spyOn(telemetryMetrics, 'recordBindRefusal');
    const persistence = {
      getClockRange: jest.fn().mockResolvedValue({ minClock: 0, maxClock: 3 }),
      getYDoc: jest.fn().mockRejectedValue(new Error('connection terminated unexpectedly')),
    };
    const ydoc = wsDoc(1);
    docs.set('s/err-doc', ydoc);

    await createBindState(deps(persistence))('s/err-doc', ydoc);

    expect(ydoc._bindFailed).toBe(true);
    expect(ydoc._bindComplete).toBeUndefined();
    expect(refusalSpy).toHaveBeenCalledWith(BIND_REFUSAL_REASONS.LOAD_ERROR);
  });

  test('a clock-range probe that fails degrades to gap-only detection, not a refusal', async () => {
    // The tail cannot be judged without it, but a load that IS complete must
    // still bind — losing the extra check is not grounds to refuse service.
    const persistence = {
      getClockRange: jest.fn().mockRejectedValue(new Error('probe failed')),
      getYDoc: jest.fn().mockResolvedValue({ ydoc: persistedDoc(2), gapped: false }),
    };
    const ydoc = wsDoc();

    await createBindState(deps(persistence))('s/probe-fail-doc', ydoc);

    expect(persistence.getYDoc).toHaveBeenCalledWith('probe-fail-doc', {
      withGap: true,
      expectedTailClock: null,
    });
    expect(ydoc._bindComplete).toBe(true);
    expect(ydoc._verifiedClock).toBe(-1);
  });

  // ── Paging posture (RBD-057-3/4) ─────────────────────────────────────────
  describe('paging posture', () => {
    const refuse = (docGuid, reason, now) => refuseBind({
      docName: `s/${docGuid}`,
      docGuid,
      ydoc: wsDoc(0),
      error: new Error('incomplete'),
      docs: new Map(),
      notify: refuse.notify,
      now,
      reason,
    });

    beforeEach(() => { refuse.notify = jest.fn(); });

    test('the FIRST incomplete-load refusal for a document pages nobody', () => {
      const result = refuse('doc-a', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 1000);

      // A lost race against a mid-commit row costs one retry and one counter
      // increment. Paging a human for it would train them to ignore the page.
      expect(result.paged).toBe(false);
      expect(refuse.notify).not.toHaveBeenCalled();
    });

    test('a REPEAT within the throttle window pages once — a persistent gap reaches a human', () => {
      refuse('doc-b', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 1000);
      const second = refuse('doc-b', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 2000);

      expect(second.paged).toBe(true);
      expect(refuse.notify).toHaveBeenCalledTimes(1);

      // And the existing per-document throttle still bounds the volume.
      const third = refuse('doc-b', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 3000);
      expect(third.paged).toBe(false);
      expect(refuse.notify).toHaveBeenCalledTimes(1);
    });

    test('a repeat LONG after the window is a fresh first occurrence, and stays silent', () => {
      refuse('doc-c', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 1000);
      const later = refuse('doc-c', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 1000 + PAGE_THROTTLE_MS + 1);

      expect(later.paged).toBe(false);
      expect(refuse.notify).not.toHaveBeenCalled();
    });

    test('one document staying silent does not silence another', () => {
      refuse('doc-d', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 1000);
      refuse('doc-e', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 1000);
      const dAgain = refuse('doc-d', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 1500);

      expect(dAgain.paged).toBe(true);
      expect(refuse.notify).toHaveBeenCalledTimes(1);
    });

    test('load-error paging is unchanged: it pages on the FIRST occurrence (041)', () => {
      const first = refuse('doc-f', BIND_REFUSAL_REASONS.LOAD_ERROR, 1000);
      expect(first.paged).toBe(true);
      expect(refuse.notify).toHaveBeenCalledTimes(1);

      const second = refuse('doc-f', BIND_REFUSAL_REASONS.LOAD_ERROR, 2000);
      expect(second.paged).toBe(false); // per-doc throttle, exactly as before
    });

    test('omitting the reason entirely is the 041 default', () => {
      const result = refuseBind({
        docName: 's/doc-g',
        docGuid: 'doc-g',
        ydoc: wsDoc(0),
        error: new Error('boom'),
        docs: new Map(),
        notify: refuse.notify,
        now: 1000,
      });
      expect(result.paged).toBe(true);
      expect(result.reason).toBe(BIND_REFUSAL_REASONS.LOAD_ERROR);
    });

    test('the incomplete-load class is distinguishable in the return shape', () => {
      const result = refuse('doc-h', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 1000);
      expect(result.reason).toBe('incomplete-load');
      expect(result).toMatchObject({
        paged: expect.any(Boolean),
        evicted: expect.any(Boolean),
        closedConnections: expect.any(Number),
        destroyed: expect.any(Boolean),
      });
    });

    test('resetPageThrottle forgets the incomplete-load history too', () => {
      refuse('doc-i', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 1000);
      resetPageThrottle();
      const afterReset = refuse('doc-i', BIND_REFUSAL_REASONS.INCOMPLETE_LOAD, 1500);
      expect(afterReset.paged).toBe(false); // first occurrence again
    });
  });
});
