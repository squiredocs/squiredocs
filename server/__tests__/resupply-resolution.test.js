/**
 * Forensic resupply resolution (feature 045, Phase 2).
 *
 * The resolution matrix is exercised with FABRICATED rows — real Yjs updates
 * paired with a deliberately wrong stamp — against an in-memory reader. That is
 * this feature's whole substrate by design (research R15): the real
 * reconnect end-to-end assertion belongs to 043, which merges after 045, so
 * nothing here builds a WebSocket harness.
 */
const fs = require('fs');
const path = require('path');
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

/**
 * The same reader with an await inside every evidence query, plus an overlap
 * detector. Two resolutions started before either finishes MUST NOT be inside
 * the fold at the same time — the fold is shared per-document state mutated
 * across awaits (045-review MEDIUM-2).
 */
function makeInterleavingReader(rowsByDoc, users = {}) {
  const base = makeReader(rowsByDoc, users);
  const trace = { inFold: 0, overlapped: false };
  return {
    ...base,
    trace,
    async getDirectAttributedRows(docGuid, opts) {
      trace.inFold += 1;
      if (trace.inFold > 1) trace.overlapped = true;
      try {
        await new Promise(resolve => setImmediate(resolve));
        return await base.getDirectAttributedRows(docGuid, opts);
      } finally {
        trace.inFold -= 1;
      }
    },
  };
}

const DOC = 'doc-045';

/** The chat assistant writes ONLY through the shared server doc (N-045-2). */
const { CHAT_AGENT_NAME } = require('../agent-identity');

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

  test('a payload whose net effect is nothing still names the created-then-deleted content (045-review LOW-5)', () => {
    // The deletion rule is structural for the DELETE SET only. A resupply diff
    // spans a window, and content created AND deleted inside that window is
    // carried as structs (GC placeholders once yjs has collected them), so its
    // AUTHOR is an origin even though nothing became visible. Never the deleter,
    // never the relayer — but not "nobody" either, which is what the module
    // header used to imply.
    const author = docWithClient(3030);
    const peer = docWithClient(3040);
    author.getText('body').insert(0, 'kept');
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(author));
    const caughtUp = Y.encodeStateVector(peer);

    author.getText('body').insert(4, 'transient');
    author.getText('body').delete(4, 9);

    const window = Y.encodeStateAsUpdate(author, caughtUp);
    expect(resolution.originClientIds(window)).toEqual([3030]);
  });
});

describe('the shared server doc never binds an identity (045-review HIGH-1, N-045-2)', () => {
  test('content created through the chat assistant resolves as Synced content, not as whoever acted first', async () => {
    // ONE live WSSharedDoc, ONE Yjs client identity, many acting identities.
    // X's assistant edit commits; Y's assistant edit is lost in a crash and
    // resupplied by a third browser. Binding the shared identity would credit X
    // for Y's words — systematically, on every surface.
    const sharedServerDoc = docWithClient(4040);
    const rows = [
      { clock: 1, userId: 'user-X', agentName: CHAT_AGENT_NAME, viaSync: null, updateData: insert(sharedServerDoc, 'x wrote this') },
      { clock: 2, userId: 'user-Z', agentName: null, viaSync: true, updateData: insert(sharedServerDoc, 'y wrote this') },
    ];
    const users = { 'user-X': { userName: 'Xavier', userEmail: 'x@x', userPicture: null } };
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }, users), DOC, rows);
    expect(ctx.outcomes.get(2)).toEqual({ origins: [], unresolved: true });
  });

  test("this instance's own live shared-doc identity never binds", async () => {
    const sharedServerDoc = docWithClient(4141);
    resolution.init({ peekSharedDoc: (guid) => (guid === DOC ? { clientID: 4141 } : null) });
    const rows = [
      // A plain human stamp on a server-side write (a title set, a seed, a
      // restore) — no agent name to give the shared doc away.
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(sharedServerDoc, 'alpha') },
      { clock: 2, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(sharedServerDoc, 'bravo') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(2)).toEqual({ origins: [], unresolved: true });
  });

  test('learning the live shared-doc identity drops outcomes already memoized under it', async () => {
    const sharedServerDoc = docWithClient(4242);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(sharedServerDoc, 'alpha') },
      { clock: 2, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(sharedServerDoc, 'bravo') },
    ];
    const reader = makeReader({ [DOC]: rows });

    const before = await resolution.resolveForRows(reader, DOC, rows);
    expect(before.outcomes.get(2).origins).toEqual([{ userId: 'user-A', agentName: null }]);

    resolution.init({ peekSharedDoc: () => ({ clientID: 4242 }) });
    const after = await resolution.resolveForRows(reader, DOC, rows);
    expect(after.outcomes.get(2)).toEqual({ origins: [], unresolved: true });
  });

  test('an agent session with its OWN doc still resolves — the poison is scoped to shared-doc writers', async () => {
    // MCP sessions open their own Y.Doc (research R12), so their client identity
    // does determine an author. US1 scenario 4 must keep working.
    const agentSessionDoc = docWithClient(4343);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: 'claude', viaSync: null, updateData: insert(agentSessionDoc, 'alpha') },
      { clock: 2, userId: 'user-H', agentName: null, viaSync: true, updateData: insert(agentSessionDoc, 'bravo') },
    ];
    const ctx = await resolution.resolveForRows(makeReader({ [DOC]: rows }), DOC, rows);
    expect(ctx.outcomes.get(2)).toEqual({
      origins: [{ userId: 'user-A', agentName: 'claude' }],
      unresolved: false,
    });
  });
});

