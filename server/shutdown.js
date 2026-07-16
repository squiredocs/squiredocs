/**
 * Graceful shutdown routine (feature 010, US1).
 *
 * One ordered drain, bound to both SIGTERM and SIGINT, that flushes in-flight
 * Yjs persistence before exit so a rolling deploy never loses the edit tail
 * (FR-004). Ordered steps (RD-8, contract):
 *
 *   ignore-if-draining (FR-002) → beginDraining → close live WS sessions
 *   → await pending-persistence flush → redisPubSub.cleanup()
 *   → persistenceProvider.destroy() → closeRedis() → server.close()
 *   → exit(0)
 *
 * A `SHUTDOWN_DEADLINE_MS` force-exit backstop (default 20000, below the
 * orchestrator's 30s grace period, RD-8/FR-003) guarantees exit even if a drain
 * step wedges. Each drain step is guarded so it no-ops safely on a half-init
 * resource — SIGTERM can arrive during a crash-loop before init finishes (U1).
 *
 * Dependencies are injected so the routine is unit-testable without booting the
 * whole server (index.js wires the real ones).
 */

/**
 * @param {object} deps
 * @param {object} deps.lifecycle - lifecycle module (beginDraining)
 * @param {object} [deps.wss] - WebSocket.Server (its .clients are closed)
 * @param {() => Promise<void>} deps.flushPendingWrites - awaits in-flight persistence
 * @param {object} [deps.redisPubSub] - redis pub/sub module (cleanup)
 * @param {object} [deps.persistenceProvider] - pg persistence (destroy)
 * @param {() => Promise<void>} [deps.closeRedis] - shared redis client closer
 * @param {object} [deps.telemetry] - OTel bootstrap (shutdown = bounded flush)
 * @param {object} [deps.server] - http server (close)
 * @param {number} deps.deadlineMs - force-exit backstop
 * @param {(code: number) => void} [deps.exit] - process.exit seam (tests)
 * @param {object} [deps.logger] - console-like
 * @returns {(signal?: string) => Promise<void>} runShutdown
 */
function createShutdown(deps) {
  const {
    lifecycle,
    wss,
    flushPendingWrites,
    redisPubSub,
    persistenceProvider,
    closeRedis,
    telemetry,
    server,
    deadlineMs,
    exit = (code) => process.exit(code),
    logger = console,
  } = deps;

  return async function runShutdown(signal) {
    // FR-002: a second signal mid-drain is ignored.
    if (!lifecycle.beginDraining()) return;
    logger.log(`[Shutdown] ${signal || 'signal'} received — draining (deadline ${deadlineMs}ms)`);

    // FR-003: force-exit backstop, armed BEFORE any await so a wedged step still exits.
    const forceTimer = setTimeout(() => {
      logger.error('[Shutdown] deadline reached — forcing exit');
      exit(0);
    }, deadlineMs);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    // Guard a drain step so a half-initialized / already-torn-down resource
    // (U1) never turns shutdown into a crash. Never rejects.
    const safe = async (label, fn) => {
      if (typeof fn !== 'function') return;
      try {
        await fn();
      } catch (err) {
        logger.error(`[Shutdown] ${label} failed (continuing):`, err?.message || err);
      }
    };

    try {
      // Close live WS sessions so clients fail over to a healthy replica and
      // server.close() can complete (1001 = going away).
      if (wss && wss.clients) {
        for (const client of wss.clients) {
          try { client.close(1001); } catch { /* already closed */ }
        }
      }

      // FR-004: flush in-flight persistence before tearing anything down.
      await safe('pending-write flush', flushPendingWrites);

      // Ordered teardown, each guarded against a half-init resource (U1).
      await safe('redis pub/sub cleanup', redisPubSub && redisPubSub.cleanup ? () => redisPubSub.cleanup() : null);
      await safe('persistence destroy', persistenceProvider && persistenceProvider.destroy ? () => persistenceProvider.destroy() : null);
      await safe('redis client close', closeRedis);

      // Flush pending telemetry within a bounded time (FR-017). Resolves even if
      // the Collector is unreachable, so shutdown never hangs on it. The overall
      // force-exit backstop above still guarantees exit regardless.
      await safe('telemetry flush', telemetry && telemetry.shutdown ? () => telemetry.shutdown() : null);

      await new Promise((resolve) => {
        if (server && server.listening) {
          server.close(() => resolve());
        } else if (server && typeof server.close === 'function') {
          // Not listening (half-init) — still attempt close, but don't hang.
          try { server.close(() => resolve()); } catch { resolve(); }
        } else {
          resolve();
        }
      });

      clearTimeout(forceTimer);
      logger.log('[Shutdown] drain complete — exiting');
      exit(0);
    } catch (err) {
      clearTimeout(forceTimer);
      logger.error('[Shutdown] unexpected error — exiting:', err?.message || err);
      exit(0);
    }
  };
}

module.exports = { createShutdown };
