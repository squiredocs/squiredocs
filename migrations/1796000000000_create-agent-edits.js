/**
 * Migration: create agent_edits (feature 016 — log-derived undo/redo).
 *
 * One row per recorded content-changing agent edit; doubles as the undo/redo
 * chain state machine and the at-most-once claim guard (specs/016 data-model.md
 * §1, research R5/R6; RBD-3, RBD-7, FR-014, FR-017, FR-028).
 *
 * Column semantics:
 *  - (doc_guid, user_id, agent_name) is the acting identity scope, matching the
 *    per-row attribution on yjs_updates (user_id uuid, agent_name text).
 *  - edit_clock_start/end: the original edit's clock range in yjs_updates.
 *  - state: 'active' (undoable) | 'undone' (redoable) — chain polarity.
 *  - undo_target_*: the range the NEXT undo inverts (init = edit range; after
 *    each redo, the redo's own inverse range).
 *  - redo_target_*: the range the NEXT redo inverts (the latest undo's inverse
 *    rows; null until first undo).
 *  - last_undone_at: LIFO ordering for redo (RBD-4).
 *
 * Timestamp is deliberately 1796000000000 — greater than the 1795000000000
 * floor imposed by the retired feature-008 phantom pgmigrations row.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('agent_edits', {
    id: { type: 'bigserial', primaryKey: true },
    doc_guid: { type: 'uuid', notNull: true },
    // Same type as yjs_updates.user_id (uuid, FK to users). ON DELETE CASCADE:
    // an edit record without its acting user has no resolvable identity.
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    agent_name: { type: 'text', notNull: true },
    edit_clock_start: { type: 'integer', notNull: true },
    edit_clock_end: { type: 'integer', notNull: true },
    state: {
      type: 'text',
      notNull: true,
      check: "state IN ('active','undone')",
    },
    undo_target_start: { type: 'integer', notNull: true },
    undo_target_end: { type: 'integer', notNull: true },
    redo_target_start: { type: 'integer', notNull: false },
    redo_target_end: { type: 'integer', notNull: false },
    last_undone_at: { type: 'timestamptz', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Identity of an edit; arbitrates concurrent legacy first-undo inserts (R6/R7).
  pgm.addConstraint('agent_edits', 'agent_edits_identity_unique', {
    unique: ['doc_guid', 'user_id', 'agent_name', 'edit_clock_start'],
  });

  // Latest edit / LIFO undo stepping (FR-003, FR-017) and undo-status canUndo.
  pgm.createIndex('agent_edits', [
    'doc_guid',
    'user_id',
    'agent_name',
    { name: 'edit_clock_start', sort: 'DESC' },
  ], { name: 'idx_agent_edits_identity_clock' });

  // Redo pick (most-recently-undone first) and undo-status canRedo.
  pgm.createIndex('agent_edits', [
    'doc_guid',
    'user_id',
    'agent_name',
    'state',
    { name: 'last_undone_at', sort: 'DESC' },
  ], { name: 'idx_agent_edits_identity_state_undone' });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('agent_edits');
};
