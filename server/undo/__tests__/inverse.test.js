/**
 * Log-derived inverse computation (feature 016, research R1).
 *
 * Pure Y.Doc fixtures + fabricated row arrays — no DB. The inverse of a clock
 * range is computed by rebuilding a gc-off scratch doc from the log, replaying
 * the acting identity's rows in the range through a replica Y.UndoManager (one
 * StackItem), popping it, and capturing the resulting transaction update.
 *
 * The US2 semantics matrix (T016) extends this file with the byte-for-byte
 * popStackItem-parity cases.
 */
const Y = require('yjs');
const { computeInverse } = require('../inverse');

const AGENT = { userId: 'user-1', agentName: 'Squire Docs Assistant' };
const HUMAN = { userId: 'user-2', agentName: null };
const OTHER_AGENT = { userId: 'user-1', agentName: 'Other Agent' };

/**
 * Builds a fabricated yjs_updates log: each edit() call runs fn against the
 * doc and appends the emitted update payloads as identity-attributed rows.
 * Returns each edit's clock range for range targeting.
 */
class LogBuilder {
  constructor() {
    this.doc = new Y.Doc();
    this.rows = [];
    this._pending = [];
    this.doc.on('update', (u) => this._pending.push(u));
  }

  get frag() {
    return this.doc.get('default', Y.XmlFragment);
  }

  edit(identity, fn) {
    this._pending = [];
    this.doc.transact(() => fn(this.doc, this.frag));
    const start = this.rows.length;
    for (const u of this._pending) {
      this.rows.push({
        clock: this.rows.length,
        userId: identity.userId,
        agentName: identity.agentName,
        updateData: u,
      });
    }
    if (this.rows.length === start) throw new Error('edit produced no update');
    return { clockStart: start, clockEnd: this.rows.length - 1 };
  }

  /** Apply an externally produced update (e.g. an inverse) as a new row. */
  applyRow(identity, update) {
    this._pending = [];
    Y.applyUpdate(this.doc, update);
    return { clockStart: this.rows.length, clockEnd: this.rows.length };
  }

