/**
 * Forensic resupply resolution (feature 045, Phase 2).
 *
 * The resolution matrix is exercised with FABRICATED rows — real Yjs updates
 * paired with a deliberately wrong stamp — against an in-memory reader. That is
 * this feature's whole substrate by design (research R15): the real
 * reconnect end-to-end assertion belongs to 043, which merges after 045, so
 * nothing here builds a WebSocket harness.
 */
const Y = require('yjs');
const resolution = require('../resupply-resolution');

/** A Y.Doc with a pinned client identity (the thing resolution binds to users). */
function docWithClient(clientID) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return doc;
}

/** Capture the update bytes produced by one edit. */
function capture(doc, edit) {
  let bytes = null;
  const handler = (update) => { bytes = update; };
  doc.on('update', handler);
  edit();
  doc.off('update', handler);
  return bytes;
}

function insert(doc, text) {
  return capture(doc, () => doc.getText('body').insert(0, text));
}

/**
 * An in-memory stand-in for the three PostgresPersistence readers, with call
 * counters. Rows are `{ clock, userId, agentName, viaSync, updateData }`.
 */
function makeReader(rowsByDoc, users = {}) {
  const calls = { payloads: 0, evidence: 0, users: 0 };
  return {
    calls,
    async getUpdatePayloads(docGuid, clocks) {
      calls.payloads += 1;
      if (!clocks || clocks.length === 0) return [];
      return (rowsByDoc[docGuid] || [])
        .filter(r => clocks.includes(r.clock))
        .sort((a, b) => a.clock - b.clock)
        .map(r => ({ clock: r.clock, updateData: r.updateData }));
    },
    async getDirectAttributedRows(docGuid, { afterClock = -1, beforeClock, limit = 500 } = {}) {
      calls.evidence += 1;
      return (rowsByDoc[docGuid] || [])
        .filter(r => r.viaSync !== true && r.userId != null)
        .filter(r => r.clock > afterClock && r.clock < beforeClock)
        .sort((a, b) => a.clock - b.clock)
        .slice(0, limit)
        .map(r => ({ clock: r.clock, userId: r.userId, agentName: r.agentName || null, updateData: r.updateData }));
    },
    async getUserDisplayFields(ids) {
      calls.users += 1;
      const out = new Map();
      for (const id of ids) {
        if (users[id]) out.set(id, users[id]);
      }
      return out;
    },
  };
}

const DOC = 'doc-045';

beforeEach(() => resolution._resetForTest());

describe('origin extraction (FR-002, FR-005)', () => {
  test('an insert payload reports its inserting client; a deletion-only payload reports nothing', () => {
    const author = docWithClient(1111);
    const insertBytes = insert(author, 'alpha');
    expect(resolution.originClientIds(insertBytes)).toEqual([1111]);

    // A second client deletes the first client's content. The delete set names
    // the DELETED content's author, which must never attribute the deleter.
    const deleter = docWithClient(2222);
    Y.applyUpdate(deleter, Y.encodeStateAsUpdate(author));
    const deleteBytes = capture(deleter, () => deleter.getText('body').delete(0, 5));
    expect(resolution.originClientIds(deleteBytes)).toEqual([]);
    expect([...Y.decodeUpdate(deleteBytes).ds.clients.keys()]).toEqual([1111]);
  });
});

