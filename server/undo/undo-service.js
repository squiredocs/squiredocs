/**
 * Log-derived undo/redo service (feature 016) — the ONE core both surfaces
 * (chat endpoints and MCP undo/redo tools) converge on.
 *
 * performUndo / performRedo:
 *   1. resolve the target from agent_edits (LIFO per identity; redo picks the
 *      most-recently-undone — FR-003/FR-017, RBD-4);
 *   2. load the full update log and compute the surgical inverse of the
 *      target range via the replica-UndoManager rebuild (research R1), with
 *      this instance's live shared doc merged in so supersession is evaluated
 *      against in-flight edits (FR-013, RBD-9);
 *   3. honest-empty short-circuit: a fully superseded target appends nothing
 *      and transitions nothing (FR-011);
 *   4. claim + store the inverse row + record the next step's target range in
 *      ONE DB transaction (at-most-once, FR-028/RBD-7 — a concurrent loser
 *      gets the honest already-undone result);
 *   5. only after commit, apply the inverse to the live shared doc under
 *      ORIGIN_INVERSE_APPLY (store-then-apply, research R3): broadcast to this
 *      instance's clients + Redis fan-out, no double-store, and — decisively —
 *      NO presence session created, extended, or consulted (FR-008).
 *
 * Results ({ success, undone|redone, message, clock }, RBD-5): clock is the
 * inverse's new log clock on success, the current max clock on the honest
 * empty path — so agents' observed-clock tracking stays coherent.
 */
const Y = require('yjs');
const { ORIGIN_INVERSE_APPLY } = require('../origin');
const editRecords = require('./edit-records');
const { computeInverse } = require('./inverse');
const documentService = require('../document-service');

const MAX_CLOCK = 2147483647; // Postgres int4 upper bound

let defaultPersistence = null;

/** Wire the module's default persistence (server boot / test harness). */
function init(persistence) {
  defaultPersistence = persistence;
}

function resolveDeps(deps = {}) {
  const persistence = deps.persistence || defaultPersistence;
  if (!persistence) throw new Error('undo-service not initialized');
  const getSharedDoc = deps.getSharedDoc || ((docGuid) => {
    try {
      return documentService.getSharedDoc(docGuid);
    } catch {
      return null; // document service not initialized (tests) — no live doc
    }
  });
  return { persistence, getSharedDoc };
}

async function currentMaxClock(persistence, docGuid) {
  const result = await persistence.getPool().query(
    'SELECT MAX(clock)::int AS clock FROM yjs_updates WHERE doc_guid = $1',
    [docGuid]
  );
  return result.rows[0]?.clock ?? 0;
}

/** Load the full log with attribution + payloads, in clock order. */
function loadLog(persistence, docGuid) {
  return persistence.getUpdatesInRange(docGuid, 0, MAX_CLOCK);
}

/**
 * Apply a committed inverse to the live shared doc (non-fatal on failure: the
 * row is durable; any subsequent load replays it — the restore posture).
 */
function applyToLiveDoc(getSharedDoc, docGuid, inverseUpdate) {
  try {
    const sharedDoc = getSharedDoc(docGuid);
    if (sharedDoc) Y.applyUpdate(sharedDoc, inverseUpdate, ORIGIN_INVERSE_APPLY);
  } catch (err) {
    console.error(`[undo-service] live apply failed for ${docGuid}:`, err.message);
  }
}

/**
 * Undo the acting identity's most recent still-undoable edit.
 *
 * @param {{docGuid: string, userId: string, agentName: string}} target
 * @param {{persistence?: object, getSharedDoc?: function}} [deps] - test
 *   injection points (a second "instance" is just other deps over the same DB)
 * @returns {Promise<{success: boolean, undone: boolean, message: string, clock: number}>}
 */
