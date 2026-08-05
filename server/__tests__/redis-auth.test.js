/**
 * Feature 010, US5 (FR-024, SC-008): server/redis.js honors REDIS_PASSWORD when
 * set (shared client + every pub/sub client authenticate), and the connection
 * config is byte-identical to the pre-feature behavior when it is unset.
 *
 * ioredis is mocked so we can inspect the exact config object passed to the
 * client constructor without a live Redis.
 */
jest.mock('ioredis', () => {
  function MockRedis(config) {
    MockRedis.ctorArgs.push(config);
    this.status = 'ready';
    this.on = () => this;
    this.once = () => this;
    this.quit = async () => {};
  }
  MockRedis.ctorArgs = [];
  return MockRedis;
});

const MockRedis = require('ioredis');

const SAVED_PASSWORD = process.env.REDIS_PASSWORD;
// The suite asserts the PRE-FEATURE key set, so it has to own every optional
// knob that can add a key — not just the one it is about. Feature 052 added
// REDIS_DB, which the test runner sets on every worker; clear it here so these
// assertions keep meaning "no stray additions" instead of quietly tracking
// whatever the runner happens to set. REDIS_DB's own behavior is asserted in
// db-isolation.test.js.
const SAVED_DB = process.env.REDIS_DB;

function loadRedisFresh() {
  let mod;
  jest.isolateModules(() => { mod = require('../redis'); }); // eager-connects on load
  return mod;
}

describe('redis auth config (FR-024)', () => {
  beforeEach(() => {
    MockRedis.ctorArgs.length = 0;
    process.env.REDIS_HOST = process.env.REDIS_HOST || 'collab-redis';
    delete process.env.REDIS_DB;
  });
  afterAll(() => {
    if (SAVED_PASSWORD === undefined) delete process.env.REDIS_PASSWORD;
    else process.env.REDIS_PASSWORD = SAVED_PASSWORD;
    if (SAVED_DB === undefined) delete process.env.REDIS_DB;
    else process.env.REDIS_DB = SAVED_DB;
  });

  it('omits the password key entirely when REDIS_PASSWORD is unset (byte-identical)', () => {
    delete process.env.REDIS_PASSWORD;
    const mod = loadRedisFresh();
    const shared = MockRedis.ctorArgs[0]; // eager shared client
    expect(shared).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(shared, 'password')).toBe(false);

    // A pub/sub client uses the same config — also no password key.
    mod.createPubSubClient();
    const pubsub = MockRedis.ctorArgs[MockRedis.ctorArgs.length - 1];
    expect('password' in pubsub).toBe(false);

    // The key set is exactly the pre-feature config (no stray additions).
    expect(Object.keys(shared).sort()).toEqual(
      ['connectTimeout', 'host', 'maxRetriesPerRequest', 'port', 'retryStrategy'].sort()
    );
  });

  it('sets the password on both the shared client and pub/sub clients when REDIS_PASSWORD is set', () => {
    process.env.REDIS_PASSWORD = 's3cret-pass';
    const mod = loadRedisFresh();
    const shared = MockRedis.ctorArgs[0];
    expect(shared.password).toBe('s3cret-pass');

    mod.createPubSubClient();
    const pubsub = MockRedis.ctorArgs[MockRedis.ctorArgs.length - 1];
    expect(pubsub.password).toBe('s3cret-pass');

    // Password is the ONLY addition versus the unset config.
    expect(Object.keys(shared).sort()).toEqual(
      ['connectTimeout', 'host', 'maxRetriesPerRequest', 'password', 'port', 'retryStrategy'].sort()
    );
  });
});
