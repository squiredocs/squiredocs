/**
 * Feature 057 US4 — readiness means the counted updates are INTEGRATED
 * (FR-009, contracts/readiness-and-telemetry.md).
 *
 * THE DEFECT: the gate asked the database how many updates the document had,
 * then resolved on the FIRST `update` event and never re-checked. One event is
 * not N updates — bindState applies its load in pieces, and a fan-out message
 * arriving first satisfied the gate outright. So an agent could be handed a
 * document readiness had declared ready and start acting on a fraction of it.
 *
 * The replacement is monotone in both stages: later edits can only over-satisfy
 * it, so it cannot starve or deadlock. The 10s timeout and the 2s DB-error
 * fallback keep their exact durations and their resolve-anyway semantics — only
 * the MEANING of ready changes (RBD-057-5, SC-007).
 */
const Y = require('yjs');
const agentPresence = require('../mcp/agent-presence');
const { docs: wsDocs } = require('y-websocket/bin/utils');

describe('057 US4 — readiness gate', () => {
  const DOC = 'doc-057-readiness';
  let logSpy;
  let warnSpy;

  /** A registry doc that has verified integration through `clock`. */
  function registryDoc(clock, build) {
    const doc = new Y.Doc();
    if (build) build(doc);
    doc._bindComplete = true;
    if (clock !== null) doc._verifiedClock = clock;
    return doc;
  }

  /** Give `session` everything `source` holds, as WebSocket sync would. */
  const syncFrom = (session, source) =>
    Y.applyUpdate(session, Y.encodeStateAsUpdate(source));

  const addParagraph = (doc, label) => doc.transact(() => {
    const el = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, label);
    el.insert(0, [t]);
    doc.getXmlFragment('default').push([el]);
  });

  /** Has the promise settled? Never awaits it, so an unresolved gate is visible. */
  function track(promise) {
    const state = { settled: false };
    promise.then(() => { state.settled = true; });
    return state;
  }

  /** Let pending microtasks run without advancing time. */
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  /** Put a doc in the y-websocket registry, where the gate looks for it. */
  const register = (doc) => { wsDocs.set(`s/${DOC}`, doc); return doc; };

  beforeEach(() => {
    wsDocs.delete(`s/${DOC}`);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    wsDocs.delete(`s/${DOC}`);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('a document with NO durable rows resolves immediately', async () => {
    agentPresence.init({ getClockRange: async () => ({ minClock: null, maxClock: null }) });
    
    await expect(agentPresence._waitForDocumentContent(new Y.Doc(), DOC)).resolves.toBeUndefined();
  });

  test('does NOT resolve on the first update event alone — the defect', async () => {
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 5 }) });
    // The registry doc has verified nothing yet: the load is still landing.
    const registry = registryDoc(null, (d) => addParagraph(d, 'partial'));
    register(registry);

    const session = new Y.Doc();
    const gate = track(agentPresence._waitForDocumentContent(session, DOC));
    await flush();

    // One event fires — under the old gate this alone resolved it.
    addParagraph(session, 'first-event');
    await flush();

    expect(gate.settled).toBe(false);
  });

  test('resolves once the registry has verified the armed clock AND the session covers it', async () => {
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 5 }) });
    const registry = registryDoc(null, (d) => addParagraph(d, 'body'));
    register(registry);

    const session = new Y.Doc();
    const gate = track(agentPresence._waitForDocumentContent(session, DOC));
    await flush();
    expect(gate.settled).toBe(false);

    // Stage 1: the pod finishes verifying integration through the armed clock.
    registry._verifiedClock = 5;
    // Stage 2 is still unmet — the session has none of that content yet.
    addParagraph(session, 'unrelated-local');
    await flush();
    expect(gate.settled).toBe(false);

    // The session catches up, as WebSocket sync delivers the state.
    syncFrom(session, registry);
    await flush();
    expect(gate.settled).toBe(true);
  });

  test('an already-satisfied gate resolves on the immediate check, with no update event', async () => {
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 3 }) });
    const registry = registryDoc(3, (d) => addParagraph(d, 'already-here'));
    register(registry);

    const session = new Y.Doc();
    syncFrom(session, registry);

    // No update ever fires on the session doc after the gate is armed.
    await expect(agentPresence._waitForDocumentContent(session, DOC)).resolves.toBeUndefined();
  });

  test('a registry doc BEHIND the armed clock does not satisfy stage 1', async () => {
    agentPresence.init({
      getClockRange: async () => ({ minClock: 0, maxClock: 9 }),
      // No rows come back, so the stage-1 nudge cannot advance anything.
      getUpdatesInRange: async () => [],
    });
    const registry = registryDoc(4, (d) => addParagraph(d, 'stale'));
    register(registry);

    const session = new Y.Doc();
    syncFrom(session, registry); // session covers the registry, but 4 < 9
    const gate = track(agentPresence._waitForDocumentContent(session, DOC));
    await flush();

    expect(gate.settled).toBe(false);
  });

  // ── The stage-1 nudge (post-merge review LOW-1) ──────────────────────────
  // Nothing on the live persist path advances `_verifiedClock`, and `check` only
  // re-runs on SESSION updates. So a row committed between the binder's tail
  // probe and this gate's arming left verified(T0) < armClock(T1) with no event
  // inside the 10s budget that could close it — the gate burned its full timeout
  // on exactly the documents being edited. Reconciliation is what advances the
  // clock, so the gate asks for one, ONCE.

  test('a registry clock behind the arm is nudged forward, settling well inside the budget', async () => {
    jest.useFakeTimers();
    // Row 9 was committed just after the binder probed the tail, leaving the
    // registry verified only through 8. Its content is already in the registry
    // doc via fan-out, so the reconcile PROVES clock 9 and applies nothing.
    const registry = registryDoc(8, (d) => addParagraph(d, 'body'));
    const rowBytes = Y.encodeStateAsUpdate(registry, Y.encodeStateVector(new Y.Doc()));
    const getUpdatesInRange = jest.fn().mockResolvedValue([{ clock: 9, update_data: rowBytes }]);
    agentPresence.init({
      getClockRange: async () => ({ minClock: 0, maxClock: 9 }),
      getUpdatesInRange,
    });
    register(registry);

    const session = new Y.Doc();
    syncFrom(session, registry); // stage 2 is already satisfied; stage 1 is not
    const gate = track(agentPresence._waitForDocumentContent(session, DOC));

    // No timer is advanced anywhere in this test: settling is the nudge's doing,
    // not the 10s timeout's.
    await flush();
    await flush();

    expect(gate.settled).toBe(true);
    expect(registry._verifiedClock).toBe(9);
    // The suffix above what is verified, never the whole log.
    expect(getUpdatesInRange).toHaveBeenCalledWith(DOC, 9, expect.any(Number), { includeData: true });
  });

  test('the nudge fires at most ONCE, however many update events arrive', async () => {
    jest.useFakeTimers();
    const getUpdatesInRange = jest.fn().mockResolvedValue([]);
    agentPresence.init({
      getClockRange: async () => ({ minClock: 0, maxClock: 9 }),
      getUpdatesInRange,
    });
    register(registryDoc(4, (d) => addParagraph(d, 'stale')));

    const session = new Y.Doc();
    const gate = track(agentPresence._waitForDocumentContent(session, DOC));
    await flush();

    // A busy document: many session updates, each running `check`. An unguarded
    // trigger would turn every one of them into a database query.
    for (let i = 0; i < 5; i++) { addParagraph(session, `edit-${i}`); await flush(); }

    expect(getUpdatesInRange).toHaveBeenCalledTimes(1);
    expect(gate.settled).toBe(false); // and the 10s timeout still bounds the wait
  });

  test('the nudge is not spent on a doc that is still binding', async () => {
    jest.useFakeTimers();
    const getUpdatesInRange = jest.fn().mockResolvedValue([]);
    agentPresence.init({
      getClockRange: async () => ({ minClock: 0, maxClock: 6 }),
      getUpdatesInRange,
    });
    register(new Y.Doc()); // no _bindComplete: the binder is about to set the clock

    const gate = track(agentPresence._waitForDocumentContent(new Y.Doc(), DOC));
    await flush();

    expect(getUpdatesInRange).not.toHaveBeenCalled();
    expect(gate.settled).toBe(false);
  });

  test('a nudge that FAILS leaves the timeout to bound the wait, never rejecting', async () => {
    jest.useFakeTimers();
    agentPresence.init({
      getClockRange: async () => ({ minClock: 0, maxClock: 9 }),
      getUpdatesInRange: async () => { throw new Error('db down mid-gate'); },
    });
    register(registryDoc(4, (d) => addParagraph(d, 'stale')));

    const gate = track(agentPresence._waitForDocumentContent(new Y.Doc(), DOC));
    await flush();
    expect(gate.settled).toBe(false);

    jest.advanceTimersByTime(10000);
    await flush();
    expect(gate.settled).toBe(true);
  });

  test('MONOTONE: edits after stage 1 over-satisfy the gate, they never starve it', async () => {
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 2 }) });
    const registry = registryDoc(2, (d) => addParagraph(d, 'target'));
    register(registry);

    const session = new Y.Doc();
    const gate = track(agentPresence._waitForDocumentContent(session, DOC));
    await flush();

    // The registry races ahead while the session is still catching up. The
    // target was captured at stage-1 satisfaction, so this cannot move the
    // goalposts — a live document would otherwise never be "ready".
    addParagraph(registry, 'newer-1');
    addParagraph(registry, 'newer-2');
    syncFrom(session, registry);
    await flush();

    expect(gate.settled).toBe(true);
  });

  test('a doc bound WITHOUT a verified clock falls back to its completion flag', async () => {
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 6 }) });
    // Only a non-production binder produces this shape; the real one sets both.
    const registry = new Y.Doc();
    addParagraph(registry, 'loaded-by-another-binder');
    registry._bindComplete = true;
    expect(registry._verifiedClock).toBeUndefined();
    register(registry);

    const session = new Y.Doc();
    const gate = track(agentPresence._waitForDocumentContent(session, DOC));
    await flush();

    // Stage 2 still governs: the session has not caught up with the pod yet.
    expect(gate.settled).toBe(false);

    syncFrom(session, registry);
    await flush();
    expect(gate.settled).toBe(true);
  });

  test('the fallback does NOT apply to a doc that is still binding', async () => {
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 6 }) });
    const registry = new Y.Doc(); // no _bindComplete, no _verifiedClock
    register(registry);

    const session = new Y.Doc();
    syncFrom(session, registry);
    const gate = track(agentPresence._waitForDocumentContent(session, DOC));
    await flush();

    expect(gate.settled).toBe(false);
  });

  // ── Timeout semantics are UNCHANGED (SC-007) ─────────────────────────────
  test('content that never arrives still resolves on the existing 10s timeout', async () => {
    jest.useFakeTimers();
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 7 }) });
    // A bind that never completes: neither stage 1 signal ever appears.
    register(new Y.Doc());

    const gate = track(agentPresence._waitForDocumentContent(new Y.Doc(), DOC));
    await flush();

    jest.advanceTimersByTime(9999);
    await flush();
    expect(gate.settled).toBe(false);

    jest.advanceTimersByTime(1);
    await flush();
    expect(gate.settled).toBe(true); // resolves honestly rather than hanging
  });

  test('a DB-error keeps the existing 2s fallback timeout', async () => {
    jest.useFakeTimers();
    agentPresence.init({ getClockRange: async () => { throw new Error('db down'); } });
    
    const gate = track(agentPresence._waitForDocumentContent(new Y.Doc(), DOC));
    await flush();

    jest.advanceTimersByTime(1999);
    await flush();
    expect(gate.settled).toBe(false);

    jest.advanceTimersByTime(1);
    await flush();
    expect(gate.settled).toBe(true);
  });

  test('a document not loaded on this pod degrades to the timeout, never a hang', async () => {
    jest.useFakeTimers();
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 4 }) });
    
    const gate = track(agentPresence._waitForDocumentContent(new Y.Doc(), DOC));
    await flush();
    jest.advanceTimersByTime(10000);
    await flush();

    expect(gate.settled).toBe(true);
  });

  test('the gate unsubscribes its listener when it settles', async () => {
    agentPresence.init({ getClockRange: async () => ({ minClock: null, maxClock: null }) });
    
    const session = new Y.Doc();
    await agentPresence._waitForDocumentContent(session, DOC);

    // A leaked listener on a long-lived session doc would run for every edit.
    expect(session._observers.get('update')?.size ?? 0).toBe(0);
  });

  test('a peek that throws does not break the gate', async () => {
    jest.useFakeTimers();
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 1 }) });
    // A registry entry whose state vector cannot be read at all.
    register({ _verifiedClock: 1, get store() { throw new Error('registry exploded'); } });

    const gate = track(agentPresence._waitForDocumentContent(new Y.Doc(), DOC));
    await flush();
    jest.advanceTimersByTime(10000);
    await flush();

    expect(gate.settled).toBe(true);
  });
});