describe('resolution matrix', () => {
  test('a single relayed origin resolves to its true author, never the relayer (FR-002)', async () => {
    const a = docWithClient(101);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'bravo') },
    ];
    const reader = makeReader({ [DOC]: rows }, { 'user-A': { userName: 'Ada', userEmail: 'a@x', userPicture: null } });

    const ctx = await resolution.resolveForRows(reader, DOC, rows.map(r => ({ ...r, updateData: undefined })));
    expect(ctx.outcomes.get(2)).toEqual({ origins: [{ userId: 'user-A', agentName: null }], unresolved: false });
    expect(ctx.directory.get('user-A')).toEqual({ userName: 'Ada', userEmail: 'a@x', userPicture: null });
  });

  test('an agent origin resolves to the (userId, agentName) pair (US1 scenario 4)', async () => {
    const agentDoc = docWithClient(202);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: 'claude', viaSync: null, updateData: insert(agentDoc, 'alpha') },
      { clock: 2, userId: 'user-H', agentName: null, viaSync: true, updateData: insert(agentDoc, 'bravo') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(2)).toEqual({
      origins: [{ userId: 'user-A', agentName: 'claude' }],
      unresolved: false,
    });
  });

  test('one client identity bound to two users is AMBIGUOUS and refuses (FR-006)', async () => {
    const shared = docWithClient(303);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(shared, 'alpha') },
      { clock: 2, userId: 'user-C', agentName: null, viaSync: null, updateData: insert(shared, 'bravo') },
      { clock: 3, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(shared, 'charlie') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(3)).toEqual({ origins: [], unresolved: true });
  });

  test('the same user acting as themselves and as an agent is ambiguous (identity is the PAIR)', async () => {
    const shared = docWithClient(313);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(shared, 'alpha') },
      { clock: 2, userId: 'user-A', agentName: 'claude', viaSync: null, updateData: insert(shared, 'bravo') },
      { clock: 3, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(shared, 'charlie') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(3).unresolved).toBe(true);
  });

  test('no prior evidence at all ⇒ unresolved (FR-004)', async () => {
    const stranger = docWithClient(404);
    const rows = [
      { clock: 1, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(stranger, 'alpha') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(1)).toEqual({ origins: [], unresolved: true });
  });

  test('a deletion-only relayed payload attributes nobody (FR-005)', async () => {
    const a = docWithClient(505);
    const evidence = insert(a, 'alpha');
    const b = docWithClient(606);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const deletion = capture(b, () => b.getText('body').delete(0, 5));
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: evidence },
      { clock: 2, userId: 'user-R', agentName: null, viaSync: true, updateData: deletion },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    // The delete set names user-A's content; crediting A (or the relayer) would
    // both be lies about who did the deleting.
    expect(ctx.outcomes.get(2)).toEqual({ origins: [], unresolved: true });
  });

  test('multi-origin partial resolution credits what resolves and flags the rest (FR-005)', async () => {
    const a = docWithClient(707);
    const stranger = docWithClient(808);
    const merged = new Y.Doc();
    Y.applyUpdate(merged, insert(a, 'alpha'));
    Y.applyUpdate(merged, insert(stranger, 'bravo'));
    const combined = Y.encodeStateAsUpdate(merged);

    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'seed') },
      { clock: 2, userId: 'user-R', agentName: null, viaSync: true, updateData: combined },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(2)).toEqual({
      origins: [{ userId: 'user-A', agentName: null }],
      unresolved: true,
    });
  });

  test('self-relay with prior evidence keeps its author, with no hedging (SC-002)', async () => {
    const a = docWithClient(909);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-A', agentName: null, viaSync: true, updateData: insert(a, 'bravo') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(2)).toEqual({
      origins: [{ userId: 'user-A', agentName: null }],
      unresolved: false,
    });
  });

  test('a via_sync row is never evidence for another via_sync row (relay chains cannot launder)', async () => {
    const a = docWithClient(1010);
    const rows = [
      // The only row that could bind client 1010 is itself sync-relayed.
      { clock: 1, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-C', agentName: null, viaSync: true, updateData: insert(a, 'bravo') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(2)).toEqual({ origins: [], unresolved: true });
    expect(ctx.outcomes.get(1)).toEqual({ origins: [], unresolved: true });
  });

  test('evidence never crosses documents (FR-006)', async () => {
    const a = docWithClient(1111);
    const otherDocRows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
    ];
    const rows = [
      { clock: 1, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'bravo') },
    ];
    const reader = makeReader({ 'other-doc': otherDocRows, [DOC]: rows });
    const ctx = await resolution.resolveForRows(reader, DOC, rows);
    expect(ctx.outcomes.get(1)).toEqual({ origins: [], unresolved: true });
  });

  test('an unattributed row is not evidence (user_id IS NOT NULL)', async () => {
    const a = docWithClient(1212);
    const rows = [
      { clock: 1, userId: null, agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'bravo') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(2).unresolved).toBe(true);
  });

  test('later rows are never evidence — only strictly prior ones (R2)', async () => {
    const a = docWithClient(1313);
    const rows = [
      { clock: 1, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'alpha') },
      // A's direct row arrives AFTER the relayed row: it cannot make the earlier
      // row resolve, or the same row would answer differently over time.
      { clock: 2, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'bravo') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(1)).toEqual({ origins: [], unresolved: true });
  });

  test('rows with via_sync NULL or false are never resolved at all (FR-008, 038 contract)', async () => {
    const a = docWithClient(1414);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-B', agentName: null, viaSync: false, updateData: insert(a, 'bravo') },
    ];
    const reader = makeReader({ [DOC]: rows });
    const ctx = await resolution.resolveForRows(reader, DOC, rows);
    expect(ctx).toBe(resolution.EMPTY_RESOLUTION);
    expect(reader.calls).toEqual({ payloads: 0, evidence: 0, users: 0 });
  });

  test('historical rows resolve with no backfill — resolution reads the log as it stands (FR-008)', async () => {
    // The relayed row and its evidence are both "already in production": nothing
    // was written by this feature, and no column was added.
    const a = docWithClient(1515);
    const rows = [
      { clock: 40, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 91, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'bravo') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(91).origins).toEqual([{ userId: 'user-A', agentName: null }]);
  });
});