async function performUndo({ docGuid, userId, agentName }, deps = {}) {
  const { persistence, getSharedDoc } = resolveDeps(deps);
  const identity = { docGuid, userId, agentName };

  const row = await editRecords.nextUndoTarget(persistence, identity);
  if (!row) {
    // Legacy fallback (pre-016 edits with no record) arrives with US5 (T028);
    // an unrecorded in-flight edit is the honest empty per RBD-7(b).
    return {
      success: true,
      undone: false,
      message: 'Nothing to undo: no recorded edit by you in this document.',
      clock: await currentMaxClock(persistence, docGuid),
    };
  }

  const range = { clockStart: row.undoTargetStart, clockEnd: row.undoTargetEnd };
  const rows = await loadLog(persistence, docGuid);
  const liveDoc = (() => {
    try { return getSharedDoc(docGuid); } catch { return null; }
  })();

  const inverse = computeInverse(rows, range, { userId, agentName }, liveDoc);
  if (!inverse) {
    // Fully superseded: nothing appended, nothing transitioned (FR-011).
    return {
      success: true,
      undone: false,
      message: 'Nothing left to undo: later edits already superseded everything this edit changed.',
      clock: await currentMaxClock(persistence, docGuid),
    };
  }

  const { claimed, clock } = await editRecords.finalizeClaim(persistence, {
    mode: 'undo',
    rowId: row.id,
    docGuid,
    userId,
    agentName,
    inverseUpdate: inverse.inverseUpdate,
  });
  if (!claimed) {
    return {
      success: true,
      undone: false,
      message: 'This edit was already undone by a concurrent request.',
      clock: await currentMaxClock(persistence, docGuid),
    };
  }

  applyToLiveDoc(getSharedDoc, docGuid, inverse.inverseUpdate);
  return {
    success: true,
    undone: true,
    message: 'Edit undone. Later edits by you and other collaborators were preserved.',
    clock,
  };
}

/**
 * Redo the acting identity's most-recently-undone edit: the identical
 * algorithm over the last inverse's recorded clock range (research R4).
 */
async function performRedo({ docGuid, userId, agentName }, deps = {}) {
  const { persistence, getSharedDoc } = resolveDeps(deps);
  const identity = { docGuid, userId, agentName };

  const row = await editRecords.nextRedoTarget(persistence, identity);
  if (!row || row.redoTargetStart == null || row.redoTargetEnd == null) {
    // No undone record (or a pre-016 undo with no recorded inverse — RBD-2).
    return {
      success: true,
      redone: false,
      message: 'Nothing to redo: no undone edit with a recorded inverse in this document.',
      clock: await currentMaxClock(persistence, docGuid),
    };
  }

  const range = { clockStart: row.redoTargetStart, clockEnd: row.redoTargetEnd };
  const rows = await loadLog(persistence, docGuid);
  const liveDoc = (() => {
    try { return getSharedDoc(docGuid); } catch { return null; }
  })();

  const inverse = computeInverse(rows, range, { userId, agentName }, liveDoc);
  if (!inverse) {
    return {
      success: true,
      redone: false,
      message: 'Nothing left to redo: later edits already superseded everything the undo reverted.',
      clock: await currentMaxClock(persistence, docGuid),
    };
  }

  const { claimed, clock } = await editRecords.finalizeClaim(persistence, {
    mode: 'redo',
    rowId: row.id,
    docGuid,
    userId,
    agentName,
    inverseUpdate: inverse.inverseUpdate,
  });
  if (!claimed) {
    return {
      success: true,
      redone: false,
      message: 'This edit was already redone by a concurrent request.',
      clock: await currentMaxClock(persistence, docGuid),
    };
  }

  applyToLiveDoc(getSharedDoc, docGuid, inverse.inverseUpdate);
  return {
    success: true,
    redone: true,
    message: 'Edit reapplied.',
    clock,
  };
}

/**
 * Cheap log-derived availability for the chat button poll (FR-019, RBD-6):
 * two indexed agent_edits lookups — canUndo = a still-active recorded edit
 * exists; canRedo = an undone record with a recorded inverse exists. Full
 * supersession is discovered at action time (the honest undone:false), which
 * the client already surfaces and re-polls after. No presence-session
 * dependency of any kind (SC-006/SC-007).
 */
async function getUndoStatus({ docGuid, userId, agentName }, deps = {}) {
  const { persistence } = resolveDeps(deps);
  const identity = { docGuid, userId, agentName };
  const [undoTarget, redoTarget] = await Promise.all([
    editRecords.nextUndoTarget(persistence, identity),
    editRecords.nextRedoTarget(persistence, identity),
  ]);
  return {
    canUndo: !!undoTarget,
    canRedo: !!(redoTarget && redoTarget.redoTargetStart != null),
  };
}

module.exports = { init, performUndo, performRedo, getUndoStatus };
