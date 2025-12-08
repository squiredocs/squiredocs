/**
 * Tests for permissions module
 */
const { Pool } = require('pg');
const permissions = require('../permissions');
const documents = require('../documents');
const { generateAccessToken } = require('../auth/jwt');

describe('Permissions module', () => {
  let pool;
  let testUserId;
  let testUser2Id;
  let testDocId;
  let testAccessToken;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'collab_db',
      user: process.env.DB_USER || process.env.USER || 'postgres',
      password: process.env.DB_PASSWORD || ''
    });

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
      expect(permissions.REQUIRED_ROLES.manage).toBe('owner');
    });
  });

  describe('extractUser', () => {
    test('extracts user from Authorization header', () => {
      const user = permissions.extractUser({
        authHeader: `Bearer ${testAccessToken}`
      });
      
      expect(user).not.toBeNull();
      expect(user.userId).toBe(testUserId);
    });

    test('extracts user from query token', () => {
      const user = permissions.extractUser({
        queryToken: testAccessToken
      });
      
      expect(user).not.toBeNull();
      expect(user.userId).toBe(testUserId);
    });

    test('extracts user from direct token', () => {
      const user = permissions.extractUser({
        token: testAccessToken
      });
      
      expect(user).not.toBeNull();
      expect(user.userId).toBe(testUserId);
    });

    test('returns null for invalid token', () => {
      const user = permissions.extractUser({
        authHeader: 'Bearer invalid-token'
      });
      
      expect(user).toBeNull();
    });

    test('returns null for missing auth', () => {
      const user = permissions.extractUser({});
      
      expect(user).toBeNull();
    });

    test('prefers Authorization header over other sources', () => {
      const user = permissions.extractUser({
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

    test('allows editor to view, edit, and share', async () => {
      await documents.setRole(testDocId, testUser2Id, 'editor');
      
      const viewResult = await permissions.checkPermission(testUser2Id, testDocId, 'view');
      const editResult = await permissions.checkPermission(testUser2Id, testDocId, 'edit');
      const shareResult = await permissions.checkPermission(testUser2Id, testDocId, 'share');
      const manageResult = await permissions.checkPermission(testUser2Id, testDocId, 'manage');
      
      expect(viewResult.allowed).toBe(true);
      expect(editResult.allowed).toBe(true);
      expect(shareResult.allowed).toBe(true);
      expect(manageResult.allowed).toBe(false);
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
      
      expect(ownerResult.allowed).toBe(true);
      expect(editorResult.allowed).toBe(false);
    });
  });
});
