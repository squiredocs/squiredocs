/**
 * agent_edits access layer (feature 016, research R5/R6).
 *
 * One row per recorded content-changing agent edit; the row doubles as the
 * undo/redo chain state machine and the at-most-once claim guard:
 *
 *   active --undo--> undone   (WHERE state='active'; redo_target := inverse [c,c])
 *   undone --redo--> active   (WHERE state='undone'; undo_target := redo    [c,c])
 *   legacy first undo         (INSERT ... ON CONFLICT DO NOTHING, state='undone')
 *
 * Every transition is a single conditional row write executed in the SAME DB
 * transaction as the inverse row's yjs_updates insert (storeUpdate with an
 * external client) and the target-range write — so the claim, the inverse row,
 * and the redo record are atomic (FR-014, FR-028, RBD-7). rowCount = 0 on any
 * transition means a concurrent request won: the caller returns the honest
 * already-undone/redone result and applies nothing.
 */

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    docGuid: row.doc_guid,
    userId: row.user_id,
    agentName: row.agent_name,
    editClockStart: row.edit_clock_start,
    editClockEnd: row.edit_clock_end,
    state: row.state,
    undoTargetStart: row.undo_target_start,
    undoTargetEnd: row.undo_target_end,
    // Exact clock set the next undo inverts (review M1); null = spanning
    // fallback (legacy first-undo inserts, rows recorded pre-migration).
    undoTargetClocks: row.undo_target_clocks ?? null,
    redoTargetStart: row.redo_target_start,
    redoTargetEnd: row.redo_target_end,
    lastUndoneAt: row.last_undone_at,
    createdAt: row.created_at,
  };
}

/**
 * Record a freshly durable edit (modify's post-durability insert, FR-002/004).
 * Idempotent: the identity-unique constraint absorbs background re-records.
 * `clocks` is the edit's EXACT covering clock set (review M1) — the durability
 * wait knows precisely which rows carry the edit, so interleaved
 * same-identity rows from a concurrent call are excluded from future undos.
 * Omitted/null keeps the spanning-range fallback.
 * @returns {Promise<object|null>} The inserted row, or null when it already existed.
 */
async function recordEdit(persistence, { docGuid, userId, agentName, clockStart, clockEnd, clocks = null }) {
  const result = await persistence.getPool().query(
    `INSERT INTO agent_edits
       (doc_guid, user_id, agent_name, edit_clock_start, edit_clock_end,
        state, undo_target_start, undo_target_end, undo_target_clocks)
     VALUES ($1, $2, $3, $4, $5, 'active', $4, $5, $6)
     ON CONFLICT (doc_guid, user_id, agent_name, edit_clock_start) DO NOTHING
     RETURNING *`,
    [docGuid, userId, agentName, clockStart, clockEnd, clocks && clocks.length ? clocks : null]
  );
  return result.rows.length ? mapRow(result.rows[0]) : null;
}

/** Most recent recorded edit for the identity (any state), by edit_clock_start. */
async function latestEdit(persistence, { docGuid, userId, agentName }) {
  const result = await persistence.getPool().query(
    `SELECT * FROM agent_edits
     WHERE doc_guid = $1 AND user_id = $2 AND agent_name = $3
     ORDER BY edit_clock_start DESC LIMIT 1`,
    [docGuid, userId, agentName]
  );
  return mapRow(result.rows[0]);
}

/**
 * The next undo target: the identity's most recent still-active edit — LIFO
 * stepping through the durable log, skipping already-undone rows (FR-017).
 */
async function nextUndoTarget(persistence, { docGuid, userId, agentName }) {
  const result = await persistence.getPool().query(
    `SELECT * FROM agent_edits
     WHERE doc_guid = $1 AND user_id = $2 AND agent_name = $3 AND state = 'active'
     ORDER BY edit_clock_start DESC LIMIT 1`,
    [docGuid, userId, agentName]
  );
  return mapRow(result.rows[0]);
}

/** The next redo target: most-recently-undone first (last_undone_at DESC, RBD-4). */
async function nextRedoTarget(persistence, { docGuid, userId, agentName }) {
  const result = await persistence.getPool().query(
    `SELECT * FROM agent_edits
     WHERE doc_guid = $1 AND user_id = $2 AND agent_name = $3 AND state = 'undone'
     ORDER BY last_undone_at DESC LIMIT 1`,
    [docGuid, userId, agentName]
  );
  return mapRow(result.rows[0]);
}