describe('concurrent resolutions (045-review MEDIUM-2)', () => {
  test('two readers of one document never share the fold, and both answers stand', async () => {
    // Two viewers opening history at once, or a timeline render racing an MCP
    // read. The evidence fold is shared per-document state mutated across
    // awaits: interleaved, one run snapshots against a map the other wiped (a
    // false "Synced content", memoized forever) or against bindings from rows
    // at or after its own clock (a resolution built from LATER evidence).
    const author = docWithClient(5050);
    const filler = docWithClient(5060);
    const rows = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(author, 'alpha') },
    ];
    for (let clock = 2; clock <= 12; clock++) {
      rows.push({ clock, userId: 'user-F', agentName: null, viaSync: null, updateData: insert(filler, `f${clock}`) });
    }
    const low = { clock: 6.5, userId: 'user-R', agentName: null, viaSync: true, updateData: insert(author, 'low') };
    const high = { clock: 20, userId: 'user-R', agentName: null, viaSync: true, updateData: insert(author, 'high') };
    rows.push(low, high);

    // One row per query, so the fold yields to the event loop between every
    // mutation of its shared state — the shape a real batched scan has.
    process.env.RESUPPLY_EVIDENCE_BATCH = '1';
    const reader = makeInterleavingReader({ [DOC]: rows });
    try {
      const [ctxHigh, ctxLow] = await Promise.all([
        resolution.resolveForRows(reader, DOC, [high]),
        resolution.resolveForRows(reader, DOC, [low]),
      ]);
      expect(reader.trace.overlapped).toBe(false);
      expect(ctxHigh.outcomes.get(20)).toEqual({ origins: [{ userId: 'user-A', agentName: null }], unresolved: false });
      expect(ctxLow.outcomes.get(6.5)).toEqual({ origins: [{ userId: 'user-A', agentName: null }], unresolved: false });
    } finally {
      delete process.env.RESUPPLY_EVIDENCE_BATCH;
    }
  });
});

