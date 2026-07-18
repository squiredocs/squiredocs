/**
 * agent_edits access layer (feature 016, research R5/R6; RBD-3/4/7).
 *
 * DB-backed tests: insert-on-record, latest/LIFO/redo lookups, and the
 * at-most-once claim — a conditional row transition executed in the SAME
 * transaction as the inverse row's yjs_updates insert (storeUpdate with an
 * external client, T003) and the target-range write. Serial only.
 */
const { randomUUID } = require('crypto');
const Y = require('yjs');
const { createPool, createPersistence, createTestUser, cleanupTestUser } = require('../../__tests__/helpers/db');
const editRecords = require('../edit-records');

function makeUpdate(text) {
  const doc = new Y.Doc();
  const payloads = [];
  doc.on('update', (u) => payloads.push(u));
  const frag = doc.get('default', Y.XmlFragment);
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  frag.insert(0, [p]);
  return payloads[0];
}

describe('edit-records', () => {
  let pool, persistence, userId;
  const AGENT = 'Squire Docs Assistant';

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    userId = await createTestUser(pool, `edit-records-016-${Date.now()}@test.com`);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM agent_edits WHERE user_id = $1', [userId]);
    await cleanupTestUser(pool, userId);
    await persistence.destroy();
    await pool.end();
  });

  function identity(docGuid) {
    return { docGuid, userId, agentName: AGENT };
  }

  test('recordEdit inserts an active row with undo_target = edit range; duplicate insert is a no-op', async () => {
    const docGuid = randomUUID();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 5, clockEnd: 8,
    });
    expect(rec).toMatchObject({
      docGuid, userId, agentName: AGENT,
      editClockStart: 5, editClockEnd: 8,
      state: 'active', undoTargetStart: 5, undoTargetEnd: 8,
      redoTargetStart: null, redoTargetEnd: null,
    });

    // Same identity + clockStart again (background re-record) — no duplicate.
    const dup = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 5, clockEnd: 8,
    });
    expect(dup).toBeNull();
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM agent_edits WHERE doc_guid = $1', [docGuid]
    );
    expect(rows[0].n).toBe(1);
  });

  test('latestEdit and nextUndoTarget: most recent by edit_clock_start, LIFO stepping skips undone', async () => {
    const docGuid = randomUUID();
    await editRecords.recordEdit(persistence, { docGuid, userId, agentName: AGENT, clockStart: 1, clockEnd: 2 });
    await editRecords.recordEdit(persistence, { docGuid, userId, agentName: AGENT, clockStart: 4, clockEnd: 6 });
    await editRecords.recordEdit(persistence, { docGuid, userId, agentName: AGENT, clockStart: 9, clockEnd: 9 });

    const latest = await editRecords.latestEdit(persistence, identity(docGuid));
    expect(latest.editClockStart).toBe(9);

    let target = await editRecords.nextUndoTarget(persistence, identity(docGuid));
    expect(target.editClockStart).toBe(9);

    // Mark the latest undone — LIFO stepping walks back to the next active.
    await pool.query(
      `UPDATE agent_edits SET state='undone', last_undone_at=now() WHERE doc_guid=$1 AND edit_clock_start=9`,
      [docGuid]
    );
    target = await editRecords.nextUndoTarget(persistence, identity(docGuid));
    expect(target.editClockStart).toBe(4);

    // Different identity sees nothing.
    const other = await editRecords.nextUndoTarget(persistence, { docGuid, userId, agentName: 'Other Agent' });
    expect(other).toBeNull();
  });

  test('nextRedoTarget picks the most-recently-undone row (last_undone_at DESC)', async () => {
    const docGuid = randomUUID();
    await editRecords.recordEdit(persistence, { docGuid, userId, agentName: AGENT, clockStart: 1, clockEnd: 1 });
    await editRecords.recordEdit(persistence, { docGuid, userId, agentName: AGENT, clockStart: 3, clockEnd: 3 });
    // Undo clock-3 first, then clock-1 — redo must pick clock-1 (most recent undo).
    await pool.query(
      `UPDATE agent_edits SET state='undone', last_undone_at=now() - interval '1 minute'
       WHERE doc_guid=$1 AND edit_clock_start=3`, [docGuid]
    );
    await pool.query(
      `UPDATE agent_edits SET state='undone', last_undone_at=now() WHERE doc_guid=$1 AND edit_clock_start=1`,
      [docGuid]
    );
    const target = await editRecords.nextRedoTarget(persistence, identity(docGuid));
    expect(target.editClockStart).toBe(1);
  });

  test('finalizeClaim(undo) commits claim + inverse row + redo target atomically', async () => {
    const docGuid = randomUUID();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
    });
    const result = await editRecords.finalizeClaim(persistence, {
      mode: 'undo', rowId: rec.id,
      docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('the inverse'),
    });
    expect(result.claimed).toBe(true);
    expect(typeof result.clock).toBe('number');

    const { rows } = await pool.query('SELECT * FROM agent_edits WHERE id = $1', [rec.id]);
    expect(rows[0].state).toBe('undone');
    expect(rows[0].redo_target_start).toBe(result.clock);
    expect(rows[0].redo_target_end).toBe(result.clock);
    expect(rows[0].last_undone_at).not.toBeNull();

    const upd = await pool.query(
      'SELECT user_id, agent_name FROM yjs_updates WHERE doc_guid = $1 AND clock = $2',
      [docGuid, result.clock]
    );
    expect(upd.rows.length).toBe(1);
    expect(upd.rows[0].user_id).toBe(userId);
    expect(upd.rows[0].agent_name).toBe(AGENT);
  });

  test('at-most-once: two concurrent undo claims — exactly one wins, exactly one inverse row', async () => {
    const docGuid = randomUUID();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
    });
    const attempt = () => editRecords.finalizeClaim(persistence, {
      mode: 'undo', rowId: rec.id,
      docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('inverse'),
    });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const winners = [a, b].filter((r) => r.claimed);
    expect(winners.length).toBe(1);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]
    );
    expect(rows[0].n).toBe(1); // only the winner appended
  });

  test('redo claim is symmetric (WHERE state=\'undone\'); loser reports honestly', async () => {
    const docGuid = randomUUID();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
    });
    // Undo first so the row is redoable.
    const undo = await editRecords.finalizeClaim(persistence, {
      mode: 'undo', rowId: rec.id, docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('inverse'),
    });
    expect(undo.claimed).toBe(true);

    const attempt = () => editRecords.finalizeClaim(persistence, {
      mode: 'redo', rowId: rec.id, docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('redo update'),
    });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const winners = [a, b].filter((r) => r.claimed);
    expect(winners.length).toBe(1);
    const winner = winners[0];

    const { rows } = await pool.query('SELECT * FROM agent_edits WHERE id = $1', [rec.id]);
    expect(rows[0].state).toBe('active');
    // The next undo now targets the redo's own range (FR-016).
    expect(rows[0].undo_target_start).toBe(winner.clock);
    expect(rows[0].undo_target_end).toBe(winner.clock);
  });

  test('legacy first-undo: INSERT ... ON CONFLICT DO NOTHING arbitrates concurrent attempts', async () => {
    const docGuid = randomUUID();
    const legacyEdit = { docGuid, userId, agentName: AGENT, clockStart: 2, clockEnd: 4 };
    const attempt = () => editRecords.finalizeClaim(persistence, {
      mode: 'legacy-undo', legacyEdit,
      docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('legacy inverse'),
    });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const winners = [a, b].filter((r) => r.claimed);
    expect(winners.length).toBe(1);

    const { rows } = await pool.query(
      'SELECT * FROM agent_edits WHERE doc_guid = $1', [docGuid]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe('undone');
    expect(rows[0].edit_clock_start).toBe(2);
    expect(rows[0].edit_clock_end).toBe(4);
    expect(rows[0].redo_target_start).toBe(winners[0].clock);
    // Native redo is now possible from this record.
    const target = await editRecords.nextRedoTarget(persistence, identity(docGuid));
    expect(target.id).toBe(Number(rows[0].id)); // pg returns bigserial as string
  });

  test('rollback atomicity: a failed inverse insert leaves the claim untaken and the log untouched', async () => {
    const docGuid = randomUUID();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
    });
    const failing = {
      getPool: () => pool,
      storeUpdate: async () => { throw new Error('boom: simulated insert failure'); },
    };
    await expect(editRecords.finalizeClaim(failing, {
      mode: 'undo', rowId: rec.id, docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('inverse'),
    })).rejects.toThrow('boom');

    // The claim rolled back with the failed insert — still active, no rows.
    const { rows } = await pool.query('SELECT state FROM agent_edits WHERE id = $1', [rec.id]);
    expect(rows[0].state).toBe('active');
    const upd = await pool.query(
      'SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]
    );
    expect(upd.rows[0].n).toBe(0);
  });
});
