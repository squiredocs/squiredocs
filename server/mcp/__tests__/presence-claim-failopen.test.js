/**
 * Fail-open postures of the presence-claim coordinator (feature 015, US4 —
 * FR-012/FR-013, RBD-2/RBD-5): Redis absent, erroring, hanging, recovering.
 */

// The "absent" posture must be tested with REDIS_HOST genuinely unset BEFORE
// any module loads (server/redis.js connects eagerly at require time when it
// is set — including the ambient value inside the dev pod).
delete process.env.REDIS_HOST;

const { createFakeClaimRedis } = require('./helpers/fake-claim-redis');
const presenceClaim = require('../presence-claim');

const KEY = 'agent-presence:user-1:default:doc-1';

describe('presence-claim fail-open', () => {
  afterEach(() => {
    presenceClaim._resetForTests();
    jest.useRealTimers();
  });

  describe('Redis absent (claims disabled, FR-012/SC-006)', () => {
    let neverClient;

    beforeEach(() => {
      presenceClaim._resetForTests();
      neverClient = new Proxy(
        {},
        {
          get() {
            throw new Error('disabled mode must never touch a Redis client');
          },
        }
      );
      presenceClaim._setDepsForTests({ getClient: () => neverClient });
      // deps.enabled stays the real isRedisEnabled() -> false (REDIS_HOST unset)
    });

    test('every API resolves holder-favoring with zero client calls and zero timers', async () => {
      jest.useFakeTimers();
      const timersBefore = jest.getTimerCount();

      expect(await presenceClaim.tryAcquire(KEY)).toBe(true);
      expect(await presenceClaim.ensureHeldForWork(KEY)).toEqual({ held: true });
      expect(presenceClaim.isHeld(KEY)).toBe(true);
      presenceClaim.startHeartbeat(KEY);
      await expect(presenceClaim.release(KEY)).resolves.toBeUndefined();

      expect(jest.getTimerCount()).toBe(timersBefore); // no op timers, no heartbeats
    });
  });

  describe('Redis configured but failing', () => {
    let fake;
    let onLost;
    let onAcquired;

    beforeEach(() => {
      presenceClaim._resetForTests();
      fake = createFakeClaimRedis();
      const pubsub = fake.makePubSubFor('instance-A');
      presenceClaim._setDepsForTests({
        enabled: () => true,
        getClient: () => fake.client,
        instanceId: () => 'instance-A',
        subscribeTakeover: (h) => pubsub.subscribeToPresenceClaims(h),
        publishTakeover: (k) => pubsub.publishPresenceClaimTakeover(k),
      });
      onLost = jest.fn();
      onAcquired = jest.fn();
      presenceClaim.init({ onLost, onAcquired });
    });

    test('erroring: APIs resolve holder-favoring, nothing rejects, transition logged once — not per op', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fake.failAll(true);

        expect(await presenceClaim.tryAcquire(KEY)).toBe(true); // fail-open: holder-favoring
        expect(presenceClaim.isHeld(KEY)).toBe(true);
        expect(await presenceClaim.ensureHeldForWork(KEY)).toEqual({ held: true });

        // Keep hammering ops on the same claim while Redis errors
        jest.useFakeTimers();
        presenceClaim.startHeartbeat(KEY);
        for (let i = 0; i < 3; i += 1) {
          await jest.advanceTimersByTimeAsync(5000);
        }
        jest.useRealTimers();

        const failOpenLogs = warnSpy.mock.calls.filter(
          (args) => typeof args[0] === 'string' && args[0].includes('fail-open enter')
        );
        expect(failOpenLogs.length).toBe(1); // once per transition, no log storm
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('release during an outage resolves without rejecting', async () => {
      fake.failAll(true);
      await presenceClaim.tryAcquire(KEY); // enters fail-open, behaves held

      await expect(presenceClaim.release(KEY)).resolves.toBeUndefined();
    });

    test('hanging: APIs resolve within AGENT_CLAIM_OP_TIMEOUT_MS and the late settlement is swallowed', async () => {
      jest.useFakeTimers();
      fake.hang(true);

      let resolved = null;
      const pending = presenceClaim.tryAcquire(KEY).then((v) => {
        resolved = v;
        return v;
      });

      // Just before the bound: still pending
      await jest.advanceTimersByTimeAsync(499);
      expect(resolved).toBeNull();

      // At the bound: resolves holder-favoring (RBD-5)
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(true);
      expect(presenceClaim.isHeld(KEY)).toBe(true);

      // The hung op settling later — even with an error — must not produce
      // an unhandled rejection
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        fake.settleHung(new Error('late failure'));
        await jest.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await Promise.resolve();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.removeListener('unhandledRejection', unhandled);
      }
    });

    test('recovery: after errors clear, claiming resumes and steady-state single-holder returns (SC-007)', async () => {
      const logSpy = jest.spyOn(console, 'log');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Outage: a tool call fails open and announces anyway (RBD-2)
        fake.failAll(true);
        expect(await presenceClaim.ensureHeldForWork(KEY)).toEqual({ held: true });
        expect(presenceClaim.isHeld(KEY)).toBe(true);
        expect(fake.peek(KEY)).toBeNull(); // the SET never landed

        jest.useFakeTimers();
        presenceClaim.startHeartbeat(KEY);

        // Redis comes back
        fake.failAll(false);

        // Next tick: the owner-checked refresh finds no key -> we were never
        // really the holder -> silence (bounded overlap ends)
        fake.advance(5000);
        await jest.advanceTimersByTimeAsync(5000);
        expect(onLost).toHaveBeenCalledWith(KEY);
        expect(
          logSpy.mock.calls.some(
            (args) => typeof args[0] === 'string' && args[0].includes('fail-open recover')
          )
        ).toBe(true);

        // Tick after that: the probe re-acquires and announces — the
        // steady-state single holder is back without operator action
        fake.advance(5000);
        await jest.advanceTimersByTimeAsync(5000);
        expect(onAcquired).toHaveBeenCalledWith(KEY);
        expect(fake.peek(KEY)).toBe('instance-A');
        expect(presenceClaim.isHeld(KEY)).toBe(true);
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });
});
