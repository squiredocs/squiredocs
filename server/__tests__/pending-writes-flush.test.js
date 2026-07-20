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

/**
 * Feature 023 T006 (FR-006): storeUpdate now serializes writes through a per-doc
 * FIFO queue, so a fire-and-forget update can be QUEUED-BUT-NOT-YET-STARTED when
 * shutdown begins. Because storeUpdate's returned promise settles only after its
 * queue slot completes, registering it in pendingWrites (exactly as bindState
 * does) keeps the graceful-shutdown flush covering those queued writes.
 */
const Y = require('yjs');
const { createPool, createPersistence, createTestUser, cleanupTestUser } = require('./helpers/db');

describe('023 flush covers queued-but-not-started storeUpdate writes (FR-006)', () => {
  let pool, persistence, userId;
  const docGuid = require('crypto').randomUUID();

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    userId = await createTestUser(pool, `pending-023-${Date.now()}@test.com`);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
    await cleanupTestUser(pool, userId);
    await persistence.destroy();
    await pool.end();
  });

  it('drains every queued write registered like bindState does', async () => {
    const { pendingWrites, flushPendingWrites } = createPendingWrites();

    // Issue a burst of fire-and-forget updates: only the head runs immediately;
    // the rest sit in the per-doc queue. Register each promise the way bindState
    // does (add on start, delete on settle).
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    const N = 12;
    for (let i = 0; i < N; i++) {
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => {
        const el = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, `f-${i}`);
        el.insert(0, [t]);
        frag.push([el]);
      });
      const p = persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(doc, sv), userId, null);
      pendingWrites.add(p);
      p.finally(() => pendingWrites.delete(p));
    }

    // At least one is still queued (not started) at flush time.
    expect(pendingWrites.size).toBe(N);

    await flushPendingWrites();
    expect(pendingWrites.size).toBe(0);

    // Every queued write landed durably, contiguous and in order.
    const rows = await pool.query('SELECT clock FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC', [docGuid]);
    expect(rows.rows).toHaveLength(N);
    for (let i = 1; i < rows.rows.length; i++) {
      expect(Number(rows.rows[i].clock)).toBe(Number(rows.rows[i - 1].clock) + 1);
    }
  });
});