  /** Snapshot for concurrent-fork edits. */
  snapshot() {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /**
   * A concurrent edit: authored on a fork of `snapshot` (its author had not
   * yet seen later rows), then merged into the log as new rows.
   */
  forkEdit(identity, snapshot, fn) {
    const fork = new Y.Doc();
    Y.applyUpdate(fork, snapshot);
    const payloads = [];
    fork.on('update', (u) => payloads.push(u));
    fork.transact(() => fn(fork, fork.get('default', Y.XmlFragment)));
    fork.destroy();
    const start = this.rows.length;
    for (const u of payloads) {
      Y.applyUpdate(this.doc, u);
      this.rows.push({
        clock: this.rows.length,
        userId: identity.userId,
        agentName: identity.agentName,
        updateData: u,
      });
    }
    return { clockStart: start, clockEnd: this.rows.length - 1 };
  }

  buildDoc() {
    const doc = new Y.Doc();
    for (const r of this.rows) Y.applyUpdate(doc, r.updateData);
    return doc;
  }

  text() {
    return this.frag.toString();
  }
}

function para(text) {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
}

/** Apply the inverse to a doc rebuilt from the log; return its serialization. */
function applyInverse(log, inverseUpdate) {
  const doc = log.buildDoc();
  Y.applyUpdate(doc, inverseUpdate);
  return doc.get('default', Y.XmlFragment).toString();
}

/**
 * The parity oracle (US2/SC-003): the SAME rows replayed onto a live-style
 * gc:true doc through a real Y.UndoManager tracking exactly the in-range
 * identity rows — the mechanism 016 retires — then undo(). The log-derived
 * inverse must produce a byte-identical serialization.
 */
function oracleUndo(rows, range, identity) {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  let um = null;
  for (const row of rows) {
    if (!um && row.clock >= range.clockStart) {
      um = new Y.UndoManager(frag, {
        trackedOrigins: new Set(['tracked']),
        captureTimeout: Number.MAX_SAFE_INTEGER,
      });
    }
    const tracked = um
      && row.clock >= range.clockStart && row.clock <= range.clockEnd
      && row.userId === identity.userId
      && (row.agentName ?? null) === (identity.agentName ?? null);
    Y.applyUpdate(doc, row.updateData, tracked ? 'tracked' : 'untracked');
  }
  const popped = um ? um.undo() : null;
  const text = frag.toString();
  if (um) um.destroy();
  doc.destroy();
  return { text, popped: !!popped };
}

/** Run both mechanisms over the same log and assert byte parity (SC-003). */
function bothWays(log, range, identity = AGENT) {
  const res = computeInverse(log.rows, range, identity);
  const logDerived = res ? applyInverse(log, res.inverseUpdate) : log.text();
  const oracle = oracleUndo(log.rows, range, identity);
  expect(logDerived).toBe(oracle.text);
  expect(!!res).toBe(oracle.popped);
  return { logDerived, inverse: res };
}

describe('computeInverse', () => {
  test('basic insert-edit inverse removes exactly the inserted content', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Original text.')]));
    const range = log.edit(AGENT, (d, f) => f.get(0).get(0).insert(14, ' AGENT ADDITION'));

    const res = computeInverse(log.rows, range, AGENT);
    expect(res).not.toBeNull();
    expect(applyInverse(log, res.inverseUpdate)).toBe('<paragraph>Original text.</paragraph>');
  });

  test('basic delete-edit inverse restores the deleted content', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => {
      f.insert(0, [para('Keep this.'), para('Agent deletes this.')]);
    });
    const range = log.edit(AGENT, (d, f) => f.delete(1, 1));
    expect(log.text()).toBe('<paragraph>Keep this.</paragraph>');

    const res = computeInverse(log.rows, range, AGENT);
    expect(res).not.toBeNull();
    expect(applyInverse(log, res.inverseUpdate)).toBe(
      '<paragraph>Keep this.</paragraph><paragraph>Agent deletes this.</paragraph>'
    );
  });

  test('multi-row edit (several updates) inverts as ONE unit', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Base.')]));
    // Simulate one modify call landing as two rows (script + sanitization pass)
    const r1 = log.edit(AGENT, (d, f) => f.get(0).get(0).insert(5, ' first'));
    const r2 = log.edit(AGENT, (d, f) => f.get(0).get(0).insert(11, ' second'));
    const range = { clockStart: r1.clockStart, clockEnd: r2.clockEnd };
    expect(log.text()).toBe('<paragraph>Base. first second</paragraph>');

    const res = computeInverse(log.rows, range, AGENT);
    expect(res).not.toBeNull();
    expect(applyInverse(log, res.inverseUpdate)).toBe('<paragraph>Base.</paragraph>');
  });

  test('interleaved foreign rows inside the range are never inverted (FR-001/FR-029)', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Start.')]));
    const r1 = log.edit(AGENT, (d, f) => f.get(0).get(0).insert(6, ' A1'));
    log.edit(HUMAN, (d, f) => f.insert(1, [para('Human interleaved.')])); // foreign row inside range
    const r2 = log.edit(AGENT, (d, f) => f.get(0).get(0).insert(9, ' A2'));
    const range = { clockStart: r1.clockStart, clockEnd: r2.clockEnd };

    const res = computeInverse(log.rows, range, AGENT);
    expect(res).not.toBeNull();
    expect(applyInverse(log, res.inverseUpdate)).toBe(
      '<paragraph>Start.</paragraph><paragraph>Human interleaved.</paragraph>'
    );
  });

  test('rows in the range attributed to a DIFFERENT agent of the same user are not inverted', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Doc.')]));
    const r1 = log.edit(AGENT, (d, f) => f.get(0).get(0).insert(4, ' mine'));
    const r2 = log.edit(OTHER_AGENT, (d, f) => f.get(0).get(0).insert(9, ' theirs'));
    const range = { clockStart: r1.clockStart, clockEnd: r2.clockEnd };

    const res = computeInverse(log.rows, range, AGENT);
    expect(res).not.toBeNull();
    expect(applyInverse(log, res.inverseUpdate)).toBe('<paragraph>Doc. theirs</paragraph>');
  });

  test('returns null (honest empty) when the edit is fully superseded', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Stable.')]));
    const range = log.edit(AGENT, (d, f) => f.insert(1, [para('Ephemeral agent paragraph.')]));
    // A later human edit deletes the agent's whole insertion.
    log.edit(HUMAN, (d, f) => f.delete(1, 1));

    const res = computeInverse(log.rows, range, AGENT);
    expect(res).toBeNull();
  });

  test('returns null when the range contains no rows for the identity', () => {
    const log = new LogBuilder();
    const range = log.edit(HUMAN, (d, f) => f.insert(0, [para('Human only.')]));
    const res = computeInverse(log.rows, range, AGENT);
    expect(res).toBeNull();
  });

  test('inverse is the minimal transaction payload, not a full-DeleteSet state diff', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('One.'), para('Two.'), para('Three.')]));
    // Unrelated earlier deletion by the human — a full-state DeleteSet diff
    // would carry this deletion; the minimal transaction payload must not.
    const humanDelete = log.edit(HUMAN, (d, f) => f.delete(2, 1));
    const range = log.edit(AGENT, (d, f) => f.get(0).get(0).insert(4, ' AGENT'));

    const res = computeInverse(log.rows, range, AGENT);
    expect(res).not.toBeNull();

    // Decode the inverse's delete set: it must only target the agent edit's
    // own struct ranges — not the human's unrelated deletion.
    const humanDeletedRanges = [];
    for (const r of log.rows.slice(humanDelete.clockStart, humanDelete.clockEnd + 1)) {
      const ds = Y.decodeUpdate(r.updateData).ds;
      for (const [client, items] of ds.clients) {
        for (const item of items) humanDeletedRanges.push({ client, clock: item.clock, len: item.len });
      }
    }
    expect(humanDeletedRanges.length).toBeGreaterThan(0);

    const inverseDs = Y.decodeUpdate(res.inverseUpdate).ds;
    for (const { client, clock, len } of humanDeletedRanges) {
      const items = inverseDs.clients.get(client) || [];
      for (const item of items) {
        const overlaps = item.clock < clock + len && clock < item.clock + item.len;
        expect(overlaps).toBe(false);
      }
    }
  });

  test('parity oracle: log-derived inverse matches a real live-session UndoManager.undo() byte-for-byte', () => {
    // The same scenario driven two ways: (a) through the log rebuild +
    // computeInverse, (b) through a live doc with a real Y.UndoManager
    // tracking the agent's transactions — the mechanism 016 retires. The
    // resulting serializations must be identical.
    const ops = [
      { who: HUMAN, target: false, fn: (d, f) => f.insert(0, [para('Intro paragraph.')]) },
      { who: AGENT, target: true, fn: (d, f) => f.insert(1, [para('Agent-added summary.')]) },
      { who: HUMAN, target: false, fn: (d, f) => f.get(0).get(0).insert(16, ' (edited by human)') },
      { who: HUMAN, target: false, fn: (d, f) => f.get(1).get(0).insert(20, ' Human touched this too.') },
    ];

    // (a) log-derived
    const log = new LogBuilder();
    let range = null;
    for (const op of ops) {
      const r = log.edit(op.who, op.fn);
      if (op.target) range = range ? { clockStart: range.clockStart, clockEnd: r.clockEnd } : r;
    }
    const res = computeInverse(log.rows, range, AGENT);
    const logDerived = res ? applyInverse(log, res.inverseUpdate) : log.text();

    // (b) live-session oracle
    const doc = new Y.Doc();
    const frag = doc.get('default', Y.XmlFragment);
    const um = new Y.UndoManager(frag, {
      trackedOrigins: new Set(['tracked']),
      captureTimeout: Number.MAX_SAFE_INTEGER,
    });
    for (const op of ops) {
      doc.transact(() => op.fn(doc, frag), op.target ? 'tracked' : 'untracked');
    }
    um.undo();
    const oracle = frag.toString();

    expect(logDerived).toBe(oracle);
    um.destroy();
    doc.destroy();
  });

  test('a clock-SET range inverts exactly the listed rows — interleaved same-identity rows survive (M1)', () => {
    // Two same-identity calls interleave in the log: A's recorded [min,max]
    // range spans B's rows. With the exact clock set, undoing A must leave
    // B's content byte-for-byte intact.
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Base.')]));
    const b1 = log.edit(AGENT, (d, f) => { const t = f.get(0).get(0); t.insert(t.length, ' B1'); });
    const a1 = log.edit(AGENT, (d, f) => { const t = f.get(0).get(0); t.insert(t.length, ' A1'); });
    const b2 = log.edit(AGENT, (d, f) => { const t = f.get(0).get(0); t.insert(t.length, ' B2'); });
    const a2 = log.edit(AGENT, (d, f) => { const t = f.get(0).get(0); t.insert(t.length, ' A2'); });
    expect(log.text()).toBe('<paragraph>Base. B1 A1 B2 A2</paragraph>');

    const res = computeInverse(log.rows, {
      clockStart: a1.clockStart,
      clockEnd: a2.clockEnd,
      clocks: [a1.clockStart, a2.clockStart],
    }, AGENT);
    expect(res).not.toBeNull();
    expect(applyInverse(log, res.inverseUpdate)).toBe('<paragraph>Base. B1 B2</paragraph>');

    // The spanning-range fallback (no clock set — legacy rows) keeps its
    // documented behavior: every identity row in [min,max] inverts.
    const spanning = computeInverse(log.rows, {
      clockStart: b1.clockStart,
      clockEnd: b2.clockEnd,
    }, AGENT);
    expect(spanning).not.toBeNull();
    expect(applyInverse(log, spanning.inverseUpdate)).toBe('<paragraph>Base. A2</paragraph>');
  });

  test('live-doc merge: supersession is evaluated against merged live state (FR-013)', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Base.')]));
    const range = log.edit(AGENT, (d, f) => f.insert(1, [para('Agent paragraph.')]));

    // A live doc holds an in-flight, NOT-yet-logged edit deleting the agent's
    // paragraph. With the live doc merged, the edit is fully superseded.
    const liveDoc = log.buildDoc();
    liveDoc.get('default', Y.XmlFragment).delete(1, 1);

    const res = computeInverse(log.rows, range, AGENT, liveDoc);
    expect(res).toBeNull();

    // Without the live merge the inverse would exist.
    const res2 = computeInverse(log.rows, range, AGENT);
    expect(res2).not.toBeNull();
  });
});

