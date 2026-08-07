/**
 * Spaces — schema-level model tests (feature 053).
 *
 * Two things live here and nothing else:
 *   1. The `doc_role` enum-inversion hazard, asserted executably (RBD-053-12).
 *   2. The `document_access` view's semantics at the SQL level.
 *
 * See specs/053-spaces/contracts/access-derivation.md for the view text and
 * design/spaces.md (D3/D5) for the union rule it implements.
 */
const { createPool } = require('./helpers/db');

const SUFFIX = 'spaces-model';

describe('Spaces model (schema level)', () => {
  let pool;

  beforeAll(async () => {
    pool = createPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('doc_role enum ordering — LOUD FLAG 1 (RBD-053-12)', () => {
    /**
     * `doc_role` was declared as ['owner','editor','viewer'] in
     * migrations/006_add_role_to_shares.js:10. PostgreSQL orders an enum by
     * DECLARATION order, so the enum collates
     *
     *     'owner' < 'editor' < 'viewer'
     *
     * which is the exact INVERSE of the privilege ladder in
     * server/documents.js ({ owner: 3, editor: 2, viewer: 1 }).
     *
     * Consequence: `GREATEST(direct_role, space_role)` — the design's literal
     * phrasing — returns the WEAKER role, so a viewer space-member would strip
     * a direct owner of their own document.
     *
     * This test exists so the hazard is executable documentation. It asserts
     * the WRONG answer on purpose. If it ever starts failing, the enum was
     * reordered and every rank mapping in the feature must be revisited.
     *
     * The one place effective role is computed is the `document_access` view
     * (migration 1799820000000), which maps to integer ranks, takes GREATEST of
     * the INTEGERS, and maps back. No GREATEST/MAX/ORDER BY over a doc_role
     * value may exist anywhere else in this feature.
     */
    test("GREATEST('owner','viewer') returns 'viewer' — the enum is inverted", async () => {
      const result = await pool.query(
        "SELECT GREATEST('owner'::doc_role, 'viewer'::doc_role) AS wrong"
      );
      expect(result.rows[0].wrong).toBe('viewer');
    });

    test('the enum collates owner < editor < viewer (declaration order)', async () => {
      const result = await pool.query(
        `SELECT ('owner'::doc_role < 'editor'::doc_role) AS a,
                ('editor'::doc_role < 'viewer'::doc_role) AS b`
      );
      expect(result.rows[0].a).toBe(true);
      expect(result.rows[0].b).toBe(true);
    });
  });

  describe('document_access view semantics', () => {
    let alice; // direct-share holder
    let bob; // space member
    let carol; // no access
    let grantor;
    const docIds = [];
    let spaceId;

    /** Insert a document owned (directly) by `ownerId`, optionally in a space. */
    async function makeDoc(ownerId, space = null) {
      const { rows } = await pool.query(
        `INSERT INTO documents (id, creator_id, space_id)
         VALUES (uuid_generate_v4(), $1, $2) RETURNING id`,
        [ownerId, space]
      );
      const docId = rows[0].id;
      docIds.push(docId);
      await pool.query(
        `INSERT INTO document_shares (doc_id, user_id, role, granted_by)
         VALUES ($1, $2, 'owner', $2)`,
        [docId, ownerId]
      );
      return docId;
    }

    async function access(docId, userId) {
      const { rows } = await pool.query(
        'SELECT role, direct_role, space_role FROM document_access WHERE doc_id = $1 AND user_id = $2',
        [docId, userId]
      );
      return rows[0] || null;
    }

    beforeAll(async () => {
      const mkUser = async (tag) => {
        const { rows } = await pool.query(
          `INSERT INTO users (google_id, email, name)
           VALUES ($1, $2, $3) RETURNING id`,
          [`gid-${SUFFIX}-${tag}-${Math.random()}`, `${SUFFIX}-${tag}@example.com`, `User ${tag}`]
        );
        return rows[0].id;
      };
      alice = await mkUser('alice');
      bob = await mkUser('bob');
      carol = await mkUser('carol');
      grantor = await mkUser('grantor');

      const space = await pool.query(
        'INSERT INTO spaces (name, created_by) VALUES ($1, $2) RETURNING id',
        [`${SUFFIX} space`, alice]
      );
      spaceId = space.rows[0].id;
      await pool.query(
        `INSERT INTO space_members (space_id, user_id, role, granted_by)
         VALUES ($1, $2, 'owner', $2)`,
        [spaceId, alice]
      );
    });

    afterAll(async () => {
      await pool.query('DELETE FROM document_shares WHERE doc_id = ANY($1::uuid[])', [docIds]);
      await pool.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [docIds]);
      await pool.query('DELETE FROM space_members WHERE space_id = $1', [spaceId]);
      await pool.query('DELETE FROM space_invites WHERE space_id = $1', [spaceId]);
      await pool.query('DELETE FROM spaces WHERE id = $1', [spaceId]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        [alice, bob, carol, grantor],
      ]);
    });

    test('direct-only access: role === direct_role, space_role null', async () => {
      const docId = await makeDoc(alice);
      await pool.query(
        `INSERT INTO document_shares (doc_id, user_id, role, granted_by)
         VALUES ($1, $2, 'editor', $3)`,
        [docId, bob, alice]
      );
      expect(await access(docId, bob)).toEqual({
        role: 'editor',
        direct_role: 'editor',
        space_role: null,
      });
    });

    test('space-only access: role === space_role, direct_role null', async () => {
      const docId = await makeDoc(alice, spaceId);
      await pool.query(
        `INSERT INTO space_members (space_id, user_id, role, granted_by)
         VALUES ($1, $2, 'editor', $3)`,
        [spaceId, bob, alice]
      );
      expect(await access(docId, bob)).toEqual({
        role: 'editor',
        direct_role: null,
        space_role: 'editor',
      });
      await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [
        spaceId,
        bob,
      ]);
    });

    test('both legs: the stronger wins when the space is stronger', async () => {
      const docId = await makeDoc(alice, spaceId);
      await pool.query(
        `INSERT INTO document_shares (doc_id, user_id, role, granted_by)
         VALUES ($1, $2, 'viewer', $3)`,
        [docId, bob, alice]
      );
      await pool.query(
        `INSERT INTO space_members (space_id, user_id, role, granted_by)
         VALUES ($1, $2, 'editor', $3)`,
        [spaceId, bob, alice]
      );
      expect(await access(docId, bob)).toEqual({
        role: 'editor',
        direct_role: 'viewer',
        space_role: 'editor',
      });
      await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [
        spaceId,
        bob,
      ]);
    });

    test('both legs: the stronger wins when the DIRECT role is stronger (the RBD-053-12 case)', async () => {
      // direct owner + space viewer. A literal GREATEST() on doc_role would
      // return 'viewer' here and silently demote the document's own owner.
      const docId = await makeDoc(bob, spaceId);
      await pool.query(
        `INSERT INTO space_members (space_id, user_id, role, granted_by)
         VALUES ($1, $2, 'viewer', $3)`,
        [spaceId, bob, alice]
      );
      expect(await access(docId, bob)).toEqual({
        role: 'owner',
        direct_role: 'owner',
        space_role: 'viewer',
      });
      await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [
        spaceId,
        bob,
      ]);
    });

    test('personal documents are unchanged: no space leg at all', async () => {
      const docId = await makeDoc(alice, null);
      expect(await access(docId, alice)).toEqual({
        role: 'owner',
        direct_role: 'owner',
        space_role: null,
      });
    });

    test('absence means no access', async () => {
      const docId = await makeDoc(alice, spaceId);
      expect(await access(docId, carol)).toBeNull();
    });

    test('space membership alone grants owner passthrough, uncapped (D5)', async () => {
      const docId = await makeDoc(bob, spaceId);
      // alice is an OWNER member of the space and holds no direct share.
      expect(await access(docId, alice)).toEqual({
        role: 'owner',
        direct_role: null,
        space_role: 'owner',
      });
    });
  });
});
