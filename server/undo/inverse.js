/**
 * Log-derived surgical inverse (feature 016, research R1).
 *
 * To invert the clock range [s, e] for an acting identity, we do not
 * re-implement undo semantics — we run the real thing: rebuild a gc-off
 * scratch doc from the full update log in clock order, replay the identity's
 * rows inside the range through a replica Y.UndoManager as ONE tracked
 * StackItem (captureTimeout: MAX_SAFE_INTEGER merges every tracked
 * transaction; untracked interleaved foreign rows neither join the item nor
 * break the merge), pop it with undo(), and capture the resulting
 * transaction's 'update' payload. That payload IS the popStackItem-equivalent
 * inverse (yjs UndoManager.js):
 *
 *  - Insertions half: iterates the edit's struct id ranges, skips structs
 *    already deleted (supersession skip, FR-010), deletes survivors by struct
 *    identity — later edits' structs are different ids and are untouched
 *    (FR-009).
 *  - Deletions half: skips structs the edit itself created (internal churn is
 *    not resurrected) and restores the rest via redoItem, which re-creates
 *    content anchored by surviving neighbors; redoItem returns null when a
 *    conflicting change wins (supersession skip for deletions). Content
 *    restoration is why the scratch doc is gc:false from the FULL log — the
 *    live doc gc's tombstones, the log never loses content (same reason
 *    diff-service builds gc-off).
 *  - Honest emptiness: with exactly one StackItem, performedChange === false
 *    makes undo() return null — the fully-superseded case (FR-011).
 *
 * The returned update is an ordinary Yjs update from the scratch doc's fresh
 * clientID: its delete set targets only the edit's own struct ids (idempotent
 * and commutative under concurrency) and its restored items anchor to structs
 * that exist in the log — applying it to the live doc is CRDT-correct and
 * never rewrites history (FR-006). Public yjs API only.
 */
const Y = require('yjs');
const { toMarkdown } = require('../mcp/yjs/serialization');
// Feature 040 (FR-015): the one shared "is this row mine?" predicate.
const { isSameIdentity } = require('../agent-identity');

/** Origin under which the target edit's rows are replayed (tracked). */
const EDIT_ORIGIN = 'undo-target-edit';
/** Origin for every other log row (untracked history). */
const HISTORY_ORIGIN = 'history';

/**
 * Compute the surgical inverse of an edit (or of an inverse — redo is the
 * same algorithm over the inverse's recorded range, research R4).
 *
 * @param {Array<{clock: number, userId: string|null, agentName: string|null,
 *   updateData: Uint8Array}>} rows - The document's FULL update log in clock
 *   order (as returned by getUpdatesInRange/getUpdatesWithUsers with data).
 * @param {{clockStart: number, clockEnd: number, clocks?: number[]|null}} range -
 *   The target range [s, e]. When `clocks` is present it is the EXACT clock
 *   set constituting the edit (review M1): only those rows are tracked, so
 *   interleaved same-identity rows from a concurrent call inside [s, e] are
 *   never inverted. Without it (legacy/pre-migration records) every identity
 *   row in the spanning range is tracked — the pre-M1 fallback.
 * @param {{userId: string, agentName: string|null}} identity - Acting identity;
 *   only rows attributed to it within the range constitute the edit
 *   (FR-001/FR-024/FR-029).
 * @param {Y.Doc|null} [liveDoc] - This instance's live shared doc, merged into
 *   the scratch state before popping so supersession is evaluated against
 *   in-flight, not-yet-persisted edits too (FR-013, RBD-9).
 * @returns {{inverseUpdate: Uint8Array, preMarkdown: string|null,
 *   postMarkdown: string|null} | null} null = nothing left to undo (fully
 *   superseded, or no identity rows in the range) — the honest empty. The
 *   markdown pair brackets the pop (feature 020, RBD-3): captured from the
 *   scratch fragment immediately before and after undoManager.undo(), AFTER
 *   the live-doc merge — race-free and honest post-supersession. Best-effort:
 *   both null when serialization throws; the inverse is never lost to it.
 */
