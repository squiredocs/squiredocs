/**
 * Re-announce after silence, tested against REAL y-protocols Awareness
 * instances (post-merge review of feature 015, CRITICAL-1 / HIGH-1).
 *
 * Why real Awareness: silencing uses `setLocalState(null)`, and y-protocols'
 * `setLocalStateField` is a NO-OP when the local state is null
 * (node_modules/y-protocols/awareness.js). Mock-based suites verified the
 * exact calls the code made — which is precisely how a per-field re-announce
 * that never lands could pass every test. These suites assert the OBSERVABLE
 * awareness state instead.
 *
 * Part 1 (CRITICAL-1 regression): both re-announce paths — the heartbeat
 * probe (`_onClaimAcquired`) and the tool-call takeover branch in
 * `getOrCreateSession` — must rebuild the full state (user + cursor) after
 * a silence.
 *
 * Part 2 (HIGH-1): two isolated agent-presence/presence-claim module pairs
 * ("pods") share one fake Redis + nudge bus, each with a real Awareness
 * object, driving an A→B→A handoff and asserting exactly one non-null
 * announcer at every settled point.
 */
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/awareness');
const { createFakeClaimRedis } = require('./helpers/fake-claim-redis');
const agentPresence = require('../agent-presence');
const presenceClaim = require('../presence-claim');

const USER = 'user-1';
const AGENT = 'default';
const DOC = 'doc-1';
const KEY = `agent-presence:${USER}:${AGENT}:${DOC}`;
const AGENT_INFO = {
  name: 'Test Agent (Sam)',
  email: 'sam@example.com',
  picture: 'pic',
  color: '#875692',
  isAgent: true,
};
const CURSOR = { anchor: { type: 'a', item: null }, head: { type: 'a', item: null } };

/** Minimal persistence provider satisfying getOrCreateSession's reuse path. */
function makeFakePersistence() {
  return {
    getPool: () => ({
      query: async () => ({
        rows: [{ id: DOC, role: 'editor', name: 'Sam', email: 'sam@example.com', picture: 'pic' }],
      }),
    }),
    getUpdateCount: async () => 0,
  };
}

