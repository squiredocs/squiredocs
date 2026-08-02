/**
 * The chat "Reverted" stamp (feature 016; verification added by feature 041,
 * FR-015).
 *
 * A chat modify renders as a tool card, and undoing that edit marks the card
 * "Reverted" so the state survives a reload. The card is identified by a
 * CLIENT-SUPPLIED `toolCallId`, and the stamp used to be applied on trust.
 *
 * That is a lie waiting to happen. Undo picks its target LIFO over the acting
 * identity's records, and the chat assistant is ONE identity shared across all
 * of a user's chats — so the record actually undone is not necessarily the edit
 * on the card the request names (a newer edit in another chat wins the LIFO),
 * and a direct API call can name any card at all. Either way a card ends up
 * saying "Reverted" about an edit nobody reverted, which is exactly the class of
 * attribution lie this area is supposed to be free of.
 *
 * The fix is a comparison, not a policy: the modify tool already stores the
 * edit's clock range on the card (`part.output.editRange`), and undo/redo now
 * report the range of the record they actually claimed. Stamp only when those
 * agree. A card with NO stored range — a pre-016 card, or one whose modify
 * returned `editRangePending` — is a MISMATCH by rule: absence of evidence is
 * not a pass.
 *
 * Explicit non-goals (design amendment 2026-08-02 / 040 D19): no per-chat undo
 * scoping, no change to LIFO target selection, no offer guards, no restore-undo.
 * This is a read-and-compare at the stamp site only, and the undo/redo result is
 * never affected by its outcome.
 */

/**
 * @param {object} deps
 * @param {{loadChat: Function, saveChat: Function}} deps.chatStore
 * @param {string} chatId
 * @param {string} userId
 * @param {string} toolCallId - client-supplied card reference
 * @param {boolean} reverted - true to stamp (undo), false to clear (redo)
 * @param {object} [opts]
 * @param {{clockStart: number, clockEnd: number}|null} [opts.expectedRange] -
 *   the range of the record actually undone/redone. Omit to skip verification
 *   (no production caller does).
 * @param {string} [opts.label='undo'] - log tag
 * @returns {Promise<{stamped: boolean, reason: string}>}
 */
async function setChatPartReverted(deps, chatId, userId, toolCallId, reverted, { expectedRange, label = 'undo' } = {}) {
  const { chatStore } = deps;
  const messages = await chatStore.loadChat(chatId, userId);
  if (!messages || !messages.length) return { stamped: false, reason: 'chat-not-found' };

  // One pass: find the part, so the compare and the mutation share a load.
  let part = null;
  for (const m of messages) {
    for (const p of (m.parts || [])) {
      if (p.toolCallId === toolCallId && typeof p.type === 'string' && p.type.startsWith('tool-')) {
        part = p;
        break;
      }
    }
    if (part) break;
  }
  if (!part) {
    console.warn(`[${label}] reverted-stamp skipped for ${chatId}/${toolCallId}: no matching tool part`);
    return { stamped: false, reason: 'part-not-found' };
  }

  if (expectedRange !== undefined) {
    const cardRange = part.output?.editRange;
    const cardOk = !!cardRange
      && typeof cardRange.clockStart === 'number'
      && typeof cardRange.clockEnd === 'number';
    const recordOk = !!expectedRange
      && typeof expectedRange.clockStart === 'number'
      && typeof expectedRange.clockEnd === 'number';
    const matches = cardOk && recordOk
      && cardRange.clockStart === expectedRange.clockStart
      && cardRange.clockEnd === expectedRange.clockEnd;

    if (!matches) {
      const cardDesc = cardOk ? `${cardRange.clockStart}-${cardRange.clockEnd}` : 'none';
      const recordDesc = recordOk ? `${expectedRange.clockStart}-${expectedRange.clockEnd}` : 'none';
      console.warn(
        `[${label}] reverted-stamp skipped for ${chatId}/${toolCallId}: card range ${cardDesc} vs record range ${recordDesc}`
      );
      return { stamped: false, reason: 'range-mismatch' };
    }
  }

  let changed = false;
  if (reverted && part.reverted !== true) { part.reverted = true; changed = true; }
  else if (!reverted && part.reverted) { delete part.reverted; changed = true; }

  if (changed) await chatStore.saveChat(chatId, userId, messages);
  return { stamped: true, reason: changed ? 'stamped' : 'already-in-state' };
}

module.exports = { setChatPartReverted };
