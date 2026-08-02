/**
 * Shared transient-failure retry (feature 042, FR-015).
 *
 * Two places implemented this identically — the title sync in `index.js`'s
 * per-update `bindState` listener (where the closure was re-allocated on every
 * Yjs update) and `_runStoreSlot` in `postgres-persistence.js` — down to the
 * same three attempts and the same jittered exponential delay. One definition
 * now serves both.
 *
 * Deliberately NOT covered by this helper:
 *  - `_fetchRowsWithGapRetry` (postgres-persistence): an env-configured FIXED
 *    delay table waiting for log rows to become visible. Different mechanism,
 *    different question.
 *  - `MAX_CONFLICT_RETRIES` in `_storeUpdateCritical`: a no-delay clock-conflict
 *    loop, where waiting is exactly the wrong response.
 */

/**
 * Run `fn`, retrying transient failures with exponential backoff plus jitter.
 *
 * The jitter matters: without it, several documents failing on the same DB blip
 * retry in lockstep and hit the recovering database as a thundering herd.
 *
 * The last attempt's error propagates unchanged — callers distinguish failure
 * kinds by the error itself, so it is never wrapped.
 *
 * @param {function(): Promise<*>} fn - the operation; called once per attempt
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3] - total attempts, including the first
 * @param {number} [opts.baseDelay=100] - ms; attempt N waits
 *   `baseDelay * 2^(N-1) + jitter`, jitter being 0-50 ms
 * @returns {Promise<*>} whatever `fn` resolved to
 */
async function retryWithBackoff(fn, { maxAttempts = 3, baseDelay = 100 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 50;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return undefined; // unreachable: the final attempt either returns or throws
}

module.exports = { retryWithBackoff };
