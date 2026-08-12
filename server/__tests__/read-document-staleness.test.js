/**
 * Feature 057 US1 — a read is never labelled with a clock it did not integrate
 * (FR-001/FR-002, contracts/read-staleness.md).
 *
 * THE DEFECT: `read_document` took `clock` straight from `MAX(clock)` in the
 * log and stapled it to whatever the pod happened to have in memory. A copy
 * holding rows {1, 5–9} was labelled 9. That label is what agents diff against,
 * gate edits on and cite in version history, so the lie propagated.
 *
 * HARNESS (the read-zero-writes pattern): the REAL handler against REAL
 * persistence, with only the WebSocket transport seam
 * (`agentPresence.getOrCreateSession`) stubbed so the test controls exactly
 * which rows the served document has integrated.
 */
const Y = require('yjs');
const { createPool, createPersistence, cleanupDocRows } = require('./helpers/db');

jest.mock('../mcp/agent-presence', () => ({
  getOrCreateSession: jest.fn(),
  queueHighlightSequence: jest.fn(),
}));

const agentPresence = require('../mcp/agent-presence');
const readDocument = require('../mcp/tools/read-document');
const documentService = require('../document-service');
const documents = require('../documents');
const collabReconcile = require('../collab-reconcile');
const telemetryMetrics = require('../telemetry/metrics');

