/**
 * Spaces — the effective-role matrix (feature 053, US2 / SC-002 / SC-007).
 *
 * ONE expected-role table for the full {none,viewer,editor,owner} direct role ×
 * {none,viewer,editor,owner} space role product, asserted through every surface
 * that answers "what may this user do here": documents.getRole, the document
 * list, and permissions.can.*.
 *
 * The two cases worth naming:
 *   - direct owner + space viewer ⇒ owner. A literal GREATEST() on the doc_role
 *     enum returns 'viewer' here, silently demoting a document's own owner.
 *     That is RBD-053-12, and it is why rank arithmetic lives only in the view.
 *   - space owner + no direct share ⇒ owner, INCLUDING delete (D5, uncapped).
 */
const crypto = require('crypto');
const { createPool, cleanupTestUser } = require('./helpers/db');

jest.mock('../email', () => ({
  sendShareInvite: jest.fn(async () => ({ ok: true })),
  sendShareNotification: jest.fn(async () => ({ ok: true })),
}));

const documents = require('../documents');
const permissions = require('../permissions');
const spaces = require('../spaces');
const users = require('../auth/users');
const { shareDocumentByEmail, changeRole, removeUserAccess } = require('../share-service');

const LEVELS = [null, 'viewer', 'editor', 'owner'];
const RANK = { viewer: 1, editor: 2, owner: 3 };

/** The whole model in one line: the stronger of the two grants, or no access. */
function expectedRole(direct, space) {
  const best = Math.max(direct ? RANK[direct] : 0, space ? RANK[space] : 0);
  return best === 0 ? null : ['viewer', 'editor', 'owner'][best - 1];
}

