/**
 * In-memory fake Redis for presence-claim tests (feature 015).
 *
 * Deterministic stand-in for the shared ioredis command client plus the
 * presence-claim pub/sub nudge channel, so claim suites never need a live
 * Redis (research R8). Provides:
 *
 * - `client`: the command surface presence-claim.js uses —
 *   `set(key, value, 'PX', ttl[, 'NX'])`, `get`, `del`, and the two Lua
 *   owner-checked commands emulated directly as methods
 *   (`claimRefresh(key, id, ttlMs)` → GET==id ? PEXPIRE+1 : 0;
 *    `claimRelease(key, id)` → GET==id ? DEL+1 : 0). `defineCommand` is a
 *   no-op (the commands already exist).
 * - A virtual clock: `advance(ms)` moves time forward and expires keys.
 * - Error injection: `failNext(n)` / `failAll(bool)` make ops reject;
 *   `hang(bool)` makes ops never settle until `settleHung(err?)` releases
 *   them (for op-timeout and late-settlement tests).
 * - A pub/sub bus bridging module instances: `makePubSubFor(instanceId)`
 *   returns `{ subscribeToPresenceClaims, publishPresenceClaimTakeover }`
 *   with real-Redis semantics (self-messages are not delivered back to the
 *   publishing instance — mirroring redis-pubsub's instance-ID filter).
 *
 * Export is a factory so every test gets isolated state.
 */

const PRESENCE_CLAIM_CHANNEL = 'presence-claim';

function createFakeClaimRedis() {
  const store = new Map(); // key -> { value, expiresAt } (virtual-clock ms)
  let now = 0;
  let failNextCount = 0;
  let failAllMode = false;
  let hangMode = false;
  const pendingHangs = []; // { resolve, reject } for hung ops
  const calls = []; // [opName, ...args] per attempted command
  const busHandlers = []; // { channel, handler, instanceId }

  function liveEntry(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  // Every command goes through guard() first: records the call, then applies
  // hang/error injection. Returns a promise so hung ops can be released later.
  function guard(record) {
    calls.push(record);
    if (hangMode) {
      return new Promise((resolve, reject) => {
        pendingHangs.push({ resolve, reject });
      });
    }
    if (failAllMode) return Promise.reject(new Error('fake-redis: injected failure'));
    if (failNextCount > 0) {
      failNextCount -= 1;
      return Promise.reject(new Error('fake-redis: injected failure'));
    }
    return Promise.resolve();
  }

  const client = {
    async set(key, value, pxToken, ttlMs, nxToken) {
      await guard(['set', key, value, pxToken, ttlMs, nxToken]);
      if (pxToken !== 'PX') throw new Error(`fake-redis: unsupported set() args (${pxToken})`);
      if (nxToken !== undefined && nxToken !== 'NX') {
        throw new Error(`fake-redis: unsupported set() flag (${nxToken})`);
      }
      if (nxToken === 'NX' && liveEntry(key)) return null;
      store.set(key, { value: String(value), expiresAt: now + Number(ttlMs) });
      return 'OK';
    },

    async get(key) {
      await guard(['get', key]);
      const entry = liveEntry(key);
      return entry ? entry.value : null;
    },

    async del(key) {
      await guard(['del', key]);
      const existed = !!liveEntry(key);
      store.delete(key);
      return existed ? 1 : 0;
    },

    // Emulation of the Lua script: GET == id -> PEXPIRE, else 0
    async claimRefresh(key, instanceId, ttlMs) {
      await guard(['claimRefresh', key, instanceId, ttlMs]);
      const entry = liveEntry(key);
      if (entry && entry.value === String(instanceId)) {
        entry.expiresAt = now + Number(ttlMs);
        return 1;
      }
      return 0;
    },

    // Emulation of the Lua script: GET == id -> DEL, else 0
    async claimRelease(key, instanceId) {
      await guard(['claimRelease', key, instanceId]);
      const entry = liveEntry(key);
      if (entry && entry.value === String(instanceId)) {
        store.delete(key);
        return 1;
      }
      return 0;
    },

    // presence-claim.js calls this on real clients to register the Lua
    // scripts; the fake already has them as plain methods.
    defineCommand() {},
  };

  return {
    client,
    calls,

    /** Number of commands attempted so far (including failed/hung ones). */
    callCount() {
      return calls.length;
    },

    /** Advance the virtual clock, expiring any keys whose TTL has passed. */
    advance(ms) {
      now += ms;
      for (const [key, entry] of store) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) {
          store.delete(key);
        }
      }
    },

    now() {
      return now;
    },

    /** Current live value of a key (or null), without recording a call. */
    peek(key) {
      const entry = liveEntry(key);
      return entry ? entry.value : null;
    },

    /** Remaining TTL of a key in virtual ms (or null when absent). */
    peekTtl(key) {
      const entry = liveEntry(key);
      if (!entry) return null;
      return entry.expiresAt === null ? Infinity : entry.expiresAt - now;
    },

    /** Directly plant a key (e.g. a foreign instance's claim). */
    setKey(key, value, ttlMs = null) {
      store.set(key, { value: String(value), expiresAt: ttlMs === null ? null : now + ttlMs });
    },

    /** Directly remove a key (e.g. simulate a crashed holder's expiry). */
    deleteKey(key) {
      store.delete(key);
    },

    /** Make the next n commands reject. */
    failNext(n = 1) {
      failNextCount = n;
    },

    /** Toggle every command rejecting. */
    failAll(on) {
      failAllMode = !!on;
    },

    /** Toggle commands hanging (never settling) until settleHung() is called. */
    hang(on) {
      hangMode = !!on;
    },

    /**
     * Settle all currently-hung commands: with an error they reject; without,
     * they resolve and the command completes normally (late settlement).
     */
    settleHung(err) {
      const pending = pendingHangs.splice(0, pendingHangs.length);
      for (const p of pending) {
        if (err) p.reject(err);
        else p.resolve();
      }
    },

    // ---- pub/sub bus (bridges module instances in multi-instance tests) ----

    /** Raw bus publish: delivers payload to all handlers on the channel
     *  registered under a DIFFERENT instance ID (self-filter, like prod). */
    publish(channel, payload, senderInstanceId) {
      for (const entry of busHandlers) {
        if (entry.channel === channel && entry.instanceId !== senderInstanceId) {
          entry.handler(payload);
        }
      }
    },

    /** Raw bus subscribe. */
    subscribe(channel, handler, instanceId) {
      busHandlers.push({ channel, handler, instanceId });
    },

    /**
     * Adapter matching the redis-pubsub surface presence-claim.js consumes,
     * bound to one simulated instance's identity.
     */
    makePubSubFor(instanceId) {
      const self = this;
      return {
        subscribeToPresenceClaims(handler) {
          self.subscribe(PRESENCE_CLAIM_CHANNEL, handler, instanceId);
        },
        publishPresenceClaimTakeover(claimKey) {
          self.publish(PRESENCE_CLAIM_CHANNEL, { claimKey }, instanceId);
        },
      };
    },
  };
}

module.exports = { createFakeClaimRedis, PRESENCE_CLAIM_CHANNEL };
