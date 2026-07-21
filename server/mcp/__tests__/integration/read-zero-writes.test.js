/**
 * Feature 027 — User Story 1 (P1): reading a document leaves zero trace.
 *
 * A read over any document shape MUST persist zero update-log rows, MUST NOT
 * advance the document clock, and MUST NOT add the agent to version-history
 * authorship (SC-001/SC-002; acceptance scenarios 1, 2, 3, 5).
 *
 * Harness: the REAL read_document handler and the REAL position helpers run
 * against REAL PostgreSQL persistence. Only the WebSocket transport seam
 * (agentPresence.getOrCreateSession) is stubbed — it hands the handler a live
 * Y.Doc loaded from persistence, and this test wires that doc's `update` event
 * straight to persistence.storeUpdate with the AGENT's attribution, exactly as
 * y-websocket's writeState would. So if the read path's position math writes so
 * much as one byte, it becomes an agent-attributed row in yjs_updates and the
 * count/clock/author assertions fail. Post-fix, the position math is pure and
 * nothing is written.
 */

const Y = require('yjs');
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');

jest.mock('../../agent-presence', () => ({
  getOrCreateSession: jest.fn(),
  queueHighlightSequence: jest.fn(),
}));

const agentPresence = require('../../agent-presence');
const readDocument = require('../../tools/read-document');

const AGENT_NAME = 'ZeroWrite Test Agent';

