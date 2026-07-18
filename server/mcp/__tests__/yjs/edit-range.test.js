/**
 * Edit-range capture + durability verification (feature 016, research R2, RBD-8).
 *
 * captureEditUpdates observes a session doc's update events (excluding remote/
 * provider origins) and collects the payloads a modify call produced.
 * awaitDurableRange polls the update log until the acting identity's stored
 * rows provably cover every captured payload's struct ranges AND delete-sets,
 * then returns the [clockStart, clockEnd] of exactly the rows that carry the
 * edit — or null on bounded-wait timeout (the honest editRangePending path).
 *
 * Pure unit tests: the persistence is a stub over fabricated log rows.
 */
const Y = require('yjs');
const { captureEditUpdates, awaitDurableRange } = require('../../yjs/edit-range');

const IDENTITY = { userId: 'user-1', agentName: 'Squire Docs Assistant' };
const OTHER_IDENTITY = { userId: 'user-2', agentName: null };

/** Build a stub persistence over a fixed row array (getUpdatesInRange shape). */
function stubPersistence(rows) {
  return {
    calls: [],
    async getUpdatesInRange(docGuid, clockStart, clockEnd) {
      this.calls.push([docGuid, clockStart, clockEnd]);
      return rows.filter((r) => r.clock >= clockStart && r.clock <= clockEnd);
    },
  };
}

function row(clock, identity, updateData) {
  return { clock, userId: identity.userId, agentName: identity.agentName, updateData };
}

/** Run fn against a doc, returning the update payloads it emitted. */
function editPayloads(doc, fn) {
  const collected = [];
  const h = (u) => collected.push(u);
  doc.on('update', h);
  fn(doc);
  doc.off('update', h);
  return collected;
}

describe('captureEditUpdates', () => {
  test('collects local edit payloads emitted during the capture window', () => {
    const doc = new Y.Doc();
    const frag = doc.get('default', Y.XmlFragment);

    const capture = captureEditUpdates(doc);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'hello');
    p.insert(0, [t]);
    frag.insert(0, [p]);
    t.insert(5, ' world');
    const payloads = capture.stop();

    expect(payloads.length).toBeGreaterThanOrEqual(1);
    // The union of captured payloads reproduces the edit
    const replica = new Y.Doc();
    for (const u of payloads) Y.applyUpdate(replica, u);
    expect(replica.get('default', Y.XmlFragment).toString()).toBe('<paragraph>hello world</paragraph>');
  });

  test('excludes updates applied with an excluded origin (the provider) but keeps other applyUpdates', () => {
    const doc = new Y.Doc();
    doc.get('default', Y.XmlFragment);
    const providerLike = { name: 'fake-provider' };

    // A remote edit arriving through the provider during the capture window
    const remote = new Y.Doc();
    const remotePayloads = editPayloads(remote, (d) => {
      const f = d.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'REMOTE');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });

    // A sandbox-style local applyUpdate (string origin — how the script bridge
    // lands worker updates on the session doc)
    const sandbox = new Y.Doc();
    const sandboxPayloads = editPayloads(sandbox, (d) => {
      const f = d.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'SANDBOX');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });

    const capture = captureEditUpdates(doc, { excludeOrigins: [providerLike] });
    for (const u of remotePayloads) Y.applyUpdate(doc, u, providerLike);
    for (const u of sandboxPayloads) Y.applyUpdate(doc, u, 'sandbox-exec-123');
    const payloads = capture.stop();

    const replica = new Y.Doc();
    for (const u of payloads) Y.applyUpdate(replica, u);
    const text = replica.get('default', Y.XmlFragment).toString();
    expect(text).toContain('SANDBOX');
    expect(text).not.toContain('REMOTE');
  });

  test('stop() unsubscribes — later edits are not captured', () => {
    const doc = new Y.Doc();
    const frag = doc.get('default', Y.XmlFragment);
    const capture = captureEditUpdates(doc);
    const payloads = capture.stop();
    const p = new Y.XmlElement('paragraph');
    frag.insert(0, [p]);
    expect(payloads.length).toBe(0);
  });
});

