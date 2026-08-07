/**
 * Spaces — moving documents in, out and across (feature 053, US3 / D7).
 *
 * The full rule matrix plus the two properties that make movement safe:
 *   - shares are NEVER written by a move (I9 / FR-014) — asserted byte-for-byte
 *     across every direction;
 *   - losing a space grant revokes exactly like losing a direct share, on the
 *     next call and on the live-connection re-check (SC-003).
 *
 * The ownership half of the rule reads `document_shares` DIRECTLY. A space
 * owner has passthrough owner on everything in their space, and letting that
 * satisfy move-IN would let them relocate someone else's document (US3-5).
 */
const crypto = require('crypto');
const { createPool, cleanupTestUser } = require('./helpers/db');

const documents = require('../documents');
const spaces = require('../spaces');

describe('Spaces: moving documents', () => {
  let pool;
  const createdUsers = [];
  const createdDocs = [];
  const createdSpaces = [];

  async function makeUser(label) {
    const { rows } = await pool.query(
      'INSERT INTO users (google_id, email, name) VALUES ($1, $2, $3) RETURNING id',
      [`mv-${label}-${crypto.randomUUID()}`, `mv-${label}-${crypto.randomUUID()}@example.com`, `Mv ${label}`]
    );
    createdUsers.push(rows[0].id);
    return rows[0].id;
  }

  async function makeSpace(ownerId, name = 'Move Space') {
    const space = await spaces.createSpace(name, ownerId);
    createdSpaces.push(space.id);
    return space.id;
  }

  async function addMember(spaceId, userId, role, grantedBy) {
    await pool.query(
      `INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (space_id, user_id) DO UPDATE SET role = $3`,
      [spaceId, userId, role, grantedBy]
    );
  }

  async function makeDoc(ownerId, spaceId = null) {
    const docId = crypto.randomUUID();
    createdDocs.push(docId);
    await documents.createDocument(docId, ownerId, 'Movable', spaceId);
    return docId;
  }

  /** Every share row for a document, in a stable, comparable shape. */
  async function shareSnapshot(docId) {
    const { rows } = await pool.query(
      `SELECT user_id, role, granted_by, created_at FROM document_shares
        WHERE doc_id = $1 ORDER BY user_id`,
      [docId]
    );
    return rows;
  }

  async function homeOf(docId) {
    return (await documents.getDocument(docId)).space_id;
  }

  beforeAll(async () => {
    pool = createPool();
    documents.init(pool);
    spaces.init(pool);
  });

  afterAll(async () => {
    if (createdDocs.length) {
      await pool.query('DELETE FROM document_shares WHERE doc_id = ANY($1::uuid[])', [createdDocs]);
      await pool.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [createdDocs]);
    }
    if (createdSpaces.length) {
      await pool.query('DELETE FROM space_members WHERE space_id = ANY($1::uuid[])', [createdSpaces]);
      await pool.query('DELETE FROM space_invites WHERE space_id = ANY($1::uuid[])', [createdSpaces]);
      await pool.query('DELETE FROM spaces WHERE id = ANY($1::uuid[])', [createdSpaces]);
    }
    for (const id of createdUsers) await cleanupTestUser(pool, id);
    await pool.end();
  });

  describe('move IN (personal → space), FR-011', () => {
    test('the direct owner who is an editor member succeeds', async () => {
      const alice = await makeUser('in-a');
      const spaceId = await makeSpace(alice);
      const docId = await makeDoc(alice);

      const res = await spaces.moveDocument(alice, docId, spaceId);
      expect(res).toMatchObject({ docId, spaceId, spaceName: 'Move Space' });
      expect(await homeOf(docId)).toBe(spaceId);
    });

    test('US3-4: refused for a direct owner who is only a VIEWER member', async () => {
      const alice = await makeUser('in-owner');
      const bob = await makeUser('in-viewer');
      const spaceId = await makeSpace(alice);
      await addMember(spaceId, bob, 'viewer', alice);
      const docId = await makeDoc(bob);

      await expect(spaces.moveDocument(bob, docId, spaceId)).rejects.toMatchObject({
        status: 403,
        message: 'You must be an editor or owner of the target space',
      });
      expect(await homeOf(docId)).toBeNull();
    });

    test('US3-5/FR-011: refused for an editor member who is not the direct owner', async () => {
      const alice = await makeUser('in-notowner-a');
      const bob = await makeUser('in-notowner-b');
      const spaceId = await makeSpace(alice);
      await addMember(spaceId, bob, 'editor', alice);
      const docId = await makeDoc(alice);
      // Bob can edit the document but does not own it.
      await documents.setRole(docId, bob, 'editor', alice);

      await expect(spaces.moveDocument(bob, docId, spaceId)).rejects.toMatchObject({
        status: 403,
        message: 'Only the document owner can move it into a space',
      });
      expect(await homeOf(docId)).toBeNull();
    });

    test('US3-5: a PASSTHROUGH owner still cannot move a document in', async () => {
      const alice = await makeUser('in-pass-a');
      const curator = await makeUser('in-pass-c');
      const sourceSpace = await makeSpace(alice, 'Source');
      const targetSpace = await makeSpace(curator, 'Target');
      // curator is an OWNER of the source space, so their effective role on
      // every document in it is 'owner' — but not a direct share.
      await addMember(sourceSpace, curator, 'owner', alice);
      const docId = await makeDoc(alice, sourceSpace);

      expect(await documents.getRole(docId, curator)).toBe('owner');
      await expect(spaces.moveDocument(curator, docId, targetSpace)).rejects.toMatchObject({
        status: 403,
        message: 'You can only move this document out to your personal area',
      });
      expect(await homeOf(docId)).toBe(sourceSpace);
    });

    test('a caller with no access at all cannot tell the document from a missing one', async () => {
      const alice = await makeUser('in-none-a');
      const stranger = await makeUser('in-none-s');
      const spaceId = await makeSpace(stranger);
      const docId = await makeDoc(alice);

      await expect(spaces.moveDocument(stranger, docId, spaceId)).rejects.toMatchObject({
        status: 404,
        message: 'Document not found',
      });
      await expect(spaces.moveDocument(stranger, crypto.randomUUID(), spaceId)).rejects.toMatchObject({
        status: 404,
        message: 'Document not found',
      });
    });
  });

  describe('move OUT (space → personal), FR-012', () => {
    test('the direct owner succeeds', async () => {
      const alice = await makeUser('out-a');
      const spaceId = await makeSpace(alice);
      const docId = await makeDoc(alice, spaceId);

      const res = await spaces.moveDocument(alice, docId, null);
      expect(res).toEqual({ docId, spaceId: null, spaceName: null });
      expect(await homeOf(docId)).toBeNull();
    });

    test('US3-3: a space OWNER who is not the document owner may evict it (curation)', async () => {
      const author = await makeUser('out-author');
      const curator = await makeUser('out-curator');
      const spaceId = await makeSpace(author);
      await addMember(spaceId, curator, 'owner', author);
      const docId = await makeDoc(author, spaceId);

      const res = await spaces.moveDocument(curator, docId, null);
      expect(res.spaceId).toBeNull();
      expect(await homeOf(docId)).toBeNull();
      // The author's own ownership is untouched.
      expect(await documents.getRole(docId, author)).toBe('owner');
    });

    test('a space EDITOR who is not the document owner cannot move it out', async () => {
      const author = await makeUser('out-ed-a');
      const editor = await makeUser('out-ed-e');
      const spaceId = await makeSpace(author);
      await addMember(spaceId, editor, 'editor', author);
      const docId = await makeDoc(author, spaceId);

      await expect(spaces.moveDocument(editor, docId, null)).rejects.toMatchObject({
        status: 403,
        message: 'Only the document owner or an owner of its space can move it out',
      });
      expect(await homeOf(docId)).toBe(spaceId);
    });
  });

  describe('move ACROSS (space A → space B), FR-013 / RBD-053-3', () => {
    test('US3-6: succeeds in one step when BOTH halves are satisfied', async () => {
      const alice = await makeUser('across-a');
      const spaceA = await makeSpace(alice, 'A');
      const spaceB = await makeSpace(alice, 'B');
      const docId = await makeDoc(alice, spaceA);

      const res = await spaces.moveDocument(alice, docId, spaceB);
      expect(res.spaceId).toBe(spaceB);
      expect(res.spaceName).toBe('B');
      expect(await homeOf(docId)).toBe(spaceB);
    });

    test('refused when only the curation path applies (RBD-053-3)', async () => {
      const author = await makeUser('across-author');
      const curator = await makeUser('across-curator');
      const spaceA = await makeSpace(author, 'A2');
      const spaceB = await makeSpace(curator, 'B2');
      await addMember(spaceA, curator, 'owner', author);
      const docId = await makeDoc(author, spaceA);

      await expect(spaces.moveDocument(curator, docId, spaceB)).rejects.toMatchObject({
        status: 403,
        message: 'You can only move this document out to your personal area',
      });
      expect(await homeOf(docId)).toBe(spaceA);
      // …but the curator may still evict it to personal.
      await spaces.moveDocument(curator, docId, null);
      expect(await homeOf(docId)).toBeNull();
    });

    test('refused when the actor is a direct owner but not an editor of the target', async () => {
      const alice = await makeUser('across-noed-a');
      const bob = await makeUser('across-noed-b');
      const spaceA = await makeSpace(alice, 'A3');
      const spaceB = await makeSpace(bob, 'B3');
      await addMember(spaceB, alice, 'viewer', bob);
      const docId = await makeDoc(alice, spaceA);

      await expect(spaces.moveDocument(alice, docId, spaceB)).rejects.toMatchObject({
        status: 403,
        message: 'You must be an editor or owner of the target space',
      });
      expect(await homeOf(docId)).toBe(spaceA);
    });
  });

  describe('edge cases', () => {
    test('moving to the same target is a no-op SUCCESS', async () => {
      const alice = await makeUser('noop-a');
      const spaceId = await makeSpace(alice, 'Same');
      const inSpace = await makeDoc(alice, spaceId);
      const personal = await makeDoc(alice);

      expect(await spaces.moveDocument(alice, inSpace, spaceId)).toEqual({
        docId: inSpace, spaceId, spaceName: 'Same',
      });
      expect(await spaces.moveDocument(alice, personal, null)).toEqual({
        docId: personal, spaceId: null, spaceName: null,
      });
    });

    test('a deleted / non-existent target fails cleanly, leaving the home untouched', async () => {
      const alice = await makeUser('gone-a');
      const spaceId = await makeSpace(alice, 'Gone');
      const docId = await makeDoc(alice, spaceId);
      const ghost = crypto.randomUUID();

      await expect(spaces.moveDocument(alice, docId, ghost)).rejects.toMatchObject({
        status: 404,
        message: 'Space not found',
      });
      expect(await homeOf(docId)).toBe(spaceId);

      // …and a target deleted after the caller last saw it behaves the same.
      const doomed = await makeSpace(alice, 'Doomed target');
      await spaces.deleteSpace(doomed);
      await expect(spaces.moveDocument(alice, docId, doomed)).rejects.toMatchObject({ status: 404 });
      expect(await homeOf(docId)).toBe(spaceId);
    });

    test('two simultaneous moves serialize; the document ends in exactly one home', async () => {
      const alice = await makeUser('race-a');
      const spaceA = await makeSpace(alice, 'Race A');
      const spaceB = await makeSpace(alice, 'Race B');
      const docId = await makeDoc(alice);

      const results = await Promise.allSettled([
        spaces.moveDocument(alice, docId, spaceA),
        spaces.moveDocument(alice, docId, spaceB),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const home = await homeOf(docId);
      expect([spaceA, spaceB]).toContain(home);
    });
  });

  describe('shares are never touched by a move (FR-014 / I9)', () => {
    test('every direction leaves document_shares byte-identical', async () => {
      const alice = await makeUser('keep-a');
      const bob = await makeUser('keep-b');
      const spaceA = await makeSpace(alice, 'Keep A');
      const spaceB = await makeSpace(alice, 'Keep B');
      const docId = await makeDoc(alice);
      await documents.setRole(docId, bob, 'viewer', alice);

      const baseline = await shareSnapshot(docId);
      expect(baseline).toHaveLength(2);

      for (const target of [spaceA, spaceB, null, spaceA, null]) {
        await spaces.moveDocument(alice, docId, target);
        expect(await shareSnapshot(docId)).toEqual(baseline);
      }
    });

    test('US3-2: a direct-share holder keeps access after the document leaves the space', async () => {
      const alice = await makeUser('survive-a');
      const bob = await makeUser('survive-b'); // direct viewer
      const carol = await makeUser('survive-c'); // space-only editor
      const spaceId = await makeSpace(alice, 'Survive');
      await addMember(spaceId, carol, 'editor', alice);
      const docId = await makeDoc(alice, spaceId);
      await documents.setRole(docId, bob, 'viewer', alice);

      expect(await documents.getRole(docId, bob)).toBe('viewer');
      expect(await documents.getRole(docId, carol)).toBe('editor');

      await spaces.moveDocument(alice, docId, null);

      expect(await documents.getRole(docId, bob)).toBe('viewer');
      expect(await documents.getRole(docId, carol)).toBeNull();
    });
  });

  describe('SC-003 — revocation reaches a live connection', () => {
    /**
     * The 60-second interval in server/index.js acts on
     * documents.evaluateAccessRecheck, which is what this drives. Asserting the
     * DECISION rather than sleeping a minute keeps the claim honest and the
     * suite fast: the branch the interval takes on `revoked` is two lines —
     * ws.close(4403, 'Access revoked') and return.
     */
    test('a space-only member is revoked by the re-check after a move-out', async () => {
      const alice = await makeUser('rev-a');
      const member = await makeUser('rev-m');
      const spaceId = await makeSpace(alice, 'Revoking');
      await addMember(spaceId, member, 'editor', alice);
      const docId = await makeDoc(alice, spaceId);

      expect(await documents.evaluateAccessRecheck(docId, member, true)).toEqual({
        revoked: false, role: 'editor', canEdit: true,
      });

      await spaces.moveDocument(alice, docId, null);

      expect(await documents.evaluateAccessRecheck(docId, member, true)).toEqual({
        revoked: true, role: null, canEdit: false,
      });
    });

    test('deleting the space revokes the same way', async () => {
      const alice = await makeUser('rev-del-a');
      const member = await makeUser('rev-del-m');
      const spaceId = await makeSpace(alice, 'Deleted soon');
      await addMember(spaceId, member, 'editor', alice);
      const docId = await makeDoc(alice, spaceId);

      await spaces.deleteSpace(spaceId);
      expect((await documents.evaluateAccessRecheck(docId, member, true)).revoked).toBe(true);
      // The owner is unaffected — their access was never the space's to revoke.
      expect((await documents.evaluateAccessRecheck(docId, alice, true)).revoked).toBe(false);
    });

    test('a direct-share holder is NOT revoked by the same move', async () => {
      const alice = await makeUser('rev-direct-a');
      const bob = await makeUser('rev-direct-b');
      const spaceId = await makeSpace(alice, 'Unaffected');
      const docId = await makeDoc(alice, spaceId);
      await documents.setRole(docId, bob, 'editor', alice);

      await spaces.moveDocument(alice, docId, null);
      expect(await documents.evaluateAccessRecheck(docId, bob, true)).toEqual({
        revoked: false, role: 'editor', canEdit: true,
      });
    });

    test('a demoted member loses edit capability without losing the connection', async () => {
      const alice = await makeUser('demote-a');
      const member = await makeUser('demote-m');
      const spaceId = await makeSpace(alice, 'Demoting');
      await addMember(spaceId, member, 'editor', alice);
      const docId = await makeDoc(alice, spaceId);

      await addMember(spaceId, member, 'viewer', alice);
      expect(await documents.evaluateAccessRecheck(docId, member, true)).toEqual({
        revoked: false, role: 'viewer', canEdit: false,
      });
    });

    test('a re-check never widens what the token allows', async () => {
      const alice = await makeUser('token-a');
      const spaceId = await makeSpace(alice, 'Token');
      const docId = await makeDoc(alice, spaceId);
      expect((await documents.evaluateAccessRecheck(docId, alice, false)).canEdit).toBe(false);
      expect((await documents.evaluateAccessRecheck(docId, alice, true)).canEdit).toBe(true);
    });
  });
});
