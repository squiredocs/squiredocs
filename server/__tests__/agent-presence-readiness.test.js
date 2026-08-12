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
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 9 }) });
    const registry = registryDoc(4, (d) => addParagraph(d, 'stale'));
    register(registry);

    const session = new Y.Doc();
    syncFrom(session, registry); // session covers the registry, but 4 < 9
    const gate = track(agentPresence._waitForDocumentContent(session, DOC));
    await flush();

    expect(gate.settled).toBe(false);
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

  // ── Timeout semantics are UNCHANGED (SC-007) ─────────────────────────────
  test('content that never arrives still resolves on the existing 10s timeout', async () => {
    jest.useFakeTimers();
    agentPresence.init({ getClockRange: async () => ({ minClock: 0, maxClock: 7 }) });
    register(registryDoc(null));

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
