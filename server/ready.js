/**
 * GET /ready handler factory (feature 010, US4).
 *
 * 200 iff the process finished startup, is not draining, and Postgres answers a
 * trivial query within a short timeout. Redis/cache state is reported but never
 * gates the decision (RD-4/FR-021). Body carries no secrets/versions/hostnames
 * (FR-022). Dependencies are injected so the handler is unit-testable without
 * booting the server.
 *
 * @param {object} deps
 * @param {object} deps.lifecycle - lifecycle flags (isInitialized/isDraining)
 * @param {object} deps.persistenceProvider - pg persistence (ping)
 * @param {object} deps.redisPubSub - redis pub/sub (isEnabled)
 * @param {() => boolean} deps.isRedisReady - shared redis client readiness
 */
function createReadyHandler({ lifecycle, persistenceProvider, redisPubSub, isRedisReady }) {
  return async function ready(req, res) {
    const cache = (redisPubSub.isEnabled() && isRedisReady()) ? 'up' : 'degraded';

    // Startup not finished or shutting down ⇒ not ready (cache is reported only).
    if (!lifecycle.isInitialized() || lifecycle.isDraining()) {
      return res.status(503).json({ status: 'not_ready', datastore: 'unknown', cache });
    }

    // Postgres gates readiness (RD-4).
    const datastoreUp = await persistenceProvider.ping();
    if (!datastoreUp) {
      return res.status(503).json({ status: 'not_ready', datastore: 'down', cache });
    }

    res.status(200).json({ status: 'ready', datastore: 'up', cache });
  };
}

module.exports = { createReadyHandler };
