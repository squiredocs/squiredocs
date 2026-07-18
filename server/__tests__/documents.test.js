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

    describe('last-update metadata (clock / lastModifiedAt / updatedSince)', () => {
      const Y = require('yjs');
      let docA; // three updates, recent
      let docB; // one update, old
      let docC; // no updates

      // A minimal valid Yjs update payload for yjs_updates rows
      const updateData = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()));

      async function insertUpdate(docGuid, clock, createdAt) {
        await pool.query(
          `INSERT INTO yjs_updates (doc_guid, clock, update_data, created_at)
           VALUES ($1, $2, $3, $4)`,
          [docGuid, clock, updateData, createdAt]
        );
      }

      beforeEach(async () => {
        const { randomUUID } = require('crypto');
        docA = randomUUID();
        docB = randomUUID();
        docC = randomUUID();
        await documents.createDocument(docA, testUserId);
        await documents.createDocument(docB, testUserId);
        await documents.createDocument(docC, testUserId);

        // docA: clocks 0..2. The max-clock row (2) deliberately has an OLDER
        // created_at than clock 1 — clock is the source of truth, not time.
        await insertUpdate(docA, 0, '2026-01-01T00:00:00');
        await insertUpdate(docA, 1, '2026-06-01T00:00:00');
        await insertUpdate(docA, 2, '2026-05-01T00:00:00');
        // docB: single old update.
        await insertUpdate(docB, 0, '2025-01-01T00:00:00');
      });

      afterEach(async () => {
        for (const id of [docA, docB, docC]) {
          await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [id]);
          await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [id]);
          await pool.query('DELETE FROM documents WHERE id = $1', [id]);
        }
      });

      test('projects the max-clock row and its created_at', async () => {
        const { rows } = await documents.getAccessibleDocuments(testUserId);
        const a = rows.find(d => d.doc_id === docA);

        expect(Number(a.last_clock)).toBe(2);
        // created_at of the clock-2 row, not the max created_at
        expect(new Date(a.last_modified_at).getFullYear()).toBe(2026);
        expect(new Date(a.last_modified_at).getMonth()).toBe(4); // May
      });

      test('documents with no updates list with null metadata', async () => {
        const { rows } = await documents.getAccessibleDocuments(testUserId);
        const c = rows.find(d => d.doc_id === docC);

        expect(c).toBeDefined();
        expect(c.last_clock).toBeNull();
        expect(c.last_modified_at).toBeNull();
      });

      test('updatedSince filters on last edit and keeps total consistent', async () => {
        // Derive the boundary from what the DB round-trips for docB's update,
        // to stay timezone-agnostic: anything after docB's edit but before docA's.
        const { rows: all } = await documents.getAccessibleDocuments(testUserId);
        const bEdit = new Date(all.find(d => d.doc_id === docB).last_modified_at);
        const boundary = new Date(bEdit.getTime() + 1000);

        const { rows, total } = await documents.getAccessibleDocuments(testUserId, {
          updatedSince: boundary.toISOString(),
        });

        const ids = rows.map(d => d.doc_id);
        expect(ids).toContain(docA);      // edited after boundary
        expect(ids).not.toContain(docB);  // edited before boundary
        expect(ids).not.toContain(docC);  // never edited
        expect(total).toBe(rows.length);
      });

      test('rejects an invalid updatedSince timestamp', async () => {
        await expect(
          documents.getAccessibleDocuments(testUserId, { updatedSince: 'not-a-date' })
        ).rejects.toThrow(/ISO-8601/);
      });
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

    test('removes the document\'s agent_edits records (feature 016)', async () => {
      // An undo/redo chain record for the doc (log-derived undo, feature 016)
      await pool.query(
        `INSERT INTO agent_edits
           (doc_guid, user_id, agent_name, edit_clock_start, edit_clock_end,
            state, undo_target_start, undo_target_end)
         VALUES ($1, $2, 'Squire Docs Assistant', 1, 2, 'active', 1, 2)`,
        [testDocId, testUserId]
      );

      const deleted = await documents.deleteDocument(testDocId);
      expect(deleted).toBe(true);

      const rec = await pool.query(
        'SELECT count(*)::int AS n FROM agent_edits WHERE doc_guid = $1',
        [testDocId]
      );
      expect(rec.rows[0].n).toBe(0);
    });
  });
});