describe('document deletion (045-review LOW-4)', () => {
  test('clearDoc drops the dead document\'s memoized outcomes so reused clocks answer fresh', async () => {
    const first = docWithClient(6060);
    const beforeDelete = [
      { clock: 1, userId: 'user-A', agentName: null, viaSync: null, updateData: insert(first, 'alpha') },
      { clock: 2, userId: 'user-B', agentName: null, viaSync: true, updateData: insert(first, 'bravo') },
    ];
    const before = await resolution.resolveForRows(makeReader({ [DOC]: beforeDelete }), DOC, beforeDelete);
    expect(before.outcomes.get(2).origins).toEqual([{ userId: 'user-A', agentName: null }]);

    // The document is deleted: every row is gone and clocks restart at 0. A
    // still-connected client writes new rows under the SAME guid at the same
    // clocks; they are a different document's content.
    resolution.clearDoc(DOC);

    const second = docWithClient(6161);
    const afterDelete = [
      { clock: 1, userId: 'user-C', agentName: null, viaSync: null, updateData: insert(second, 'gamma') },
      { clock: 2, userId: 'user-D', agentName: null, viaSync: true, updateData: insert(second, 'delta') },
    ];
    const after = await resolution.resolveForRows(makeReader({ [DOC]: afterDelete }), DOC, afterDelete);
    expect(after.outcomes.get(2).origins).toEqual([{ userId: 'user-C', agentName: null }]);
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
describe('scope guard (FR-010)', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  function importsResolver(relPath) {
    const full = path.join(repoRoot, relPath);
    if (!fs.existsSync(full)) return false;
    return fs.readFileSync(full, 'utf8').includes('resupply-resolution');
  }

  function filesIn(relDir) {
    const full = path.join(repoRoot, relDir);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full)
      .filter(f => f.endsWith('.js'))
      .map(f => path.join(relDir, f));
  }

  test('undo, diff and restore never import the resolver', () => {
    const forbidden = [
      ...filesIn('server/undo'),
      'server/diff-service.js',
      'server/live-apply.js',
    ];
    for (const file of forbidden) {
      expect({ file, imports: importsResolver(file) }).toEqual({ file, imports: false });
    }
  });

  test('every author-displaying surface consumes the resolver', () => {
    const consumers = [
      'server/version-history.js',
      'server/collab-guardrail.js',
      'server/mcp/tools/read-document.js',
      // The REST export's front-matter `lastModifiedBy` is the sixth author
      // surface and the only DURABLE one (045-review MEDIUM-3).
      'server/api/docs-export.js',
      // Feature 047 (NF-3): the two surfaces that make an "edited by X" claim
      // in prose to a model. `modify.js` is a write tool, but the resolution
      // only decides whom its conflict refusal NAMES — never whether to refuse.
      'server/api/chat.js',
      'server/mcp/tools/modify.js',
    ];
    for (const file of consumers) {
      expect({ file, imports: importsResolver(file) }).toEqual({ file, imports: true });
    }
  });

  test('the only non-display importers are the two wiring sites', () => {
    // `index.js` injects the live-shared-doc probe (N-045-2) and
    // `postgres-persistence.js` calls `clearDoc` when a document is deleted
    // (045-review LOW-4). Neither reads an outcome.
    const indexSrc = fs.readFileSync(path.join(repoRoot, 'server/index.js'), 'utf8');
    expect(indexSrc).toMatch(/resupplyResolution\.init\(\{\s*peekSharedDoc/);
    expect(indexSrc).not.toMatch(/resolveForRows/);

    const persistenceSrc = fs.readFileSync(path.join(repoRoot, 'server/postgres-persistence.js'), 'utf8');
    const clearDocument = persistenceSrc.slice(
      persistenceSrc.indexOf('async clearDocument('),
      persistenceSrc.indexOf('async clearAll(')
    );
    expect(clearDocument).toMatch(/resupplyResolution\.clearDoc\(docGuid\)/);
    expect(persistenceSrc).not.toMatch(/resolveForRows/);
  });

  test("undo's via_sync run-breaking guard is unchanged (038 D2)", () => {
    const legacy = fs.readFileSync(path.join(repoRoot, 'server/undo/legacy.js'), 'utf8');
    expect(legacy).toMatch(/viaSync/);
    // The guard reads the ROW's flag directly and refuses; it must not consult a
    // display resolution.
    expect(legacy).not.toMatch(/resolveForRows|resupply/);
  });

  test('the restore path in version-history never receives a resolution context', () => {
    const vh = fs.readFileSync(path.join(repoRoot, 'server/version-history.js'), 'utf8');
    const restore = vh.slice(vh.indexOf('async function restoreVersion'), vh.indexOf('async function getUpdatesForVersion'));
    expect(restore).not.toMatch(/resolveForRows|resolution/);
  });
});
