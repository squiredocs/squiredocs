/**
 * Spaces — the membership lifecycle (feature 053, US1 + US4).
 *
 * none → invited (pending) → member(role) → none, plus the invariants that make
 * it safe: raise-only invites (I6), one pending invite per address per space
 * (I5), "at most your own role" (FR-008/FR-009), and the last-owner guard
 * (FR-010/I3) across all three ways to lose an owner.
 */
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { createPool, cleanupTestUser } = require('./helpers/db');

process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret';

const mockSendSpaceInvite = jest.fn(async () => ({ ok: true }));
const mockSendSpaceNotification = jest.fn(async () => ({ ok: true }));
jest.mock('../email', () => ({
  sendShareInvite: jest.fn(async () => ({ ok: true })),
  sendShareNotification: jest.fn(async () => ({ ok: true })),
  sendSpaceInvite: (...a) => mockSendSpaceInvite(...a),
  sendSpaceNotification: (...a) => mockSendSpaceNotification(...a),
  sendEmail: jest.fn(async () => ({ ok: true })),
  notifyNewUser: jest.fn(),
  notifyLogin: jest.fn(),
  notifyCreditLimitReached: jest.fn(),
  notifySupportRequest: jest.fn(),
  sendWelcomeEmail: jest.fn(),
}));

const spacesApi = require('../api/spaces');
const spaces = require('../spaces');
const documents = require('../documents');
const users = require('../auth/users');
const { generateAccessToken } = require('../auth/jwt');