describe('027 US1 — reads persist zero updates', () => {
  let pool;
  let persistence;
  let testUserId;
  const createdDocs = [];

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    readDocument.init(persistence);

    const u = await pool.query(
      `INSERT INTO users (google_id, name, email)
       VALUES ($1, 'ZeroWrite User', $2) RETURNING id`,
      ['g-027-' + Date.now(), `zw-027-${Date.now()}@example.com`]
    );
    testUserId = u.rows[0].id;
  });

  afterAll(async () => {
    for (const docGuid of createdDocs) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docGuid]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docGuid]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
    await persistence.destroy();
  });

  /** Create + seed a document; the seed is attributed to the human user. */
  async function seedDoc(title, build) {
    const r = await pool.query(
      `INSERT INTO documents (id, title, creator_id)
       VALUES (uuid_generate_v4(), $1, $2) RETURNING id`,
      [title, testUserId]
    );
    const docGuid = r.rows[0].id;
    createdDocs.push(docGuid);
    await pool.query(
      `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [docGuid, testUserId]
    );
    const ydoc = new Y.Doc();
    const frag = ydoc.get('default', Y.XmlFragment);
    ydoc.transact(() => build(frag));
    await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(ydoc), testUserId, null);
    ydoc.destroy();
    return docGuid;
  }

  /**
   * Install a live session doc loaded from persistence. Any mutation of that
   * doc is persisted as an AGENT-attributed row (faithful writeState) so a
   * stray write from position math is observable in the update log.
   */
  async function installSession(docGuid) {
    const ydoc = await persistence.getYDoc(docGuid);
    const pending = [];
    ydoc.on('update', (update) => {
      pending.push(persistence.storeUpdate(docGuid, update, testUserId, AGENT_NAME));
    });
    agentPresence.getOrCreateSession.mockResolvedValue({
      provider: { doc: ydoc },
      sessionId: 'sess-' + docGuid,
    });
    return { ydoc, flush: () => Promise.all(pending) };
  }

  const agentToken = () => ({ userId: testUserId, agentName: AGENT_NAME, baseUrl: '' });

  /** Assert a single read of `docGuid` (with the given args) writes nothing. */
  async function assertReadIsPure(docGuid, session, args) {
    const beforeCount = await persistence.getUpdateCount(docGuid);

    const result = await readDocument.handler({ docGuid, ...args }, agentToken());
    await session.flush();

    const afterCount = await persistence.getUpdateCount(docGuid);
    expect(afterCount).toBe(beforeCount);

    // The agent never appears as a recent author of a doc it only read.
    const authorNames = (result.recentAuthors || []).map((a) => a && (a.agentName || a.name));
    expect(authorNames).not.toContain(AGENT_NAME);

    return result;
  }

  test('whole-document and per-node reads over empty paragraph + image + hr write nothing', async () => {
    const docGuid = await seedDoc('mixed text-less', (frag) => {
      const h = new Y.XmlElement('heading');
      h.setAttribute('level', 1);
      const ht = new Y.XmlText();
      ht.insert(0, 'Doc Title');
      h.insert(0, [ht]);
      const emptyP = new Y.XmlElement('paragraph');
      const img = new Y.XmlElement('image');
      img.setAttribute('src', 'https://example.com/x.png');
      const hr = new Y.XmlElement('horizontalRule');
      frag.insert(0, [h, emptyP, img, hr]);
    });
    const session = await installSession(docGuid);

    const clockBefore = (await readDocument.handler({ docGuid }, agentToken())).clock;

    // (a) whole-document read (scenario 1, 5)
    const whole = await assertReadIsPure(docGuid, session, {});
    expect(whole.blockCount).toBe(4);
    expect(whole.clock).toBe(clockBefore); // clock unchanged (scenario 5)

    // (b) query-scoped reads targeting each text-less block individually (scenario 2)
    await assertReadIsPure(docGuid, session, { xpath: '//paragraph' }); // the empty paragraph
    await assertReadIsPure(docGuid, session, { xpath: '//image' });
    await assertReadIsPure(docGuid, session, { xpath: '//horizontalRule' });

    // Highlights were still queued (not dropped) for the text-less reads.
    expect(agentPresence.queueHighlightSequence).toHaveBeenCalled();

    session.ydoc.destroy();
  });

  test('a document whose only blocks are text-less (three images) reads with zero writes', async () => {
    const docGuid = await seedDoc('only images', (frag) => {
      const mk = () => {
        const img = new Y.XmlElement('image');
        img.setAttribute('src', 'https://example.com/i.png');
        return img;
      };
      frag.insert(0, [mk(), mk(), mk()]);
    });
    const session = await installSession(docGuid);

    const whole = await assertReadIsPure(docGuid, session, {});
    expect(whole.blockCount).toBe(3);

    session.ydoc.destroy();
  });

  test('a completely empty document reads successfully with no error and zero writes', async () => {
    // Seed an entirely empty doc (zero blocks).
    const docGuid = await seedDoc('empty doc', () => { /* no blocks */ });
    const session = await installSession(docGuid);

    const beforeCount = await persistence.getUpdateCount(docGuid);

    let result;
    await expect(
      (async () => { result = await readDocument.handler({ docGuid }, agentToken()); })()
    ).resolves.toBeUndefined(); // no throw

    await session.flush();
    const afterCount = await persistence.getUpdateCount(docGuid);

    expect(result.blockCount).toBe(0);
    expect(afterCount).toBe(beforeCount);

    session.ydoc.destroy();
  });

  // C1 (FR-009): if a highlight position genuinely cannot be produced (the
  // presence step fails), the read must fail OBSERVATIONAL — a non-fatal
  // warning, zero bytes written, and the read still returns successfully. Under
  // no circumstance does a fallback path write to the document.
  test('C1 — a failing highlight step warns non-fatally, writes nothing, and the read still succeeds', async () => {
    const docGuid = await seedDoc('c1 fail-observational', (frag) => {
      const emptyP = new Y.XmlElement('paragraph');
      const img = new Y.XmlElement('image');
      img.setAttribute('src', 'https://example.com/x.png');
      frag.insert(0, [emptyP, img]);
    });
    const session = await installSession(docGuid);

    const beforeCount = await persistence.getUpdateCount(docGuid);

    // Force the presence step to blow up on the (validly computed) positions —
    // simulating a genuinely uncomputable/undeliverable highlight downstream of
    // the pure position math.
    agentPresence.queueHighlightSequence.mockImplementationOnce(() => {
      throw new Error('simulated unresolvable highlight target');
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    let result;
    try {
      // The read must NOT throw despite the highlight failure.
      result = await readDocument.handler({ docGuid }, agentToken());
      await session.flush();

      // Non-fatal warning was emitted (fail-observational).
      const warned = warnSpy.mock.calls.some(
        (c) => String(c[0]).includes('[read-document]')
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    // The read succeeded and returned content...
    expect(result).toBeDefined();
    expect(result.blockCount).toBe(2);
    // ...and NOTHING was written to the document.
    const afterCount = await persistence.getUpdateCount(docGuid);
    expect(afterCount).toBe(beforeCount);

    session.ydoc.destroy();
  });
});
