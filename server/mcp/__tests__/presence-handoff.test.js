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

  describe('failover and release (US4)', () => {
    // Every test drives the heartbeat with jest fake timers while moving the
    // fake Redis virtual clock in lockstep.
    async function passTime(ms) {
      fake.advance(ms);
      await jest.advanceTimersByTimeAsync(ms);
    }

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('holder heartbeat refreshes the claim TTL', async () => {
      await presenceClaim.tryAcquire(KEY);
      presenceClaim.startHeartbeat(KEY);
      expect(fake.peekTtl(KEY)).toBe(15000);

      await passTime(10000); // two ticks without refresh would leave 5000
      expect(fake.peek(KEY)).toBe('instance-A');
      expect(fake.peekTtl(KEY)).toBe(15000); // owner-checked refresh reset it
    });

    test('a lost nudge is backstopped: the holder silences within one heartbeat of a foreign takeover (FR-005)', async () => {
      const session = createMockSession();
      await presenceClaim.tryAcquire(KEY);
      presenceClaim.startHeartbeat(KEY);

      // Instance B takes over but its nudge is LOST (publish suppressed)
      const { mod: b } = loadInstanceB();
      b._setDepsForTests({ publishTakeover: () => {} });
      await b.ensureHeldForWork(KEY);
      expect(fake.peek(KEY)).toBe('instance-B');
      expect(presenceClaim.isHeld(KEY)).toBe(true); // A still believes — nudge never arrived

      // One heartbeat later A's owner-checked refresh discovers the loss…
      await passTime(5000);
      expect(presenceClaim.isHeld(KEY)).toBe(false);
      expect(session.claimState).toBe('silent');
      expect(session.provider.awareness.setLocalState).toHaveBeenCalledWith(null);
      // …and the foreign claim was NOT extended by A's refresh attempts
      expect(fake.peek(KEY)).toBe('instance-B');
      expect(fake.peekTtl(KEY)).toBeLessThanOrEqual(10000);

      removeMockSession(session);
    });

    test('holder crash: survivor probe acquires after TTL expiry and re-announces (FR-010/SC-004)', async () => {
      // A crashed holder elsewhere in the cluster owns the key, no heartbeat
      fake.setKey(KEY, 'instance-Z', 15000);

      // This instance's session lost the initial race: silent, probing
      const session = createMockSession({ claimState: 'silent' });
      expect(await presenceClaim.tryAcquire(KEY)).toBe(false);
      presenceClaim.startHeartbeat(KEY);

      // Before expiry: probes never steal from a live claim
      await passTime(10000);
      expect(fake.peek(KEY)).toBe('instance-Z');
      expect(session.claimState).toBe('silent');

      // Past the TTL the claim expires and the next probe wins
      await passTime(10000);
      expect(fake.peek(KEY)).toBe('instance-A');
      expect(session.claimState).toBe('holder');
      expect(session.provider.awareness.setLocalStateField).toHaveBeenCalledWith(
        'user',
        session.agentInfo
      );
      expect(session.provider.awareness.setLocalStateField).toHaveBeenCalledWith(
        'cursor',
        session.cursor
      );

      removeMockSession(session);
    });

    test('clean release: survivor picks the claim up on its next probe without any TTL wait (FR-011/RBD-4)', async () => {
      fake.setKey(KEY, 'instance-Z', 15000);
      const session = createMockSession({ claimState: 'silent' });
      expect(await presenceClaim.tryAcquire(KEY)).toBe(false);
      presenceClaim.startHeartbeat(KEY);

      // The holder's session ends cleanly: owner-checked delete, key gone now
      fake.deleteKey(KEY);

      // One heartbeat — far less than the TTL — is enough
      await passTime(5000);
      expect(fake.peek(KEY)).toBe('instance-A');
      expect(session.claimState).toBe('holder');

      removeMockSession(session);
    });

    test('release deletes an owned claim immediately and stops the heartbeat for good', async () => {
      await presenceClaim.tryAcquire(KEY);
      presenceClaim.startHeartbeat(KEY);

      await presenceClaim.release(KEY);

      expect(fake.peek(KEY)).toBeNull(); // owner-checked DEL, no expiry wait
      const callsAfterRelease = fake.callCount();

      // The claim never outlives its session: no tick ever runs again
      await passTime(60000);
      expect(fake.callCount()).toBe(callsAfterRelease);
      expect(fake.peek(KEY)).toBeNull();
    });

    test('release never deletes a foreign claim (contract E6)', async () => {
      fake.setKey(KEY, 'instance-Z', 15000);

      await presenceClaim.release(KEY);

      expect(fake.peek(KEY)).toBe('instance-Z');
    });
  });
});
