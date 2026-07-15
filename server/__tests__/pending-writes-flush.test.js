/**
 * Feature 010 review F4 (FR-004): flushPendingWrites must not lose the edit tail.
 * The old flush snapshotted `pendingWrites` once (Promise.allSettled([...set])),
 * so an update queued while the snapshot's promises were still settling — the
 * user's last keystrokes as SIGTERM arrives — registered AFTER the snapshot and
 * was killed by the subsequent persistence.destroy() + exit(0).
 *
 * The fix loops until the set drains, yielding between passes so a write queued
 * mid-flush is observed and awaited.
 */
const { createPendingWrites } = require('../pending-writes');

// Mirror index.js's registration: add on start, delete on settle.
function makeEnqueue(pendingWrites, persisted) {
  return function enqueue(label, delayMs) {
    const p = new Promise((r) => setTimeout(r, delayMs)).then(() => persisted.push(label));
    pendingWrites.add(p);
    p.finally(() => pendingWrites.delete(p));
    return p;
  };
}

describe('flushPendingWrites drains the edit tail (review F4)', () => {
  it('awaits a write queued WHILE the first batch is still flushing', async () => {
    const { pendingWrites, flushPendingWrites } = createPendingWrites();
    const persisted = [];
    const enqueue = makeEnqueue(pendingWrites, persisted);

    // First write is in flight when the drain starts (settles at ~30ms).
    enqueue('first', 30);
    // The user's last keystroke lands 5ms into the drain, AFTER a one-shot
    // snapshot would have been taken; it settles at ~35ms.
    setTimeout(() => enqueue('last-keystroke', 30), 5);

    await flushPendingWrites();

    expect(persisted).toContain('first');
    expect(persisted).toContain('last-keystroke');
    expect(pendingWrites.size).toBe(0);
  });

  it('a one-shot snapshot (the OLD behavior) would have lost that write', async () => {
    // Demonstrates the bug the fix closes: snapshot once, and the mid-flush write
    // is not awaited.
    const pendingWrites = new Set();
    const persisted = [];
    const enqueue = makeEnqueue(pendingWrites, persisted);

    enqueue('first', 30);
    setTimeout(() => enqueue('last-keystroke', 30), 5);

    // One-shot snapshot flush (the pre-fix implementation).
    await Promise.allSettled([...pendingWrites]);

    expect(persisted).toContain('first');
    expect(persisted).not.toContain('last-keystroke'); // lost
  });

  it('resolves immediately when there is nothing pending', async () => {
    const { flushPendingWrites, pendingWrites } = createPendingWrites();
    await expect(flushPendingWrites()).resolves.toBeUndefined();
    expect(pendingWrites.size).toBe(0);
  });
});
