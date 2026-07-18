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

describe('two-pod A→B→A handoff with real awareness state (HIGH-1)', () => {
  // The isolated module copies still require server/redis at load; all deps
  // are overridden, so a real connection must never be attempted.
  let fake;
  let pods;
  let awarenesses;
  let plantedByPod;

  /**
   * Load an isolated agent-presence + presence-claim module PAIR (one
   * simulated pod) wired to the shared fake Redis and nudge bus under its
   * own instance identity, with a working fake persistence provider.
   */
  function loadPod(instanceId) {
    let ap;
    let pc;
    jest.isolateModules(() => {
      pc = require('../presence-claim');
      ap = require('../agent-presence');
    });
    const pubsub = fake.makePubSubFor(instanceId);
    pc._setDepsForTests({
      enabled: () => true,
      getClient: () => fake.client,
      instanceId: () => instanceId,
      subscribeTakeover: (h) => pubsub.subscribeToPresenceClaims(h),
      publishTakeover: (k) => pubsub.publishPresenceClaimTakeover(k),
    });
    ap.init(makeFakePersistence()); // wires pc.init({ onLost, onAcquired })
    const pod = { instanceId, ap, pc };
    pods.push(pod);
    plantedByPod.set(pod, []);
    return pod;
  }

  /**
   * Plant an initialized, connected session (real Awareness) in a pod's
   * indexes — the state a pod is in after its own earlier tool call created
   * the working session. getOrCreateSession then exercises its real reuse +
   * claim-takeover path on it.
   */
  function plantSession(pod, overrides = {}) {
    const awareness = new awarenessProtocol.Awareness(new Y.Doc());
    awarenesses.push(awareness);
    const session = {
      sessionId: `pod-${pod.instanceId}-${Date.now()}-${Math.random()}`,
      docGuid: DOC,
      userId: USER,
      agentId: AGENT,
      provider: { wsconnected: true, awareness },
      cleanup: jest.fn(),
      timeoutId: null,
      createdAt: Date.now(),
      cursor: null,
      initialized: true,

      clipboard: null,
      lastActivityAt: Date.now(),
      highlightQueue: null,
      claimState: 'holder',
      claimKey: KEY,
      ...overrides,
    };
    session.key = `${session.userId}-${session.agentId}-${session.docGuid}`;
    pod.ap.getActiveSessions().set(session.sessionId, session);
    pod.ap._sessionsByKey.set(session.key, session.sessionId);
    if (!pod.ap._sessionsByUserId.has(session.userId)) {
      pod.ap._sessionsByUserId.set(session.userId, new Set());
    }
    pod.ap._sessionsByUserId.get(session.userId).add(session.sessionId);
    plantedByPod.get(pod).push(session);
    return session;
  }

  /** A pod's announced awareness state (null when silenced). */
  function announcedState(session) {
    return session.provider.awareness.getLocalState();
  }

  /** True when the pod is actually announcing the agent to peers. */
  function isAnnouncing(session) {
    const state = announcedState(session);
    return !!(state && state.user);
  }

  beforeEach(() => {
    fake = createFakeClaimRedis();
    pods = [];
    awarenesses = [];
    plantedByPod = new Map();
  });

  afterEach(() => {
    for (const [pod, sessions] of plantedByPod) {
      for (const session of sessions) {
        if (session.timeoutId) clearTimeout(session.timeoutId);
        pod.ap.getActiveSessions().delete(session.sessionId);
      }
      pod.pc._resetForTests();
    }
    for (const aw of awarenesses) aw.destroy();
  });

  test('alternating tool calls: exactly one real announcer after each settle; the returning pod re-announces', async () => {
    const podA = loadPod('instance-A');
    const podB = loadPod('instance-B');
    const sessionA = plantSession(podA, { cursor: CURSOR });
    const sessionB = plantSession(podB);
    const token = { userId: USER, agentId: AGENT, agentName: 'Test Agent' };

    // Tool call on pod A: A claims and announces
    await podA.ap.getOrCreateSession(DOC, token, 60);
    expect(fake.peek(KEY)).toBe('instance-A');
    expect(isAnnouncing(sessionA)).toBe(true);
    expect(isAnnouncing(sessionB)).toBe(false);

    // Tool call on pod B: takeover; the nudge silences A's REAL awareness
    await podB.ap.getOrCreateSession(DOC, token, 60);
    expect(fake.peek(KEY)).toBe('instance-B');
    expect(announcedState(sessionA)).toBeNull(); // fully removed, not just user-less
    expect(isAnnouncing(sessionB)).toBe(true);
    expect([sessionA, sessionB].filter(isAnnouncing)).toHaveLength(1);

    // Tool call back on pod A (the A→B→A handoff): the returning pod's
    // awareness must be REBUILT from null — this was CRITICAL-1's dark spot.
    await podA.ap.getOrCreateSession(DOC, token, 60);
    expect(fake.peek(KEY)).toBe('instance-A');
    expect(announcedState(sessionB)).toBeNull();
    const stateA = announcedState(sessionA);
    expect(stateA).not.toBeNull();
    expect(stateA.user).toBeTruthy();
    expect(stateA.user.name).toBe('Test Agent (Sam)');
    expect(stateA.cursor).toEqual(CURSOR); // last recorded position restored
    expect([sessionA, sessionB].filter(isAnnouncing)).toHaveLength(1);

    // And B→A→B: the other direction re-announces just the same
    await podB.ap.getOrCreateSession(DOC, token, 60);
    expect(announcedState(sessionA)).toBeNull();
    expect(isAnnouncing(sessionB)).toBe(true);
    expect([sessionA, sessionB].filter(isAnnouncing)).toHaveLength(1);
  });
});
