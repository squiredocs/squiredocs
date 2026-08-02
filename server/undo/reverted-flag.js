/**
 * The "Reverted" marker on a chat tool part — and the FR-018 guarantee that it
 * never lies (feature 040, FR-019, D17).
 *
 * Extracted from `server/index.js` so the guard is directly testable: SC-013
 * requires proof that the mislabel is impossible even with the client guard
 * bypassed, and `index.js` cannot be required from a test without starting the
 * HTTP server. `index.js` holds the route; this holds the rule.
 *
 * Background — why a rule is needed at all:
 *
 *   `POST /api/docs/:docId/undo` selects the identity's most-recent record
 *   (LIFO) and has always used the request's `toolCallId` ONLY to stamp this
 *   flag. The two were never checked against each other. Once a web-UI restore
 *   enters that queue (FR-001), pressing "Undo edit" on an assistant modify
 *   card inverts the RESTORE while stamping "Reverted" on the MODIFY — a
 *   false statement to the user, and exactly what FR-018 forbids.
 *
 *   The client-side offer guard (FR-017) cannot close this by itself: it is
 *   fed by a 30-second poll, and nothing tells the chat component that a
 *   restore happened over in the version-history panel. So the lie stays
 *   reachable for up to 30s — and indefinitely for an older client that never
 *   sends the new fields. This module is the by-construction half; the client
 *   guard is the UX half.
 */

/**
 * Set or clear the `reverted` flag on a chat tool part, but ONLY when that
 * part is the record the undo/redo endpoint actually acted on.
 *
 * The part's `output.editRange.clockStart` and the record's
 * `agent_edits.edit_clock_start` are the same number by construction —
 * `modify.js` writes both from one durability result.
 *
 * Fail directions are deliberate and asymmetric:
 *
 *  - **Fail closed** when the part carries no `editRange.clockStart`. That is
 *    the `editRangePending` case (the modify's durability wait timed out, so
 *    the tool returned no `editRange`). The acted record is known but the part
 *    is unidentifiable, so any stamp would be a guess. Not stamping costs a
 *    missing marker on a rare card; stamping risks the lie. This is also what
 *    closes the residual window the client guard leaves open, since that guard
 *    fails OPEN on this same missing value.
 *
 *  - **Fail open** when `actedEditClockStart` is `undefined`. That happens only
 *    on the legacy-derivation undo path, and it is safe BY CONSTRUCTION rather
 *    than by optimism: that path runs only when the identity has no
 *    `agent_edits` rows at all in the document (`undo-service` checks
 *    `latestEdit` first), so there is no competing record — in particular no
 *    restore — that the flag could be misattributed away from. Refusing here
 *    would regress a working pre-016 path for no honesty gain.
 *
 * The undo/redo itself is never affected: this only governs the label.
 *
 * @param {{loadChat: Function, saveChat: Function}} chatStore
 * @param {object} opts
 * @param {string} opts.chatId
 * @param {string} opts.userId
 * @param {string} opts.toolCallId
 * @param {boolean} opts.reverted - true after an undo, false after a redo.
 * @param {number|undefined} opts.actedEditClockStart - `edit_clock_start` of
 *   the record actually inverted; `undefined` when no record backed the action.
 * @returns {Promise<{changed: boolean, refused: boolean}>}
 */
async function applyRevertedFlag(chatStore, {
  chatId, userId, toolCallId, reverted, actedEditClockStart,
}) {
  const messages = await chatStore.loadChat(chatId, userId);
  if (!messages || !messages.length) return { changed: false, refused: false };

  let changed = false;
  let refused = false;

  for (const m of messages) {
    for (const p of (m.parts || [])) {
      if (p.toolCallId !== toolCallId) continue;
      if (typeof p.type !== 'string' || !p.type.startsWith('tool-')) continue;

      if (actedEditClockStart !== undefined) {
        const partClock = p.output?.editRange?.clockStart;
        if (partClock !== actedEditClockStart) {
          refused = true;
          console.warn(
            `[undo] refusing to mark tool part ${toolCallId} as `
            + `${reverted ? 'reverted' : 'not reverted'}: it is not the record that was `
            + `acted on (part editRange.clockStart=${partClock}, `
            + `acted edit_clock_start=${actedEditClockStart}). `
            + `The ${reverted ? 'undo' : 'redo'} itself stands.`
          );
          continue;
        }
      }

      if (reverted && p.reverted !== true) { p.reverted = true; changed = true; }
      else if (!reverted && p.reverted) { delete p.reverted; changed = true; }
    }
  }

  if (changed) await chatStore.saveChat(chatId, userId, messages);
  return { changed, refused };
}

module.exports = { applyRevertedFlag };
