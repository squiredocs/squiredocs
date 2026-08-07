/**
 * Share attribution — `granted_by` on every write path (feature 053, US5 / D8).
 *
 * Three claims:
 *   1. No share lacks a grantor, post-migration and forever after (SC-005).
 *   2. Every write path records the ACTING user, not the recipient and not the
 *      document owner by default.
 *   3. FR-030 / RBD-053-7 — passthrough does not inflate any "owned" count.
 *      The absence of a diff is not evidence, so the numbers are asserted.
 */
const crypto = require('crypto');
const { createPool, cleanupTestUser } = require('./helpers/db');

const mockSendShareInvite = jest.fn(async () => ({ ok: true }));
const mockSendShareNotification = jest.fn(async () => ({ ok: true }));
jest.mock('../email', () => ({
  sendShareInvite: (...a) => mockSendShareInvite(...a),
  sendShareNotification: (...a) => mockSendShareNotification(...a),
  sendSpaceInvite: jest.fn(async () => ({ ok: true })),
  sendSpaceNotification: jest.fn(async () => ({ ok: true })),
  sendEmail: jest.fn(async () => ({ ok: true })),
  notifyNewUser: jest.fn(),
  notifyLogin: jest.fn(),
  notifyCreditLimitReached: jest.fn(),
  notifySupportRequest: jest.fn(),
  sendWelcomeEmail: jest.fn(),
}));

const Y = require('yjs');
const documents = require('../documents');
const spaces = require('../spaces');
const users = require('../auth/users');
const onboarding = require('../onboarding');
const documentService = require('../document-service');
const { shareDocumentByEmail } = require('../share-service');