function computeInverse(rows, range, identity, liveDoc = null) {
  const { clockStart, clockEnd } = range;
  const clockSet = Array.isArray(range.clocks) && range.clocks.length > 0
    ? new Set(range.clocks)
    : null;
  const scratch = new Y.Doc({ gc: false });
  let undoManager = null;
  try {
    const fragment = scratch.get('default', Y.XmlFragment);

    // Feature 040 (FR-015): the one shared identity predicate. Behavior-
    // preserving here — this site already normalized with `?? null`.
    const isIdentityRow = (r) => isSameIdentity(r, identity);

    let trackedAny = false;
    for (const row of rows) {
      const data = row.updateData instanceof Uint8Array
        ? row.updateData
        : new Uint8Array(row.updateData);

      if (row.clock < clockStart) {
        Y.applyUpdate(scratch, data, HISTORY_ORIGIN);
        continue;
      }

      // Create the UndoManager lazily, right before the first in-range row —
      // pre-range history must not be trackable under any circumstance.
      if (!undoManager) {
        undoManager = new Y.UndoManager(fragment, {
          trackedOrigins: new Set([EDIT_ORIGIN]),
          captureTimeout: Number.MAX_SAFE_INTEGER,
        });
      }

      // The SPANNING-RANGE fallback (no recorded clock set — a legacy/pre-016
      // row) is the only branch that can sweep in rows the recorder never
      // named. Feature 041 (FR-016, RBD-041-5): exclude sync-channel rows there,
      // mirroring the rule legacy.js already applies. A `via_sync` row proves
      // only that content reached the server THROUGH a client's reconnect
      // catch-up — never that the client authored it in this edit — so
      // inverting one would revert somebody else's work under this identity.
      // Until now that was safe only by timing, which is not an invariant. The
      // clockSet path needs no guard: exact clock sets come from the recorder,
      // which never records sync rows.
      const inTarget = clockSet
        ? clockSet.has(row.clock)
        : (row.clock >= clockStart && row.clock <= clockEnd && row.viaSync !== true);
      if (inTarget && isIdentityRow(row)) {
        Y.applyUpdate(scratch, data, EDIT_ORIGIN);
        trackedAny = true;
      } else {
        Y.applyUpdate(scratch, data, HISTORY_ORIGIN);
      }
    }

    if (!undoManager || !trackedAny || undoManager.undoStack.length === 0) {
      return null; // no identity rows in the range — nothing to invert
    }

    // Merge the live shared-doc state (in-flight edits not yet in the log)
    // so supersession is evaluated against what the inverse merges into.
    if (liveDoc) {
      const missing = Y.encodeStateAsUpdate(liveDoc, Y.encodeStateVector(scratch));
      Y.applyUpdate(scratch, missing, HISTORY_ORIGIN);
    }

    // Markdown bracket, half 1 (020, RBD-3): the pre-pop state — after the
    // live merge, immediately before undo(). Best-effort only.
    let preMarkdown = null;
    try {
      preMarkdown = toMarkdown(fragment);
    } catch {
      preMarkdown = null;
    }

    // Pop the one StackItem, capturing the transaction's update payload.
    let inverseUpdate = null;
    const onUpdate = (update) => { inverseUpdate = update; };
    scratch.on('update', onUpdate);
    let popped;
    try {
      popped = undoManager.undo();
    } finally {
      scratch.off('update', onUpdate);
    }

    if (!popped || !inverseUpdate) {
      return null; // performedChange === false — fully superseded (FR-011)
    }

    // Markdown bracket, half 2: the post-pop state. The pair nulls together —
    // a half-bracket can only produce a dishonest diff.
    let postMarkdown = null;
    if (preMarkdown !== null) {
      try {
        postMarkdown = toMarkdown(fragment);
      } catch {
        postMarkdown = null;
      }
    }
    if (postMarkdown === null) preMarkdown = null;

    return { inverseUpdate, preMarkdown, postMarkdown };
  } finally {
    if (undoManager) undoManager.destroy();
    scratch.destroy();
  }
}

// EDIT_ORIGIN / HISTORY_ORIGIN are module-internal scratch-doc origins used only
// by the replica-UndoManager rebuild below; nothing outside this file reads them.
module.exports = { computeInverse };