describe('057 US1 — honest read labels', () => {
  let pool;
  let persistence;
  let userId;
  const docGuids = [];
  const agentToken = { userId: null, baseUrl: 'http://test' };

  /** Sequential incremental updates from one client; update i appends `para-i`. */
  function buildUpdateChain(count) {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    const updates = [];
    for (let i = 0; i < count; i++) {
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => {
        const el = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, `para-${i}`);
        el.insert(0, [t]);
        frag.push([el]);
      });
      updates.push(Y.encodeStateAsUpdate(doc, sv));
    }
    return updates;
  }

  /** A document row plus `count` update rows at clocks 0..count-1. */
  async function seedDoc(count) {
    const r = await pool.query(
      `INSERT INTO documents (id, title, creator_id) VALUES (uuid_generate_v4(), $1, $2) RETURNING id`,
      ['057 staleness', userId]
    );
    const docGuid = r.rows[0].id;
    docGuids.push(docGuid);
    // Access is granted by document_shares (or space membership), never by
    // creator_id — the versionId branch checks it.
    await pool.query(
      `INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)`,
      [docGuid, userId]
    );
    const updates = buildUpdateChain(count);
    for (let i = 0; i < count; i++) {
      await pool.query(
        'INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id) VALUES ($1, $2, $3, $4)',
        [docGuid, i, Buffer.from(updates[i]), userId]
      );
    }
    return { docGuid, updates };
  }

  /** Serve this doc as the agent session's document for the next read. */
  function serve(ydoc) {
    agentPresence.getOrCreateSession.mockResolvedValue({
      provider: { doc: ydoc },
      sessionId: 'session-057',
    });
    return ydoc;
  }

  /** A Y.Doc holding exactly the listed update indices. */
  function docHolding(updates, indices) {
    const doc = new Y.Doc();
    for (const i of indices) Y.applyUpdate(doc, updates[i]);
    return doc;
  }

  const read = (docGuid, args = {}) => readDocument.handler({ docGuid, format: 'markdown', ...args }, agentToken);

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    readDocument.init(persistence);
    documents.init(pool); // the versionId branch checks access through it
    const u = await pool.query(
      `INSERT INTO users (google_id, name, email) VALUES ($1, '057 User', $2) RETURNING id`,
      [`g-057-${Date.now()}`, `u057-${Date.now()}@example.com`]
    );
    userId = u.rows[0].id;
    agentToken.userId = userId;
  });

  afterAll(async () => {
    await cleanupDocRows(pool, docGuids);
    await pool.query('DELETE FROM document_shares WHERE user_id = $1 OR granted_by = $1', [userId]);
    for (const g of docGuids) await pool.query('DELETE FROM documents WHERE id = $1', [g]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
    await persistence.destroy?.();
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(documentService, 'peekSharedDoc').mockReturnValue(null);
  });

  // ── Acceptance 1 ──────────────────────────────────────────────────────────
  test('a CURRENT copy is labelled with the newest clock and carries no staleness fields', async () => {
    const { docGuid, updates } = await seedDoc(10);
    serve(docHolding(updates, [...Array(10).keys()]));

    const result = await read(docGuid);

    expect(result.clock).toBe(9);
    expect(result.newestClock).toBeUndefined();
    expect(result.stale).toBeUndefined();
    expect(result.stalenessNote).toBeUndefined();
  });

  // ── Acceptance 2 ──────────────────────────────────────────────────────────
  test('a LAGGING copy is labelled with what it integrated, and says so', async () => {
    const { docGuid, updates } = await seedDoc(10);
    const served = serve(docHolding(updates, [0, 1, 2, 3, 4, 5]));

    const result = await read(docGuid);

    expect(result.clock).toBe(5);          // NOT 9
    expect(result.newestClock).toBe(9);
    expect(result.stale).toBe(true);
    expect(typeof result.stalenessNote).toBe('string');
    expect(result.stalenessNote).toContain('9');
    expect(result.content).not.toContain('para-9');
    expect(served._verifiedClock).toBe(5);
  });

  // ── Acceptance 3 ──────────────────────────────────────────────────────────
  test('a TORN copy ({0,1} then {5..9}) is labelled 1 — the field-report shape', async () => {
    const { docGuid, updates } = await seedDoc(10);
    serve(docHolding(updates, [0, 1, 5, 6, 7, 8, 9]));

    const result = await read(docGuid);

    // Rows 2,3,4 are missing, so nothing above 1 is provably integrated.
    expect(result.clock).toBe(1);
    expect(result.newestClock).toBe(9);
    expect(result.stale).toBe(true);
  });

  test('the label can never exceed the integrated contiguous clock, over many tears', async () => {
    const { docGuid, updates } = await seedDoc(10);
    for (const cut of [0, 1, 2, 5, 8, 9]) {
      const held = [...Array(cut + 1).keys()];
      serve(docHolding(updates, held));
      const result = await read(docGuid);
      expect(result.clock).toBe(cut);
      expect(result.clock).toBeLessThanOrEqual(9);
    }
  });

  // ── Edge case: no spurious marker ────────────────────────────────────────
  test('a doc read straight after a fresh bind carries NO staleness marker and issues no suffix query', async () => {
    const { docGuid, updates } = await seedDoc(6);
    const bound = docHolding(updates, [0, 1, 2, 3, 4, 5]);
    bound._verifiedClock = 5;      // exactly what a completed bind sets
    bound._bindComplete = true;
    serve(bound);

    const suffixSpy = jest.spyOn(persistence, 'getUpdatesInRange');
    const result = await read(docGuid);

    expect(result.clock).toBe(5);
    expect(result.stale).toBeUndefined();
    expect(suffixSpy).not.toHaveBeenCalled(); // verified == newest ⇒ zero extra queries
  });

  test('a pod made current by FAN-OUT carries no spurious marker (verification proves currency)', async () => {
    const { docGuid, updates } = await seedDoc(8);
    // Fan-out messages carry no clock, so this doc has every row's CONTENT but
    // has never verified anything. A ledger-only scheme would call it stale.
    const fanoutCurrent = docHolding(updates, [...Array(8).keys()]);
    expect(fanoutCurrent._verifiedClock).toBeUndefined();
    serve(fanoutCurrent);

    const result = await read(docGuid);

    expect(result.clock).toBe(7);
    expect(result.stale).toBeUndefined();
    expect(result.newestClock).toBeUndefined();
  });

  test('a document with no update rows keeps its null clock and no staleness fields', async () => {
    const { docGuid } = await seedDoc(0);
    serve(new Y.Doc());

    const result = await read(docGuid);

    expect(result.clock).toBeNull();
    expect(result.stale).toBeUndefined();
    expect(result.lastModifiedBy).toBeNull();
  });

  // ── Repair trigger ───────────────────────────────────────────────────────
  test('a stale serve fires a repair for the REGISTRY doc and never awaits it', async () => {
    const { docGuid, updates } = await seedDoc(10);
    serve(docHolding(updates, [0, 1, 2]));
    const registryDoc = docHolding(updates, [0, 1, 2]);
    registryDoc._verifiedClock = 2;
    documentService.peekSharedDoc.mockReturnValue(registryDoc);

    // A repair that never settles: if the handler awaited it, this test hangs.
    const reconcileSpy = jest
      .spyOn(collabReconcile, 'reconcileDoc')
      .mockReturnValue(new Promise(() => {}));

    const result = await read(docGuid);

    expect(result.stale).toBe(true);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    // The REGISTRY doc is the repair target — repairing the served session doc
    // would push the applied updates back up the WebSocket as agent edits.
    expect(reconcileSpy.mock.calls[0][0]).toBe(docGuid);
    expect(reconcileSpy.mock.calls[0][1]).toBe(registryDoc);
  });

  test('a repair failure never propagates into the read', async () => {
    const { docGuid, updates } = await seedDoc(6);
    serve(docHolding(updates, [0, 1]));
    documentService.peekSharedDoc.mockReturnValue(docHolding(updates, [0, 1]));
    jest.spyOn(collabReconcile, 'reconcileDoc').mockRejectedValue(new Error('repair exploded'));

    await expect(read(docGuid)).resolves.toMatchObject({ clock: 1, stale: true });
    await expect(readDocument._awaitLastRepair()).resolves.toBeUndefined();
  });

  test('a stale serve with no registry doc on this pod is still an honest, non-throwing read', async () => {
    const { docGuid, updates } = await seedDoc(6);
    serve(docHolding(updates, [0, 1]));
    documentService.peekSharedDoc.mockReturnValue(null); // not loaded here

    const result = await read(docGuid);
    expect(result.clock).toBe(1);
    expect(result.stale).toBe(true);
  });

  test('after the repair completes, the next read labels the newest clock with no staleness fields', async () => {
    const { docGuid, updates } = await seedDoc(10);
    const live = docHolding(updates, [0, 1, 2]);
    serve(live);
    documentService.peekSharedDoc.mockReturnValue(live);

    const first = await read(docGuid);
    expect(first.clock).toBe(2);
    expect(first.stale).toBe(true);

    // Deterministic: await the repair the read fired, no sleeping.
    await readDocument._awaitLastRepair();

    const second = await read(docGuid);
    expect(second.clock).toBe(9);
    expect(second.stale).toBeUndefined();
    expect(second.newestClock).toBeUndefined();
    expect(second.content).toContain('para-9');
  });

  // ── Telemetry ────────────────────────────────────────────────────────────
  test('a staleness-marked serve increments collab.read.stale_serves; a current one does not', async () => {
    const { docGuid, updates } = await seedDoc(6);
    const staleSpy = jest.spyOn(telemetryMetrics, 'recordStaleServe');

    serve(docHolding(updates, [0, 1]));
    await read(docGuid);
    expect(staleSpy).toHaveBeenCalledTimes(1);

    serve(docHolding(updates, [0, 1, 2, 3, 4, 5]));
    await read(docGuid);
    expect(staleSpy).toHaveBeenCalledTimes(1); // unchanged
  });

  // ── Cost bound ───────────────────────────────────────────────────────────
  test('a behind copy fetches ONLY the unverified suffix, never the whole log', async () => {
    const { docGuid, updates } = await seedDoc(10);
    const served = docHolding(updates, [...Array(8).keys()]);
    served._verifiedClock = 6; // proven this far already
    serve(served);

    const suffixSpy = jest.spyOn(persistence, 'getUpdatesInRange');
    await read(docGuid);

    expect(suffixSpy).toHaveBeenCalledTimes(1);
    const [, clockStart, clockEnd, opts] = suffixSpy.mock.calls[0];
    expect(clockStart).toBe(7);      // verified + 1, not 0
    expect(clockEnd).toBe(9);
    expect(opts).toMatchObject({ includeData: true });
  });

  test('the verified clock is MONOTONE across reads on one served doc', async () => {
    const { docGuid, updates } = await seedDoc(10);
    const served = docHolding(updates, [0, 1, 2, 3]);
    serve(served);

    expect((await read(docGuid)).clock).toBe(3);
    Y.applyUpdate(served, updates[4]);
    expect((await read(docGuid)).clock).toBe(4);
    expect((await read(docGuid)).clock).toBe(4);
    expect(served._verifiedClock).toBe(4);
  });

  // ── First-read seeding (implement-brief C3) ──────────────────────────────
  test('a fresh session doc adopts the registry docs verified clock without a query', async () => {
    const { docGuid, updates } = await seedDoc(8);
    const registryDoc = docHolding(updates, [...Array(8).keys()]);
    registryDoc._verifiedClock = 7;
    registryDoc._bindComplete = true;
    documentService.peekSharedDoc.mockReturnValue(registryDoc);

    // A brand-new session doc, synced from the registry doc, nothing verified.
    const session = docHolding(updates, [...Array(8).keys()]);
    expect(session._verifiedClock).toBeUndefined();
    serve(session);

    const suffixSpy = jest.spyOn(persistence, 'getUpdatesInRange');
    const result = await read(docGuid);

    expect(result.clock).toBe(7);
    expect(result.stale).toBeUndefined();
    expect(suffixSpy).not.toHaveBeenCalled(); // seeded in-process, no full-log read
    expect(session._verifiedClock).toBe(7);
  });

  test('seeding is REFUSED when the session doc does not cover the registry doc', async () => {
    const { docGuid, updates } = await seedDoc(8);
    const registryDoc = docHolding(updates, [...Array(8).keys()]);
    registryDoc._verifiedClock = 7;
    documentService.peekSharedDoc.mockReturnValue(registryDoc);

    // The session doc is BEHIND the registry doc — adopting 7 would be a lie.
    const session = docHolding(updates, [0, 1, 2]);
    serve(session);

    const result = await read(docGuid);

    expect(result.clock).toBe(2);
    expect(result.stale).toBe(true);
  });

  // ── The version-read path is untouched ───────────────────────────────────
  test('a versionId read is unchanged — no presence session, no staleness fields', async () => {
    const { docGuid } = await seedDoc(5);
    agentPresence.getOrCreateSession.mockClear();

    const result = await readDocument.handler(
      { docGuid, versionId: '3', format: 'markdown' },
      agentToken
    );

    expect(agentPresence.getOrCreateSession).not.toHaveBeenCalled();
    expect(result.stale).toBeUndefined();
    expect(result.newestClock).toBeUndefined();
    expect(result.version).toBeDefined();
  });
});
