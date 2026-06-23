/**
 * Tests for login-time conversion of pending share invites into real shares
 * (server/auth/users.js convertPendingInvites, run inside findOrCreateUser).
 */
const users = require('../auth/users');
const documents = require('../documents');
const { createPool } = require('./helpers/db');

describe('Pending invite conversion on login', () => {
  let pool;
  let inviterId;
  let docId;

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    documents.init(pool);

    const inviter = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ('test-invite-inviter', 'test-invite-inviter@example.com', 'Inviter')
       RETURNING id`
    );
    inviterId = inviter.rows[0].id;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM document_share_invites WHERE lower(email) LIKE 'test-invite-%@example.com'");
    await pool.query("DELETE FROM document_shares WHERE doc_id IN (SELECT id FROM documents WHERE creator_id = $1)", [inviterId]);
    await pool.query("DELETE FROM documents WHERE creator_id = $1", [inviterId]);
    await pool.query("DELETE FROM users WHERE email LIKE 'test-invite-%@example.com'");
    await pool.end();
  });

  beforeEach(async () => {
    docId = require('crypto').randomUUID();
    await documents.createDocument(docId, inviterId);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM document_share_invites WHERE doc_id = $1', [docId]);
    await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
    await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    await pool.query("DELETE FROM users WHERE email LIKE 'test-invite-new%@example.com'");
  });

  test('converts a pending invite into a real share on first login', async () => {
    await documents.createInvite(docId, 'test-invite-new1@example.com', 'editor', inviterId);

    const user = await users.findOrCreateUser({
      googleId: 'test-invite-new1',
      email: 'test-invite-new1@example.com',
      name: 'New User',
      picture: null,
    });

    expect(await documents.getRole(docId, user.id)).toBe('editor');
    expect(await documents.getInvitesForDoc(docId)).toHaveLength(0);
  });

  test('matches email case-insensitively', async () => {
    await documents.createInvite(docId, 'Test-Invite-New2@Example.com', 'viewer', inviterId);

    const user = await users.findOrCreateUser({
      googleId: 'test-invite-new2',
      email: 'test-invite-new2@example.com',
      name: 'New User 2',
      picture: null,
    });

    expect(await documents.getRole(docId, user.id)).toBe('viewer');
  });

  test('does not downgrade an existing stronger role', async () => {
    const user = await users.findOrCreateUser({
      googleId: 'test-invite-new3',
      email: 'test-invite-new3@example.com',
      name: 'New User 3',
      picture: null,
    });
    // Already an editor on the doc
    await documents.setRole(docId, user.id, 'editor');
    // A viewer invite arrives, then they log in again
    await documents.createInvite(docId, 'test-invite-new3@example.com', 'viewer', inviterId);

    await users.findOrCreateUser({
      googleId: 'test-invite-new3',
      email: 'test-invite-new3@example.com',
      name: 'New User 3',
      picture: null,
    });

    expect(await documents.getRole(docId, user.id)).toBe('editor');
    expect(await documents.getInvitesForDoc(docId)).toHaveLength(0);
  });
});
