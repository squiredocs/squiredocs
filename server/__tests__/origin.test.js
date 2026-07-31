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
  ORIGIN_RESTORE,
  createOrigin,
  createSyncPushOrigin,
  isSyncPushOrigin,
  parseOrigin,
} = require('../origin');

// Mirrors the redisUpdateHandler skip-list in server/index.js exactly: publish
// everything EXCEPT Redis (feedback loop) and DB-load (already everywhere).
function shouldPublishToRedis(origin) {
  return origin !== ORIGIN_REDIS && origin !== ORIGIN_DB_LOAD;
}

describe('origin sentinels', () => {
  test('the five sentinels are distinct string values', () => {
    const set = new Set([
      ORIGIN_DB_LOAD, ORIGIN_REDIS, ORIGIN_SYNC_PUSH, ORIGIN_INVERSE_APPLY, ORIGIN_RESTORE,
    ]);
    expect(set.size).toBe(5);
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

describe('per-push sync origins (037 LOW-3)', () => {
  // Two pushes to one document overlap freely, so the changed-range observer
  // needs origins it can tell apart. Every OTHER consumer must keep treating a
  // per-push origin exactly like the shared sentinel — that is the whole risk
  // of the shape, so it is asserted here rather than left to inspection.
  test('each push gets its own identity, all recognised as sync pushes', () => {
    const a = createSyncPushOrigin('a');
    const b = createSyncPushOrigin('b');
    expect(a).not.toBe(b);
    expect(isSyncPushOrigin(a)).toBe(true);
    expect(isSyncPushOrigin(b)).toBe(true);
    // The legacy string sentinel is still a sync push…
    expect(isSyncPushOrigin(ORIGIN_SYNC_PUSH)).toBe(true);
    // …and nothing else is.
    expect(isSyncPushOrigin(ORIGIN_REDIS)).toBe(false);
    expect(isSyncPushOrigin(createOrigin('u', 'Repo Sync'))).toBe(false);
    expect(isSyncPushOrigin(null)).toBe(false);
    expect(isSyncPushOrigin({})).toBe(false);
  });

  test('a per-push origin routes exactly like the sentinel: no re-store, still published', () => {
    const origin = createSyncPushOrigin('doc-1');
    // F3, unchanged: the push is already stored as its one attributed row.
    expect(parseOrigin(origin)).toBeNull();
    // …and still fans out to instances holding the doc.
    expect(shouldPublishToRedis(origin)).toBe(true);
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

describe('ORIGIN_RESTORE — F2 version restore (store-then-apply)', () => {
  // restoreVersion stores the one attributed restore-delta row via storeUpdate
  // FIRST, then applies it to the live shared doc with this sentinel. Same
  // treatment as sync-push/inverse: bindState listener must skip it (storeUpdate
  // allocates a fresh clock every call and never content-dedupes, so a parseable
  // origin would persist the delta a SECOND time), yet it must fan out to Redis.
  test('parseOrigin returns null (bindState listener never double-stores a restore)', () => {
    expect(parseOrigin(ORIGIN_RESTORE)).toBeNull();
  });

  test('NOT on the Redis publish skip-list (restore fans out cross-instance)', () => {
    expect(shouldPublishToRedis(ORIGIN_RESTORE)).toBe(true);
  });

  test('suppressed from persistence AND published to Redis, together', () => {
    expect(parseOrigin(ORIGIN_RESTORE)).toBeNull();
    expect(shouldPublishToRedis(ORIGIN_RESTORE)).toBe(true);
  });
});
