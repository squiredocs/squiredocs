/**
 * get_version_diff tool tests
 *
 * Tests the MCP tool for getting changes between document versions.
 */
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const Y = require('yjs');
const { setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');
const { getYDoc, extractDocGuid } = require('../../../documents');

// Use shared test database configuration
const pool = createPool();
const persistenceProvider = createPersistence();

// Import modules
const getVersionDiff = require('../../tools/get-version-diff');
const createDocument = require('../../tools/create-document');

describe('get_version_diff tool', () => {
  let testUserId;
  let testDocGuid;
  const pendingOperations = [];

  beforeAll(async () => {
    // Set up y-websocket persistence
    const ORIGIN_DB_LOAD = 'db-load';
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
        ydoc.on('update', (update, origin) => {
          if (origin === ORIGIN_DB_LOAD) return;
          const userId = typeof origin === 'string' ? origin : null;
          const storePromise = persistenceProvider.storeUpdate(docGuid, update, userId);
          pendingOperations.push(storePromise);
        });
        try {
          const persistedYdoc = await persistenceProvider.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);
        } catch (error) {
          // Document doesn't exist yet
        }
      },
      writeState: async () => {},
      provider: persistenceProvider,
    });

    // Initialize document service
    documentService.init(getYDoc, extractDocGuid);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-test-diff', 'test-diff@example.com', 'Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Initialize tools
    getVersionDiff.init(persistenceProvider);
    createDocument.init(persistenceProvider);
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  afterEach(async () => {
    await Promise.all(pendingOperations);
    pendingOperations.length = 0;
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(getVersionDiff.name).toBe('get_version_diff');
      expect(getVersionDiff.description).toBeDefined();
      expect(getVersionDiff.inputSchema).toBeDefined();
      expect(getVersionDiff.inputSchema.type).toBe('object');
    });

    test('requires docGuid and versionId parameters', () => {
      expect(getVersionDiff.inputSchema.required).toContain('docGuid');
      expect(getVersionDiff.inputSchema.required).toContain('versionId');
    });

    test('has optional compareToVersionId parameter', () => {
      expect(getVersionDiff.inputSchema.properties.compareToVersionId).toBeDefined();
    });
  });

  describe('handler', () => {
    beforeEach(async () => {
      // Create a test document with multiple edits
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler(
        { title: 'Test Document for Diff' },
        agentToken
      );
      testDocGuid = result.docGuid;

      // Add initial content
      const ydoc = getYDoc(testDocGuid);
      ydoc.transact(() => {
        const xmlFragment = ydoc.get('default', Y.XmlFragment);
        const paragraph = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, 'Initial content');
        paragraph.insert(0, [text]);
        xmlFragment.insert(0, [paragraph]);
      }, testUserId);

      await Promise.all(pendingOperations);
      pendingOperations.length = 0;

      // Make a second edit
      ydoc.transact(() => {
        const xmlFragment = ydoc.get('default', Y.XmlFragment);
        const paragraph2 = new Y.XmlElement('paragraph');
        const text2 = new Y.XmlText();
        text2.insert(0, 'Second paragraph');
        paragraph2.insert(0, [text2]);
        xmlFragment.insert(1, [paragraph2]);
      }, testUserId);

      await Promise.all(pendingOperations);
      pendingOperations.length = 0;
    });

    afterEach(async () => {
      if (testDocGuid) {
        await pool.query('DELETE FROM documents WHERE id = $1', [testDocGuid]);
        testDocGuid = null;
      }
    });

    test('computes diff between version and predecessor', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const updates = await persistenceProvider.getUpdatesWithUsers(testDocGuid);
      const latestClock = updates[updates.length - 1].clock;
      const versionId = `auto-${latestClock}`;

      const result = await getVersionDiff.handler(
        { docGuid: testDocGuid, versionId },
        agentToken
      );

      expect(result).toHaveProperty('document');
      expect(result).toHaveProperty('changes');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('currentVersion');
      expect(result).toHaveProperty('previousVersion');
      expect(Array.isArray(result.changes)).toBe(true);
    });

    test('computes diff between two specified versions', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const updates = await persistenceProvider.getUpdatesWithUsers(testDocGuid);
      const currentClock = updates[updates.length - 1].clock;
      const previousClock = updates[0].clock;
      const currentVersionId = `auto-${currentClock}`;
      const previousVersionId = `auto-${previousClock}`;

      const result = await getVersionDiff.handler(
        {
          docGuid: testDocGuid,
          versionId: currentVersionId,
          compareToVersionId: previousVersionId
        },
        agentToken
      );

      expect(result.currentVersion.id).toBe(currentVersionId);
      expect(result.previousVersion.id).toBe(previousVersionId);
      expect(result.currentVersion.clockEnd).toBe(currentClock);
      expect(result.previousVersion.clockEnd).toBe(previousClock);
    });

    test('summary includes insertion and deletion counts', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const updates = await persistenceProvider.getUpdatesWithUsers(testDocGuid);
      const latestClock = updates[updates.length - 1].clock;
      const versionId = `auto-${latestClock}`;

      const result = await getVersionDiff.handler(
        { docGuid: testDocGuid, versionId },
        agentToken
      );

      expect(result.summary).toHaveProperty('insertions');
      expect(result.summary).toHaveProperty('deletions');
      expect(result.summary).toHaveProperty('textIdentical');
      expect(typeof result.summary.insertions).toBe('number');
      expect(typeof result.summary.deletions).toBe('number');
      expect(typeof result.summary.textIdentical).toBe('boolean');
    });

    test('changes array contains proper change objects', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const updates = await persistenceProvider.getUpdatesWithUsers(testDocGuid);
      const latestClock = updates[updates.length - 1].clock;
      const versionId = `auto-${latestClock}`;

      const result = await getVersionDiff.handler(
        { docGuid: testDocGuid, versionId },
        agentToken
      );

      if (result.changes.length > 0) {
        const change = result.changes[0];
        expect(change).toHaveProperty('type');
        expect(['insert', 'delete']).toContain(change.type);
        expect(change).toHaveProperty('fromB');

        if (change.type === 'insert') {
          expect(change).toHaveProperty('toB');
        } else if (change.type === 'delete') {
          expect(change).toHaveProperty('deletedContent');
        }
      }
    });

    test('enforces access control - unauthorized user', async () => {
      const unauthorizedResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-unauthorized-diff', 'unauthorized-diff@example.com', 'Unauthorized User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const unauthorizedUserId = unauthorizedResult.rows[0].id;

      const agentToken = {
        userId: unauthorizedUserId,
        scopes: ['documents:read'],
      };

      await expect(
        getVersionDiff.handler(
          { docGuid: testDocGuid, versionId: 'auto-0' },
          agentToken
        )
      ).rejects.toThrow('do not have access');

      await pool.query('DELETE FROM users WHERE id = $1', [unauthorizedUserId]);
    });

    test('throws error for invalid version ID format', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      await expect(
        getVersionDiff.handler(
          { docGuid: testDocGuid, versionId: 'invalid-format' },
          agentToken
        )
      ).rejects.toThrow();
    });
  });
});
