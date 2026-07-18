/**
 * Origin routing (server/origin.js).
 *
 * Focuses on the F3 contract for ORIGIN_SYNC_PUSH: it must be a persistence
 * sentinel (parseOrigin → null, so the bindState listener never re-stores a
 * two-way-sync push) YET remain publishable to Redis (so other instances that
 * have the doc loaded receive the push via cross-instance fan-out).
 */
const {
  ORIGIN_DB_LOAD,
  ORIGIN_REDIS,
  ORIGIN_SYNC_PUSH,
  ORIGIN_INVERSE_APPLY,
  createOrigin,
  parseOrigin,
} = require('../origin');

// Mirrors the redisUpdateHandler skip-list in server/index.js exactly: publish
// everything EXCEPT Redis (feedback loop) and DB-load (already everywhere).
function shouldPublishToRedis(origin) {
  return origin !== ORIGIN_REDIS && origin !== ORIGIN_DB_LOAD;
}

describe('origin sentinels', () => {
  test('the four sentinels are distinct string values', () => {
    const set = new Set([ORIGIN_DB_LOAD, ORIGIN_REDIS, ORIGIN_SYNC_PUSH, ORIGIN_INVERSE_APPLY]);
    expect(set.size).toBe(4);
  });
});

describe('parseOrigin — persistence listener routing', () => {
  test('all persistence sentinels return null (bindState listener skips them)', () => {
    expect(parseOrigin(ORIGIN_DB_LOAD)).toBeNull();
    expect(parseOrigin(ORIGIN_REDIS)).toBeNull();
    // F3: a sync push is already stored as its one attributed row, so the
    // persistence listener must NOT write a second, unattributed one.
    expect(parseOrigin(ORIGIN_SYNC_PUSH)).toBeNull();
  });

  test('real origins still parse to attribution', () => {
    expect(parseOrigin('user-123')).toEqual({ userId: 'user-123', agentName: null });
    expect(parseOrigin(createOrigin('u', 'Repo Sync'))).toEqual({ userId: 'u', agentName: 'Repo Sync' });
  });
});

describe('Redis publish predicate — F3 fan-out routing', () => {
  test('DB-load and Redis are suppressed; a sync push IS published', () => {
    expect(shouldPublishToRedis(ORIGIN_DB_LOAD)).toBe(false);
    expect(shouldPublishToRedis(ORIGIN_REDIS)).toBe(false);
    // The crux of F3: unlike ORIGIN_DB_LOAD (which sync used before), a sync
    // push is publishable, so other instances holding the doc see it.
    expect(shouldPublishToRedis(ORIGIN_SYNC_PUSH)).toBe(true);
  });

  test('the two routings together: suppressed from persistence, published to Redis', () => {
    // This is the exact combination F3 requires — no double-store, yet fanned out.
    expect(parseOrigin(ORIGIN_SYNC_PUSH)).toBeNull();
    expect(shouldPublishToRedis(ORIGIN_SYNC_PUSH)).toBe(true);
  });
});

describe('ORIGIN_INVERSE_APPLY — feature 016 log-derived undo (research R3)', () => {
  // A log-derived inverse is stored FIRST (one attributed row via storeUpdate)
  // and then applied to the live shared doc with this sentinel — byte-for-byte
  // the ORIGIN_SYNC_PUSH treatment: the bindState persistence listener must
  // skip it (no unattributed double-store), yet the Redis publisher must fan
  // it out so other instances holding the doc see the reversion live.
  test('parseOrigin returns null (bindState listener never double-stores an inverse)', () => {
    expect(parseOrigin(ORIGIN_INVERSE_APPLY)).toBeNull();
  });

  test('NOT on the Redis publish skip-list (inverse fans out cross-instance)', () => {
    expect(shouldPublishToRedis(ORIGIN_INVERSE_APPLY)).toBe(true);
  });

  test('suppressed from persistence AND published to Redis, together', () => {
    expect(parseOrigin(ORIGIN_INVERSE_APPLY)).toBeNull();
    expect(shouldPublishToRedis(ORIGIN_INVERSE_APPLY)).toBe(true);
  });
});