describe('Share attribution (granted_by)', () => {
  let pool;
  const createdUsers = [];
  const createdDocs = [];
  const createdSpaces = [];

  async function makeUser(label) {
    const user = await users.findOrCreateUser({
      googleId: `attr-${label}-${crypto.randomUUID()}`,
      email: `attr-${label}-${crypto.randomUUID()}@example.com`,
      name: `Attr ${label}`,
      picture: null,
    });
    createdUsers.push(user.id);
    return user;
  }

  async function makeDoc(ownerId, spaceId = null) {
    const docId = crypto.randomUUID();
    createdDocs.push(docId);
    await documents.createDocument(docId, ownerId, 'Attributed', spaceId);
    return docId;
  }

  async function grantorOf(docId, userId) {
    const { rows } = await pool.query(
      'SELECT granted_by FROM document_shares WHERE doc_id = $1 AND user_id = $2',
      [docId, userId]
    );
    return rows[0]?.granted_by ?? null;
  }

  beforeAll(async () => {
    pool = createPool();
    documents.init(pool);
    spaces.init(pool);
    users.init(pool);
    onboarding.init(pool);
    // The welcome-doc path runs through document-service; wire it to local
    // Y.Docs so the attribution assertion exercises the real chain
    // (onboarding → createSeededDocument → documents.createDocument → setRole)
    // without a websocket server.
    const ydocs = new Map();
    documentService.init(
      (name) => {
        const guid = name.startsWith('s/') ? name.slice(2) : name;
        if (!ydocs.has(guid)) {
          const doc = new Y.Doc();
          // No y-websocket bindState runs here, so mark the doc loaded the way
          // a completed bind would — waitForDocReady otherwise polls to timeout.
          doc._bindComplete = true;
          ydocs.set(guid, doc);
        }
        return ydocs.get(guid);
      },
      (name) => (name.startsWith('s/') ? name.slice(2) : name)
    );
  });

  afterAll(async () => {
    if (createdDocs.length) {
      await pool.query('DELETE FROM document_shares WHERE doc_id = ANY($1::uuid[])', [createdDocs]);
      await pool.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [createdDocs]);
    }
    if (createdSpaces.length) {
      await pool.query('DELETE FROM space_members WHERE space_id = ANY($1::uuid[])', [createdSpaces]);
      await pool.query('DELETE FROM spaces WHERE id = ANY($1::uuid[])', [createdSpaces]);
    }
    for (const id of createdUsers) await cleanupTestUser(pool, id);
    await pool.end();
  });

  test('SC-005: no share in the database lacks a grantor', async () => {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM document_shares WHERE granted_by IS NULL'
    );
    expect(rows[0].n).toBe(0);
  });

  test('the column is NOT NULL, so a grantorless row cannot be written at all', async () => {
    const alice = await makeUser('notnull');
    const docId = await makeDoc(alice.id);
    const bob = await makeUser('notnull-b');
    await expect(
      pool.query(
        "INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'viewer')",
        [docId, bob.id]
      )
    ).rejects.toThrow(/granted_by/);
  });

  describe('one assertion per write path (FR-034)', () => {
    test('document creation: the creator grants themselves owner', async () => {
      const alice = await makeUser('create');
      const docId = await makeDoc(alice.id);
      expect(await grantorOf(docId, alice.id)).toBe(alice.id);
    });

    test('setRole refuses to write without a grantor', async () => {
      const alice = await makeUser('norole-a');
      const bob = await makeUser('norole-b');
      const docId = await makeDoc(alice.id);
      await expect(documents.setRole(docId, bob.id, 'editor')).rejects.toThrow(
        'setRole requires grantedBy (D8: every share records its grantor)'
      );
      expect(await grantorOf(docId, bob.id)).toBeNull();
    });

    test('the REST share path records the acting user, not the document owner', async () => {
      const alice = await makeUser('rest-owner');
      const bob = await makeUser('rest-sharer');
      const carol = await makeUser('rest-target');
      const docId = await makeDoc(alice.id);
      await documents.setRole(docId, bob.id, 'editor', alice.id);

      // Bob — an editor, not the owner — shares onward.
      const res = await shareDocumentByEmail({
        actor: { userId: bob.id, email: bob.email, name: bob.name },
        docId,
        email: carol.email,
        role: 'viewer',
        baseUrl: 'https://test.example',
      });
      expect(res.status).toBe(201);
      expect(await grantorOf(docId, carol.id)).toBe(bob.id);
    });

    test('a role change re-attributes the grant to whoever changed it', async () => {
      const alice = await makeUser('rechange-a');
      const bob = await makeUser('rechange-b');
      const carol = await makeUser('rechange-c');
      const docId = await makeDoc(alice.id);
      await documents.setRole(docId, carol.id, 'viewer', alice.id);
      expect(await grantorOf(docId, carol.id)).toBe(alice.id);

      await documents.setRole(docId, carol.id, 'editor', bob.id);
      expect(await grantorOf(docId, carol.id)).toBe(bob.id);
      expect(await documents.getRole(docId, carol.id)).toBe('editor');
    });

    test('invite conversion attributes to the inviter (FR-034)', async () => {
      const alice = await makeUser('conv-inviter');
      const docId = await makeDoc(alice.id);
      const inviteeEmail = `attr-conv-${crypto.randomUUID()}@example.com`;
      await documents.createInvite(docId, inviteeEmail, 'editor', alice.id);

      const invitee = await users.findOrCreateUser({
        googleId: `attr-conv-${crypto.randomUUID()}`,
        email: inviteeEmail,
        name: 'Converted',
        picture: null,
      });
      createdUsers.push(invitee.id);

      expect(await documents.getRole(docId, invitee.id)).toBe('editor');
      expect(await grantorOf(docId, invitee.id)).toBe(alice.id);
    });

    test('RBD-053-13: conversion still works when the inviter is gone', async () => {
      const alice = await makeUser('orphan-owner');
      const inviter = await makeUser('orphan-inviter');
      const docId = await makeDoc(alice.id);
      await documents.setRole(docId, inviter.id, 'editor', alice.id);
      const inviteeEmail = `attr-orphan-${crypto.randomUUID()}@example.com`;
      await documents.createInvite(docId, inviteeEmail, 'viewer', inviter.id);

      // invited_by_user_id is ON DELETE SET NULL, so removing the inviter
      // leaves an invite with no inviter — and granted_by is NOT NULL.
      await pool.query('DELETE FROM document_shares WHERE user_id = $1', [inviter.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [inviter.id]);
      const { rows } = await pool.query(
        'SELECT invited_by_user_id FROM document_share_invites WHERE doc_id = $1',
        [docId]
      );
      expect(rows[0].invited_by_user_id).toBeNull();

      const invitee = await users.findOrCreateUser({
        googleId: `attr-orphan-${crypto.randomUUID()}`,
        email: inviteeEmail,
        name: 'Orphan invitee',
        picture: null,
      });
      createdUsers.push(invitee.id);

      // Falls back to the document's owner.
      expect(await documents.getRole(docId, invitee.id)).toBe('viewer');
      expect(await grantorOf(docId, invitee.id)).toBe(alice.id);
    });

    test('the onboarding welcome doc is granted by the new user', async () => {
      const newcomer = await makeUser('welcome');
      const state = await onboarding.resolveOnboarding(
        await users.findById(newcomer.id),
        { seed: true }
      );
      expect(state.welcomeDocId).toBeTruthy();
      createdDocs.push(state.welcomeDocId);
      expect(await grantorOf(state.welcomeDocId, newcomer.id)).toBe(newcomer.id);
    });

    test('space memberships carry a grantor too (FR-036)', async () => {
      const alice = await makeUser('sm-a');
      const bob = await makeUser('sm-b');
      const space = await spaces.createSpace('Attributed space', alice.id);
      createdSpaces.push(space.id);
      await spaces.inviteMember(space.id, bob.email, 'editor', alice.id);

      const { rows } = await pool.query(
        'SELECT user_id, granted_by FROM space_members WHERE space_id = $1',
        [space.id]
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.granted_by).not.toBeNull();
      expect(rows.find((r) => r.user_id === bob.id).granted_by).toBe(alice.id);
    });
  });

  describe('FR-030 / RBD-053-7 — passthrough must not inflate any owned count', () => {
    let author;
    let curator;
    let spaceId;

    /** The admin list's doc_count, exactly as server/api/admin.js computes it. */
    async function adminDocCount(userId) {
      const { rows } = await pool.query(
        `SELECT COALESCE(d.doc_count, 0)::int AS doc_count
           FROM users u
           LEFT JOIN (
             SELECT user_id, COUNT(*) AS doc_count
             FROM document_shares WHERE role = 'owner' GROUP BY user_id
           ) d ON d.user_id = u.id
          WHERE u.id = $1`,
        [userId]
      );
      return rows[0].doc_count;
    }

    /** The admin detail's authored_non_welcome_doc, same SQL. */
    async function authoredNonWelcomeDoc(userId) {
      const { rows } = await pool.query(
        `SELECT EXISTS (
             SELECT 1 FROM document_shares ds
             WHERE ds.user_id = u.id AND ds.role = 'owner'
               AND (u.welcome_doc_id IS NULL OR ds.doc_id <> u.welcome_doc_id)
           ) AS authored
         FROM users u WHERE u.id = $1`,
        [userId]
      );
      return rows[0].authored;
    }

    beforeAll(async () => {
      author = await makeUser('count-author');
      curator = await makeUser('count-curator');
      const space = await spaces.createSpace('Counting', author.id);
      createdSpaces.push(space.id);
      spaceId = space.id;
      await spaces.inviteMember(spaceId, curator.email, 'owner', author.id);
    });

    test('the admin doc_count is unchanged by becoming a space owner', async () => {
      const before = await adminDocCount(curator.id);
      for (let i = 0; i < 3; i++) await makeDoc(author.id, spaceId);

      // The curator's EFFECTIVE role on all three is owner…
      const { rows } = await documents.getAccessibleDocuments(curator.id, { space: spaceId });
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row.role).toBe('owner');

      // …and the count is still exactly what it was.
      expect(await adminDocCount(curator.id)).toBe(before);
      expect(await adminDocCount(author.id)).toBeGreaterThanOrEqual(3);
    });

    test('authored_non_welcome_doc stays false for a passthrough-only owner', async () => {
      const bystander = await makeUser('count-bystander');
      await spaces.inviteMember(spaceId, bystander.email, 'owner', author.id);
      expect(await authoredNonWelcomeDoc(bystander.id)).toBe(false);
    });

    test("onboarding isEngaged is not satisfied by someone else's space documents", async () => {
      const bystander = await makeUser('count-engaged');
      await spaces.inviteMember(spaceId, bystander.email, 'owner', author.id);
      expect(await onboarding.isEngaged(bystander.id, null)).toBe(false);
    });

    test("the list's `owned` filter agrees with all three counts", async () => {
      const owned = await documents.getAccessibleDocuments(curator.id, {
        space: spaceId,
        filter: 'owned',
      });
      expect(owned.rows).toEqual([]);
    });
  });
});
