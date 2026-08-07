/**
 * Spaces REST API (feature 053) — create/list/detail/rename/delete, the
 * uniform non-member 404, and the SC-001 "access with zero share rows" claim.
 *
 * Mounts the real router with the real auth middleware (the
 * server/api/__tests__/admin.test.js pattern), so the authorization rules under
 * test are the ones production runs.
 */
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { createPool, cleanupTestUser } = require('./helpers/db');

process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret';

const spacesApi = require('../api/spaces');
const spaces = require('../spaces');
const documents = require('../documents');
const users = require('../auth/users');
const { generateAccessToken } = require('../auth/jwt');

jest.mock('../email', () => ({
  sendShareInvite: jest.fn(async () => ({ ok: true })),
  sendShareNotification: jest.fn(async () => ({ ok: true })),
  sendSpaceInvite: jest.fn(async () => ({ ok: true })),
  sendSpaceNotification: jest.fn(async () => ({ ok: true })),
  sendEmail: jest.fn(async () => ({ ok: true })),
  notifyNewUser: jest.fn(),
  notifyLogin: jest.fn(),
  notifyCreditLimitReached: jest.fn(),
  notifySupportRequest: jest.fn(),
  sendWelcomeEmail: jest.fn(),
}));

describe('Spaces REST API', () => {
  let app;
  let pool;
  const createdUsers = [];
  const createdDocs = [];

  /** Create a real user row and a bearer token for it. */
  async function makeUser(label) {
    const user = await users.findOrCreateUser({
      googleId: `spaces-api-${label}-${crypto.randomUUID()}`,
      email: `spaces-api-${label}-${crypto.randomUUID()}@example.com`,
      name: `Spaces ${label}`,
      picture: null,
    });
    createdUsers.push(user.id);
    return { ...user, token: generateAccessToken(user) };
  }

  /** Create a document directly owned by `owner`, optionally inside a space. */
  async function makeDoc(owner, spaceId = null, title = 'Doc') {
    const docId = crypto.randomUUID();
    createdDocs.push(docId);
    await documents.createDocument(docId, owner.id, title, spaceId);
    return docId;
  }

  const auth = (req, user) => req.set('Authorization', `Bearer ${user.token}`);

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    documents.init(pool);
    spaces.init(pool);
    spacesApi.init(pool);

    app = express();
    app.use('/api/spaces', express.json(), spacesApi.router);
  });

  afterAll(async () => {
    if (createdDocs.length) {
      await pool.query('DELETE FROM document_shares WHERE doc_id = ANY($1::uuid[])', [createdDocs]);
      await pool.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [createdDocs]);
    }
    for (const id of createdUsers) await cleanupTestUser(pool, id);
    await pool.end();
  });

  describe('POST /api/spaces — create', () => {
    test('creates a space and makes the creator its sole owner', async () => {
      const alice = await makeUser('create');
      const res = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Platform' });

      expect(res.status).toBe(201);
      expect(res.body.space.name).toBe('Platform');
      expect(res.body.space.role).toBe('owner');
      expect(res.body.space.memberCount).toBe(1);

      const members = await spaces.getMembers(res.body.space.id);
      expect(members).toHaveLength(1);
      expect(members[0].userId).toBe(alice.id);
      expect(members[0].role).toBe('owner');
      // D8: even a self-grant records a grantor.
      expect(members[0].grantedBy).toBe(alice.id);
    });

    test('trims the name', async () => {
      const alice = await makeUser('trim');
      const res = await auth(request(app).post('/api/spaces'), alice).send({ name: '  Design  ' });
      expect(res.status).toBe(201);
      expect(res.body.space.name).toBe('Design');
    });

    test.each([
      ['missing', undefined],
      ['blank', ''],
      ['whitespace only', '   '],
    ])('rejects a %s name with 400', async (_label, name) => {
      const alice = await makeUser('blank');
      const res = await auth(request(app).post('/api/spaces'), alice).send({ name });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Space name is required');
    });

    test('rejects a 101-character name and accepts a 100-character one', async () => {
      const alice = await makeUser('long');
      const tooLong = await auth(request(app).post('/api/spaces'), alice).send({ name: 'x'.repeat(101) });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error).toMatch(/100 characters or fewer/);

      const atLimit = await auth(request(app).post('/api/spaces'), alice).send({ name: 'y'.repeat(100) });
      expect(atLimit.status).toBe(201);
    });

    test('allows duplicate names (RBD-053-1 — no uniqueness constraint)', async () => {
      const alice = await makeUser('dup');
      const first = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Platform' });
      const second = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Platform' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.space.id).not.toBe(first.body.space.id);
    });
  });

  describe('GET /api/spaces — my spaces', () => {
    test('is membership-scoped and ordered by name', async () => {
      const alice = await makeUser('list-a');
      const bob = await makeUser('list-b');
      await auth(request(app).post('/api/spaces'), alice).send({ name: 'Zeta' });
      await auth(request(app).post('/api/spaces'), alice).send({ name: 'Alpha' });

      const mine = await auth(request(app).get('/api/spaces'), alice);
      expect(mine.status).toBe(200);
      expect(mine.body.spaces.map((s) => s.name)).toEqual(['Alpha', 'Zeta']);

      const theirs = await auth(request(app).get('/api/spaces'), bob);
      expect(theirs.body.spaces).toEqual([]);
    });
  });

  describe('GET /api/spaces/:id — detail', () => {
    test('returns members, invites and the document count for a member', async () => {
      const alice = await makeUser('detail-a');
      const bob = await makeUser('detail-b');
      const created = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Detail' });
      const spaceId = created.body.space.id;

      await auth(request(app).post(`/api/spaces/${spaceId}/members`), alice)
        .send({ email: bob.email, role: 'editor' });
      await auth(request(app).post(`/api/spaces/${spaceId}/members`), alice)
        .send({ email: 'nobody-053@example.com', role: 'viewer' });
      await makeDoc(alice, spaceId);
      await makeDoc(alice, spaceId);

      const res = await auth(request(app).get(`/api/spaces/${spaceId}`), bob);
      expect(res.status).toBe(200);
      expect(res.body.space.documentCount).toBe(2);
      expect(res.body.space.role).toBe('editor');
      expect(res.body.members.map((m) => m.userId).sort()).toEqual([alice.id, bob.id].sort());
      // RBD-053-16: pending invites are visible to ALL members, not just owners.
      expect(res.body.invites.map((i) => i.email)).toEqual(['nobody-053@example.com']);
    });

    test('a non-member gets 404, indistinguishable from a missing space (RBD-053-10)', async () => {
      const alice = await makeUser('404-a');
      const stranger = await makeUser('404-s');
      const created = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Secret' });
      const spaceId = created.body.space.id;

      const nonMember = await auth(request(app).get(`/api/spaces/${spaceId}`), stranger);
      const missing = await auth(request(app).get(`/api/spaces/${crypto.randomUUID()}`), stranger);

      expect(nonMember.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(nonMember.body).toEqual(missing.body);
      expect(nonMember.body).toEqual({ error: 'Space not found' });
    });

    test('every /:id route answers a non-member with the same 404', async () => {
      const alice = await makeUser('404-all-a');
      const stranger = await makeUser('404-all-s');
      const created = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Sealed' });
      const id = created.body.space.id;

      const calls = [
        auth(request(app).get(`/api/spaces/${id}`), stranger),
        auth(request(app).patch(`/api/spaces/${id}`), stranger).send({ name: 'Nope' }),
        auth(request(app).delete(`/api/spaces/${id}`), stranger),
        auth(request(app).post(`/api/spaces/${id}/members`), stranger).send({ email: 'x@y.z', role: 'viewer' }),
        auth(request(app).put(`/api/spaces/${id}/members/${alice.id}`), stranger).send({ role: 'viewer' }),
        auth(request(app).delete(`/api/spaces/${id}/members/${alice.id}`), stranger),
        auth(request(app).delete(`/api/spaces/${id}/invites`), stranger).send({ email: 'x@y.z' }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Space not found' });
      }
    });
  });

  describe('PATCH /api/spaces/:id — rename', () => {
    test('an owner renames; a member who is not an owner gets 403', async () => {
      const alice = await makeUser('rename-a');
      const bob = await makeUser('rename-b');
      const created = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Before' });
      const id = created.body.space.id;
      await auth(request(app).post(`/api/spaces/${id}/members`), alice)
        .send({ email: bob.email, role: 'editor' });

      const ok = await auth(request(app).patch(`/api/spaces/${id}`), alice).send({ name: 'After' });
      expect(ok.status).toBe(200);
      expect(ok.body.space.name).toBe('After');

      const refused = await auth(request(app).patch(`/api/spaces/${id}`), bob).send({ name: 'Nope' });
      expect(refused.status).toBe(403);
      expect((await spaces.getSpace(id)).name).toBe('After');
    });

    test('applies the same name validation as create', async () => {
      const alice = await makeUser('rename-v');
      const created = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Valid' });
      const res = await auth(request(app).patch(`/api/spaces/${created.body.space.id}`), alice)
        .send({ name: '   ' });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/spaces/:id — delete (FR-024)', () => {
    test('documents revert to personal and are NOT deleted', async () => {
      const alice = await makeUser('del-a');
      const bob = await makeUser('del-b');
      const created = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Doomed' });
      const id = created.body.space.id;
      await auth(request(app).post(`/api/spaces/${id}/members`), alice)
        .send({ email: bob.email, role: 'editor' });
      await auth(request(app).post(`/api/spaces/${id}/members`), alice)
        .send({ email: 'pending-053@example.com', role: 'viewer' });

      const docA = await makeDoc(alice, id, 'Kept A');
      const docB = await makeDoc(alice, id, 'Kept B');
      // A direct share that must survive the deletion untouched.
      await documents.setRole(docB, bob.id, 'viewer', alice.id);

      // The count the confirm dialog states comes from the detail endpoint,
      // fetched BEFORE confirming — assert the two agree.
      const detail = await auth(request(app).get(`/api/spaces/${id}`), alice);
      expect(detail.body.space.documentCount).toBe(2);

      const res = await auth(request(app).delete(`/api/spaces/${id}`), alice);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: true, documentsReverted: 2 });

      for (const docId of [docA, docB]) {
        const doc = await documents.getDocument(docId);
        expect(doc).not.toBeNull();
        expect(doc.space_id).toBeNull();
      }
      expect(await documents.getRole(docB, bob.id)).toBe('viewer');
      expect(await spaces.getSpace(id)).toBeNull();
      const members = await pool.query('SELECT 1 FROM space_members WHERE space_id = $1', [id]);
      const invites = await pool.query('SELECT 1 FROM space_invites WHERE space_id = $1', [id]);
      expect(members.rowCount).toBe(0);
      expect(invites.rowCount).toBe(0);
    });

    test('a non-owner member cannot delete', async () => {
      const alice = await makeUser('del-na');
      const bob = await makeUser('del-nb');
      const created = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Safe' });
      const id = created.body.space.id;
      await auth(request(app).post(`/api/spaces/${id}/members`), alice)
        .send({ email: bob.email, role: 'editor' });

      const res = await auth(request(app).delete(`/api/spaces/${id}`), bob);
      expect(res.status).toBe(403);
      expect(await spaces.getSpace(id)).not.toBeNull();
    });
  });

  describe('SC-001 — access with ZERO new document_shares rows', () => {
    test('M members + N documents grants access without creating a single share', async () => {
      const alice = await makeUser('sc001-owner');
      const members = [await makeUser('sc001-m1'), await makeUser('sc001-m2'), await makeUser('sc001-m3')];
      const memberIds = members.map((m) => m.id);

      const before = await pool.query(
        'SELECT count(*)::int AS n FROM document_shares WHERE user_id = ANY($1::uuid[])',
        [memberIds]
      );

      const created = await auth(request(app).post('/api/spaces'), alice).send({ name: 'Zero Shares' });
      const spaceId = created.body.space.id;
      for (const m of members) {
        const res = await auth(request(app).post(`/api/spaces/${spaceId}/members`), alice)
          .send({ email: m.email, role: 'editor' });
        expect(res.status).toBe(201);
      }
      const docIds = [
        await makeDoc(alice, spaceId, 'N1'),
        await makeDoc(alice, spaceId, 'N2'),
        await makeDoc(alice, spaceId, 'N3'),
        await makeDoc(alice, spaceId, 'N4'),
      ];

      // Every member can act on every document…
      for (const m of members) {
        for (const docId of docIds) {
          expect(await documents.getRole(docId, m.id)).toBe('editor');
        }
        const { rows } = await documents.getAccessibleDocuments(m.id, { space: spaceId });
        expect(rows.map((r) => r.doc_id).sort()).toEqual([...docIds].sort());
      }

      // …and not one document_shares row was created for any of them.
      const after = await pool.query(
        'SELECT count(*)::int AS n FROM document_shares WHERE user_id = ANY($1::uuid[])',
        [memberIds]
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  describe('space filter matrix on the document list (FR-026/FR-040)', () => {
    let alice;
    let spaceA;
    let spaceB;
    let personalDoc;
    let docA;
    let docB;

    beforeAll(async () => {
      alice = await makeUser('filter');
      spaceA = (await auth(request(app).post('/api/spaces'), alice).send({ name: 'Filter A' })).body.space.id;
      spaceB = (await auth(request(app).post('/api/spaces'), alice).send({ name: 'Filter B' })).body.space.id;
      personalDoc = await makeDoc(alice, null, 'Personal');
      docA = await makeDoc(alice, spaceA, 'In A');
      docB = await makeDoc(alice, spaceB, 'In B');
    });

    const ids = (result) => result.rows.map((r) => r.doc_id).sort();

    test('omitting the filter returns exactly the same set as space=all', async () => {
      const omitted = await documents.getAccessibleDocuments(alice.id, {});
      const all = await documents.getAccessibleDocuments(alice.id, { space: 'all' });
      expect(ids(omitted)).toEqual([personalDoc, docA, docB].sort());
      expect(ids(all)).toEqual(ids(omitted));
      expect(omitted.total).toBe(all.total);
    });

    test("space='personal' returns only documents in no space", async () => {
      const res = await documents.getAccessibleDocuments(alice.id, { space: 'personal' });
      expect(ids(res)).toEqual([personalDoc]);
    });

    test('a space id returns only that space', async () => {
      expect(ids(await documents.getAccessibleDocuments(alice.id, { space: spaceA }))).toEqual([docA]);
      expect(ids(await documents.getAccessibleDocuments(alice.id, { space: spaceB }))).toEqual([docB]);
    });

    test('rows carry spaceId and spaceName', async () => {
      const res = await documents.getAccessibleDocuments(alice.id, { space: spaceA });
      expect(res.rows[0].space_id).toBe(spaceA);
      expect(res.rows[0].space_name).toBe('Filter A');
      const personal = await documents.getAccessibleDocuments(alice.id, { space: 'personal' });
      expect(personal.rows[0].space_id).toBeNull();
      expect(personal.rows[0].space_name).toBeNull();
    });

    test('a non-member asking for someone else\'s space gets zero rows, not a refusal', async () => {
      const stranger = await makeUser('filter-stranger');
      const res = await documents.getAccessibleDocuments(stranger.id, { space: spaceA });
      expect(res.rows).toEqual([]);
      expect(res.total).toBe(0);
    });

    test('an unparseable scope throws rather than silently listing everything', () => {
      expect(() => documents.normalizeSpaceScope('not-a-space')).toThrow(/'all', 'personal', or a space id/);
    });

    test('the space filter composes with filter=owned/shared_with_me', async () => {
      const bob = await makeUser('filter-bob');
      await auth(request(app).post(`/api/spaces/${spaceA}/members`), alice)
        .send({ email: bob.email, role: 'editor' });
      // Bob owns nothing; his only route to docA is the space.
      const owned = await documents.getAccessibleDocuments(bob.id, { space: spaceA, filter: 'owned' });
      expect(owned.rows).toEqual([]);
      const shared = await documents.getAccessibleDocuments(bob.id, { space: spaceA, filter: 'shared_with_me' });
      expect(ids(shared)).toEqual([docA]);
    });
  });
});
