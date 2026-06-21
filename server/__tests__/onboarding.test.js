/**
 * Onboarding / welcome-flow integration tests
 *
 * Exercises server/onboarding.js end-to-end against the test database with a
 * real Yjs-backed document service (mirrors the create_document tool harness),
 * so welcome-doc seeding actually persists content + Yjs updates.
 */
const { createPool, createPersistence } = require('./helpers/db');
const Y = require('yjs');

const pool = createPool();
const persistenceProvider = createPersistence();

const documents = require('../documents');
const users = require('../auth/users');
const onboarding = require('../onboarding');
const documentService = require('../document-service');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../origin');

const pendingOperations = [];

describe('onboarding / welcome flow', () => {
  let testUserId;
  const createdDocIds = [];

  beforeAll(async () => {
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          const { userId, agentName } = parsed;
          pendingOperations.push(
            persistenceProvider.storeUpdate(docGuid, update, userId, agentName).catch((err) => {
              console.error(`Error persisting update for ${docGuid}:`, err);
            })
          );
        });
        try {
          const persistedYdoc = await persistenceProvider.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);
        } catch (error) {
          /* doc doesn't exist yet — fine */
        }
      },
      writeState: async () => {},
      provider: persistenceProvider,
    });

    const extractDocGuid = (docName) => (docName.startsWith('s/') ? docName.slice(2) : docName);
    documentService.init(getYDoc, extractDocGuid);

    documents.init(pool);
    users.init(pool);
    onboarding.init(pool);

    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-onboarding-test', 'onboarding-test@example.com', 'Onboarding Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    for (const docId of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('UPDATE users SET welcome_doc_id = NULL WHERE welcome_doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    }
    await pool.query('DELETE FROM document_shares WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  // Reset onboarding state between tests
  afterEach(async () => {
    await Promise.all(pendingOperations);
    pendingOperations.length = 0;
  });

  // Reset the shared user to a truly brand-new state: clear onboarding columns
  // AND remove every doc they own (so engagement starts from zero).
  async function freshUser() {
    const owned = await pool.query(
      "SELECT doc_id FROM document_shares WHERE user_id = $1 AND role = 'owner'",
      [testUserId]
    );
    for (const { doc_id } of owned.rows) {
      await pool.query('UPDATE users SET welcome_doc_id = NULL WHERE welcome_doc_id = $1', [doc_id]);
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [doc_id]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [doc_id]);
      await pool.query('DELETE FROM documents WHERE id = $1', [doc_id]);
    }
    await pool.query('UPDATE users SET welcome_doc_id = NULL, onboarded_at = NULL WHERE id = $1', [testUserId]);
    return users.findById(testUserId);
  }

  describe('seedWelcomeDoc', () => {
    test('creates an owned, content-filled welcome doc and records it on the user', async () => {
      await freshUser();
      const docGuid = await onboarding.seedWelcomeDoc(testUserId);
      createdDocIds.push(docGuid);

      // Owner share
      const share = await pool.query(
        "SELECT role FROM document_shares WHERE doc_id = $1 AND user_id = $2",
        [docGuid, testUserId]
      );
      expect(share.rows[0]?.role).toBe('owner');

      // Title persisted in DB + Yjs meta
      const doc = await pool.query('SELECT title FROM documents WHERE id = $1', [docGuid]);
      expect(doc.rows[0].title).toBe('Welcome to Squire Docs');

      await new Promise((r) => setTimeout(r, 150));
      const ydoc = documentService.getSharedDoc(docGuid);
      expect(ydoc.getMap('meta').get('title')).toBe('Welcome to Squire Docs');
      const fragment = ydoc.get('default', Y.XmlFragment);
      expect(fragment.length).toBeGreaterThan(0); // content actually seeded

      // Recorded on the user
      const u = await users.findById(testUserId);
      expect(u.welcome_doc_id).toBe(docGuid);
    });

    test('is idempotent — returns the existing doc without creating another', async () => {
      const u = await users.findById(testUserId);
      const existing = u.welcome_doc_id;
      expect(existing).toBeTruthy();

      const again = await onboarding.seedWelcomeDoc(testUserId);
      expect(again).toBe(existing);

      const owned = await pool.query(
        "SELECT COUNT(*)::int AS n FROM document_shares WHERE user_id = $1 AND role = 'owner'",
        [testUserId]
      );
      expect(owned.rows[0].n).toBe(1); // still just the welcome doc
    });
  });

  describe('isEngaged', () => {
    test('false when the user only owns their welcome doc', async () => {
      const u = await users.findById(testUserId);
      expect(await onboarding.isEngaged(testUserId, u.welcome_doc_id)).toBe(false);
    });

    test('true once the user owns another doc that has content', async () => {
      const u = await users.findById(testUserId);
      const otherDoc = await documents.createDocument(require('crypto').randomUUID(), testUserId);
      createdDocIds.push(otherDoc.id);
      // Simulate content: a persisted Yjs update for the other doc
      await pool.query(
        `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id)
         VALUES ($1, 0, $2, $3)`,
        [otherDoc.id, Buffer.from([0]), testUserId]
      );
      expect(await onboarding.isEngaged(testUserId, u.welcome_doc_id)).toBe(true);
    });
  });

  describe('resolveOnboarding', () => {
    test('brand-new user (seed): seeds a welcome doc and is not onboarded', async () => {
      const user = await freshUser();
      const { welcomeDocId, onboarded } = await onboarding.resolveOnboarding(user, { seed: true });
      expect(onboarded).toBe(false);
      expect(welcomeDocId).toBeTruthy();
      createdDocIds.push(welcomeDocId);
    });

    test('engaged user: stamps onboarded_at and reports onboarded', async () => {
      // User already has a welcome doc + an engaging doc from earlier tests setup
      const user = await users.findById(testUserId);
      // Ensure an engaging doc exists
      const otherDoc = await documents.createDocument(require('crypto').randomUUID(), testUserId);
      createdDocIds.push(otherDoc.id);
      await pool.query(
        `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id) VALUES ($1, 0, $2, $3)`,
        [otherDoc.id, Buffer.from([0]), testUserId]
      );

      const { onboarded } = await onboarding.resolveOnboarding(user, { seed: false });
      expect(onboarded).toBe(true);
      const u = await users.findById(testUserId);
      expect(u.onboarded_at).toBeTruthy();
    });

    test('already-onboarded user: early return, no work', async () => {
      const user = await users.findById(testUserId);
      expect(user.onboarded_at).toBeTruthy();
      const res = await onboarding.resolveOnboarding(user, { seed: true });
      expect(res.onboarded).toBe(true);
    });
  });

  describe('resetForDev', () => {
    test('clears onboarding state and reseeds a fresh welcome doc', async () => {
      // Establish a starting welcome doc + onboarded state
      await freshUser();
      const first = await onboarding.seedWelcomeDoc(testUserId);
      createdDocIds.push(first);
      await users.markOnboarded(testUserId);

      const second = await onboarding.resetForDev(testUserId);
      createdDocIds.push(second);
      await Promise.all(pendingOperations);

      expect(second).not.toBe(first);

      // Old welcome doc removed
      const oldDoc = await pool.query('SELECT 1 FROM documents WHERE id = $1', [first]);
      expect(oldDoc.rows.length).toBe(0);
      const oldUpdates = await pool.query('SELECT 1 FROM yjs_updates WHERE doc_guid = $1', [first]);
      expect(oldUpdates.rows.length).toBe(0);

      // User points at the new doc and is no longer onboarded
      const u = await users.findById(testUserId);
      expect(u.welcome_doc_id).toBe(second);
      expect(u.onboarded_at).toBeNull();

      // New doc has seeded content
      await new Promise((r) => setTimeout(r, 150));
      const ydoc = documentService.getSharedDoc(second);
      expect(ydoc.get('default', Y.XmlFragment).length).toBeGreaterThan(0);
    });
  });
});
