/**
 * Tests for documents module (RBAC)
 */
const documents = require('../documents');
const { createPool } = require('./helpers/db');

describe('Documents module', () => {
  let pool;
  let testUserId;
  let testUser2Id;
  let testDocId;

  beforeAll(async () => {
    // Use shared test database configuration
    pool = createPool();

    documents.init(pool);

    // Create test users
    const user1 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-google-id-1', 'test-doc-user1@example.com', 'Test User 1', NULL)
       RETURNING id`
    );
    testUserId = user1.rows[0].id;

    const user2 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-google-id-2', 'test-doc-user2@example.com', 'Test User 2', NULL)
       RETURNING id`
    );
    testUser2Id = user2.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query("DELETE FROM document_share_invites WHERE doc_id IN (SELECT id FROM documents WHERE creator_id IN (SELECT id FROM users WHERE email LIKE 'test-doc-%@example.com'))");
    await pool.query("DELETE FROM document_shares WHERE doc_id IN (SELECT id FROM documents WHERE creator_id IN (SELECT id FROM users WHERE email LIKE 'test-doc-%@example.com'))");
    await pool.query("DELETE FROM documents WHERE creator_id IN (SELECT id FROM users WHERE email LIKE 'test-doc-%@example.com')");
    await pool.query("DELETE FROM users WHERE email LIKE 'test-doc-%@example.com'");
    await pool.end();
  });

  beforeEach(async () => {
    // Generate a unique doc ID for each test
    testDocId = require('crypto').randomUUID();
  });

  afterEach(async () => {
    // Clean up document shares and documents after each test
    if (testDocId) {
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [testDocId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [testDocId]);
    }
  });

  describe('ROLES', () => {
    test('defines role hierarchy', () => {
      expect(documents.ROLES.owner).toBeGreaterThan(documents.ROLES.editor);
      expect(documents.ROLES.editor).toBeGreaterThan(documents.ROLES.viewer);
    });
  });

  describe('createDocument', () => {
    test('creates document with owner role', async () => {
      const doc = await documents.createDocument(testDocId, testUserId);
      
      expect(doc.id).toBe(testDocId);
      expect(doc.creator_id).toBe(testUserId);
      
      const role = await documents.getRole(testDocId, testUserId);
      expect(role).toBe('owner');
    });
  });

  describe('getRole', () => {
    test('returns null for user without access', async () => {
      await documents.createDocument(testDocId, testUserId);
      
      const role = await documents.getRole(testDocId, testUser2Id);
      expect(role).toBeNull();
    });

    test('returns role for user with access', async () => {
      await documents.createDocument(testDocId, testUserId);
      await documents.setRole(testDocId, testUser2Id, 'editor');
      
      const role = await documents.getRole(testDocId, testUser2Id);
      expect(role).toBe('editor');
    });
  });

  describe('hasRole', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
    });

    test('owner has all roles', async () => {
      expect(await documents.hasRole(testDocId, testUserId, 'owner')).toBe(true);
      expect(await documents.hasRole(testDocId, testUserId, 'editor')).toBe(true);
      expect(await documents.hasRole(testDocId, testUserId, 'viewer')).toBe(true);
    });

    test('editor has editor and viewer roles', async () => {
      await documents.setRole(testDocId, testUser2Id, 'editor');
      
      expect(await documents.hasRole(testDocId, testUser2Id, 'owner')).toBe(false);
      expect(await documents.hasRole(testDocId, testUser2Id, 'editor')).toBe(true);
      expect(await documents.hasRole(testDocId, testUser2Id, 'viewer')).toBe(true);
    });

    test('viewer has only viewer role', async () => {
      await documents.setRole(testDocId, testUser2Id, 'viewer');
      
      expect(await documents.hasRole(testDocId, testUser2Id, 'owner')).toBe(false);
      expect(await documents.hasRole(testDocId, testUser2Id, 'editor')).toBe(false);
      expect(await documents.hasRole(testDocId, testUser2Id, 'viewer')).toBe(true);
    });
  });

  describe('convenience methods', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
    });

    test('hasAccess returns true for any role', async () => {
      expect(await documents.hasAccess(testDocId, testUserId)).toBe(true);
      
      await documents.setRole(testDocId, testUser2Id, 'viewer');
      expect(await documents.hasAccess(testDocId, testUser2Id)).toBe(true);
    });

    test('canEdit returns true for editor and owner', async () => {
      expect(await documents.canEdit(testDocId, testUserId)).toBe(true);
      
      await documents.setRole(testDocId, testUser2Id, 'editor');
      expect(await documents.canEdit(testDocId, testUser2Id)).toBe(true);
    });

    test('canEdit returns false for viewer', async () => {
      await documents.setRole(testDocId, testUser2Id, 'viewer');
      expect(await documents.canEdit(testDocId, testUser2Id)).toBe(false);
    });

    test('isOwner returns true only for owner', async () => {
      expect(await documents.isOwner(testDocId, testUserId)).toBe(true);
      
      await documents.setRole(testDocId, testUser2Id, 'editor');
      expect(await documents.isOwner(testDocId, testUser2Id)).toBe(false);
    });
  });

  describe('setRole', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
    });

    test('creates new share with role', async () => {
      const share = await documents.setRole(testDocId, testUser2Id, 'editor');
      
      expect(share.doc_id).toBe(testDocId);
      expect(share.user_id).toBe(testUser2Id);
      expect(share.role).toBe('editor');
    });

    test('updates existing role', async () => {
      await documents.setRole(testDocId, testUser2Id, 'viewer');
      const updated = await documents.setRole(testDocId, testUser2Id, 'editor');
      
      expect(updated.role).toBe('editor');
    });

    test('throws for invalid role', async () => {
      await expect(documents.setRole(testDocId, testUser2Id, 'invalid'))
        .rejects.toThrow('Invalid role');
    });
  });

  describe('removeAccess', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
      await documents.setRole(testDocId, testUser2Id, 'editor');
    });

    test('removes user access', async () => {
      const removed = await documents.removeAccess(testDocId, testUser2Id);
      
      expect(removed).toBe(true);
      expect(await documents.hasAccess(testDocId, testUser2Id)).toBe(false);
    });

    test('returns false when no access exists', async () => {
      const randomUserId = require('crypto').randomUUID();
      const removed = await documents.removeAccess(testDocId, randomUserId);
      
      expect(removed).toBe(false);
    });
  });

  describe('getDocumentUsers', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
      await documents.setRole(testDocId, testUser2Id, 'editor');
    });

    test('returns all users with access', async () => {
      const users = await documents.getDocumentUsers(testDocId);
      
      expect(users).toHaveLength(2);
      
      const owner = users.find(u => u.role === 'owner');
      expect(owner.id).toBe(testUserId);
      
      const editor = users.find(u => u.role === 'editor');
      expect(editor.id).toBe(testUser2Id);
    });

    test('orders by role (owner first)', async () => {
      const users = await documents.getDocumentUsers(testDocId);
      
      expect(users[0].role).toBe('owner');
    });
  });

  describe('getAccessibleDocuments', () => {
    test('returns documents user has access to', async () => {
      await documents.createDocument(testDocId, testUserId);
      await documents.setRole(testDocId, testUser2Id, 'editor');

      const { rows: docsForUser1 } = await documents.getAccessibleDocuments(testUserId);
      const { rows: docsForUser2 } = await documents.getAccessibleDocuments(testUser2Id);

      expect(docsForUser1.some(d => d.doc_id === testDocId)).toBe(true);
      expect(docsForUser2.some(d => d.doc_id === testDocId)).toBe(true);
    });

    test('includes role information', async () => {
      await documents.createDocument(testDocId, testUserId);

      const { rows: docs } = await documents.getAccessibleDocuments(testUserId);
      const doc = docs.find(d => d.doc_id === testDocId);

      expect(doc.role).toBe('owner');
    });
  });

  describe('findUserByEmail', () => {
    test('finds user by email (case insensitive)', async () => {
      const user = await documents.findUserByEmail('TEST-DOC-USER1@EXAMPLE.COM');
      
      expect(user).not.toBeNull();
      expect(user.id).toBe(testUserId);
    });

    test('returns null for non-existent email', async () => {
      const user = await documents.findUserByEmail('nonexistent@example.com');
      
      expect(user).toBeNull();
    });
  });

  describe('searchUsers', () => {
    test('matches by email or name, excludes requester', async () => {
      const results = await documents.searchUsers('test-doc-user', { excludeUserId: testUserId });
      expect(results.some(u => u.id === testUser2Id)).toBe(true);
      expect(results.some(u => u.id === testUserId)).toBe(false);
    });

    test('excludes users already shared on the doc', async () => {
      await documents.createDocument(testDocId, testUserId);
      await documents.setRole(testDocId, testUser2Id, 'editor');

      const results = await documents.searchUsers('test-doc-user2', {
        excludeUserId: testUserId,
        excludeDocId: testDocId,
      });
      expect(results.some(u => u.id === testUser2Id)).toBe(false);
    });
  });

  describe('invites', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
    });

    afterEach(async () => {
      await pool.query('DELETE FROM document_share_invites WHERE doc_id = $1', [testDocId]);
    });

    test('createInvite creates a pending invite', async () => {
      const invite = await documents.createInvite(testDocId, 'invitee@example.com', 'editor', testUserId);
      expect(invite.email).toBe('invitee@example.com');
      expect(invite.role).toBe('editor');

      const invites = await documents.getInvitesForDoc(testDocId);
      expect(invites).toHaveLength(1);
    });

    test('createInvite is idempotent per (doc, lower(email)) and updates role', async () => {
      await documents.createInvite(testDocId, 'Invitee@Example.com', 'viewer', testUserId);
      await documents.createInvite(testDocId, 'invitee@example.com', 'editor', testUserId);

      const invites = await documents.getInvitesForDoc(testDocId);
      expect(invites).toHaveLength(1);
      expect(invites[0].role).toBe('editor');
    });

    test('removeInvite deletes case-insensitively', async () => {
      await documents.createInvite(testDocId, 'invitee@example.com', 'editor', testUserId);
      const removed = await documents.removeInvite(testDocId, 'INVITEE@EXAMPLE.COM');
      expect(removed).toBe(true);
      expect(await documents.getInvitesForDoc(testDocId)).toHaveLength(0);
    });
  });

  describe('deleteDocument', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
      await documents.setRole(testDocId, testUser2Id, 'editor');
    });

    test('deletes document and all shares', async () => {
      const deleted = await documents.deleteDocument(testDocId);
      
      expect(deleted).toBe(true);
      
      // Document should no longer exist
      const doc = await documents.getDocument(testDocId);
      expect(doc).toBeNull();
      
      // Shares should be removed
      const role = await documents.getRole(testDocId, testUserId);
      expect(role).toBeNull();
    });

    test('returns false for non-existent document', async () => {
      const randomDocId = require('crypto').randomUUID();
      const deleted = await documents.deleteDocument(randomDocId);
      
      expect(deleted).toBe(false);
    });
  });
});
