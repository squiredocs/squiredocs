/**
 * Feature 010 review F1: redisPubSub.init() must be hang-safe. If Redis is
 * unreachable or REDIS_PASSWORD mismatches, ioredis never emits 'ready', so a
 * bare once('ready') would block init() forever — lifecycle.markInitialized()
 * would never fire and GET /ready would return 503 forever, stalling the deploy.
 *
 * init() now races the ready-wait against REDIS_INIT_TIMEOUT_MS and RESOLVES on
 * timeout (logging a warning), so startup completes and the app becomes ready.
 * Readiness gates on Postgres, not cache (RD-4).
 *
 * This suite mocks ../redis with clients that NEVER become ready, so it does not
 * depend on a writable/reachable Redis (the shared dev Redis is misconfigured).
 */
const request = require('supertest');
const express = require('express');

// A pub/sub client that connects but NEVER reaches 'ready' (Redis unreachable /
// auth failure): status stays 'connecting' and it never emits 'ready'. Defined
// inside the factory because jest.mock factories can't close over out-of-scope
// variables.
jest.mock('../redis', () => {
  const EventEmitter = require('events');
  class NeverReadyRedis extends EventEmitter {
    constructor() { super(); this.status = 'connecting'; }
    quit() { this.status = 'end'; return Promise.resolve('OK'); }
  }
  return {
    createPubSubClient: jest.fn(() => new NeverReadyRedis()),
    isRedisEnabled: jest.fn(() => true),
  };
});

const redisPubSub = require('../redis-pubsub');
const { createReadyHandler } = require('../ready');
const lifecycle = require('../lifecycle');

describe('redisPubSub.init() hang-safety (review F1)', () => {
  const OLD_ENV = process.env.REDIS_INIT_TIMEOUT_MS;
  beforeEach(async () => {
    process.env.REDIS_INIT_TIMEOUT_MS = '100';
    await redisPubSub._reset();
    lifecycle._reset();
  });
  afterEach(async () => {
    if (OLD_ENV === undefined) delete process.env.REDIS_INIT_TIMEOUT_MS;
    else process.env.REDIS_INIT_TIMEOUT_MS = OLD_ENV;
    await redisPubSub.cleanup();
  });

  it('resolves (does not hang) when clients never become ready', async () => {
    const started = Date.now();
    // A hard test-side backstop: if init() hangs this rejects the race.
    const guard = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('init() hung — never resolved')), 3000)
    );
    await Promise.race([redisPubSub.init(), guard]);
    const elapsed = Date.now() - started;
    // Resolved shortly after the 100ms timeout, not after some multi-second hang.
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('with Redis unreachable, /ready still becomes 200 once Postgres is healthy', async () => {
    await redisPubSub.init(); // resolves via the timeout path
    lifecycle.markInitialized(); // this is what index.js does after init() returns

    const app = express();
    app.get('/ready', createReadyHandler({
      lifecycle,
      persistenceProvider: { ping: async () => true }, // Postgres healthy
      redisPubSub,
      isRedisReady: () => false, // Redis never connected
    }));

    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.datastore).toBe('up');
    // Cache is reported degraded (never gates readiness — RD-4).
    expect(res.body.cache).toBe('degraded');
  });
});
