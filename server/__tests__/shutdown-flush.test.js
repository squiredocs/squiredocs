/**
 * Feature 010, US1 (FR-004, SC-001): the graceful-shutdown routine awaits all
 * in-flight Yjs persistence before exit, so an edit accepted just before the
 * drain is persisted rather than lost.
 */
const { createShutdown } = require('../shutdown');
const lifecycle = require('../lifecycle');

function silentLogger() {
  return { log: () => {}, error: () => {} };
}

describe('graceful shutdown — pending-write flush (FR-004)', () => {
  beforeEach(() => lifecycle._reset());

  it('awaits pending persistence, so a pre-drain edit is persisted before exit', async () => {
    // A write that resolves on the next turn, recording into "persisted state".
    const persisted = [];
    let resolveWrite;
    const writePromise = new Promise((r) => { resolveWrite = r; })
      .then(() => { persisted.push('edit-just-before-drain'); });

    const pendingWrites = new Set([writePromise]);
    const flushPendingWrites = () => Promise.allSettled([...pendingWrites]);

    const exit = jest.fn();
    const order = [];
    const runShutdown = createShutdown({
      lifecycle,
      wss: { clients: new Set() },
      flushPendingWrites: async () => { await flushPendingWrites(); order.push('flushed'); },
      redisPubSub: { cleanup: async () => { order.push('redis-cleanup'); } },
      persistenceProvider: { destroy: async () => { order.push('pg-destroy'); } },
      closeRedis: async () => { order.push('redis-close'); },
      server: { listening: false, close: (cb) => cb() },
      deadlineMs: 10_000,
      exit: (code) => { order.push('exit:' + code); exit(code); },
      logger: silentLogger(),
    });

    const p = runShutdown('SIGTERM');
    // The write is still pending at drain time; let it resolve.
    resolveWrite();
    await p;

    // The edit made it to persisted state, and exit happened after the flush
    // and the ordered teardown.
    expect(persisted).toContain('edit-just-before-drain');
    expect(exit).toHaveBeenCalledWith(0);
    expect(order).toEqual([
      'flushed', 'redis-cleanup', 'pg-destroy', 'redis-close', 'exit:0',
    ]);
  });

  it('closes live WS sessions with 1001 before flushing', async () => {
    lifecycle._reset();
    const closed = [];
    const clients = new Set([
      { close: (code) => closed.push(code) },
      { close: (code) => closed.push(code) },
    ]);
    const runShutdown = createShutdown({
      lifecycle,
      wss: { clients },
      flushPendingWrites: async () => {},
      redisPubSub: { cleanup: async () => {} },
      persistenceProvider: { destroy: async () => {} },
      closeRedis: async () => {},
      server: { listening: false, close: (cb) => cb() },
      deadlineMs: 10_000,
      exit: () => {},
      logger: silentLogger(),
    });
    await runShutdown('SIGTERM');
    expect(closed).toEqual([1001, 1001]);
  });

  it('no-ops safely on half-initialized resources (U1)', async () => {
    lifecycle._reset();
    const exit = jest.fn();
    // redisPubSub.cleanup and persistence.destroy throw as if init never finished.
    const runShutdown = createShutdown({
      lifecycle,
      wss: undefined,
      flushPendingWrites: async () => {},
      redisPubSub: { cleanup: async () => { throw new Error('pubsub half-init'); } },
      persistenceProvider: { destroy: async () => { throw new Error('pool half-init'); } },
      closeRedis: async () => { throw new Error('redis half-init'); },
      server: undefined,
      deadlineMs: 10_000,
      exit,
      logger: silentLogger(),
    });
    // Must still reach a clean exit(0) despite every teardown step throwing.
    await expect(runShutdown('SIGTERM')).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
