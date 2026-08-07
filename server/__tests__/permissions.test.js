/**
 * Tests for permissions module
 */
const permissions = require('../permissions');
const documents = require('../documents');
const { generateAccessToken } = require('../auth/jwt');
const { createPool } = require('./helpers/db');

// Protocol constants and the edit classifier come from the REAL module
// (feature 038 FR-007). They used to be re-declared here alongside a local copy
// of isEditMessage — see the note on the suite below.
const {
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  isEditMessage,
} = require('../ws-edit-gate');

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
      await documents.setRole(testDocId, testUser2Id, 'editor', testUser2Id);
      
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
      await documents.setRole(testDocId, testUser2Id, 'viewer', testUser2Id);
      
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
      await documents.setRole(testDocId, testUser2Id, 'viewer', testUser2Id);
      
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
      await documents.setRole(testDocId, testUser2Id, 'viewer', testUser2Id);
      
      const result = await permissions.can.edit(testUser2Id, testDocId);
      expect(result.allowed).toBe(false);
    });

    test('can.share checks share permission', async () => {
      await documents.setRole(testDocId, testUser2Id, 'viewer', testUser2Id);
      
      const result = await permissions.can.share(testUser2Id, testDocId);
      expect(result.allowed).toBe(true);
    });

    test('can.manage checks manage permission', async () => {
      const ownerResult = await permissions.can.manage(testUserId, testDocId);
      
      await documents.setRole(testDocId, testUser2Id, 'editor', testUser2Id);
      const editorResult = await permissions.can.manage(testUser2Id, testDocId);
      
      await documents.setRole(testDocId, testUser2Id, 'viewer', testUser2Id);
      const viewerResult = await permissions.can.manage(testUser2Id, testDocId);
      
      expect(ownerResult.allowed).toBe(true);
      expect(editorResult.allowed).toBe(true);  // Editors can manage
      expect(viewerResult.allowed).toBe(false); // Viewers cannot
    });

    test('can.delete checks delete permission (owner only)', async () => {
      const ownerResult = await permissions.can.delete(testUserId, testDocId);
      
      await documents.setRole(testDocId, testUser2Id, 'editor', testUser2Id);
      const editorResult = await permissions.can.delete(testUser2Id, testDocId);
      
      expect(ownerResult.allowed).toBe(true);
      expect(editorResult.allowed).toBe(false);
    });
  });

  describe('WebSocket edit message detection', () => {
    /**
     * These cases run against the REAL classifier exported by
     * server/ws-edit-gate.js.
     *
     * This suite previously defined its own local copy of `isEditMessage`,
     * described as "mirrors the isEditMessage function in server/index.js" —
     * because the real one was unexported. The mirror faithfully copied a
     * security bug (SyncStep2 classified as not-an-edit, letting a viewer write
     * through the sync channel) and nothing forced it to track the real code, so
     * the bug passed its own test. The mirror is gone and the step2 expectation
     * below is flipped to the true contract: a frame that can reach
     * Y.applyUpdate IS an edit (feature 038 FR-001/FR-007).
     */

    test('identifies sync update as edit message', () => {
      const editMsg = Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 0, 1, 2]); // sync update with payload
      expect(isEditMessage(editMsg)).toBe(true);
    });

    test('identifies sync step1 as non-edit message', () => {
      const syncStep1 = Buffer.from([MESSAGE_SYNC, SYNC_STEP1, 0, 1, 2]);
      expect(isEditMessage(syncStep1)).toBe(false);
    });

    test('identifies sync step2 as an EDIT message (it can mutate the document)', () => {
      const syncStep2 = Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 0, 1, 2]);
      expect(isEditMessage(syncStep2)).toBe(true);
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

  // ————————————————————————————————————————————————————————————————————————
  // Feature 053: the thresholds in REQUIRED_ROLES are unchanged (D6). What
  // changed is the ROLE that reaches them — checkPermission asks
  // documents.getRole, which is now the effective union of a direct share and a
  // space membership. Nothing in this module knows spaces exist, and that is
  // the point.
  // ————————————————————————————————————————————————————————————————————————
  describe('effective role through a space (feature 053)', () => {
    const spaces = require('../spaces');
    let spaceId;
    let curatorId; // space OWNER, no direct share
    let editorId; // space EDITOR, no direct share
    let strangerId;

    beforeAll(async () => {
      spaces.init(pool);
      const mk = async (tag) => {
        const { rows } = await pool.query(
          `INSERT INTO users (google_id, email, name)
           VALUES ($1, $2, $3) RETURNING id`,
          [`test-perm-space-${tag}`, `test-perm-space-${tag}@example.com`, `Perm ${tag}`]
        );
        return rows[0].id;
      };
      curatorId = await mk('curator');
      editorId = await mk('editor');
      strangerId = await mk('stranger');

      const space = await spaces.createSpace('Permissions Space', testUserId);
      spaceId = space.id;
      await pool.query(
        "INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $3)",
        [spaceId, curatorId, testUserId]
      );
      await pool.query(
        "INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, 'editor', $3)",
        [spaceId, editorId, testUserId]
      );
    });

    afterAll(async () => {
      await pool.query('DELETE FROM space_members WHERE space_id = $1', [spaceId]);
      await pool.query('DELETE FROM spaces WHERE id = $1', [spaceId]);
      await pool.query("DELETE FROM users WHERE email LIKE 'test-perm-space-%@example.com'");
    });

    beforeEach(async () => {
      await documents.createDocument(testDocId, testUserId, null, spaceId);
    });

    test('checkPermission resolves the effective role for a space member', async () => {
      const result = await permissions.checkPermission(editorId, testDocId, 'edit');
      expect(result.allowed).toBe(true);
      expect(result.role).toBe('editor');
    });

    test('a space owner passes can.delete with no direct share', async () => {
      const { rows } = await pool.query(
        'SELECT 1 FROM document_shares WHERE doc_id = $1 AND user_id = $2',
        [testDocId, curatorId]
      );
      expect(rows).toHaveLength(0);
      expect((await permissions.can.delete(curatorId, testDocId)).allowed).toBe(true);
    });

    test('a space editor does NOT pass can.delete', async () => {
      const result = await permissions.can.delete(editorId, testDocId);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Requires owner role, you have editor/);
    });

    test('a space member clears the share threshold (REQUIRED_ROLES.share is viewer)', async () => {
      expect((await permissions.can.share(editorId, testDocId)).allowed).toBe(true);
    });

    test('a non-member is refused with the unchanged no-access reason', async () => {
      const result = await permissions.checkPermission(strangerId, testDocId, 'view');
      expect(result.allowed).toBe(false);
      expect(result.role).toBeNull();
      expect(result.reason).toBe('No access to document');
    });

    test('the thresholds themselves are unchanged (D6)', () => {
      expect(permissions.REQUIRED_ROLES).toEqual({
        view: 'viewer',
        edit: 'editor',
        share: 'viewer',
        manage: 'editor',
        delete: 'owner',
      });
    });
  });
});
