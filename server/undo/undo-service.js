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
 * empty path — so agents' observed-clock tracking stays coherent. Since
 * feature 020, success results additively carry `diff` (modify's exact chat
 * diff shape) computed from the markdown pair bracketing the applied inverse
 * — best-effort, never on honest-empty results, never empty.
 */
const Y = require('yjs');
const { ORIGIN_INVERSE_APPLY } = require('../origin');
const { applyLiveUpdate } = require('../live-apply');
const editRecords = require('./edit-records');
const { computeInverse } = require('./inverse');
// Namespace import (feature 020, analyze A1): the call site must stay
// diffUtils.computeChatDiff so tests can inject failures via jest.spyOn.
const diffUtils = require('../mcp/diff-utils');
const { deriveLegacyRange } = require('./legacy');
const documentService = require('../document-service');
const defaultRedisPubSub = require('../redis-pubsub');
const { EDIT_RANGE_BACKGROUND_WAIT_MS } = require('../mcp/yjs/edit-range');

const MAX_CLOCK = 2147483647; // Postgres int4 upper bound

let defaultPersistence = null;

/** Wire the module's default persistence (server boot / test harness). */
function init(persistence) {
  defaultPersistence = persistence;
}

function resolveDeps(deps = {}) {
  const persistence = deps.persistence || defaultPersistence;
  if (!persistence) throw new Error('undo-service not initialized');
  // Feature 041 (FR-013): undo/redo only ever ASK whether the doc is live here
  // (to merge into it and to fan out). The creating `getSharedDoc` made that
  // question self-fulfilling — every undo of a document nobody had open
  // allocated an in-memory doc plus a spurious full load that nothing would ever
  // evict. `peekSharedDoc` never creates, so the not-loaded branches in
  // applyLiveUpdate are genuinely reachable and nothing leaks.
  const getSharedDoc = deps.getSharedDoc || ((docGuid) => {
    try {
      return documentService.peekSharedDoc(docGuid);
    } catch {
      return null; // document service not initialized (tests) — no live doc
    }
  });
  const redisPubSub = deps.redisPubSub || defaultRedisPubSub;
  return { persistence, getSharedDoc, redisPubSub };
}

/**
 * Feature 020 (plan D2/D3): the chat diff of what the inverse actually did,
 * from the markdown pair bracketing the pop inside computeInverse. Computed
 * only after the claim succeeds (both surfaces share this ONE attach point).
 * Best-effort (FR-006): any failure logs and returns null — the revert
 * stands sans diff. Never attached empty (FR-003: no empty-diff cards).
 *
 * @returns {object|null} modify-shape diff, or null to omit the field
 */
function computeRevertDiff(inverse, docGuid) {
  if (inverse.preMarkdown == null || inverse.postMarkdown == null) return null;
  try {
    const diff = diffUtils.computeChatDiff(inverse.preMarkdown, inverse.postMarkdown);
    return diff && diff.lines.length > 0 ? diff : null;
  } catch (err) {
    console.error(`[undo-service] revert diff computation failed for ${docGuid}:`, err.message);
    return null;
  }
}

async function currentMaxClock(persistence, docGuid) {
  const result = await persistence.getPool().query(
    'SELECT MAX(clock)::int AS clock FROM yjs_updates WHERE doc_guid = $1',
    [docGuid]
  );
  return result.rows[0]?.clock ?? 0;
}

/**
 * Load the full log with attribution + payloads, in clock order, WITH the gap
 * indicator (023 FR-009/D-2). The inverse and its agent_edits transition are
 * stored artifacts — they must never be computed from a torn read, so a still-
 * gapped load aborts the undo before any claim.
 * @returns {Promise<{updates: Array, gapped: boolean}>}
 */
