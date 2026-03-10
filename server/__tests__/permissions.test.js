/**
 * Tests for permissions module
 */
const permissions = require('../permissions');
const documents = require('../documents');
const { generateAccessToken } = require('../auth/jwt');
const { createPool } = require('./helpers/db');

// y-websocket protocol constants (same as server/index.js)
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

describe('Permissions module', () => {
  let pool;
  let testUserId;
  let testUser2Id;
  let testDocId;
  let testAccessToken;

  beforeAll(async () => {
    // Use shared test database configuration
    pool = createPool();

    documents.init(pool);

    // Create test users
    const user1 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-perm-google-1', 'test-perm-user1@example.com', 'Test Perm User 1', NULL)
       RETURNING id, email, name, picture`
    );
    testUserId = user1.rows[0].id;
    testAccessToken = generateAccessToken({
      id: testUserId,
      email: user1.rows[0].email,
      name: user1.rows[0].name,
      picture: user1.rows[0].picture
    });

    const user2 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-perm-google-2', 'test-perm-user2@example.com', 'Test Perm User 2', NULL)
       RETURNING id`
    );
    testUser2Id = user2.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query("DELETE FROM document_shares WHERE doc_id IN (SELECT id FROM documents WHERE creator_id IN (SELECT id FROM users WHERE email LIKE 'test-perm-%@example.com'))");
    await pool.query("DELETE FROM documents WHERE creator_id IN (SELECT id FROM users WHERE email LIKE 'test-perm-%@example.com')");
    await pool.query("DELETE FROM users WHERE email LIKE 'test-perm-%@example.com'");
    await pool.end();
  });

  beforeEach(async () => {
    testDocId = require('crypto').randomUUID();
  });

  afterEach(async () => {
    if (testDocId) {
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [testDocId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [testDocId]);
    }
  });

  describe('REQUIRED_ROLES', () => {
    test('defines required roles for actions', () => {
      expect(permissions.REQUIRED_ROLES.view).toBe('viewer');
      expect(permissions.REQUIRED_ROLES.edit).toBe('editor');
      expect(permissions.REQUIRED_ROLES.share).toBe('viewer');
      expect(permissions.REQUIRED_ROLES.manage).toBe('editor'); // Editors can manage shares
      expect(permissions.REQUIRED_ROLES.delete).toBe('owner');  // Only owners can delete
    });
  });

  describe('extractUser', () => {
    test('extracts user from Authorization header', async () => {
      const user = await permissions.extractUser({
        authHeader: `Bearer ${testAccessToken}`
      });

      expect(user).not.toBeNull();
      expect(user.userId).toBe(testUserId);
    });

    test('extracts user from query token', async () => {
      const user = await permissions.extractUser({
        queryToken: testAccessToken
      });

      expect(user).not.toBeNull();
      expect(user.userId).toBe(testUserId);
    });

    test('extracts user from direct token', async () => {
      const user = await permissions.extractUser({
        token: testAccessToken
      });

      expect(user).not.toBeNull();
      expect(user.userId).toBe(testUserId);
    });

    test('returns null for invalid token', async () => {
      const user = await permissions.extractUser({
        authHeader: 'Bearer invalid-token'
      });

      expect(user).toBeNull();
    });

    test('returns null for missing auth', async () => {
      const user = await permissions.extractUser({});

      expect(user).toBeNull();
    });

    test('prefers Authorization header over other sources', async () => {
      const user = await permissions.extractUser({
        authHeader: `Bearer ${testAccessToken}`,
        queryToken: 'invalid',
        token: 'invalid'
      });

      expect(user).not.toBeNull();
      expect(user.userId).toBe(testUserId);
    });
  });

  describe('checkPermission', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
    });

    test('allows owner all actions', async () => {
      const viewResult = await permissions.checkPermission(testUserId, testDocId, 'view');
      const editResult = await permissions.checkPermission(testUserId, testDocId, 'edit');
      const shareResult = await permissions.checkPermission(testUserId, testDocId, 'share');
      const manageResult = await permissions.checkPermission(testUserId, testDocId, 'manage');
      
      expect(viewResult.allowed).toBe(true);
      expect(editResult.allowed).toBe(true);
      expect(shareResult.allowed).toBe(true);
      expect(manageResult.allowed).toBe(true);
      expect(viewResult.role).toBe('owner');
    });

    test('allows editor to view, edit, share, and manage', async () => {
      await documents.setRole(testDocId, testUser2Id, 'editor');
      
      const viewResult = await permissions.checkPermission(testUser2Id, testDocId, 'view');
      const editResult = await permissions.checkPermission(testUser2Id, testDocId, 'edit');
      const shareResult = await permissions.checkPermission(testUser2Id, testDocId, 'share');
      const manageResult = await permissions.checkPermission(testUser2Id, testDocId, 'manage');
      const deleteResult = await permissions.checkPermission(testUser2Id, testDocId, 'delete');
      
      expect(viewResult.allowed).toBe(true);
      expect(editResult.allowed).toBe(true);
      expect(shareResult.allowed).toBe(true);
      expect(manageResult.allowed).toBe(true);  // Editors can manage shares
      expect(deleteResult.allowed).toBe(false); // But can't delete
    });

    test('allows viewer only to view and share', async () => {
      await documents.setRole(testDocId, testUser2Id, 'viewer');
      
      const viewResult = await permissions.checkPermission(testUser2Id, testDocId, 'view');
      const editResult = await permissions.checkPermission(testUser2Id, testDocId, 'edit');
      const shareResult = await permissions.checkPermission(testUser2Id, testDocId, 'share');
      const manageResult = await permissions.checkPermission(testUser2Id, testDocId, 'manage');
      
      expect(viewResult.allowed).toBe(true);
      expect(editResult.allowed).toBe(false);
      expect(shareResult.allowed).toBe(true);
      expect(manageResult.allowed).toBe(false);
    });

    test('denies access to user without role', async () => {
      const result = await permissions.checkPermission(testUser2Id, testDocId, 'view');
      
      expect(result.allowed).toBe(false);
      expect(result.role).toBeNull();
      expect(result.reason).toBe('No access to document');
    });

    test('denies access with null userId', async () => {
      const result = await permissions.checkPermission(null, testDocId, 'view');
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Not authenticated');
    });

    test('includes reason when permission denied', async () => {
      await documents.setRole(testDocId, testUser2Id, 'viewer');
      
      const result = await permissions.checkPermission(testUser2Id, testDocId, 'edit');
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Requires editor role');
      expect(result.reason).toContain('you have viewer');
    });
  });

  describe('can convenience methods', () => {
    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId);
    });

    test('can.view checks view permission', async () => {
      const result = await permissions.can.view(testUserId, testDocId);
      expect(result.allowed).toBe(true);
    });

    test('can.edit checks edit permission', async () => {
      await documents.setRole(testDocId, testUser2Id, 'viewer');
      
      const result = await permissions.can.edit(testUser2Id, testDocId);
      expect(result.allowed).toBe(false);
    });

    test('can.share checks share permission', async () => {
      await documents.setRole(testDocId, testUser2Id, 'viewer');
      
      const result = await permissions.can.share(testUser2Id, testDocId);
      expect(result.allowed).toBe(true);
    });

    test('can.manage checks manage permission', async () => {
      const ownerResult = await permissions.can.manage(testUserId, testDocId);
      
      await documents.setRole(testDocId, testUser2Id, 'editor');
      const editorResult = await permissions.can.manage(testUser2Id, testDocId);
      
      await documents.setRole(testDocId, testUser2Id, 'viewer');
      const viewerResult = await permissions.can.manage(testUser2Id, testDocId);
      
      expect(ownerResult.allowed).toBe(true);
      expect(editorResult.allowed).toBe(true);  // Editors can manage
      expect(viewerResult.allowed).toBe(false); // Viewers cannot
    });

    test('can.delete checks delete permission (owner only)', async () => {
      const ownerResult = await permissions.can.delete(testUserId, testDocId);
      
      await documents.setRole(testDocId, testUser2Id, 'editor');
      const editorResult = await permissions.can.delete(testUser2Id, testDocId);
      
      expect(ownerResult.allowed).toBe(true);
      expect(editorResult.allowed).toBe(false);
    });
  });

  describe('WebSocket edit message detection', () => {
    /**
     * Helper to check if a message is an edit operation
     * (mirrors the isEditMessage function in server/index.js)
     */
    function isEditMessage(data) {
      if (!data || data.length < 2) return false;
      const messageType = data[0];
      const syncType = data[1];
      return messageType === MESSAGE_SYNC && syncType === SYNC_UPDATE;
    }

    test('identifies sync update as edit message', () => {
      const editMsg = Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 0, 1, 2]); // sync update with payload
      expect(isEditMessage(editMsg)).toBe(true);
    });

    test('identifies sync step1 as non-edit message', () => {
      const syncStep1 = Buffer.from([MESSAGE_SYNC, SYNC_STEP1, 0, 1, 2]);
      expect(isEditMessage(syncStep1)).toBe(false);
    });

    test('identifies sync step2 as non-edit message', () => {
      const syncStep2 = Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 0, 1, 2]);
      expect(isEditMessage(syncStep2)).toBe(false);
    });

    test('identifies awareness message as non-edit', () => {
      const awarenessMsg = Buffer.from([MESSAGE_AWARENESS, 0, 1, 2]);
      expect(isEditMessage(awarenessMsg)).toBe(false);
    });

    test('handles empty or short messages', () => {
      expect(isEditMessage(null)).toBe(false);
      expect(isEditMessage(Buffer.from([]))).toBe(false);
      expect(isEditMessage(Buffer.from([0]))).toBe(false);
    });
  });
});
