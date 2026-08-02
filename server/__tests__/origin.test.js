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
    // A bare string origin must be a UUID (feature 038 US3) — 'user-123' used to
    // be accepted here and is now a degraded parse, covered below.
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(parseOrigin(uuid)).toEqual({ userId: uuid, agentName: null });
    expect(parseOrigin(createOrigin('u', 'Repo Sync'))).toEqual({ userId: 'u', agentName: 'Repo Sync' });
  });
});

/**
 * Feature 038 US3 (FR-017). A malformed origin must degrade ATTRIBUTION and
 * shout — never make the caller skip persistence, never throw. Before this,
 * a non-UUID string flowed into the uuid `user_id` column, the INSERT failed,
 * retries exhausted, and the row was DROPPED while the update stayed live in
 * every connected browser: silent durable-history loss.
 */
describe('parseOrigin — malformed origins degrade loudly, never drop (feature 038 US3)', () => {
  let errorSpy;
  let warnSpy;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('(a) a valid UUID string is attributed, unchanged', () => {
    for (const uuid of [
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      '00000000-0000-0000-0000-000000000000',
      'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', // case-insensitive
    ]) {
      expect(parseOrigin(uuid)).toEqual({ userId: uuid, agentName: null });
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('(b) a non-UUID string degrades to unattributed + a flag, and logs loudly', () => {
    const result = parseOrigin('user-123');
    expect(result).toEqual({
      userId: null,
      agentName: null,
      malformedOrigin: 'non-uuid-string',
    });
    // The signal must name the rejected value so the caller is findable.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('user-123');
  });

  test('(b) validation is STRICT — almost-UUIDs are rejected, not tolerated', () => {
    const almost = [
      '3f2504e0-4f89-41d3-9a0c-0305e82c330',    // too short
      '3f2504e0-4f89-41d3-9a0c-0305e82c33011',  // too long
      '3f2504e0-4f89-41d3-9a0c-0305e82c330g',   // non-hex character
      '3f2504e04f8941d39a0c0305e82c3301',       // no hyphens
      '3f2504e0-4f89-41d3-9a0c0305e82c3301',    // missing a hyphen
      ' 3f2504e0-4f89-41d3-9a0c-0305e82c3301',  // leading space
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301 ',  // trailing space
      '{3f2504e0-4f89-41d3-9a0c-0305e82c3301}', // braced form
      '',
    ];
    for (const value of almost) {
      expect(parseOrigin(value)).toEqual({
        userId: null, agentName: null, malformedOrigin: 'non-uuid-string',
      });
    }
  });

  test('(c) an object with neither userId nor agentName is an unrecognized shape', () => {
    const result = parseOrigin({ someOtherField: 1 });
    expect(result).toEqual({
      userId: null,
      agentName: null,
      malformedOrigin: 'unrecognized-object',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('(d) explicit nulls and ws-shaped objects are RECOGNIZED, never flagged', () => {
    // `in`-checks, not truthiness: "present but null" means unattributed, which
    // is a legitimate answer, not a malformation.
    for (const origin of [
      { userId: null },
      { agentName: null },
      { userId: null, agentName: null },
      createOrigin(null, null),
      { userId: 'u1', agentName: null },                 // ws-shaped
      Object.assign(Object.create(null), { userId: 'u2' }), // null-prototype ws-like
    ]) {
      const result = parseOrigin(origin);
      expect(result).not.toHaveProperty('malformedOrigin');
      expect(result).toEqual({
        userId: origin.userId ?? null,
        agentName: origin.agentName ?? null,
      });
    }
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('(e) all five sentinels still return null — the skip-list runs first', () => {
    expect(parseOrigin(ORIGIN_DB_LOAD)).toBeNull();
    expect(parseOrigin(ORIGIN_REDIS)).toBeNull();
    expect(parseOrigin(ORIGIN_SYNC_PUSH)).toBeNull();          // string form
    expect(parseOrigin(createSyncPushOrigin('push-1'))).toBeNull(); // branded object form
    expect(parseOrigin(ORIGIN_INVERSE_APPLY)).toBeNull();
    expect(parseOrigin(ORIGIN_RESTORE)).toBeNull();
    // Sentinels are non-UUID strings; they must NOT be reported as malformed.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('never throws, whatever it is handed', () => {
    for (const origin of [
      null, undefined, 0, 1, NaN, true, false, Symbol('s'), 123n,
      [], [1, 2], () => {}, new Date(), new Map(), /re/,
      Object.create(null), { toString() { throw new Error('boom'); } },
    ]) {
      expect(() => parseOrigin(origin)).not.toThrow();
    }
  });

  // ── Feature 041 (FR-017, SC-010, RBD-041-9) ──────────────────────────────
  // This fallback used to return a clean-looking unattributed result with no
  // marker and no log — indistinguishable from a legitimately unattributed row.
  // A server-side caller that stopped passing an origin down the attribution
  // path would accumulate anonymous rows in total silence, which is exactly the
  // kind of invisible degradation the attribution system cannot afford.
  test('041 FR-017: null/undefined/primitive origins are MARKED and logged, still unattributed', () => {
    for (const origin of [null, undefined, 42, 0, true, false, NaN]) {
      errorSpy.mockClear();
      const result = parseOrigin(origin);
      expect(result).toEqual({
        userId: null,
        agentName: null,
        malformedOrigin: 'null-or-primitive',
      });
      // Persisting unattributed is deliberate: attribution is recoverable, a
      // dropped update is not.
      expect(result.userId).toBeNull();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain(`typeof=${typeof origin}`);
    }
  });

  test('041 FR-017: the marker is a distinct class — object and string malformations keep theirs', () => {
    expect(parseOrigin('user-123').malformedOrigin).toBe('non-uuid-string');
    expect(parseOrigin({ someOtherField: 1 }).malformedOrigin).toBe('unrecognized-object');
    expect(parseOrigin(null).malformedOrigin).toBe('null-or-primitive');
  });

  test('041 FR-017: the loud fallback still never throws on an exotic primitive', () => {
    expect(() => parseOrigin(Symbol('s'))).not.toThrow();
    expect(() => parseOrigin(123n)).not.toThrow();
    expect(parseOrigin(Symbol('s')).malformedOrigin).toBe('null-or-primitive');
  });
});

// The bindState listener is the one persistence-path consumer of the marker.
// Feature 041 (FR-017) extends its page from 'non-uuid-string' to the
// null/primitive class; 'unrecognized-object' stays warn-only.
describe('041 FR-017: bindState notification routing by malformed class', () => {
  /** Mirror of the notification branch in server/index.js's update listener. */
  function pageIfMalformed(parsed, notify) {
    if (parsed.malformedOrigin === 'non-uuid-string' || parsed.malformedOrigin === 'null-or-primitive') {
      notify(new Error(`Malformed transaction origin (${parsed.malformedOrigin}) — persisting unattributed`), {
        source: 'origin-parsing',
        extra: { malformedOrigin: parsed.malformedOrigin },
      });
    }
  }

  let errorSpy;
  let warnSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('a null origin pages exactly like a non-UUID string, and the row still persists unattributed', () => {
    const notify = jest.fn();
    const parsed = parseOrigin(null);

    pageIfMalformed(parsed, notify);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1].source).toBe('origin-parsing');
    expect(notify.mock.calls[0][1].extra.malformedOrigin).toBe('null-or-primitive');
    // Attribution degraded, persistence unaffected: the listener continues.
    expect(parsed.userId).toBeNull();
    expect(parsed.agentName).toBeNull();
  });

  test('an unrecognized object still does NOT page (warn-only, unchanged)', () => {
    const notify = jest.fn();
    pageIfMalformed(parseOrigin({ nope: 1 }), notify);
    expect(notify).not.toHaveBeenCalled();
  });

  test('a well-formed origin pages nothing', () => {
    const notify = jest.fn();
    pageIfMalformed(parseOrigin('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), notify);
    pageIfMalformed(parseOrigin({ userId: 'u1', agentName: 'A' }), notify);
    expect(notify).not.toHaveBeenCalled();
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