function loadLog(persistence, docGuid) {
  return persistence.getUpdatesInRange(docGuid, 0, MAX_CLOCK, { withGap: true });
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
  const { persistence, getSharedDoc, redisPubSub } = resolveDeps(deps);
  const identity = { docGuid, userId, agentName };

  const row = await editRecords.nextUndoTarget(persistence, identity);
  let mode = 'undo';
  let legacyEdit = null;
  let range = null;

  if (row) {
    // Review M2: during the editRangePending window (RBD-8) the newest edit's
    // rows are in the log but its record is not — honoring nextUndoTarget
    // here would silently undo the WRONG (older) edit. Refuse honestly until
    // the recording lands or ages past the background wait bound.
    const pendingRecording = await editRecords.hasPendingRecording(
      persistence, identity, EDIT_RANGE_BACKGROUND_WAIT_MS
    );
    if (pendingRecording) {
      return {
        success: true,
        undone: false,
        message: 'Nothing undone: your latest edit is still being recorded — retry shortly.',
        clock: await currentMaxClock(persistence, docGuid),
      };
    }
    // undoTargetClocks (review M1): the exact clock set to invert; null on
    // legacy/pre-migration rows falls back to the spanning range.
    range = {
      clockStart: row.undoTargetStart,
      clockEnd: row.undoTargetEnd,
      clocks: row.undoTargetClocks,
    };
  } else {
    // Legacy fallback (FR-021, research R7): ONLY when the identity has no
    // 016 records at all for this doc — a pre-016 edit identifiable from the
    // log's attribution. An unrecorded in-flight 016 edit stays the honest
    // empty (RBD-7(b)): the derivation's freshness guard refuses just-landed
    // runs, and any existing record suppresses the fallback entirely.
    const hasAnyRecord = await editRecords.latestEdit(persistence, identity);
    if (!hasAnyRecord) {
      const recent = await persistence.getRecentUpdatesWithUsers(docGuid, 100);
      const derived = deriveLegacyRange(recent, { userId, agentName });
      if (derived) {
        mode = 'legacy-undo';
        legacyEdit = { docGuid, userId, agentName, clockStart: derived.clockStart, clockEnd: derived.clockEnd };
        range = derived;
      }
    }
    if (!range) {
      return {
        success: true,
        undone: false,
        message: 'Nothing to undo: no recorded edit by you in this document.',
        clock: await currentMaxClock(persistence, docGuid),
      };
    }
  }

  // The ORIGINAL edit's clock range for the record about to be claimed — what a
  // chat card stores (`part.output.editRange`, feature 016). Feature 041 returns
  // it so the stamp site can verify it is talking about the same edit.
  const recordRange = row
    ? { clockStart: row.editClockStart, clockEnd: row.editClockEnd }
    : { clockStart: legacyEdit.clockStart, clockEnd: legacyEdit.clockEnd };

  const { updates: rows, gapped } = await loadLog(persistence, docGuid);
  if (gapped) {
    // Torn read after the retry budget (023 FR-009/D-2): abort BEFORE any claim
    // — never transition an agent_edits row or store an inverse from a gapped log.
    console.warn(`[undo-service] aborting undo for ${docGuid}: update log still gapped after retry budget`);
    return {
      success: true,
      undone: false,
      message: 'Nothing undone: the document is still syncing — retry in a moment.',
      clock: await currentMaxClock(persistence, docGuid),
    };
  }
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
    mode,
    rowId: row ? row.id : undefined,
    // M3: the claim CAS re-checks the exact range this inverse was computed
    // from — if a concurrent chain step rewrote it, this claim must lose.
    targetRange: mode === 'undo'
      ? { clockStart: range.clockStart, clockEnd: range.clockEnd }
      : undefined,
    legacyEdit,
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

  const diff = computeRevertDiff(inverse, docGuid);
  applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, inverse.inverseUpdate, ORIGIN_INVERSE_APPLY, 'undo-service');
  return {
    success: true,
    undone: true,
    message: 'Edit undone. Later edits by you and other collaborators were preserved.',
    clock,
    // Feature 041 (FR-015), ADDITIVE: the ORIGINAL clock range of the record
    // that was actually undone. The chat route compares this against the range
    // stored on the card it was asked to stamp, so "Reverted" can only ever
    // land on the card whose edit was the one reverted. Present on success only.
    undoneRecordRange: recordRange,
    ...(diff ? { diff } : {}),
  };
}

/**
 * Redo the acting identity's most-recently-undone edit: the identical
 * algorithm over the last inverse's recorded clock range (research R4).
 */
async function performRedo({ docGuid, userId, agentName }, deps = {}) {
  const { persistence, getSharedDoc, redisPubSub } = resolveDeps(deps);
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
  const { updates: rows, gapped } = await loadLog(persistence, docGuid);
  if (gapped) {
    // Torn read after the retry budget (023 FR-009/D-2): abort before any claim.
    console.warn(`[undo-service] aborting redo for ${docGuid}: update log still gapped after retry budget`);
    return {
      success: true,
      redone: false,
      message: 'Nothing redone: the document is still syncing — retry in a moment.',
      clock: await currentMaxClock(persistence, docGuid),
    };
  }
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
    targetRange: range, // M3: CAS on the exact redo range the inverse used
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

  const diff = computeRevertDiff(inverse, docGuid);
  applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, inverse.inverseUpdate, ORIGIN_INVERSE_APPLY, 'undo-service');
  return {
    success: true,
    redone: true,
    message: 'Edit reapplied.',
    clock,
    // Feature 041 (FR-015), ADDITIVE: the ORIGINAL edit's range (the same
    // `edit_clock_*` bounds undo reports), because that is what the chat card
    // stores — the redo un-stamps exactly the card the undo stamped.
    redoneRecordRange: { clockStart: row.editClockStart, clockEnd: row.editClockEnd },
    ...(diff ? { diff } : {}),
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
  if (undoTarget || redoTarget) {
    return {
      canUndo: !!undoTarget,
      canRedo: !!(redoTarget && redoTarget.redoTargetStart != null),
    };
  }
  // Legacy fallback (FR-021, research R8): no records at all — one bounded
  // log read through the R7 derivation. Refusal (null) means honest
  // unavailability; a pre-016 undo has no recorded inverse, so canRedo stays
  // false here by construction (RBD-2).
  try {
    const recent = await persistence.getRecentUpdatesWithUsers(docGuid, 100);
    const derived = deriveLegacyRange(recent, { userId, agentName });
    return { canUndo: !!derived, canRedo: false };
  } catch (e) {
    console.warn(`[undo-service] legacy status derivation failed for ${docGuid}:`, e.message);
    return { canUndo: false, canRedo: false };
  }
}

module.exports = { init, performUndo, performRedo, getUndoStatus };
