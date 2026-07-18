/**
 * Presence-claim coordinator: claim lifecycle against the in-memory fake
 * Redis (feature 015, US1 — FR-001/FR-002/FR-012).
 */
const { createFakeClaimRedis } = require('./helpers/fake-claim-redis');
const presenceClaim = require('../presence-claim');

const INSTANCE_A = 'instance-A';
const KEY = 'agent-presence:user-1:default:doc-1';

describe('presence-claim', () => {
  let fake;

  function wireFake(instanceId = INSTANCE_A) {
    const pubsub = fake.makePubSubFor(instanceId);
    presenceClaim._setDepsForTests({
      enabled: () => true,
      getClient: () => fake.client,
      instanceId: () => instanceId,
      subscribeTakeover: (h) => pubsub.subscribeToPresenceClaims(h),
      publishTakeover: (k) => pubsub.publishPresenceClaimTakeover(k),
    });
  }

  beforeEach(() => {
    presenceClaim._resetForTests();
    fake = createFakeClaimRedis();
    wireFake();
  });

  afterEach(() => {
    presenceClaim._resetForTests();
  });

  describe('buildClaimKey', () => {
    test('matches the FR-001 shape', () => {
      expect(presenceClaim.buildClaimKey('u1', 'agent-x', 'd1')).toBe(
        'agent-presence:u1:agent-x:d1'
      );
    });

    test('agentId falls back to default', () => {
      expect(presenceClaim.buildClaimKey('u1', undefined, 'd1')).toBe(
        'agent-presence:u1:default:d1'
      );
      expect(presenceClaim.buildClaimKey('u1', null, 'd1')).toBe('agent-presence:u1:default:d1');
    });
  });

  describe('tryAcquire', () => {
    test('sets the claim key with NX + PX and this instance ID', async () => {
      const acquired = await presenceClaim.tryAcquire(KEY);

      expect(acquired).toBe(true);
      expect(fake.peek(KEY)).toBe(INSTANCE_A);
      expect(fake.peekTtl(KEY)).toBe(15000); // AGENT_CLAIM_TTL_MS default
      expect(fake.calls[fake.calls.length - 1]).toEqual([
        'set',
        KEY,
        INSTANCE_A,
        'PX',
        15000,
        'NX',
      ]);
    });

    test('returns false when the key is held by another instance', async () => {
      fake.setKey(KEY, 'instance-B', 15000);

      const acquired = await presenceClaim.tryAcquire(KEY);

      expect(acquired).toBe(false);
      expect(fake.peek(KEY)).toBe('instance-B'); // untouched
    });

    test('isHeld reflects local belief', async () => {
      expect(presenceClaim.isHeld(KEY)).toBe(false);

      await presenceClaim.tryAcquire(KEY);
      expect(presenceClaim.isHeld(KEY)).toBe(true);

      // A key we never acquired
      expect(presenceClaim.isHeld('agent-presence:other:default:doc')).toBe(false);
    });

    test('a winning acquire logs one [presence-claim] transition with key and instance (FR-016)', async () => {
      const logSpy = jest.spyOn(console, 'log');
      try {
        await presenceClaim.tryAcquire(KEY);
        const lines = logSpy.mock.calls
          .map((args) => args[0])
          .filter((line) => typeof line === 'string' && line.startsWith('[presence-claim]'));
        expect(lines).toEqual([`[presence-claim] acquired key=${KEY} instance=${INSTANCE_A}`]);
      } finally {
        logSpy.mockRestore();
      }
    });

    test('losing an acquire leaves local belief not-held', async () => {
      fake.setKey(KEY, 'instance-B', 15000);

      await presenceClaim.tryAcquire(KEY);

      expect(presenceClaim.isHeld(KEY)).toBe(false);
    });

    test('distinct claim keys are independent', async () => {
      const keyOther = 'agent-presence:user-1:default:doc-2';
      fake.setKey(keyOther, 'instance-B', 15000);

      expect(await presenceClaim.tryAcquire(KEY)).toBe(true);
      expect(await presenceClaim.tryAcquire(keyOther)).toBe(false);

      expect(presenceClaim.isHeld(KEY)).toBe(true);
      expect(presenceClaim.isHeld(keyOther)).toBe(false);
    });
  });

  describe('disabled mode (no Redis coordination configured)', () => {
    beforeEach(() => {
      presenceClaim._setDepsForTests({ enabled: () => false });
    });

    test('tryAcquire and isHeld answer holder-favoring with zero Redis calls', async () => {
      expect(await presenceClaim.tryAcquire(KEY)).toBe(true);
      expect(presenceClaim.isHeld(KEY)).toBe(true);
      expect(presenceClaim.isHeld('agent-presence:any:default:thing')).toBe(true);
      expect(fake.callCount()).toBe(0);
    });
  });
});
