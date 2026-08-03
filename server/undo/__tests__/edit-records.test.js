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
const { createPool, createPersistence, createTestUser, cleanupTestUser, cleanupDocRows } = require('../../__tests__/helpers/db');
// Feature 043 (FR-010, ledger D3): this suite writes `yjs_updates` rows under
// ad-hoc guids. Every guid it mints is recorded here and deleted in `afterAll`,
// so the global reindexStale scan can never find this suite's orphans. See the
// convention block in server/__tests__/helpers/db.js.
const createdDocGuids = [];
const newDocGuid = () => {
  const guid = randomUUID();
  createdDocGuids.push(guid);
  return guid;
};

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
    await cleanupDocRows(pool, createdDocGuids);
    await pool.query('DELETE FROM agent_edits WHERE user_id = $1', [userId]);
    await cleanupTestUser(pool, userId);
    await persistence.destroy();
    await pool.end();
  });

  function identity(docGuid) {
    return { docGuid, userId, agentName: AGENT };
  }

  test('recordEdit inserts an active row with undo_target = edit range; duplicate insert is a no-op', async () => {
    const docGuid = newDocGuid();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 5, clockEnd: 8, clocks: [5, 8],
    });
    expect(rec).toMatchObject({
      docGuid, userId, agentName: AGENT,
      editClockStart: 5, editClockEnd: 8,
      state: 'active', undoTargetStart: 5, undoTargetEnd: 8,
      undoTargetClocks: [5, 8], // exact set (M1): clocks 6 and 7 are NOT this edit's
      redoTargetStart: null, redoTargetEnd: null,
    });

    // Without a clock set (legacy callers) the column stays null — the
    // spanning-range fallback.
    const noClocks = await editRecords.recordEdit(persistence, {
      docGuid: newDocGuid(), userId, agentName: AGENT, clockStart: 1, clockEnd: 2,
    });
    expect(noClocks.undoTargetClocks).toBeNull();

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
    const docGuid = newDocGuid();
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
    const docGuid = newDocGuid();
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
    const docGuid = newDocGuid();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
    });
    const result = await editRecords.finalizeClaim(persistence, {
      mode: 'undo', rowId: rec.id,
      targetRange: { clockStart: 0, clockEnd: 0 },
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

  test('T005: finalizeClaim composes with a burst of ordinary storeUpdate calls (no deadlock, ordering holds)', async () => {
    const docGuid = newDocGuid();
    // Seed an ordinary update so the recorded edit inverts a real row.
    const seedClock = await persistence.storeUpdate(docGuid, makeUpdate('seed'), userId, null);
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: seedClock, clockEnd: seedClock,
    });

    // Fire the claim (external-client storeUpdate inside BEGIN..COMMIT, holding
    // the advisory lock to commit) CONCURRENTLY with a burst of ordinary
    // fire-and-forget pool-client storeUpdate calls on the same doc. The advisory
    // lock ordering must be deadlock-free (FR-003): the claim takes its
    // agent_edits row lock before the advisory lock; ordinary writers take only
    // the advisory lock — unidirectional, no cycle.
    const ordinary = [];
    for (let i = 0; i < 10; i++) {
      ordinary.push(persistence.storeUpdate(docGuid, makeUpdate(`ord-${i}`), userId, null));
    }
    const claimP = editRecords.finalizeClaim(persistence, {
      mode: 'undo', rowId: rec.id,
      targetRange: { clockStart: seedClock, clockEnd: seedClock },
      docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('the inverse'),
    });

    const [claim, ...ordClocks] = await Promise.all([claimP, ...ordinary]);
    expect(claim.claimed).toBe(true);

    // All writes completed and clocks are unique (no dropped/duplicated clock).
    const allClocks = [seedClock, claim.clock, ...ordClocks];
    expect(new Set(allClocks).size).toBe(allClocks.length);

    // Ordinary updates keep their production order among themselves.
    for (let i = 1; i < ordClocks.length; i++) {
      expect(ordClocks[i]).toBeGreaterThan(ordClocks[i - 1]);
    }

    // The inverse row's clock is causally after everything it inverts (the seed).
    expect(claim.clock).toBeGreaterThan(seedClock);

    // Contiguous log: seed + 10 ordinary + 1 inverse = 12 rows, no gaps.
    const rows = await pool.query('SELECT clock FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC', [docGuid]);
    expect(rows.rows).toHaveLength(12);
    for (let i = 1; i < rows.rows.length; i++) {
      expect(Number(rows.rows[i].clock)).toBe(Number(rows.rows[i - 1].clock) + 1);
    }
  });

  test('at-most-once: two concurrent undo claims — exactly one wins, exactly one inverse row', async () => {
    const docGuid = newDocGuid();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
    });
    const attempt = () => editRecords.finalizeClaim(persistence, {
      mode: 'undo', rowId: rec.id,
      targetRange: { clockStart: 0, clockEnd: 0 },
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

  test('claim CAS covers the target range too (M3): a stale range never commits', async () => {
    const docGuid = newDocGuid();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
    });

    // Undo claim computed from a STALE read of the target range — refused,
    // nothing transitions, nothing is appended.
    const stale = await editRecords.finalizeClaim(persistence, {
      mode: 'undo', rowId: rec.id,
      targetRange: { clockStart: 5, clockEnd: 9 },
      docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('stale inverse'),
    });
    expect(stale.claimed).toBe(false);
    let state = await pool.query('SELECT state FROM agent_edits WHERE id = $1', [rec.id]);
    expect(state.rows[0].state).toBe('active');
    let count = await pool.query('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
    expect(count.rows[0].n).toBe(0);

    // The range actually on the row commits.
    const undo = await editRecords.finalizeClaim(persistence, {
      mode: 'undo', rowId: rec.id,
      targetRange: { clockStart: 0, clockEnd: 0 },
      docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('inverse'),
    });
    expect(undo.claimed).toBe(true);

    // Redo claims are symmetric on redo_target: stale range refused...
    const staleRedo = await editRecords.finalizeClaim(persistence, {
      mode: 'redo', rowId: rec.id,
      targetRange: { clockStart: undo.clock + 7, clockEnd: undo.clock + 7 },
      docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('stale redo'),
    });
    expect(staleRedo.claimed).toBe(false);
    state = await pool.query('SELECT state FROM agent_edits WHERE id = $1', [rec.id]);
    expect(state.rows[0].state).toBe('undone');

    // ...the recorded redo target commits.
    const redo = await editRecords.finalizeClaim(persistence, {
      mode: 'redo', rowId: rec.id,
      targetRange: { clockStart: undo.clock, clockEnd: undo.clock },
      docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('redo'),
    });
    expect(redo.claimed).toBe(true);
    count = await pool.query('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
    expect(count.rows[0].n).toBe(2); // only the two winners appended
  });

  test('redo claim is symmetric (WHERE state=\'undone\'); loser reports honestly', async () => {
    const docGuid = newDocGuid();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
    });
    // Undo first so the row is redoable.
    const undo = await editRecords.finalizeClaim(persistence, {
      mode: 'undo', rowId: rec.id,
      targetRange: { clockStart: 0, clockEnd: 0 },
      docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('inverse'),
    });
    expect(undo.claimed).toBe(true);

    const attempt = () => editRecords.finalizeClaim(persistence, {
      mode: 'redo', rowId: rec.id,
      targetRange: { clockStart: undo.clock, clockEnd: undo.clock },
      docGuid, userId, agentName: AGENT,
      inverseUpdate: makeUpdate('redo update'),
    });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const winners = [a, b].filter((r) => r.claimed);
    expect(winners.length).toBe(1);
    const winner = winners[0];

    const { rows } = await pool.query('SELECT * FROM agent_edits WHERE id = $1', [rec.id]);
    expect(rows[0].state).toBe('active');
    // The next undo now targets the redo's own range (FR-016) — and the exact
    // clock set follows it (M1): the redo's inverse is that single row.
    expect(rows[0].undo_target_start).toBe(winner.clock);
    expect(rows[0].undo_target_end).toBe(winner.clock);
    expect(rows[0].undo_target_clocks).toEqual([winner.clock]);
  });

  test('legacy first-undo: INSERT ... ON CONFLICT DO NOTHING arbitrates concurrent attempts', async () => {
    const docGuid = newDocGuid();
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

  // T020 (feature 040, FR-006/FR-007, SC-006): the recording boundary rejects
  // an identityless call LOUDLY and BY NAME, before any SQL runs.
  //
  // Before 040 these calls either reached Postgres and came back as
  // `null value in column "agent_name" violates not-null constraint` — which
  // names no document, no user and no code path — or (via restoreVersion's
  // `?? ''` fallback) silently wrote a row under the '' sentinel that no undo
  // surface could ever find. Both failure modes are now impossible.
  describe('040 T020: recordEdit rejects a missing agent identity before any query (FR-006)', () => {
    const badIdentities = [
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['a non-string', 12345],
    ];

    test.each(badIdentities)('rejects agentName = %s without touching the database', async (_label, agentName) => {
      const docGuid = newDocGuid();
      // A persistence double whose pool would throw if it were ever reached:
      // proves the guard runs BEFORE any query, not after a failed insert.
      let queried = false;
      const spyingPersistence = {
        getPool: () => {
          queried = true;
          throw new Error('recordEdit must not reach the database for an identityless call');
        },
      };

      await expect(editRecords.recordEdit(spyingPersistence, {
        docGuid, userId, agentName, clockStart: 0, clockEnd: 0,
      })).rejects.toThrow(/no agent identity/i);

      expect(queried).toBe(false);
    });

    test('the message names the missing identity, the document and the user — and is never a Postgres constraint string', async () => {
      const docGuid = newDocGuid();
      let thrown = null;
      try {
        await editRecords.recordEdit(persistence, {
          docGuid, userId, agentName: null, clockStart: 0, clockEnd: 0,
        });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toContain('no agent identity');
      expect(thrown.message).toContain(docGuid);
      expect(thrown.message).toContain(userId);
      // SC-006: the whole point is that this is NOT the raw DB error.
      expect(thrown.message).not.toContain('violates not-null constraint');
      expect(thrown.message).not.toContain('null value in column');

      // And nothing was written — in particular no '' sentinel row.
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM agent_edits WHERE doc_guid = $1', [docGuid]
      );
      expect(rows[0].n).toBe(0);
    });

    test('a real agent name is still accepted, unchanged', async () => {
      const docGuid = newDocGuid();
      const rec = await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
      });
      expect(rec).not.toBeNull();
      expect(rec.agentName).toBe(AGENT);
    });
  });

  test('rollback atomicity: a failed inverse insert leaves the claim untaken and the log untouched', async () => {
    const docGuid = newDocGuid();
    const rec = await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
    });
    const failing = {
      getPool: () => pool,
      storeUpdate: async () => { throw new Error('boom: simulated insert failure'); },
    };
    await expect(editRecords.finalizeClaim(failing, {
      mode: 'undo', rowId: rec.id,
      targetRange: { clockStart: 0, clockEnd: 0 },
      docGuid, userId, agentName: AGENT,
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

  // ── Feature 041 (FR-014, SC-007) ─────────────────────────────────────────
  // A reconnect catch-up re-supplies rows under the acting identity flagged
  // via_sync. Those rows never get an agent_edits record, so the pending-recording
  // heuristic false-positived on them and blocked undo with "still being
  // recorded — retry shortly" for the whole freshness window after every
  // routine reconnect.
  describe('041 FR-014: hasPendingRecording ignores sync-channel rows', () => {
    const FRESHNESS_MS = 60000;

    test('a fresh via_sync row does NOT report a pending recording', async () => {
      const docGuid = newDocGuid();
      // A recorded edit at clock 0, fully accounted for.
      await persistence.storeUpdate(docGuid, makeUpdate('edit'), userId, AGENT);
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
      });
      // Then a reconnect re-supplies content: newer clock, same identity, flagged.
      await persistence.storeUpdate(docGuid, makeUpdate('resupplied'), userId, AGENT, null, null, { viaSync: true });

      const pending = await editRecords.hasPendingRecording(persistence, identity(docGuid), FRESHNESS_MS);
      expect(pending).toBe(false);
    });

    test('a genuine fresh UNRECORDED edit still reports pending (the guard keeps its teeth)', async () => {
      const docGuid = newDocGuid();
      await persistence.storeUpdate(docGuid, makeUpdate('edit'), userId, AGENT);
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: AGENT, clockStart: 0, clockEnd: 0,
      });
      // No via_sync flag: an edit whose record has not landed yet.
      await persistence.storeUpdate(docGuid, makeUpdate('in-flight'), userId, AGENT);

      const pending = await editRecords.hasPendingRecording(persistence, identity(docGuid), FRESHNESS_MS);
      expect(pending).toBe(true);
    });

    test('via_sync = NULL (every pre-038 row and every normal write) still counts', async () => {
      const docGuid = newDocGuid();
      await persistence.storeUpdate(docGuid, makeUpdate('edit'), userId, AGENT, null, null, { viaSync: null });

      const pending = await editRecords.hasPendingRecording(persistence, identity(docGuid), FRESHNESS_MS);
      expect(pending).toBe(true);
    });

    test('a sync row does not mask an OLDER unrecorded real edit', async () => {
      const docGuid = newDocGuid();
      await persistence.storeUpdate(docGuid, makeUpdate('real'), userId, AGENT);            // clock 0, unrecorded
      await persistence.storeUpdate(docGuid, makeUpdate('resupplied'), userId, AGENT, null, null, { viaSync: true }); // clock 1

      // Excluding the sync row surfaces the real unrecorded edit beneath it.
      const pending = await editRecords.hasPendingRecording(persistence, identity(docGuid), FRESHNESS_MS);
      expect(pending).toBe(true);
    });
  });
});
