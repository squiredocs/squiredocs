/**
 * Multi-instance simulation (feature 015): two REAL copies of
 * presence-claim.js (separate module registries via jest.isolateModules,
 * distinct instance IDs) pointed at ONE fake Redis + one bridged pub/sub
 * bus — an honest stand-in for two pods sharing a cluster (research R8).
 *
 * Part 1 (US1): atomic first claim — one winner (FR-002); independent claims
 * per (user, agent, doc).
 * Part 2 (US2): work-follows-the-claim across alternating tool calls —
 * at most one holder at every steady-state point (SC-001/SC-002).
 */
const { createFakeClaimRedis } = require('./helpers/fake-claim-redis');

// The isolated module copies still require server/redis at load; mock it so
// no real connection is ever attempted (all deps are overridden anyway).
jest.mock('../../redis', () => ({
  getRedisClient: () => {
    throw new Error('multi-instance tests must inject the fake client');
  },
  createPubSubClient: () => null,
  isRedisEnabled: () => false,
}));

const KEY = 'agent-presence:user-1:default:doc-1';

/**
 * Load an isolated presence-claim module copy wired to the shared fake
 * under its own instance identity.
 */
function loadInstance(fake, instanceId, callbacks = {}) {
  let mod;
  jest.isolateModules(() => {
    mod = require('../presence-claim');
  });
  const pubsub = fake.makePubSubFor(instanceId);
  mod._setDepsForTests({
    enabled: () => true,
    getClient: () => fake.client,
    instanceId: () => instanceId,
    subscribeTakeover: (h) => pubsub.subscribeToPresenceClaims(h),
    publishTakeover: (k) => pubsub.publishPresenceClaimTakeover(k),
  });
  mod.init(callbacks);
  return mod;
}

describe('presence-claim multi-instance simulation', () => {
  let fake;
  let instances;

  beforeEach(() => {
    fake = createFakeClaimRedis();
    instances = [];
  });

  afterEach(() => {
    for (const mod of instances) mod._resetForTests();
  });

  function spawn(instanceId, callbacks) {
    const mod = loadInstance(fake, instanceId, callbacks);
    instances.push(mod);
    return mod;
  }

  describe('US1: atomic first claim', () => {
    test('simultaneous first tryAcquire for the same key yields exactly one winner', async () => {
      const a = spawn('instance-A');
      const b = spawn('instance-B');

      const [resA, resB] = await Promise.all([a.tryAcquire(KEY), b.tryAcquire(KEY)]);

      // Exactly one winner (FR-002, spec edge "simultaneous first tool calls")
      expect([resA, resB].filter(Boolean).length).toBe(1);

      const winner = resA ? 'instance-A' : 'instance-B';
      expect(fake.peek(KEY)).toBe(winner);

      // Local beliefs agree: exactly one instance believes it holds the claim
      const held = [a.isHeld(KEY), b.isHeld(KEY)];
      expect(held.filter(Boolean).length).toBe(1);
      expect(resA ? held[0] : held[1]).toBe(true);
    });

    test('alternating tool calls across instances: at most one holder at every steady point (US2)', async () => {
      // Each simulated instance mirrors agent-presence's wiring: a "session"
      // whose announce state follows the claim (announce after
      // ensureHeldForWork, full-state silence on onLost).
      const sessions = {
        'instance-A': { announcing: false },
        'instance-B': { announcing: false },
      };
      const a = spawn('instance-A', {
        onLost: () => {
          sessions['instance-A'].announcing = false;
        },
      });
      const b = spawn('instance-B', {
        onLost: () => {
          sessions['instance-B'].announcing = false;
        },
      });
      const mods = { 'instance-A': a, 'instance-B': b };

      const activityLog = [];
      async function toolCall(instanceId) {
        const result = await mods[instanceId].ensureHeldForWork(KEY);
        expect(result).toEqual({ held: true });
        // The executing instance announces + emits the call's activity
        // (mirrors getOrCreateSession after the claim resolves)
        expect(mods[instanceId].isHeld(KEY)).toBe(true);
        sessions[instanceId].announcing = true;
        activityLog.push(instanceId);
      }

      function assertSteadyState(expectedHolder) {
        // Exactly one holder across the cluster (SC-001)
        const holders = ['instance-A', 'instance-B'].filter((id) => mods[id].isHeld(KEY));
        expect(holders).toEqual([expectedHolder]);
        // Never both announcing beyond the (synchronous) nudge hop (SC-003)
        const announcing = ['instance-A', 'instance-B'].filter(
          (id) => sessions[id].announcing
        );
        expect(announcing).toEqual([expectedHolder]);
        expect(fake.peek(KEY)).toBe(expectedHolder);
      }

      // A rapid conversation alternating between instances
      const callSequence = [
        'instance-A',
        'instance-B',
        'instance-A',
        'instance-A', // repeat on the holder: no handoff
        'instance-B',
        'instance-A',
        'instance-B',
        'instance-B',
      ];
      for (const instanceId of callSequence) {
        await toolCall(instanceId);
        assertSteadyState(instanceId);
      }

      // Every tool call emitted its activity from the executing instance (SC-002)
      expect(activityLog).toEqual(callSequence);
    });

    test('repeat calls on the holder publish no nudges and do not disturb the claim (FR-009)', async () => {
      const a = spawn('instance-A');
      await a.ensureHeldForWork(KEY);
      const callsAfterTakeover = fake.callCount();

      await a.ensureHeldForWork(KEY);
      await a.ensureHeldForWork(KEY);

      expect(fake.callCount()).toBe(callsAfterTakeover); // zero further Redis ops
      expect(fake.peek(KEY)).toBe('instance-A');
    });

    test('same user+agent on two docs holds two independent claims', async () => {
      const a = spawn('instance-A');
      const b = spawn('instance-B');
      const keyDoc1 = 'agent-presence:user-1:default:doc-1';
      const keyDoc2 = 'agent-presence:user-1:default:doc-2';

      expect(await a.tryAcquire(keyDoc1)).toBe(true);
      expect(await b.tryAcquire(keyDoc2)).toBe(true);

      // Both hold their own doc's claim; neither holds the other's (US1-3:
      // dedup never merges or suppresses across distinct combinations)
      expect(a.isHeld(keyDoc1)).toBe(true);
      expect(b.isHeld(keyDoc2)).toBe(true);
      expect(a.isHeld(keyDoc2)).toBe(false);
      expect(b.isHeld(keyDoc1)).toBe(false);
      expect(fake.peek(keyDoc1)).toBe('instance-A');
      expect(fake.peek(keyDoc2)).toBe('instance-B');
    });
  });
});