describe('degradation and cost ceiling', () => {
  test('an evidence query failure degrades to unresolved and never throws', async () => {
    const a = docWithClient(1616);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'bravo') },
    ];
    const reader = makeReader({ [DOC]: rows });
    reader.getDirectAttributedRows = async () => { throw new Error('database is on fire'); };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const ctx = await resolution.resolveForRows(reader, DOC, rows);
    expect(ctx.outcomes.get(2)).toEqual({ origins: [], unresolved: true });
    errSpy.mockRestore();
  });

  test('an undecodable payload degrades that row only', async () => {
    const a = docWithClient(1717);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-B', agentName: null, viaSync: true, updateData: new Uint8Array([9, 9, 9, 9]) },
      { clock: 3, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'bravo') },
    ];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(2)).toEqual({ origins: [], unresolved: true });
    expect(ctx.outcomes.get(3).origins).toEqual([{ userId: 'user-A', agentName: null }]);
    warnSpy.mockRestore();
  });

  test('the evidence cap refuses honestly instead of guessing from partial evidence', async () => {
    const a = docWithClient(1818);
    const rows = [];
    for (let clock = 1; clock <= 5; clock++) {
      rows.push({ clock, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, `e${clock}`) });
    }
    rows.push({ clock: 6, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'relayed') });

    process.env.RESUPPLY_EVIDENCE_MAX_ROWS = '2';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
      expect(ctx.outcomes.get(6)).toEqual({ origins: [], unresolved: true });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('evidence cap reached'));
    } finally {
      delete process.env.RESUPPLY_EVIDENCE_MAX_ROWS;
      warnSpy.mockRestore();
    }
  });

  test('a missing payload row leaves exactly one target unresolved', async () => {
    const a = docWithClient(1919);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-B', agentName: null, viaSync: true, updateData: null },
    ];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(2)).toEqual({ origins: [], unresolved: true });
    warnSpy.mockRestore();
  });
});

describe('cost and reuse (FR-009 / SC-005)', () => {
  test('a document with no via_sync rows performs zero queries and zero decodes', async () => {
    const a = docWithClient(2020);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-A', agentName: null, viaSync: false, updateData: insert(a, 'bravo') },
    ];
    const reader = makeReader({ [DOC]: rows });
    await resolution.resolveForRows(reader, DOC, rows);
    expect(reader.calls).toEqual({ payloads: 0, evidence: 0, users: 0 });
    expect(resolution._stats()).toEqual({ evidenceRowsDecoded: 0, targetRowsDecoded: 0, evidenceQueries: 0 });
  });

  test('a repeated request over already-resolved history performs zero additional decodes', async () => {
    const a = docWithClient(2121);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'bravo') },
      { clock: 3, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'charlie') },
    ];
    const reader = makeReader({ [DOC]: rows });

    const first = await resolution.resolveForRows(reader, DOC, rows);
    const afterFirst = resolution._stats();
    expect(afterFirst.targetRowsDecoded).toBe(1);
    expect(afterFirst.evidenceRowsDecoded).toBeGreaterThan(0);

    const second = await resolution.resolveForRows(reader, DOC, rows);
    expect(resolution._stats()).toEqual(afterFirst);
    expect(reader.calls.payloads).toBe(1);
    expect(reader.calls.evidence).toBe(afterFirst.evidenceQueries);
    expect(second.outcomes.get(3)).toEqual(first.outcomes.get(3));
  });

  test('first-render evidence cost is bounded by the rows before the highest target', async () => {
    const a = docWithClient(2222);
    const rows = [];
    for (let clock = 1; clock <= 6; clock++) {
      rows.push({ clock, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, `e${clock}`) });
    }
    rows.splice(3, 0, { clock: 3.5, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'relayed') });

    const reader = makeReader({ [DOC]: rows });
    await resolution.resolveForRows(reader, DOC, rows);
    // Rows at clocks 1-3 only: the scan stops at the target's own clock.
    expect(resolution._stats().evidenceRowsDecoded).toBe(3);
  });

  test('display fields are looked up per request, never cached with the outcome (R6)', async () => {
    const a = docWithClient(2323);
    const evidenceRow = { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(a, 'alpha') };
    const relayed = { clock: 2, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'bravo') };
    const users = { 'user-A': { userName: 'Ada', userEmail: 'a@x', userPicture: null } };
    const reader = makeReader({ [DOC]: [evidenceRow, relayed] }, users);

    // The caller's window carries no display fields for user-A, so the batched
    // users lookup fills them in.
    const first = await resolution.resolveForRows(reader, DOC, [relayed]);
    expect(first.directory.get('user-A').userName).toBe('Ada');

    users['user-A'] = { userName: 'Ada Lovelace', userEmail: 'a@x', userPicture: null };
    const second = await resolution.resolveForRows(reader, DOC, [relayed]);
    expect(second.directory.get('user-A').userName).toBe('Ada Lovelace');
  });

  test('a resolved id with no users row stays out of the directory (deleted account, RBD-045-11)', async () => {
    const a = docWithClient(2424);
    const rows = [
      { clock: 1, userId: 'user-gone', agentName: null, viaSync: null, updateData: insert(a, 'alpha') },
      { clock: 2, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(a, 'bravo') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }, {}), DOC, [rows[1]]);
    expect(ctx.outcomes.get(2).origins).toEqual([{ userId: 'user-gone', agentName: null }]);
    expect(ctx.directory.has('user-gone')).toBe(false);
  });
});
