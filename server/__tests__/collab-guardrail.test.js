/**
 * Feature 021 US2 — server guardrail (FR-009..012, RBD-1/2/4, SC-004).
 *
 * Detection, never prevention: a human-attributed update whose Yjs delete
 * set covers item ranges inserted by agent-attributed rows younger than the
 * freshness window raises exactly one rate-limited exception-notifier alert
 * carrying doc / human / agent / DB clock range. Intersection happens in
 * Yjs ITEM-ID space; the alert reports the matched rows' DB clock range
 * (feature-016 invertible). Controls must stay silent; evaluation failures
 * are swallowed and can never affect persistence.
 *
 * Written FIRST (tests-first): RED until server/collab-guardrail.js lands.
 * Updates are built with real Y.Docs so delete sets are genuine.
 */
const Y = require('yjs');

jest.mock('../exception-notifier', () => ({
  notifyException: jest.fn(),
}));

const { notifyException } = require('../exception-notifier');
const guardrail = require('../collab-guardrail');
const { createPool, createPersistence, createTestUser } = require('./helpers/db');

let HUMAN_ID;
let AGENT_USER_ID;
const AGENT_NAME = 'squire-assistant';

describe('021 collab guardrail', () => {
  let pool;
  let persistence;
  const docGuids = [];
  let warnSpy;
  let errorSpy;

  /** Fresh doc guid, tracked for cleanup. */
  const newDocGuid = () => {
    const guid = `10000000-${String(docGuids.length).padStart(4, '0')}-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
    docGuids.push(guid);
    return guid;
  };

  /**
   * Build the incident signature with REAL Yjs updates:
   * 1. agent inserts a paragraph  -> stored as an agent-attributed row
   * 2. human deletes that content -> returned as the human update's bytes
   */
  async function buildSignature(docGuid, { text = 'agent wrote this' } = {}) {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');

    const svBeforeAgent = Y.encodeStateVector(doc);
    doc.transact(() => {
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, text);
      el.insert(0, [t]);
      frag.push([el]);
    });
    const agentUpdate = Y.encodeStateAsUpdate(doc, svBeforeAgent);
    await persistence.storeUpdate(docGuid, agentUpdate, AGENT_USER_ID, AGENT_NAME);

    const svBeforeDelete = Y.encodeStateVector(doc);
    doc.transact(() => {
      frag.delete(0, frag.length);
    });
    const humanDeleteUpdate = Y.encodeStateAsUpdate(doc, svBeforeDelete);
    return { doc, frag, agentUpdate, humanDeleteUpdate };
  }

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    guardrail.init(pool);
    HUMAN_ID = await createTestUser(pool, 'guardrail-human-021@example.com');
    AGENT_USER_ID = await createTestUser(pool, 'guardrail-agent-021@example.com');
  });

  afterAll(async () => {
    for (const guid of docGuids) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [guid]);
      await pool.query('DELETE FROM yjs_state_vectors WHERE doc_guid = $1', [guid]);
    }
    await pool.query('DELETE FROM users WHERE email IN ($1, $2)', [
      'guardrail-human-021@example.com',
      'guardrail-agent-021@example.com',
    ]);
    await pool.end();
    await persistence.close?.();
  });

  beforeEach(() => {
    notifyException.mockClear();
    guardrail._resetForTest();
    delete process.env.GUARDRAIL_FRESHNESS_SECONDS;
    delete process.env.GUARDRAIL_SUPPRESSION_MS;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('(a) signature: exactly one alert with doc/human/agent/clock-range fields', async () => {
    const docGuid = newDocGuid();
    const { humanDeleteUpdate } = await buildSignature(docGuid);

    const result = await guardrail.evaluateUpdate({
      docGuid,
      update: humanDeleteUpdate,
      userId: HUMAN_ID,
      agentName: null,
    });

    expect(result).toEqual({ matched: true, alerted: true });
    expect(notifyException).toHaveBeenCalledTimes(1);
    const [err, ctx] = notifyException.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/human-attributed deletion of fresh agent content/i);
    expect(ctx.source).toBe('collab-guardrail');
    expect(ctx.extra.docGuid).toBe(docGuid);
    expect(ctx.extra.humanUserId).toBe(HUMAN_ID);
    expect(ctx.extra.agentName).toContain(AGENT_NAME);
    expect(ctx.extra.agentUserId).toBe(AGENT_USER_ID);
    // DB clock space (feature-016 invertible): the first stored row is clock 0.
    expect(ctx.extra.agentClockRange).toEqual([0, 0]);
    // Yjs item-ID space forensics:
    expect(Array.isArray(ctx.extra.overlappedItemRanges)).toBe(true);
    expect(ctx.extra.overlappedItemRanges.length).toBeGreaterThan(0);
    for (const r of ctx.extra.overlappedItemRanges) {
      expect(r).toEqual({
        client: expect.any(Number),
        clock: expect.any(Number),
        len: expect.any(Number),
      });
    }
    expect(ctx.extra.suppressedSinceLastAlert).toBe(0);
  });

  test('(b) silence: normal human edit (no deletions) — zero DB work, no alert', async () => {
    const docGuid = newDocGuid();
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    const sv = Y.encodeStateVector(doc);
    doc.transact(() => {
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'typed by a human');
      el.insert(0, [t]);
      frag.push([el]);
    });
    const humanInsert = Y.encodeStateAsUpdate(doc, sv);

    const querySpy = jest.spyOn(pool, 'query');
    const result = await guardrail.evaluateUpdate({
      docGuid,
      update: humanInsert,
      userId: HUMAN_ID,
      agentName: null,
    });
    expect(result).toBeNull();
    expect(notifyException).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled(); // empty delete set short-circuits
    querySpy.mockRestore();
  });

  test('(b) silence: human deletes agent content OLDER than the freshness window', async () => {
    const docGuid = newDocGuid();
    const { humanDeleteUpdate } = await buildSignature(docGuid);
    // Age the agent row past the window.
    await pool.query(
      "UPDATE yjs_updates SET created_at = now() - interval '1 hour' WHERE doc_guid = $1",
      [docGuid]
    );

    const result = await guardrail.evaluateUpdate({
      docGuid,
      update: humanDeleteUpdate,
      userId: HUMAN_ID,
      agentName: null,
    });
    expect(result).toBeNull();
    expect(notifyException).not.toHaveBeenCalled();
  });

  test('(b) silence: agent-deletes-agent is not the incident class (RBD-2)', async () => {
    const docGuid = newDocGuid();
    const { humanDeleteUpdate } = await buildSignature(docGuid);

    const result = await guardrail.evaluateUpdate({
      docGuid,
      update: humanDeleteUpdate,
      userId: AGENT_USER_ID,
      agentName: 'other-agent',
    });
    expect(result).toBeNull();
    expect(notifyException).not.toHaveBeenCalled();
  });

  test('(b) silence: anonymous/unattributed updates are ignored', async () => {
    const docGuid = newDocGuid();
    const { humanDeleteUpdate } = await buildSignature(docGuid);
    const result = await guardrail.evaluateUpdate({
      docGuid,
      update: humanDeleteUpdate,
      userId: null,
      agentName: null,
    });
    expect(result).toBeNull();
    expect(notifyException).not.toHaveBeenCalled();
  });

  test('(c) suppression: a storm pages once, counts, and carries the count on the next alert; docs independent', async () => {
    process.env.GUARDRAIL_SUPPRESSION_MS = '200';
    const docGuid = newDocGuid();

    // First match: alert.
    const first = await buildSignature(docGuid, { text: 'first burst' });
    await guardrail.evaluateUpdate({
      docGuid, update: first.humanDeleteUpdate, userId: HUMAN_ID, agentName: null,
    });
    expect(notifyException).toHaveBeenCalledTimes(1);

    // Storm: three more matches within the suppression window — counted, not paged.
    for (let i = 0; i < 3; i++) {
      const sig = await buildSignature(docGuid, { text: `storm ${i}` });
      const res = await guardrail.evaluateUpdate({
        docGuid, update: sig.humanDeleteUpdate, userId: HUMAN_ID, agentName: null,
      });
      expect(res).toEqual({ matched: true, alerted: false });
    }
    expect(notifyException).toHaveBeenCalledTimes(1);
    // N1: every match is still logged even while paging is suppressed.
    const matchLogs = warnSpy.mock.calls.filter((c) => String(c[0]).includes('[CollabGuardrail]'));
    expect(matchLogs.length).toBe(4);

    // A second doc alerts independently despite the first doc's suppression.
    const otherDoc = newDocGuid();
    const otherSig = await buildSignature(otherDoc, { text: 'other doc' });
    await guardrail.evaluateUpdate({
      docGuid: otherDoc, update: otherSig.humanDeleteUpdate, userId: HUMAN_ID, agentName: null,
    });
    expect(notifyException).toHaveBeenCalledTimes(2);

    // After the window expires the next match pages again and carries the count.
    await new Promise((r) => setTimeout(r, 250));
    const late = await buildSignature(docGuid, { text: 'after window' });
    const res = await guardrail.evaluateUpdate({
      docGuid, update: late.humanDeleteUpdate, userId: HUMAN_ID, agentName: null,
    });
    expect(res).toEqual({ matched: true, alerted: true });
    expect(notifyException).toHaveBeenCalledTimes(3);
    const lastCtx = notifyException.mock.calls.at(-1)[1];
    expect(lastCtx.extra.suppressedSinceLastAlert).toBe(3);
  });

  test('(d) never-blocks: malformed update bytes are swallowed, logged, and resolve null', async () => {
    const result = await guardrail.evaluateUpdate({
      docGuid: newDocGuid(),
      update: new Uint8Array([1, 2, 3, 4, 5]), // not a valid Yjs update
      userId: HUMAN_ID,
      agentName: null,
    });
    expect(result).toBeNull();
    expect(notifyException).not.toHaveBeenCalled();
    const swallowed = errorSpy.mock.calls.filter((c) => String(c[0]).includes('[CollabGuardrail]'));
    expect(swallowed.length).toBe(1);
  });

  test('(d) never-blocks: persistence is unaffected when evaluation throws (fire-and-forget wiring)', async () => {
    const docGuid = newDocGuid();
    const { agentUpdate, humanDeleteUpdate } = await buildSignature(docGuid);
    // (buildSignature already stored the agent row — store the human row the
    // way the bindState listener does, THEN evaluate fire-and-forget with the
    // evaluation forced to throw.)
    const evalSpy = jest.spyOn(guardrail, 'evaluateUpdate').mockImplementation(() => {
      throw new Error('guardrail exploded synchronously');
    });

    // Mirror server/index.js: storeUpdate first; guardrail after the promise
    // resolves, wrapped so nothing can propagate.
    let persistenceFailed = false;
    let listenerThrew = false;
    try {
      await persistence.storeUpdate(docGuid, humanDeleteUpdate, HUMAN_ID, null).then(() => {
        try {
          Promise.resolve(guardrail.evaluateUpdate({
            docGuid, update: humanDeleteUpdate, userId: HUMAN_ID, agentName: null,
          })).catch(() => {});
        } catch (e) {
          // even a synchronous throw must not reach the persistence chain
        }
      });
    } catch (e) {
      persistenceFailed = true;
    }
    evalSpy.mockRestore();

    expect(persistenceFailed).toBe(false);
    expect(listenerThrew).toBe(false);
    // Both rows persisted despite the guardrail malfunction.
    const { rows } = await pool.query(
      'SELECT clock, user_id, agent_name FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock',
      [docGuid]
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].agent_name).toBe(AGENT_NAME);
    expect(rows[1].user_id).toBe(HUMAN_ID);
    expect(rows[1].agent_name).toBeNull();
    expect(agentUpdate.length).toBeGreaterThan(0);
  });
});