/** Conditional undo claim on an open client/transaction. True when this caller won. */
async function claimUndo(client, rowId) {
  const result = await client.query(
    `UPDATE agent_edits
     SET state = 'undone', last_undone_at = now(), updated_at = now()
     WHERE id = $1 AND state = 'active'`,
    [rowId]
  );
  return result.rowCount === 1;
}

/** Conditional redo claim. True when this caller won. */
async function claimRedo(client, rowId) {
  const result = await client.query(
    `UPDATE agent_edits
     SET state = 'active', updated_at = now()
     WHERE id = $1 AND state = 'undone'`,
    [rowId]
  );
  return result.rowCount === 1;
}

/**
 * Legacy first-undo claim (research R7): insert the derived edit already in
 * the undone state. The identity-unique constraint arbitrates concurrent
 * attempts — the loser's INSERT does nothing and it reports honestly.
 * @returns {Promise<{inserted: boolean, id: number|null}>}
 */
async function insertLegacyUndone(client, { docGuid, userId, agentName, clockStart, clockEnd }) {
  const result = await client.query(
    `INSERT INTO agent_edits
       (doc_guid, user_id, agent_name, edit_clock_start, edit_clock_end,
        state, undo_target_start, undo_target_end, last_undone_at)
     VALUES ($1, $2, $3, $4, $5, 'undone', $4, $5, now())
     ON CONFLICT (doc_guid, user_id, agent_name, edit_clock_start) DO NOTHING
     RETURNING id`,
    [docGuid, userId, agentName, clockStart, clockEnd]
  );
  return result.rows.length
    ? { inserted: true, id: Number(result.rows[0].id) }
    : { inserted: false, id: null };
}

/**
 * The at-most-once transaction (research R6): claim the state transition,
 * insert the inverse's yjs_updates row (storeUpdate on the SAME client), and
 * record the resulting clock as the next step's target range — atomically.
 *
 * @param {object} persistence - PostgresPersistence
 * @param {object} opts
 * @param {'undo'|'redo'|'legacy-undo'} opts.mode
 * @param {number} [opts.rowId] - agent_edits row id (undo/redo)
 * @param {object} [opts.legacyEdit] - { docGuid, userId, agentName, clockStart,
 *   clockEnd } for the legacy first-undo insert
 * @param {string} opts.docGuid
 * @param {string} opts.userId
 * @param {string} opts.agentName
 * @param {Uint8Array} opts.inverseUpdate - The computed inverse (never empty here;
 *   the fully-superseded case short-circuits before claiming, FR-011)
 * @returns {Promise<{claimed: boolean, clock: number|null}>} claimed=false means
 *   a concurrent request won (honest already-undone/redone, FR-028)
 */
async function finalizeClaim(persistence, opts) {
  const { mode, rowId, legacyEdit, docGuid, userId, agentName, inverseUpdate } = opts;
  const pool = persistence.getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let claimed;
    let targetRowId = rowId ?? null;
    if (mode === 'undo') {
      claimed = await claimUndo(client, rowId);
    } else if (mode === 'redo') {
      claimed = await claimRedo(client, rowId);
    } else if (mode === 'legacy-undo') {
      const r = await insertLegacyUndone(client, legacyEdit);
      claimed = r.inserted;
      targetRowId = r.id;
    } else {
      throw new Error(`finalizeClaim: unknown mode ${mode}`);
    }

    if (!claimed) {
      await client.query('ROLLBACK');
      return { claimed: false, clock: null };
    }

    // The inverse row joins the claim transaction (T003 external client).
    const clock = await persistence.storeUpdate(
      docGuid, inverseUpdate, userId, agentName, null, client
    );

    // Record this application's own range as the next step's input (FR-014/016).
    if (mode === 'redo') {
      // The redo's inverse is a single row, so the exact clock set (M1) is
      // exactly [clock] — rewritten alongside the range it mirrors.
      await client.query(
        `UPDATE agent_edits
         SET undo_target_start = $1, undo_target_end = $1,
             undo_target_clocks = ARRAY[$1]::integer[], updated_at = now()
         WHERE id = $2`,
        [clock, targetRowId]
      );
    } else {
      await client.query(
        'UPDATE agent_edits SET redo_target_start = $1, redo_target_end = $1, updated_at = now() WHERE id = $2',
        [clock, targetRowId]
      );
    }

    await client.query('COMMIT');
    return { claimed: true, clock };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  recordEdit,
  latestEdit,
  nextUndoTarget,
  nextRedoTarget,
  claimUndo,
  claimRedo,
  insertLegacyUndone,
  finalizeClaim,
};
