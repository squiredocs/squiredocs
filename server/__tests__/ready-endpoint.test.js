/**
 * Feature 010, US4 (FR-020/021/022, SC-006): GET /ready gates on Postgres
 * reachability + lifecycle state; reports (never gates) cache; /health stays a
 * pure liveness signal; the body exposes no secrets/versions/hostnames.
 *
 * Uses the REAL handler factory (server/ready.js) with injected stubs so the
 * exact production logic is exercised.
 */
const request = require('supertest');
const express = require('express');
const { createReadyHandler } = require('../ready');
const lifecycle = require('../lifecycle');

function buildApp({ ping, cacheEnabled = true, redisReady = true }) {
  const app = express();
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/ready', createReadyHandler({
    lifecycle,
    persistenceProvider: { ping: async () => ping },
    redisPubSub: { isEnabled: () => cacheEnabled },
    isRedisReady: () => redisReady,
  }));
  return app;
}

describe('GET /ready (FR-020/021/022)', () => {
  beforeEach(() => { lifecycle._reset(); lifecycle.markInitialized(); });

  it('healthy → 200 {datastore:up, cache:up}', async () => {
    const res = await request(buildApp({ ping: true })).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', datastore: 'up', cache: 'up' });
  });

  it('Postgres unreachable → 503 while /health stays 200', async () => {
    const app = buildApp({ ping: false });
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.datastore).toBe('down');

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
  });

  it('cache down but datastore up → 200 with cache:degraded (RD-4: cache never gates)', async () => {
    const res = await request(buildApp({ ping: true, cacheEnabled: false })).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', datastore: 'up', cache: 'degraded' });
  });

  it('reports cache:degraded when the client is enabled but not ready', async () => {
    const res = await request(buildApp({ ping: true, cacheEnabled: true, redisReady: false })).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.cache).toBe('degraded');
  });

  it('pre-init → 503', async () => {
    lifecycle._reset(); // not initialized
    const res = await request(buildApp({ ping: true })).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });

  it('draining → 503 (does not even probe the datastore)', async () => {
    lifecycle.beginDraining();
    let probed = false;
    const app = express();
    app.get('/ready', createReadyHandler({
      lifecycle,
      persistenceProvider: { ping: async () => { probed = true; return true; } },
      redisPubSub: { isEnabled: () => true },
      isRedisReady: () => true,
    }));
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(probed).toBe(false);
  });

  it('body exposes no secrets/versions/hostnames', async () => {
    const res = await request(buildApp({ ping: true })).get('/ready');
    const keys = Object.keys(res.body).sort();
    expect(keys).toEqual(['cache', 'datastore', 'status']);
    const blob = JSON.stringify(res.body);
    expect(blob).not.toMatch(/postgres|redis|password|secret|localhost|version|amazonaws|\d+\.\d+\.\d+/i);
  });
});