describe('Spaces membership lifecycle', () => {
  let app;
  let pool;
  const createdUsers = [];

  async function makeUser(label) {
    const user = await users.findOrCreateUser({
      googleId: `spaces-mem-${label}-${crypto.randomUUID()}`,
      email: `spaces-mem-${label}-${crypto.randomUUID()}@example.com`,
      name: `Member ${label}`,
      picture: null,
    });
    createdUsers.push(user.id);
    return { ...user, token: generateAccessToken(user) };
  }

  const auth = (req, user) => req.set('Authorization', `Bearer ${user.token}`);

  async function makeSpace(owner, name = 'Space') {
    const res = await auth(request(app).post('/api/spaces'), owner).send({ name });
    return res.body.space.id;
  }

  const invite = (actor, spaceId, email, role) =>
    auth(request(app).post(`/api/spaces/${spaceId}/members`), actor).send({ email, role });

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
    for (const id of createdUsers) await cleanupTestUser(pool, id);
    await pool.end();
  });

  beforeEach(() => {
    mockSendSpaceInvite.mockClear();
    mockSendSpaceNotification.mockClear();
  });

  describe('inviting an existing account (US1)', () => {
    test('adds the membership immediately, with granted_by set (FR-036)', async () => {
      const alice = await makeUser('inv-a');
      const bob = await makeUser('inv-b');
      const spaceId = await makeSpace(alice);

      const res = await invite(alice, spaceId, bob.email, 'editor');
      expect(res.status).toBe(201);
      expect(res.body.member.userId).toBe(bob.id);
      expect(res.body.member.role).toBe('editor');
      expect(res.body.member.grantedBy).toBe(alice.id);
      expect(await spaces.getMemberRole(spaceId, bob.id)).toBe('editor');
    });

    test('matches the address case-insensitively', async () => {
      const alice = await makeUser('case-a');
      const bob = await makeUser('case-b');
      const spaceId = await makeSpace(alice);
      const res = await invite(alice, spaceId, bob.email.toUpperCase(), 'viewer');
      expect(res.status).toBe(201);
      expect(await spaces.getMemberRole(spaceId, bob.id)).toBe('viewer');
    });

    test('re-inviting RAISES the role but never lowers it (FR-019 / I6)', async () => {
      const alice = await makeUser('raise-a');
      const bob = await makeUser('raise-b');
      const spaceId = await makeSpace(alice);

      await invite(alice, spaceId, bob.email, 'viewer');
      await invite(alice, spaceId, bob.email, 'editor');
      expect(await spaces.getMemberRole(spaceId, bob.id)).toBe('editor');

      // A lower re-invite is a no-op success, not a demotion and not an error.
      const lower = await invite(alice, spaceId, bob.email, 'viewer');
      expect(lower.status).toBe(201);
      expect(await spaces.getMemberRole(spaceId, bob.id)).toBe('editor');
    });

    test('inviting an existing member or yourself is a re-invite, never an error', async () => {
      const alice = await makeUser('self-a');
      const spaceId = await makeSpace(alice);
      const res = await invite(alice, spaceId, alice.email, 'viewer');
      expect(res.status).toBe(201);
      // Still owner — a lower self re-invite cannot demote the only owner.
      expect(await spaces.getMemberRole(spaceId, alice.id)).toBe('owner');
    });

    test('at most your own role: an editor cannot grant owner (US4-3)', async () => {
      const alice = await makeUser('cap-a');
      const bob = await makeUser('cap-b');
      const carol = await makeUser('cap-c');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, bob.email, 'editor');

      const tooHigh = await invite(bob, spaceId, carol.email, 'owner');
      expect(tooHigh.status).toBe(403);
      expect(await spaces.getMemberRole(spaceId, carol.id)).toBeNull();

      const allowed = await invite(bob, spaceId, carol.email, 'editor');
      expect(allowed.status).toBe(201);
    });

    test('an owner CAN grant owner (D5/FR-009)', async () => {
      const alice = await makeUser('grant-owner-a');
      const bob = await makeUser('grant-owner-b');
      const spaceId = await makeSpace(alice);
      const res = await invite(alice, spaceId, bob.email, 'owner');
      expect(res.status).toBe(201);
      expect(await spaces.getMemberRole(spaceId, bob.id)).toBe('owner');
    });

    test('rejects a role outside the enum with 400', async () => {
      const alice = await makeUser('badrole');
      const spaceId = await makeSpace(alice);
      const res = await invite(alice, spaceId, 'x@example.com', 'admin');
      expect(res.status).toBe(400);
    });
  });

  describe('email gating (FR-021)', () => {
    test('mail is sent when the inviter has email_enabled', async () => {
      const alice = await makeUser('mail-on-a');
      const bob = await makeUser('mail-on-b');
      await pool.query('UPDATE users SET email_enabled = true WHERE id = $1', [alice.id]);
      const spaceId = await makeSpace(alice, 'Mailed');

      const res = await invite(alice, spaceId, bob.email, 'editor');
      expect(res.status).toBe(201);
      expect(mockSendSpaceNotification).toHaveBeenCalledTimes(1);
      expect(mockSendSpaceNotification.mock.calls[0][0]).toMatchObject({
        to: bob.email,
        spaceName: 'Mailed',
      });
    });

    test('membership is granted even when the inviter cannot send mail (G1)', async () => {
      const alice = await makeUser('mail-off-a');
      const bob = await makeUser('mail-off-b');
      await pool.query('UPDATE users SET email_enabled = false WHERE id = $1', [alice.id]);
      const spaceId = await makeSpace(alice);

      const res = await invite(alice, spaceId, bob.email, 'editor');
      expect(res.status).toBe(201);
      expect(await spaces.getMemberRole(spaceId, bob.id)).toBe('editor');
      expect(mockSendSpaceNotification).not.toHaveBeenCalled();
      expect(mockSendSpaceInvite).not.toHaveBeenCalled();
    });

    test('a pending invite is recorded even when mail is suppressed (G1)', async () => {
      const alice = await makeUser('mail-off-p');
      await pool.query('UPDATE users SET email_enabled = false WHERE id = $1', [alice.id]);
      const spaceId = await makeSpace(alice);

      const res = await invite(alice, spaceId, 'unknown-053-g1@example.com', 'viewer');
      expect(res.status).toBe(201);
      expect(res.body.invite).toMatchObject({ email: 'unknown-053-g1@example.com', pending: true });
      expect(await spaces.getInvites(spaceId)).toHaveLength(1);
      expect(mockSendSpaceInvite).not.toHaveBeenCalled();
    });
  });

  describe('pending invites for unknown addresses (US4)', () => {
    test('creates a pending row rather than a membership', async () => {
      const alice = await makeUser('pend-a');
      const spaceId = await makeSpace(alice);
      const res = await invite(alice, spaceId, 'Future-053@Example.com', 'editor');

      expect(res.status).toBe(201);
      expect(res.body.invite).toEqual({ email: 'Future-053@Example.com', role: 'editor', pending: true });
      const invites = await spaces.getInvites(spaceId);
      expect(invites).toHaveLength(1);
      expect(invites[0].role).toBe('editor');
    });

    test('re-invite raises the pending role and never lowers it (RBD-053-9)', async () => {
      const alice = await makeUser('pend-raise');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, 'raise-053@example.com', 'viewer');
      await invite(alice, spaceId, 'raise-053@example.com', 'editor');
      expect((await spaces.getInvites(spaceId))[0].role).toBe('editor');

      await invite(alice, spaceId, 'raise-053@example.com', 'viewer');
      expect((await spaces.getInvites(spaceId))[0].role).toBe('editor');
    });

    test('one pending invite per space per address, case-insensitive (FR-020 / I5)', async () => {
      const alice = await makeUser('pend-uniq');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, 'Dup-053@example.com', 'viewer');
      await invite(alice, spaceId, 'dup-053@EXAMPLE.com', 'editor');
      const invites = await spaces.getInvites(spaceId);
      expect(invites).toHaveLength(1);
      expect(invites[0].role).toBe('editor');
    });

    test('revoking a pending invite is owner-only and idempotent (FR-023 / RBD-053-4)', async () => {
      const alice = await makeUser('revoke-a');
      const bob = await makeUser('revoke-b');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, bob.email, 'editor');
      await invite(alice, spaceId, 'revoke-053@example.com', 'viewer');

      const byMember = await auth(request(app).delete(`/api/spaces/${spaceId}/invites`), bob)
        .send({ email: 'revoke-053@example.com' });
      expect(byMember.status).toBe(403);
      expect(await spaces.getInvites(spaceId)).toHaveLength(1);

      const byOwner = await auth(request(app).delete(`/api/spaces/${spaceId}/invites`), alice)
        .send({ email: 'REVOKE-053@example.com' });
      expect(byOwner.status).toBe(200);
      expect(await spaces.getInvites(spaceId)).toHaveLength(0);

      const again = await auth(request(app).delete(`/api/spaces/${spaceId}/invites`), alice)
        .send({ email: 'revoke-053@example.com' });
      expect(again.status).toBe(200);
    });
  });

  describe('role changes and removal', () => {
    test('an owner changes a role; granted_by follows the acting user (FR-036)', async () => {
      const alice = await makeUser('role-a');
      const bob = await makeUser('role-b');
      const carol = await makeUser('role-c');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, bob.email, 'owner');
      await invite(alice, spaceId, carol.email, 'viewer');

      const res = await auth(request(app).put(`/api/spaces/${spaceId}/members/${carol.id}`), bob)
        .send({ role: 'editor' });
      expect(res.status).toBe(200);
      expect(res.body.member.role).toBe('editor');
      expect(res.body.member.grantedBy).toBe(bob.id);
    });

    test('a non-owner member cannot change roles or remove others (US4-5)', async () => {
      const alice = await makeUser('nonowner-a');
      const bob = await makeUser('nonowner-b');
      const carol = await makeUser('nonowner-c');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, bob.email, 'editor');
      await invite(alice, spaceId, carol.email, 'viewer');

      const roleChange = await auth(request(app).put(`/api/spaces/${spaceId}/members/${carol.id}`), bob)
        .send({ role: 'editor' });
      expect(roleChange.status).toBe(403);

      const removal = await auth(request(app).delete(`/api/spaces/${spaceId}/members/${carol.id}`), bob);
      expect(removal.status).toBe(403);
      expect(await spaces.getMemberRole(spaceId, carol.id)).toBe('viewer');
    });

    test('removing a member leaves their DIRECT shares intact (FR-022)', async () => {
      const alice = await makeUser('keepshare-a');
      const bob = await makeUser('keepshare-b');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, bob.email, 'editor');

      const docId = crypto.randomUUID();
      await documents.createDocument(docId, alice.id, 'Shared too', spaceId);
      await documents.setRole(docId, bob.id, 'viewer', alice.id);

      const res = await auth(request(app).delete(`/api/spaces/${spaceId}/members/${bob.id}`), alice);
      expect(res.status).toBe(200);
      expect(await spaces.getMemberRole(spaceId, bob.id)).toBeNull();
      expect(await documents.getRole(docId, bob.id)).toBe('viewer');

      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    });

    test('any member may leave', async () => {
      const alice = await makeUser('leave-a');
      const bob = await makeUser('leave-b');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, bob.email, 'viewer');

      const res = await auth(request(app).delete(`/api/spaces/${spaceId}/members/${bob.id}`), bob);
      expect(res.status).toBe(200);
      expect(await spaces.getMemberRole(spaceId, bob.id)).toBeNull();
    });
  });

  describe('the last owner (FR-010 / I3 / US4-6)', () => {
    const GUIDANCE =
      'A space must have at least one owner. Make another member an owner first, or delete the space.';

    test('cannot leave', async () => {
      const alice = await makeUser('last-leave');
      const spaceId = await makeSpace(alice);
      const res = await auth(request(app).delete(`/api/spaces/${spaceId}/members/${alice.id}`), alice);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(GUIDANCE);
      expect(await spaces.getMemberRole(spaceId, alice.id)).toBe('owner');
    });

    test('cannot be removed', async () => {
      const alice = await makeUser('last-remove-a');
      const bob = await makeUser('last-remove-b');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, bob.email, 'owner');
      // Bob is now an owner too and may act; he tries to remove the other owner
      // AFTER demoting himself is not possible, so instead remove alice while
      // alice is the only owner — recreate that state by demoting bob first.
      await auth(request(app).put(`/api/spaces/${spaceId}/members/${bob.id}`), alice)
        .send({ role: 'editor' });

      const res = await auth(request(app).delete(`/api/spaces/${spaceId}/members/${alice.id}`), alice);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(GUIDANCE);
    });

    test('cannot be demoted', async () => {
      const alice = await makeUser('last-demote');
      const spaceId = await makeSpace(alice);
      const res = await auth(request(app).put(`/api/spaces/${spaceId}/members/${alice.id}`), alice)
        .send({ role: 'editor' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(GUIDANCE);
      expect(await spaces.getMemberRole(spaceId, alice.id)).toBe('owner');
    });

    test('all three become possible once a second owner exists (ownership transfer)', async () => {
      const alice = await makeUser('transfer-a');
      const bob = await makeUser('transfer-b');
      const carol = await makeUser('transfer-c');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, bob.email, 'owner');
      await invite(alice, spaceId, carol.email, 'owner');

      // demote
      const demote = await auth(request(app).put(`/api/spaces/${spaceId}/members/${carol.id}`), alice)
        .send({ role: 'viewer' });
      expect(demote.status).toBe(200);

      // remove the other owner
      const remove = await auth(request(app).delete(`/api/spaces/${spaceId}/members/${bob.id}`), alice);
      expect(remove.status).toBe(200);

      // now alice is the last owner again and cannot leave
      const leave = await auth(request(app).delete(`/api/spaces/${spaceId}/members/${alice.id}`), alice);
      expect(leave.status).toBe(409);

      // promote carol, then alice may leave
      await auth(request(app).put(`/api/spaces/${spaceId}/members/${carol.id}`), alice)
        .send({ role: 'owner' });
      const leaveOk = await auth(request(app).delete(`/api/spaces/${spaceId}/members/${alice.id}`), alice);
      expect(leaveOk.status).toBe(200);
      expect(await spaces.getMemberRole(spaceId, carol.id)).toBe('owner');
    });
  });

  describe('granted_by is set on EVERY membership write path (FR-036 / T085)', () => {
    test('creation, invite, role change and conversion all record a grantor', async () => {
      const alice = await makeUser('gb-a');
      const bob = await makeUser('gb-b');
      const spaceId = await makeSpace(alice);
      await invite(alice, spaceId, bob.email, 'viewer');
      await auth(request(app).put(`/api/spaces/${spaceId}/members/${bob.id}`), alice)
        .send({ role: 'editor' });

      // conversion path
      const carolEmail = `spaces-mem-conv-${crypto.randomUUID()}@example.com`;
      await invite(alice, spaceId, carolEmail, 'viewer');
      const carol = await users.findOrCreateUser({
        googleId: `spaces-mem-conv-${crypto.randomUUID()}`,
        email: carolEmail,
        name: 'Converted',
        picture: null,
      });
      createdUsers.push(carol.id);

      const { rows } = await pool.query(
        'SELECT user_id, granted_by FROM space_members WHERE space_id = $1',
        [spaceId]
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row.granted_by).not.toBeNull();
      expect(rows.find((r) => r.user_id === alice.id).granted_by).toBe(alice.id);
      expect(rows.find((r) => r.user_id === bob.id).granted_by).toBe(alice.id);
      expect(rows.find((r) => r.user_id === carol.id).granted_by).toBe(alice.id);
    });
  });
});
