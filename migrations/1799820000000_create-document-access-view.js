/**
 * Migration: the `document_access` view — feature 053, design/spaces.md D3/D5.
 *
 * THE single derivation of effective document access in this application.
 * Nothing else may go in this migration: it is the one artifact a reviewer
 * reads to audit the whole permission model. See
 * specs/053-spaces/contracts/access-derivation.md.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE VIEW document_access AS
    SELECT
      src.doc_id,
      src.user_id,
      -- Rank arithmetic, NOT the doc_role enum, whose declaration order
      -- ('owner','editor','viewer') collates owner < editor < viewer — the
      -- exact inverse of the privilege ladder. GREATEST() on doc_role returns
      -- the WEAKER role. See specs/053-spaces/research.md R2. This is the ONLY
      -- place in the codebase where role ranks are compared in SQL.
      (ARRAY['viewer','editor','owner'])[
         GREATEST(COALESCE(MAX(src.direct_rank), 0), COALESCE(MAX(src.space_rank), 0))
      ]::doc_role                                                        AS role,
      (ARRAY['viewer','editor','owner'])[MAX(src.direct_rank)]::doc_role AS direct_role,
      (ARRAY['viewer','editor','owner'])[MAX(src.space_rank)]::doc_role  AS space_role
    FROM (
      -- direct leg
      SELECT ds.doc_id,
             ds.user_id,
             CASE ds.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END AS direct_rank,
             NULL::int AS space_rank
        FROM document_shares ds
      UNION ALL
      -- space leg (D3 union, D5 uncapped passthrough)
      SELECT d.id,
             sm.user_id,
             NULL::int,
             CASE sm.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END
        FROM documents d
        JOIN space_members sm ON sm.space_id = d.space_id
    ) src
    GROUP BY src.doc_id, src.user_id;
  `);

  pgm.sql(`
    COMMENT ON VIEW document_access IS
      'Effective document access: the stronger of a direct document_shares role and a space_members role via documents.space_id (feature 053, design/spaces.md D3/D5). doc_id and user_id are deliberately the ONLY non-aggregated columns so quals push down through the GROUP BY into both UNION ALL branches and reach the underlying indexes — do NOT add space_id. direct_role is what "owned" means everywhere (RBD-053-7).';
  `);
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS document_access');
};
