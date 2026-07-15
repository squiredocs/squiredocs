/**
 * Feature 010, US1 (FR-002/003, SC-002): the shutdown deadline force-exits even
 * when a drain step wedges; SIGINT runs the same routine; a second signal
 * mid-drain is ignored.
 */
const { createShutdown } = require('../shutdown');
const lifecycle = require('../lifecycle');

function silentLogger() {
  return { log: () => {}, error: () => {} };
}

function wedgedShutdown(exit, deadlineMs = 20_000) {
  return createShutdown({
    lifecycle,
    wss: { clients: new Set() },
    // Never resolves — simulates a stuck flush / teardown.
    flushPendingWrites: () => new Promise(() => {}),
    redisPubSub: { cleanup: async () => {} },
    persistenceProvider: { destroy: async () => {} },
    closeRedis: async () => {},
    server: { listening: true, close: () => {} },
    deadlineMs,
    exit,
    logger: silentLogger(),
  });
}

describe('graceful shutdown — deadline & signal handling (FR-002/003)', () => {
  beforeEach(() => {
    lifecycle._reset();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('force-exits at SHUTDOWN_DEADLINE_MS when the flush wedges', async () => {
    const exit = jest.fn();
    const runShutdown = wedgedShutdown(exit, 20_000);

    runShutdown('SIGTERM'); // wedged — do not await
    await Promise.resolve(); // let the synchronous prefix run up to the await

    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(19_999);
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('SIGINT runs the same routine (deadline backstop still fires)', async () => {
    const exit = jest.fn();
    const runShutdown = wedgedShutdown(exit, 20_000);
    runShutdown('SIGINT');
    await Promise.resolve();
    jest.advanceTimersByTime(20_000);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ignores a second signal received mid-drain (FR-002)', async () => {
    const exit = jest.fn();
    const runShutdown = wedgedShutdown(exit, 20_000);

    runShutdown('SIGTERM');     // begins draining, wedges
    await Promise.resolve();
    await runShutdown('SIGINT'); // second signal — must be a no-op

    // Only the first drain armed a deadline timer; the second returned early.
    jest.advanceTimersByTime(20_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('lifecycle.beginDraining is the idempotent guard', () => {
    lifecycle._reset();
    expect(lifecycle.isDraining()).toBe(false);
    expect(lifecycle.beginDraining()).toBe(true);
    expect(lifecycle.isDraining()).toBe(true);
    expect(lifecycle.beginDraining()).toBe(false); // second call ignored
  });
});
