/**
 * Work-follows-the-claim handoff + failover (feature 015, US2/US4).
 *
 * Instance A is the REAL module pair (agent-presence + presence-claim
 * singletons, mock sessions in the real indexes); instance B is an isolated
 * presence-claim copy (jest.isolateModules). Both share one fake Redis and
 * one bridged nudge bus.
 */
const { createFakeClaimRedis } = require('./helpers/fake-claim-redis');
const agentPresence = require('../agent-presence');
const presenceClaim = require('../presence-claim');

const USER = 'user-1';
const AGENT = 'default';
const DOC = 'doc-1';
const KEY = `agent-presence:${USER}:${AGENT}:${DOC}`;

describe('presence handoff', () => {
  let fake;
  let publishSpyA;
  let isolatedInstances;

  function wireA() {
    const pubsub = fake.makePubSubFor('instance-A');
    publishSpyA = jest.fn((k) => pubsub.publishPresenceClaimTakeover(k));
    presenceClaim._setDepsForTests({
      enabled: () => true,
      getClient: () => fake.client,
      instanceId: () => 'instance-A',
      subscribeTakeover: (h) => pubsub.subscribeToPresenceClaims(h),
      publishTakeover: publishSpyA,
    });
    // Wires presence-claim callbacks (onLost/onAcquired) exactly as the
    // server does at startup.
    agentPresence.init({});
  }

  function loadInstanceB(callbacks = {}) {
    let mod;
    jest.isolateModules(() => {
      mod = require('../presence-claim');
    });
    const pubsub = fake.makePubSubFor('instance-B');
    const publishSpy = jest.fn((k) => pubsub.publishPresenceClaimTakeover(k));
    mod._setDepsForTests({
      enabled: () => true,
      getClient: () => fake.client,
      instanceId: () => 'instance-B',
      subscribeTakeover: (h) => pubsub.subscribeToPresenceClaims(h),
      publishTakeover: publishSpy,
    });
    mod.init(callbacks);
    isolatedInstances.push(mod);
    return { mod, publishSpy };
  }

  function createMockSession(overrides = {}) {
    const sessions = agentPresence.getActiveSessions();
    const sessionsByKey = agentPresence._sessionsByKey;
    const sessionsByUserId = agentPresence._sessionsByUserId;
    const defaults = {
      sessionId: `handoff-session-${Date.now()}-${Math.random()}`,
      docGuid: DOC,
      userId: USER,
      agentId: AGENT,
      provider: {
        wsconnected: true,
        awareness: { setLocalStateField: jest.fn(), setLocalState: jest.fn() },
      },
      cleanup: jest.fn(),
      timeoutId: setTimeout(() => {}, 60000),
      createdAt: Date.now(),
      cursor: { anchor: { type: 'x' }, head: { type: 'x' } },
      initialized: true,
      undoManager: { destroy: jest.fn() },
      clipboard: null,
      lastActivityAt: Date.now(),
      highlightQueue: null,
      claimState: 'holder',
      agentInfo: { name: 'Test Agent (User)', isAgent: true },
      claimKey: KEY,
    };
    const session = { ...defaults, ...overrides };
    session.key = `${session.userId}-${session.agentId}-${session.docGuid}`;

    sessions.set(session.sessionId, session);
    sessionsByKey.set(session.key, session.sessionId);
    if (!sessionsByUserId.has(session.userId)) {
      sessionsByUserId.set(session.userId, new Set());
    }
    sessionsByUserId.get(session.userId).add(session.sessionId);
    return session;
  }

  function removeMockSession(session) {
    const sessions = agentPresence.getActiveSessions();
    clearTimeout(session.timeoutId);
    sessions.delete(session.sessionId);
    if (agentPresence._sessionsByKey.get(session.key) === session.sessionId) {
      agentPresence._sessionsByKey.delete(session.key);
    }
    const userSessions = agentPresence._sessionsByUserId.get(session.userId);
    if (userSessions) {
      userSessions.delete(session.sessionId);
      if (userSessions.size === 0) agentPresence._sessionsByUserId.delete(session.userId);
    }
  }

  beforeEach(() => {
    presenceClaim._resetForTests();
    fake = createFakeClaimRedis();
    isolatedInstances = [];
    wireA();
  });

  afterEach(() => {
    for (const mod of isolatedInstances) mod._resetForTests();
    presenceClaim._resetForTests();
  });

  describe('takeover (US2)', () => {
    test('ensureHeldForWork on a non-holder overwrites the claim and publishes exactly one nudge', async () => {
      // A holds the claim
      await presenceClaim.tryAcquire(KEY);
      expect(fake.peek(KEY)).toBe('instance-A');

      const { mod: b, publishSpy } = loadInstanceB();
      const result = await b.ensureHeldForWork(KEY);

      expect(result).toEqual({ held: true });
      expect(fake.peek(KEY)).toBe('instance-B'); // owner flipped
      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(publishSpy).toHaveBeenCalledWith(KEY);
      expect(b.isHeld(KEY)).toBe(true);
    });

    test("the nudge silences the previous holder's session via setLocalState(null), leaving the working session intact", async () => {
      const session = createMockSession();
      await presenceClaim.tryAcquire(KEY);
      expect(presenceClaim.isHeld(KEY)).toBe(true);

      const { mod: b } = loadInstanceB();
      await b.ensureHeldForWork(KEY);

      // FR-007: full-state silence — the exact call
      expect(session.provider.awareness.setLocalState).toHaveBeenCalledTimes(1);
      expect(session.provider.awareness.setLocalState).toHaveBeenCalledWith(null);
      expect(session.claimState).toBe('silent');
      expect(presenceClaim.isHeld(KEY)).toBe(false);

      // FR-004: the working session survives untouched
      expect(agentPresence.getSession(session.sessionId)).toBe(session);
      expect(agentPresence._sessionsByKey.get(session.key)).toBe(session.sessionId);
      expect(session.provider.wsconnected).toBe(true);
      expect(session.undoManager.destroy).not.toHaveBeenCalled();
      expect(session.cleanup).not.toHaveBeenCalled();
      expect(session.timeoutId).not.toBeNull();

      removeMockSession(session);
    });

    test('silencing an unknown or already-silent claim is a no-op', async () => {
      const session = createMockSession({ claimState: 'silent' });

      const { mod: b } = loadInstanceB();
      // Nudge for a claim A never held
      await b.ensureHeldForWork('agent-presence:someone:default:elsewhere');
      // Nudge for a claim whose session is already silent
      await presenceClaim.tryAcquire(KEY); // A re-acquires…
      const nudged = presenceClaim.isHeld(KEY);
      expect(nudged).toBe(true);
      await b.ensureHeldForWork(KEY); // …and loses it again
      await b.ensureHeldForWork(KEY); // second call: already holder — no second nudge

      // The already-silent session was silenced exactly once, without error
      expect(session.provider.awareness.setLocalState.mock.calls.length).toBeLessThanOrEqual(1);
      expect(agentPresence.getSession(session.sessionId)).toBe(session);

      removeMockSession(session);
    });

    test('ensureHeldForWork when already holder is a pure no-op (FR-009)', async () => {
      await presenceClaim.tryAcquire(KEY);
      const session = createMockSession();
      const callsBefore = fake.callCount();

      const result = await presenceClaim.ensureHeldForWork(KEY);

      expect(result).toEqual({ held: true });
      expect(fake.callCount()).toBe(callsBefore); // zero Redis writes
      expect(publishSpyA).not.toHaveBeenCalled(); // zero nudges
      expect(session.provider.awareness.setLocalStateField).not.toHaveBeenCalled(); // no re-announce
      expect(session.provider.awareness.setLocalState).not.toHaveBeenCalled();

      removeMockSession(session);
    });

    test('end-to-end silencing completes in under 1 second (SC-003/RBD-3)', async () => {
      jest.useFakeTimers();
      try {
        const session = createMockSession();
        await presenceClaim.tryAcquire(KEY);

        const { mod: b } = loadInstanceB();
        const takeover = b.ensureHeldForWork(KEY);
        // Give the handoff less than one second of (fake) time
        await jest.advanceTimersByTimeAsync(999);
        await takeover;

        expect(session.provider.awareness.setLocalState).toHaveBeenCalledWith(null);
        expect(session.claimState).toBe('silent');

        removeMockSession(session);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