describe('Spaces effective role', () => {
  let pool;
  const createdUsers = [];
  const createdDocs = [];
  const createdSpaces = [];

  async function makeUser(label) {
    const { rows } = await pool.query(
      `INSERT INTO users (google_id, email, name) VALUES ($1, $2, $3) RETURNING id, email`,
      [`eff-${label}-${crypto.randomUUID()}`, `eff-${label}-${crypto.randomUUID()}@example.com`, `Eff ${label}`]
    );
    createdUsers.push(rows[0].id);
    return rows[0];
  }

  async function makeSpace(ownerId, name = 'Effective') {
    const space = await spaces.createSpace(name, ownerId);
    createdSpaces.push(space.id);
    return space.id;
  }

  async function makeDoc(ownerId, spaceId = null) {
    const docId = crypto.randomUUID();
    createdDocs.push(docId);
    await documents.createDocument(docId, ownerId, 'Matrix doc', spaceId);
    return docId;
  }

  beforeAll(async () => {
    pool = createPool();
    documents.init(pool);
    spaces.init(pool);
    users.init(pool);
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

  describe('the 4×4 matrix through getRole', () => {
    let author;
    let subject;
    let spaceId;
    let docId;

    beforeAll(async () => {
      author = await makeUser('matrix-author');
      subject = await makeUser('matrix-subject');
      spaceId = await makeSpace(author.id);
      docId = await makeDoc(author.id, spaceId);
    });

    /** Put the subject at exactly (direct, space) on the one shared document. */
    async function place(direct, space) {
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1 AND user_id = $2', [docId, subject.id]);
      await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, subject.id]);
      if (direct) await documents.setRole(docId, subject.id, direct, author.id);
      if (space) {
        await pool.query(
          'INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, $3, $4)',
          [spaceId, subject.id, space, author.id]
        );
      }
    }

    for (const direct of LEVELS) {
      for (const space of LEVELS) {
        const want = expectedRole(direct, space);
        test(`direct=${direct ?? 'none'} space=${space ?? 'none'} ⇒ ${want ?? 'no access'}`, async () => {
          await place(direct, space);
          expect(await documents.getRole(docId, subject.id)).toBe(want);

          // The list agrees with getRole on the same pair.
          const { rows } = await documents.getAccessibleDocuments(subject.id, { space: spaceId });
          const row = rows.find((r) => r.doc_id === docId);
          if (want === null) {
            expect(row).toBeUndefined();
          } else {
            expect(row.role).toBe(want);
            expect(row.direct_role).toBe(direct);
            expect(row.space_role).toBe(space);
          }

          // permissions.can.* reads the same effective role.
          const canView = await permissions.can.view(subject.id, docId);
          const canEdit = await permissions.can.edit(subject.id, docId);
          const canDelete = await permissions.can.delete(subject.id, docId);
          expect(canView.allowed).toBe(want !== null);
          expect(canEdit.allowed).toBe(want === 'editor' || want === 'owner');
          expect(canDelete.allowed).toBe(want === 'owner');
        });
      }
    }
  });

  describe('the two cases the model exists for', () => {
    test('US2-3: a space OWNER with no direct share may delete (D5, uncapped)', async () => {
      const author = await makeUser('pass-author');
      const curator = await makeUser('pass-curator');
      const spaceId = await makeSpace(author.id);
      await pool.query(
        "INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $3)",
        [spaceId, curator.id, author.id]
      );
      const docId = await makeDoc(author.id, spaceId);

      expect(await documents.getRole(docId, curator.id)).toBe('owner');
      expect((await permissions.can.delete(curator.id, docId)).allowed).toBe(true);
      // …but they still do not DIRECTLY own it.
      const { rows } = await pool.query(
        'SELECT direct_role FROM document_access WHERE doc_id = $1 AND user_id = $2',
        [docId, curator.id]
      );
      expect(rows[0].direct_role).toBeNull();
    });

    test('US2-4: a space EDITOR may not delete', async () => {
      const author = await makeUser('nodel-author');
      const editor = await makeUser('nodel-editor');
      const spaceId = await makeSpace(author.id);
      await pool.query(
        "INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, 'editor', $3)",
        [spaceId, editor.id, author.id]
      );
      const docId = await makeDoc(author.id, spaceId);

      expect(await documents.getRole(docId, editor.id)).toBe('editor');
      expect((await permissions.can.delete(editor.id, docId)).allowed).toBe(false);
      expect((await permissions.can.edit(editor.id, docId)).allowed).toBe(true);
    });

    test('RBD-053-12: direct owner + space viewer stays owner', async () => {
      const author = await makeUser('inv-author');
      const spaceId = await makeSpace(author.id);
      const owner = await makeUser('inv-owner');
      const docId = await makeDoc(owner.id, spaceId);
      await pool.query(
        "INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, 'viewer', $3)",
        [spaceId, owner.id, author.id]
      );

      expect(await documents.getRole(docId, owner.id)).toBe('owner');
      expect((await permissions.can.delete(owner.id, docId)).allowed).toBe(true);
    });
  });

  describe('SC-007 — nothing changes for all-personal data', () => {
    test('role === direct_role and the list is unchanged when no space is involved', async () => {
      const alice = await makeUser('sc007-a');
      const bob = await makeUser('sc007-b');
      const owned = await makeDoc(alice.id);
      const shared = await makeDoc(bob.id);
      await documents.setRole(shared, alice.id, 'editor', bob.id);

      const { rows } = await documents.getAccessibleDocuments(alice.id, {});
      const mine = rows.filter((r) => [owned, shared].includes(r.doc_id));
      expect(mine).toHaveLength(2);
      for (const row of mine) {
        expect(row.role).toBe(row.direct_role);
        expect(row.space_role).toBeNull();
        expect(row.space_id).toBeNull();
      }

      expect((await documents.getAccessibleDocuments(alice.id, { filter: 'owned' })).rows
        .map((r) => r.doc_id)).toContain(owned);
      expect((await documents.getAccessibleDocuments(alice.id, { filter: 'shared_with_me' })).rows
        .map((r) => r.doc_id)).toContain(shared);
    });
  });

  /**
   * Post-merge review M1. The three target-owner guards (share, role change,
   * unshare) protect the document's DIRECT owner row. Reading the EFFECTIVE
   * role there froze direct-share management for every space-owner member,
   * because D5 passthrough already calls them an owner of the document.
   */
  describe('review M1 — the target-owner guards read the DIRECT role', () => {
    let author;
    let curator;
    let spaceId;
    let docId;

    beforeEach(async () => {
      author = await makeUser('m1-author');
      curator = await makeUser('m1-curator');
      spaceId = await makeSpace(author.id, 'Manageable');
      await pool.query(
        "INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $3)",
        [spaceId, curator.id, author.id]
      );
      docId = await makeDoc(author.id, spaceId);

      // The precondition that made the bug: effective owner, no direct row.
      expect(await documents.getRole(docId, curator.id)).toBe('owner');
      expect(await documents.getDirectRole(docId, curator.id)).toBeNull();
    });

    test('sharing TO a space-owner member with no direct row succeeds', async () => {
      const res = await shareDocumentByEmail({
        actor: { userId: author.id, email: author.email },
        docId,
        email: curator.email,
        role: 'editor',
        baseUrl: 'https://example.test',
      });

      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe('editor');
      expect(await documents.getDirectRole(docId, curator.id)).toBe('editor');
      // Their effective role is still owner — the space grant is untouched.
      expect(await documents.getRole(docId, curator.id)).toBe('owner');
    });

    test('a stale direct viewer row on a space-owner member can be changed', async () => {
      await documents.setRole(docId, curator.id, 'viewer', author.id);

      const res = await changeRole({
        actor: { userId: author.id },
        docId,
        targetUserId: curator.id,
        role: 'editor',
      });

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('editor');
      expect(await documents.getDirectRole(docId, curator.id)).toBe('editor');
    });

    test('a stale direct viewer row on a space-owner member can be removed', async () => {
      await documents.setRole(docId, curator.id, 'viewer', author.id);

      const res = await removeUserAccess({
        actor: { userId: author.id },
        docId,
        targetUserId: curator.id,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(await documents.getDirectRole(docId, curator.id)).toBeNull();
      // Removing the direct row does not revoke space-derived access (FR-022).
      expect(await documents.getRole(docId, curator.id)).toBe('owner');
    });

    describe('the real direct owner is still protected at all three sites', () => {
      test('share', async () => {
        const res = await shareDocumentByEmail({
          actor: { userId: curator.id, email: curator.email },
          docId,
          email: author.email,
          role: 'viewer',
          baseUrl: 'https://example.test',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Cannot change owner's role");
        expect(await documents.getDirectRole(docId, author.id)).toBe('owner');
      });

      test('role change', async () => {
        const res = await changeRole({
          actor: { userId: curator.id },
          docId,
          targetUserId: author.id,
          role: 'viewer',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Cannot change owner's role");
        expect(await documents.getDirectRole(docId, author.id)).toBe('owner');
      });

      test('unshare', async () => {
        const res = await removeUserAccess({
          actor: { userId: curator.id },
          docId,
          targetUserId: author.id,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Cannot remove owner');
        expect(await documents.getDirectRole(docId, author.id)).toBe('owner');
      });
    });
  });

  describe('FR-015 — access follows the document as it moves', () => {
    test('a space-only member loses the role on the very next getRole after a move-out', async () => {
      const author = await makeUser('move-author');
      const member = await makeUser('move-member');
      const spaceId = await makeSpace(author.id);
      await pool.query(
        "INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, 'editor', $3)",
        [spaceId, member.id, author.id]
      );
      const docId = await makeDoc(author.id, spaceId);

      expect(await documents.getRole(docId, member.id)).toBe('editor');
      await spaces.moveDocument(author.id, docId, null);
      expect(await documents.getRole(docId, member.id)).toBeNull();
    });

    test('deleting the space revokes the same way', async () => {
      const author = await makeUser('del-author');
      const member = await makeUser('del-member');
      const spaceId = await makeSpace(author.id, 'Vanishing');
      await pool.query(
        "INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, 'editor', $3)",
        [spaceId, member.id, author.id]
      );
      const docId = await makeDoc(author.id, spaceId);
      expect(await documents.getRole(docId, member.id)).toBe('editor');

      await spaces.deleteSpace(spaceId);
      expect(await documents.getRole(docId, member.id)).toBeNull();
      expect(await documents.getRole(docId, author.id)).toBe('owner');
    });
  });
});
