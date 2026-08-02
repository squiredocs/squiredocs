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
 *
 * ---------------------------------------------------------------------------
 * THE SINGLE SENTINEL RULE FOR `agent_name` (feature 040, FR-007, D1)
 * ---------------------------------------------------------------------------
 *
 * `agent_edits.agent_name` is `NOT NULL`, and there is exactly ONE class of
 * permitted value: a **real, non-empty agent display name**. In practice that
 * is either an MCP token's own agent name, or the shared chat-assistant
 * identity (`CHAT_AGENT_NAME` from `server/agent-identity.js`) used by the
 * in-app assistant's own edits.
 *
 * A human web-UI restore records NOTHING here. It briefly did, under the
 * assistant identity, so that the undo endpoint could invert it — that was
 * cut (2026-08-02) because it put restores into the assistant's undo queue,
 * which is what forced a whole apparatus to keep the "Reverted" label honest.
 * A web-UI restore is attributed to the human in `yjs_updates` and is simply
 * not an undo target; you revert one by restoring again.
 *
 * The empty string `''` is **RETIRED**. It was previously written as a "human,
 * no agent" sentinel by the restore path, which is precisely why those rows
 * were unreachable: no undo surface queries for `''`, so the record existed
 * but nothing could ever invert it. `recordEdit` now REJECTS `''` (and `null`,
 * `undefined`, whitespace-only, and non-strings) before any SQL runs.
 *
 * Legacy `''` rows are **left exactly where they are** — no migration, no
 * backfill (FR-014's zero-migration constraint). They remain intentionally
 * unreachable. `isSameIdentity` deliberately treats `''` as a DISTINCT
 * identity rather than folding it into "absent", so those rows can never be
 * silently claimed by the human identity.
 *
 * NOTE: `insertLegacyUndone` (below) is deliberately NOT guarded. It runs
 * inside the `finalizeClaim` transaction, so throwing there would roll back a
 * legitimate legacy undo — turning a data-hygiene check into data loss
 * (research R7, D12). Do not "complete" the guard by extending it there.
 *
 * ---------------------------------------------------------------------------
 * FK-POLICY DIVERGENCE — INTENTIONAL, DO NOT UNIFY (feature 040, FR-012, D3)
 * ---------------------------------------------------------------------------
 *
 * `yjs_updates.user_id` is `ON DELETE SET NULL`, while `agent_edits.user_id`
 * is `ON DELETE CASCADE`. That asymmetry looks like an oversight and is not:
 *
 *  - **History must survive a deleted account, anonymized.** A document's
 *    update log is the document. Cascading it away would silently destroy
 *    other people's collaborative history because one contributor closed
 *    their account. `SET NULL` keeps the content and drops the identity —
 *    which is exactly what surfaces in version history as the "Unknown
 *    author" contributor entry (FR-008).
 *  - **An undo chain must NOT survive its owner.** `agent_edits` rows are
 *    per-identity undo state, and a deleted user can never undo anything
 *    again. Keeping their chain would leave rows no one can act on, still
 *    occupying the `(doc_guid, user_id, agent_name, edit_clock_start)` unique
 *    key. `CASCADE` is the coherent policy.
 *
 * The two policies must stay different. Migration files are not touched by
 * this feature.
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
 *
 * PRECONDITION (feature 040, FR-006): `agentName` must be a real, non-empty
 * agent display name — see the single sentinel rule in the module header. An
 * identityless call is rejected HERE, before any SQL, with a message that
 * names the actual problem. Previously such a call reached Postgres and came
 * back as `null value in column "agent_name" violates not-null constraint`,
 * which says nothing about which document, which user, or which code path —
 * or it wrote a `''` row that no undo surface could ever find.
 *
 * Callers' non-fatal handling is unchanged (D6): `restoreVersion` and
 * `modify.js` both catch, log, and continue, so the user's content change is
 * never lost to a recording failure. The throw makes the failure loud in the
 * logs; it does not make it fatal to the enclosing operation.
 *
 * @throws {Error} When `agentName` is null/undefined/non-string/blank.
 * @returns {Promise<object|null>} The inserted row, or null when it already existed.
 */
async function recordEdit(persistence, { docGuid, userId, agentName, clockStart, clockEnd, clocks = null }) {
  if (typeof agentName !== 'string' || agentName.trim() === '') {
    throw new Error(
      `[edit-records] refusing to record an edit with no agent identity: `
      + `agentName must be a non-empty string, got ${
        typeof agentName === 'string' ? JSON.stringify(agentName) : String(agentName)
      } (docGuid=${docGuid}, userId=${userId}). `
      + `Every recorded edit is scoped by (document, user, agent name); an edit `
      + `recorded without an identity can never be found or undone.`
    );
  }
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

/**
 * True while the identity's newest log row looks like an edit whose record is
 * still being written (review M2 — the editRangePending window): the row is
 * (a) newer than every clock any agent_edits row accounts for — edit ranges,
 * undo targets (redo inverses) and redo targets (undo inverses) — and
 * (b) younger than `freshnessMs` (callers pass the background wait bound, so
 * anything the background recorder could still record counts as pending).
 * Rows older than that will never be recorded and must not wedge undo.
 *
 * SYNC-CHANNEL ROWS ARE EXCLUDED (feature 041, FR-014). A reconnect catch-up
 * re-supplies rows under the acting identity flagged `via_sync = true`. Those
 * rows will NEVER get an `agent_edits` record — they are a re-delivery, not a
 * new edit — so the "newer than everything accounted for" heuristic
 * false-positived on them and refused undo with "still being recorded — retry
 * shortly" for the whole freshness window after every routine reconnect.
 * `IS NOT TRUE` keeps NULL matching, per the uniform via_sync read rule
 * (`postgres-persistence._mapUpdateRow`): only a FLAGGED row is excluded;
 * pre-038 rows and every normal write still count.
 */
async function hasPendingRecording(persistence, { docGuid, userId, agentName }, freshnessMs) {
  const pool = persistence.getPool();
  const newest = await pool.query(
    `SELECT clock, created_at FROM yjs_updates
     WHERE doc_guid = $1 AND user_id = $2 AND agent_name = $3
       AND via_sync IS NOT TRUE
     ORDER BY clock DESC LIMIT 1`,
    [docGuid, userId, agentName]
  );
  if (newest.rows.length === 0) return false;
  const { clock, created_at: createdAt } = newest.rows[0];
  if (Date.now() - new Date(createdAt).getTime() >= freshnessMs) return false;
  const accounted = await pool.query(
    `SELECT GREATEST(
        COALESCE(MAX(edit_clock_end), -1),
        COALESCE(MAX(undo_target_end), -1),
        COALESCE(MAX(redo_target_end), -1)) AS max_clock
     FROM agent_edits
     WHERE doc_guid = $1 AND user_id = $2 AND agent_name = $3`,
    [docGuid, userId, agentName]
  );
  const maxAccounted = accounted.rows[0]?.max_clock ?? -1;
  return clock > maxAccounted;
}

/**
 * Conditional undo claim on an open client/transaction. True when this caller
 * won. The CAS covers state AND the target range (review M3): a caller whose
 * inverse was computed from a range that has since been rewritten (undo →
 * redo → this claim landing late) must lose, or a stale inverse commits.
 */
async function claimUndo(client, rowId, targetRange) {
  const result = await client.query(
    `UPDATE agent_edits
     SET state = 'undone', last_undone_at = now(), updated_at = now()
     WHERE id = $1 AND state = 'active'
       AND undo_target_start = $2 AND undo_target_end = $3`,
    [rowId, targetRange.clockStart, targetRange.clockEnd]
  );
  return result.rowCount === 1;
}

/** Conditional redo claim, symmetric on redo_target (M3). True when this caller won. */
async function claimRedo(client, rowId, targetRange) {
  const result = await client.query(
    `UPDATE agent_edits
     SET state = 'active', updated_at = now()
     WHERE id = $1 AND state = 'undone'
       AND redo_target_start = $2 AND redo_target_end = $3`,
    [rowId, targetRange.clockStart, targetRange.clockEnd]
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
 * @param {{clockStart: number, clockEnd: number}} [opts.targetRange] - The
 *   range the caller computed its inverse FROM (undo/redo modes; review M3):
 *   the claim CAS requires the row still to carry exactly this range, so an
 *   inverse computed from a stale read can never commit
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
  const { mode, rowId, targetRange, legacyEdit, docGuid, userId, agentName, inverseUpdate } = opts;
  if ((mode === 'undo' || mode === 'redo') && !targetRange) {
    throw new Error(`finalizeClaim: targetRange is required for mode ${mode} (M3 range CAS)`);
  }
  const pool = persistence.getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let claimed;
    let targetRowId = rowId ?? null;
    if (mode === 'undo') {
      claimed = await claimUndo(client, rowId, targetRange);
    } else if (mode === 'redo') {
      claimed = await claimRedo(client, rowId, targetRange);
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

    // The inverse row joins the claim transaction (external client). An undo/redo
    // inverse is meaningful by construction (it changes visible content), so it is
    // classified true at write time (feature 023 R3) rather than left unknown.
    const clock = await persistence.storeUpdate(
      docGuid, inverseUpdate, userId, agentName, null, client, { meaningful: true }
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
  hasPendingRecording,
  // claimUndo / claimRedo / insertLegacyUndone are module-internal: they are the
  // steps `finalizeClaim` runs inside its transaction and have no external caller.
  finalizeClaim,
};