/**
 * US2 semantics matrix (T016, SC-003/SC-004): every pole byte-compared, and —
 * the parity oracle — asserted equal to a real live-session
 * Y.UndoManager.undo() over the same scenario. popStackItem parity IS the
 * Sam-ratified semantics; where a naive reading of "superseded" differs from
 * what popStackItem does (e.g. concurrent duplicate deletions), the oracle
 * wins by definition.
 */
describe('popStackItem-parity matrix (US2)', () => {
  test('human edits before, after, and inside the agent insertion: only the agent contribution reverts', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Alpha.')]));
    const range = log.edit(AGENT, (d, f) => f.insert(1, [para('Agent paragraph.')]));
    log.edit(HUMAN, (d, f) => f.get(0).get(0).insert(6, ' BEFORE-EDIT')); // before the insertion
    log.edit(HUMAN, (d, f) => f.insert(2, [para('After paragraph.')])); // after it
    log.edit(HUMAN, (d, f) => f.get(1).get(0).insert(16, ' HUMAN-INSIDE')); // inside it

    const { logDerived } = bothWays(log, range);
    // The agent's paragraph goes (with it, the text typed inside its element —
    // exactly what popStackItem does); everything else byte-preserved.
    expect(logDerived).toBe(
      '<paragraph>Alpha. BEFORE-EDIT</paragraph><paragraph>After paragraph.</paragraph>'
    );
  });

  test('agent-deleted paragraph is restored', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('One.'), para('Two.'), para('Three.')]));
    const range = log.edit(AGENT, (d, f) => f.delete(1, 1));
    expect(log.text()).toBe('<paragraph>One.</paragraph><paragraph>Three.</paragraph>');

    const { logDerived } = bothWays(log, range);
    expect(logDerived).toBe(
      '<paragraph>One.</paragraph><paragraph>Two.</paragraph><paragraph>Three.</paragraph>'
    );
  });

  test('content the agent deleted whose parent a later edit removed stays deleted — honest empty', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Keep.'), para('Agent trims this sentence. Rest stays.')]));
    const range = log.edit(AGENT, (d, f) => f.get(1).get(0).delete(0, 27));
    // A later edit removes the WHOLE paragraph the agent had trimmed inside —
    // the restoration target's parent is gone: supersession skip (FR-010),
    // and with nothing else in the edit, the honest empty result (FR-011).
    log.edit(HUMAN, (d, f) => f.delete(1, 1));

    const { logDerived, inverse } = bothWays(log, range);
    expect(inverse).toBeNull();
    expect(logDerived).toBe('<paragraph>Keep.</paragraph>');
  });

  test('concurrent duplicate deletion of the same content: exact popStackItem parity', () => {
    // A collaborator who had NOT yet seen the agent's deletion deletes the
    // same paragraph concurrently. popStackItem restores it on undo (the
    // delete halves merge; restoration wins) — parity, not intuition, is the
    // ratified contract, so the oracle defines the expectation.
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('A.'), para('B.')]));
    const snap = log.snapshot();
    const range = log.edit(AGENT, (d, f) => f.delete(1, 1));
    log.forkEdit(HUMAN, snap, (d, f) => f.delete(1, 1)); // concurrent same-target delete

    bothWays(log, range); // byte parity with the real UndoManager is the assertion
  });

  test('insertion partially rewritten later: only the surviving parts are removed', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Base.')]));
    const range = log.edit(AGENT, (d, f) => f.get(0).get(0).insert(5, ' AGENT WROTE THIS'));
    // Human rewrites the middle of the agent's insertion.
    log.edit(HUMAN, (d, f) => {
      const t = log.frag.get(0).get(0);
      t.delete(11, 5); // ' AGENT [WROTE] THIS' -> the human's replacement below
      t.insert(11, 'REWROTE');
    });

    const { logDerived } = bothWays(log, range);
    // Agent's surviving characters removed; the human's REWROTE preserved.
    expect(logDerived).toBe('<paragraph>Base.REWROTE</paragraph>');
  });

  test('created-and-deleted-within-edit churn is not resurrected', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Stable.')]));
    const r1 = log.edit(AGENT, (d, f) => f.insert(1, [para('Scratch work')]));
    const r2 = log.edit(AGENT, (d, f) => {
      f.delete(1, 1);
      f.insert(1, [para('Final agent text.')]);
    });
    const range = { clockStart: r1.clockStart, clockEnd: r2.clockEnd };
    expect(log.text()).toBe('<paragraph>Stable.</paragraph><paragraph>Final agent text.</paragraph>');

    const { logDerived } = bothWays(log, range);
    // The whole edit reverts as one unit; the internal scratch paragraph the
    // edit itself deleted does NOT come back.
    expect(logDerived).toBe('<paragraph>Stable.</paragraph>');
    expect(logDerived).not.toContain('Scratch');
  });

  test('formatting-only edit (bold) reverts under the same rules (FR-012)', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Some emphasised words here.')]));
    const range = log.edit(AGENT, (d, f) => f.get(0).get(0).format(5, 10, { bold: true }));
    expect(log.text()).toBe('<paragraph>Some <bold>emphasised</bold> words here.</paragraph>');

    const { logDerived } = bothWays(log, range);
    expect(logDerived).toBe('<paragraph>Some emphasised words here.</paragraph>');
  });

  test('formatting later overridden on the same text is not resurrected', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Some emphasised words here.')]));
    const range = log.edit(AGENT, (d, f) => f.get(0).get(0).format(5, 10, { bold: true }));
    // A later edit overrides the same span's formatting entirely.
    log.edit(HUMAN, (d, f) => f.get(0).get(0).format(5, 10, { bold: null, italic: true }));

    const { logDerived } = bothWays(log, range);
    // Parity with popStackItem; whatever the exact outcome, the agent's bold
    // must NOT be resurrected over the human's override.
    expect(logDerived).not.toContain('<bold>');
    expect(logDerived).toContain('emphasised');
  });

  test('fully superseded edit: null inverse, byte-stable document (SC-004)', () => {
    const log = new LogBuilder();
    log.edit(HUMAN, (d, f) => f.insert(0, [para('Stable.')]));
    const range = log.edit(AGENT, (d, f) => f.insert(1, [para('Doomed insertion.')]));
    log.edit(HUMAN, (d, f) => f.delete(1, 1)); // everything the edit did is gone

    const { logDerived, inverse } = bothWays(log, range);
    expect(inverse).toBeNull();
    expect(logDerived).toBe('<paragraph>Stable.</paragraph>');
  });
});
