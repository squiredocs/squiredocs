/**
 * In-flight persistence tracker + drain (feature 010, US1/FR-004).
 *
 * Yjs update persistence is fire-and-forget: each write registers its promise in
 * `pendingWrites` on start and removes it on settle. The graceful-shutdown
 * routine awaits `flushPendingWrites()` before tearing persistence down so the
 * edit tail (the user's last keystrokes as SIGTERM arrives) is never lost.
 *
 * The flush LOOPS rather than snapshotting once: an update queued while we are
 * awaiting the current batch registers in `pendingWrites` AFTER a one-shot
 * `Promise.allSettled([...pendingWrites])` would have captured its inputs, so a
 * single snapshot would drop exactly those last edits (feature 010 review F4).
 * Each pass yields with setImmediate so writes registered synchronously in a
 * settled promise's `.then`/`.finally` (including the tracker's own delete) are
 * observed before we re-check `size`. The shutdown deadline backstop (FR-003)
 * bounds the loop if writes never stop arriving.
 */
function createPendingWrites() {
  const pendingWrites = new Set();

  async function flushPendingWrites() {
    while (pendingWrites.size > 0) {
      await Promise.allSettled([...pendingWrites]);
      // Yield a macrotask so newly-registered writes (and the settle-time
      // deletions) are visible before the next size check.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return { pendingWrites, flushPendingWrites };
}

module.exports = { createPendingWrites };
