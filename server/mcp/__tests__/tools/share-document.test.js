/**
 * share_document MCP tool — the converged behavior (feature 053, FR-029 /
 * RBD-053-5).
 *
 * The tool used to be its own sharing implementation and had drifted from the
 * REST endpoint in four ways. This suite pins the convergence, so a future
 * change to one path cannot quietly re-open the gap:
 *   - an editor (not owner) may share;
 *   - a viewer may share at viewer only;
 *   - an unknown address becomes a pending invite instead of an error;
 *   - mail goes out only when the TOKEN OWNER has email_enabled;
 *   - `granted_by` is the token's owner.
 */
const crypto = require('crypto');
const { createPool, createPersistence, cleanupTestUser } = require('../../../__tests__/helpers/db');

const mockSendShareInvite = jest.fn(async () => ({ ok: true }));
const mockSendShareNotification = jest.fn(async () => ({ ok: true }));
jest.mock('../../../email', () => ({
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

const documents = require('../../../documents');
const spaces = require('../../../spaces');
const users = require('../../../auth/users');
const shareDocument = require('../../tools/share-document');

describe('share_document MCP tool', () => {
  let pool;
  const createdUsers = [];
  const createdDocs = [];
  const createdSpaces = [];

  const token = (userId) => ({ userId, baseUrl: 'https://test.example' });

  async function makeUser(label) {
    const user = await users.findOrCreateUser({
      googleId: `mcpshare-${label}-${crypto.randomUUID()}`,
      email: `mcpshare-${label}-${crypto.randomUUID()}@example.com`,
      name: `MCP ${label}`,
      picture: null,
    });
    createdUsers.push(user.id);
    return user;
  }

  async function makeDoc(ownerId, spaceId = null) {
    const docId = crypto.randomUUID();
    createdDocs.push(docId);
    await documents.createDocument(docId, ownerId, 'Shared by an agent', spaceId);
    return docId;
  }

  async function grantorOf(docId, userId) {
    const { rows } = await pool.query(
      'SELECT granted_by, role FROM document_shares WHERE doc_id = $1 AND user_id = $2',
      [docId, userId]
    );
    return rows[0] || null;
  }

  beforeAll(async () => {
    pool = createPool();
    documents.init(pool);
    spaces.init(pool);
    users.init(pool);
    shareDocument.init(createPersistence());
  });

  afterAll(async () => {
    if (createdDocs.length) {
      await pool.query('DELETE FROM document_share_invites WHERE doc_id = ANY($1::uuid[])', [createdDocs]);
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

  beforeEach(() => {
    mockSendShareInvite.mockClear();
    mockSendShareNotification.mockClear();
  });

  test('the description no longer claims owner-only', () => {
    expect(shareDocument.description).not.toMatch(/only the document owner/i);
    expect(shareDocument.description).toMatch(/anyone with access/i);
  });

  test('an EDITOR (not the owner) may share', async () => {
    const owner = await makeUser('ed-owner');
    const editor = await makeUser('ed-editor');
    const target = await makeUser('ed-target');
    const docId = await makeDoc(owner.id);
    await documents.setRole(docId, editor.id, 'editor', owner.id);

    const res = await shareDocument.handler(
      { docGuid: docId, email: target.email, role: 'editor' },
      token(editor.id)
    );
    expect(res.success).toBe(true);
    expect(res.sharedWith).toMatchObject({ email: target.email, role: 'editor' });
    expect(await grantorOf(docId, target.id)).toEqual({ role: 'editor', granted_by: editor.id });
  });

  test('a VIEWER may share, but only at viewer (D6)', async () => {
    const owner = await makeUser('vw-owner');
    const viewer = await makeUser('vw-viewer');
    const target = await makeUser('vw-target');
    const docId = await makeDoc(owner.id);
    await documents.setRole(docId, viewer.id, 'viewer', owner.id);

    await expect(
      shareDocument.handler({ docGuid: docId, email: target.email, role: 'editor' }, token(viewer.id))
    ).rejects.toThrow('Viewers can only share with viewer access');

    const ok = await shareDocument.handler(
      { docGuid: docId, email: target.email, role: 'viewer' },
      token(viewer.id)
    );
    expect(ok.success).toBe(true);
    expect(await grantorOf(docId, target.id)).toEqual({ role: 'viewer', granted_by: viewer.id });
  });

  test('an unknown email creates a pending invite instead of throwing', async () => {
    const owner = await makeUser('inv-owner');
    const docId = await makeDoc(owner.id);
    const unknown = `mcpshare-unknown-${crypto.randomUUID()}@example.com`;

    const res = await shareDocument.handler(
      { docGuid: docId, email: unknown, role: 'viewer' },
      token(owner.id)
    );
    expect(res.success).toBe(true);
    expect(res.invited).toEqual({ email: unknown, role: 'viewer', pending: true });
    const invites = await documents.getInvitesForDoc(docId);
    expect(invites.map((i) => i.email)).toEqual([unknown]);
  });

  test('email is sent only when the TOKEN OWNER has email_enabled', async () => {
    const quiet = await makeUser('mail-quiet');
    const loud = await makeUser('mail-loud');
    const targetA = await makeUser('mail-ta');
    const targetB = await makeUser('mail-tb');
    await pool.query('UPDATE users SET email_enabled = false WHERE id = $1', [quiet.id]);
    await pool.query('UPDATE users SET email_enabled = true WHERE id = $1', [loud.id]);

    const quietDoc = await makeDoc(quiet.id);
    await shareDocument.handler({ docGuid: quietDoc, email: targetA.email, role: 'viewer' }, token(quiet.id));
    expect(mockSendShareNotification).not.toHaveBeenCalled();
    // …access is granted regardless.
    expect(await documents.getRole(quietDoc, targetA.id)).toBe('viewer');

    const loudDoc = await makeDoc(loud.id);
    await shareDocument.handler({ docGuid: loudDoc, email: targetB.email, role: 'viewer' }, token(loud.id));
    expect(mockSendShareNotification).toHaveBeenCalledTimes(1);
    expect(mockSendShareNotification.mock.calls[0][0].to).toBe(targetB.email);
  });

  test('a SPACE editor with no direct share can share a space document', async () => {
    const owner = await makeUser('space-owner');
    const agentOwner = await makeUser('space-agent');
    const target = await makeUser('space-target');
    const space = await spaces.createSpace('Agent Space', owner.id);
    createdSpaces.push(space.id);
    await spaces.inviteMember(space.id, agentOwner.email, 'editor', owner.id);
    const docId = await makeDoc(owner.id, space.id);

    const res = await shareDocument.handler(
      { docGuid: docId, email: target.email, role: 'viewer' },
      token(agentOwner.id)
    );
    expect(res.success).toBe(true);
    expect(await grantorOf(docId, target.id)).toEqual({ role: 'viewer', granted_by: agentOwner.id });
  });

  test('someone with no access at all is refused with the unchanged message', async () => {
    const owner = await makeUser('none-owner');
    const stranger = await makeUser('none-stranger');
    const target = await makeUser('none-target');
    const docId = await makeDoc(owner.id);

    await expect(
      shareDocument.handler({ docGuid: docId, email: target.email, role: 'viewer' }, token(stranger.id))
    ).rejects.toThrow('You do not have access to this document');
  });

  test("the owner's role still cannot be changed", async () => {
    const owner = await makeUser('ownerole-o');
    const editor = await makeUser('ownerole-e');
    const docId = await makeDoc(owner.id);
    await documents.setRole(docId, editor.id, 'editor', owner.id);

    await expect(
      shareDocument.handler({ docGuid: docId, email: owner.email, role: 'viewer' }, token(editor.id))
    ).rejects.toThrow("Cannot change owner's role");
    expect(await documents.getRole(docId, owner.id)).toBe('owner');
  });

  test('re-sharing upserts rather than failing on the unique constraint', async () => {
    const owner = await makeUser('upsert-o');
    const target = await makeUser('upsert-t');
    const docId = await makeDoc(owner.id);

    await shareDocument.handler({ docGuid: docId, email: target.email, role: 'viewer' }, token(owner.id));
    const second = await shareDocument.handler(
      { docGuid: docId, email: target.email, role: 'editor' },
      token(owner.id)
    );
    expect(second.success).toBe(true);
    expect(await documents.getRole(docId, target.id)).toBe('editor');
  });
});
