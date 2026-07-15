/**
 * Feature 010 review F3: PostgresPersistence.ping() must never hold a pool client
 * past the check. The old connect()+manual-release raced the timeout against
 * pool.connect(), leaking a client whenever connect resolved AFTER the timeout
 * (a 2s–5s window) and releasing while SELECT 1 was still in flight — under an
 * unauthenticated, probe-hammered /ready that exhausted DB_POOL_MAX. The fix
 * uses pool.query, which acquires and ALWAYS releases its client when the query
 * settles, even after ping() has already timed out and returned false.
 *
 * These tests drive ping() against a fake pool that models pg's checkout/checkin
 * so no real database is required.
 */
const { PostgresPersistence } = require('../postgres-persistence');

// A fake pool whose query() checks out a client, resolves after `queryMs`, and
// checks it back in — mirroring pg.Pool.query's acquire→run→release.
function makeTrackingPool(queryMs) {
  let checkedOut = 0;
  let peak = 0;
  return {
    query() {
      checkedOut++;
      peak = Math.max(peak, checkedOut);
      return new Promise((resolve) => {
        setTimeout(() => {
          checkedOut--;
          resolve({ rows: [{ '?column?': 1 }] });
        }, queryMs);
      });
    },
    // pool.connect must never be called by the fixed ping().
    connect() { throw new Error('ping() must not call pool.connect()'); },
    stats: () => ({ checkedOut, peak }),
  };
}

function withFakePool(pool) {
  // Construct against a dummy DSN (no connection is opened) then swap the pool.
  const p = new PostgresPersistence('postgres://u:p@localhost:5432/nope');
  p.pool = pool;
  return p;
}

describe('PostgresPersistence.ping() — pool client release (review F3)', () => {
  it('returns true when the query answers within the deadline', async () => {
    const pool = makeTrackingPool(1);
    const p = withFakePool(pool);
    await expect(p.ping(200)).resolves.toBe(true);
    // Let the (fast) query settle, then assert the client came back.
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.stats().checkedOut).toBe(0);
  });

  it('returns false when the query outlasts the deadline (datastore slow/down)', async () => {
    const pool = makeTrackingPool(100);
    const p = withFakePool(pool);
    await expect(p.ping(20)).resolves.toBe(false);
  });

  it('releases the client on every timed-out ping — pool is not exhausted', async () => {
    // Slow queries (60ms) with a short ping deadline (10ms): every ping times out
    // and returns false, but each underlying query must still release its client.
    const pool = makeTrackingPool(60);
    const p = withFakePool(pool);

    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, () => p.ping(10))
    );
    // All timed out.
    expect(results.every((r) => r === false)).toBe(true);
    // At the peak, more than a bounded pool's worth were briefly checked out...
    expect(pool.stats().peak).toBeGreaterThan(1);

    // ...but after the slow queries settle, EVERY client is released — no leak.
    await new Promise((r) => setTimeout(r, 120));
    expect(pool.stats().checkedOut).toBe(0);

    // The pool is still usable afterward (a fresh ping succeeds).
    const fast = withFakePool(makeTrackingPool(1));
    await expect(fast.ping(200)).resolves.toBe(true);
  });

  it('never calls pool.connect() (no manually-managed client to leak)', async () => {
    const pool = makeTrackingPool(1);
    const connectSpy = jest.spyOn(pool, 'connect');
    const p = withFakePool(pool);
    await p.ping(200);
    expect(connectSpy).not.toHaveBeenCalled();
  });
});
