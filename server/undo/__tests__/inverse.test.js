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