describe('awaitDurableRange', () => {
  test('confirms when identity rows cover every captured struct range, and returns exactly their clock span', async () => {
    // Baseline row (clock 0, human), then the agent edit as two rows (1, 2).
    const doc = new Y.Doc();
    const basePayloads = editPayloads(doc, (d) => {
      const f = d.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'base');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });

    const capture = captureEditUpdates(doc);
    const editA = editPayloads(doc, (d) => {
      d.get('default', Y.XmlFragment).get(0).get(0).insert(4, ' one');
    });
    const editB = editPayloads(doc, (d) => {
      d.get('default', Y.XmlFragment).get(0).get(0).insert(8, ' two');
    });
    const captured = capture.stop();
    expect(captured.length).toBe(editA.length + editB.length);

    const rows = [
      row(0, OTHER_IDENTITY, basePayloads[0]),
      row(1, IDENTITY, editA[0]),
      row(2, IDENTITY, editB[0]),
    ];
    const persistence = stubPersistence(rows);
    const range = await awaitDurableRange(persistence, 'doc-guid', IDENTITY, 0, captured, { timeoutMs: 500 });
    expect(range).toEqual({ clockStart: 1, clockEnd: 2, clocks: [1, 2] });
    // Poll queried rows strictly after the baseline
    expect(persistence.calls[0][1]).toBe(1);
  });

  test('does NOT confirm while any captured payload is missing from the identity rows (partial persistence)', async () => {
    const doc = new Y.Doc();
    const capture = captureEditUpdates(doc);
    const editA = editPayloads(doc, (d) => {
      const f = d.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'first');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });
    const editB = editPayloads(doc, (d) => {
      d.get('default', Y.XmlFragment).get(0).get(0).insert(5, ' second');
    });
    capture.stop();

    // Only the first row landed; the second never does.
    const persistence = stubPersistence([row(0, IDENTITY, editA[0])]);
    const range = await awaitDurableRange(
      persistence, 'doc-guid', IDENTITY,
      -1, [...editA, ...editB],
      { timeoutMs: 300, pollIntervalMs: 50 }
    );
    expect(range).toBeNull();
    expect(persistence.calls.length).toBeGreaterThan(1); // it actually polled
  });

  test('does NOT confirm when the covering rows belong to another identity', async () => {
    const doc = new Y.Doc();
    const capture = captureEditUpdates(doc);
    const edit = editPayloads(doc, (d) => {
      const f = d.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'mine');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });
    capture.stop();

    // Byte-covering row exists but is attributed to someone else.
    const persistence = stubPersistence([row(0, OTHER_IDENTITY, edit[0])]);
    const range = await awaitDurableRange(persistence, 'doc-guid', IDENTITY, -1, edit, { timeoutMs: 300, pollIntervalMs: 50 });
    expect(range).toBeNull();
  });

  test('covers a deletion-only edit (no struct-clock advance, only a delete set)', async () => {
    const doc = new Y.Doc();
    const basePayloads = editPayloads(doc, (d) => {
      const f = d.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'delete me');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });

    const capture = captureEditUpdates(doc);
    const del = editPayloads(doc, (d) => {
      d.get('default', Y.XmlFragment).get(0).get(0).delete(0, 6);
    });
    const captured = capture.stop();
    expect(captured.length).toBe(1);

    const rows = [
      row(0, OTHER_IDENTITY, basePayloads[0]),
      row(1, IDENTITY, del[0]),
    ];
    const persistence = stubPersistence(rows);
    const range = await awaitDurableRange(persistence, 'doc-guid', IDENTITY, 0, captured, { timeoutMs: 500 });
    expect(range).toEqual({ clockStart: 1, clockEnd: 1, clocks: [1] });
  });

  test('excludes unrelated same-identity rows (different clientID) from the recorded range', async () => {
    // An unrelated row by the SAME identity but from a different session
    // (different clientID) lands after the baseline, before the edit's rows.
    const unrelatedDoc = new Y.Doc();
    const unrelated = editPayloads(unrelatedDoc, (d) => {
      const f = d.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'unrelated');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });

    const doc = new Y.Doc();
    const capture = captureEditUpdates(doc);
    const edit = editPayloads(doc, (d) => {
      const f = d.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'the edit');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });
    const captured = capture.stop();

    const rows = [
      row(3, IDENTITY, unrelated[0]), // same identity, different clientID — not this edit
      row(4, IDENTITY, edit[0]),
    ];
    const persistence = stubPersistence(rows);
    const range = await awaitDurableRange(persistence, 'doc-guid', IDENTITY, 2, captured, { timeoutMs: 500 });
    expect(range).toEqual({ clockStart: 4, clockEnd: 4, clocks: [4] });
  });

  test('bounded wait: returns null when the rows never appear', async () => {
    const doc = new Y.Doc();
    const capture = captureEditUpdates(doc);
    const edit = editPayloads(doc, (d) => {
      const f = d.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'never persisted');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });
    capture.stop();

    const persistence = stubPersistence([]);
    const started = Date.now();
    const range = await awaitDurableRange(persistence, 'doc-guid', IDENTITY, -1, edit, { timeoutMs: 250, pollIntervalMs: 50 });
    expect(range).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  test('empty capture (no payloads) yields null — nothing to record', async () => {
    const persistence = stubPersistence([]);
    const range = await awaitDurableRange(persistence, 'doc-guid', IDENTITY, -1, [], { timeoutMs: 200 });
    expect(range).toBeNull();
  });
});