describe('re-announce after silence with a real Awareness (CRITICAL-1 regression)', () => {
  let fake;
  let isolatedInstances;
  let plantedSessions;
  let awarenesses;

  function wireA() {
    const pubsub = fake.makePubSubFor('instance-A');
    presenceClaim._setDepsForTests({
      enabled: () => true,
      getClient: () => fake.client,
      instanceId: () => 'instance-A',
      subscribeTakeover: (h) => pubsub.subscribeToPresenceClaims(h),
      publishTakeover: (k) => pubsub.publishPresenceClaimTakeover(k),
    });
    // Wires presence-claim's onLost/onAcquired exactly as server startup does,
    // and installs the fake persistence used by getOrCreateSession.
    agentPresence.init(makeFakePersistence());
  }

  function loadInstanceB(callbacks = {}) {
    let mod;
    jest.isolateModules(() => {
      mod = require('../presence-claim');
    });
    const pubsub = fake.makePubSubFor('instance-B');
    mod._setDepsForTests({
      enabled: () => true,
      getClient: () => fake.client,
      instanceId: () => 'instance-B',
      subscribeTakeover: (h) => pubsub.subscribeToPresenceClaims(h),
      publishTakeover: (k) => pubsub.publishPresenceClaimTakeover(k),
    });
    mod.init(callbacks);
    isolatedInstances.push(mod);
    return mod;
  }

  /** Plant a session in the singleton's indexes with a REAL Awareness. */
  function plantRealSession(overrides = {}) {
    const awareness = new awarenessProtocol.Awareness(new Y.Doc());
    awarenesses.push(awareness);
    const defaults = {
      sessionId: `real-session-${Date.now()}-${Math.random()}`,
      docGuid: DOC,
      userId: USER,
      agentId: AGENT,
      provider: { wsconnected: true, awareness },
      cleanup: jest.fn(),
      timeoutId: null,
      createdAt: Date.now(),
      cursor: null,
      initialized: true,
      undoManager: null,
      clipboard: null,
      lastActivityAt: Date.now(),
      highlightQueue: null,
      claimState: 'holder',
      agentInfo: AGENT_INFO,
      claimKey: KEY,
    };
    const session = { ...defaults, ...overrides };
    session.key = `${session.userId}-${session.agentId}-${session.docGuid}`;

    agentPresence.getActiveSessions().set(session.sessionId, session);
    agentPresence._sessionsByKey.set(session.key, session.sessionId);
    if (!agentPresence._sessionsByUserId.has(session.userId)) {
      agentPresence._sessionsByUserId.set(session.userId, new Set());
    }
    agentPresence._sessionsByUserId.get(session.userId).add(session.sessionId);
    plantedSessions.push(session);
    return session;
  }

  function removePlantedSessions() {
    for (const session of plantedSessions) {
      if (session.timeoutId) clearTimeout(session.timeoutId);
      agentPresence.getActiveSessions().delete(session.sessionId);
      if (agentPresence._sessionsByKey.get(session.key) === session.sessionId) {
        agentPresence._sessionsByKey.delete(session.key);
      }
      const userSessions = agentPresence._sessionsByUserId.get(session.userId);
      if (userSessions) {
        userSessions.delete(session.sessionId);
        if (userSessions.size === 0) agentPresence._sessionsByUserId.delete(session.userId);
      }
    }
    plantedSessions = [];
  }

  async function passTime(ms) {
    fake.advance(ms);
    await jest.advanceTimersByTimeAsync(ms);
  }

  beforeEach(() => {
    presenceClaim._resetForTests();
    fake = createFakeClaimRedis();
    isolatedInstances = [];
    plantedSessions = [];
    awarenesses = [];
    wireA();
  });

  afterEach(() => {
    removePlantedSessions();
    for (const aw of awarenesses) aw.destroy();
    for (const mod of isolatedInstances) mod._resetForTests();
    presenceClaim._resetForTests();
    jest.useRealTimers();
  });

  test('heartbeat re-acquire (_onClaimAcquired) restores the full state: user AND cursor', async () => {
    jest.useFakeTimers();
    const session = plantRealSession({ cursor: CURSOR });
    const aw = session.provider.awareness;
    // The initial announce, exactly as production writes it
    aw.setLocalStateField('user', AGENT_INFO);
    aw.setLocalStateField('cursor', CURSOR);
    await presenceClaim.tryAcquire(KEY);
    presenceClaim.startHeartbeat(KEY);

    // Another instance takes the claim over; the nudge silences this session
    const b = loadInstanceB();
    await b.ensureHeldForWork(KEY);
    expect(session.claimState).toBe('silent');
    expect(aw.getLocalState()).toBeNull(); // real full-state silence

    // The other instance releases cleanly; our next heartbeat probe wins
    await b.release(KEY);
    await passTime(5000);
    expect(session.claimState).toBe('holder');

    // CRITICAL-1: with setLocalStateField this was a permanent no-op — the
    // avatar stayed dark cluster-wide despite claimState saying 'holder'.
    const state = aw.getLocalState();
    expect(state).not.toBeNull();
    expect(state.user).toEqual(AGENT_INFO);
    expect(state.cursor).toEqual(CURSOR);
  });

  test('heartbeat re-acquire without a recorded cursor announces the user alone', async () => {
    jest.useFakeTimers();
    const session = plantRealSession({ cursor: null });
    const aw = session.provider.awareness;
    aw.setLocalStateField('user', AGENT_INFO);
    await presenceClaim.tryAcquire(KEY);
    presenceClaim.startHeartbeat(KEY);

    const b = loadInstanceB();
    await b.ensureHeldForWork(KEY);
    expect(aw.getLocalState()).toBeNull();

    await b.release(KEY);
    await passTime(5000);

    const state = aw.getLocalState();
    expect(state).not.toBeNull();
    expect(state.user).toEqual(AGENT_INFO);
    expect(state.cursor).toBeUndefined();
  });

  test('getOrCreateSession takeover (wasSilent branch) restores the full state: user AND cursor', async () => {
    // Silenced earlier by a foreign takeover; the foreign claim is live
    const session = plantRealSession({ cursor: CURSOR, claimState: 'silent' });
    const aw = session.provider.awareness;
    aw.setLocalState(null);
    fake.setKey(KEY, 'instance-B', 15000);

    // A tool call on this instance: the claim follows the work
    const token = { userId: USER, agentId: AGENT, agentName: 'Test Agent' };
    const returned = await agentPresence.getOrCreateSession(DOC, token, 60);

    expect(returned).toBe(session);
    expect(session.claimState).toBe('holder');
    expect(fake.peek(KEY)).toBe('instance-A');

    const state = aw.getLocalState();
    expect(state).not.toBeNull();
    expect(state.user).toBeTruthy();
    expect(state.user.isAgent).toBe(true);
    expect(state.user.name).toBe('Test Agent (Sam)');
    expect(state.cursor).toEqual(CURSOR);
  });
});
