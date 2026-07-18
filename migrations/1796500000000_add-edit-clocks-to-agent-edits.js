/**
 * Migration: add undo_target_clocks to agent_edits (016 post-merge review M1).
 *
 * A recorded edit's [edit_clock_start, edit_clock_end] span can enclose
 * interleaved rows of the SAME identity from a concurrent call (A: 10,12;
 * B: 11,13). Range-based inversion would revert B's row 11 while undoing A.
 * undo_target_clocks persists the EXACT clock set the next undo inverts:
 *
 *  - set to the edit's covering clock set on record (modify's durability wait
 *    already knows exactly which rows carry the edit);
 *  - overwritten with the redo's single inverse clock on each redo claim
 *    (matching the undo_target_start/end rewrite);
 *  - NULL means "no exact set known" (legacy first-undo inserts and rows
 *    recorded before this migration): the inverse computation falls back to
 *    the spanning [start, end] range, the pre-M1 behavior.
 *
 * Timestamp is deliberately 1796500000000 — after 016's 1796000000000 (which
 * local DBs already ran, so it must not be edited) and before the 1797…
 * range reserved for feature 017, keeping migration order consistent
 * everywhere.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('agent_edits', {
    undo_target_clocks: { type: 'integer[]', notNull: false },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn('agent_edits', 'undo_target_clocks');
};
