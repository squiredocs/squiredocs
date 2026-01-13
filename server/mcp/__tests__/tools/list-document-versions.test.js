/**
 * list_document_versions tool tests
 *
 * Tests the MCP tool for listing document version history.
 */
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const Y = require('yjs');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');

// Use shared test database configuration
const pool = createPool();
const persistenceProvider = createPersistence();

// Import modules
const documents = require('../../../documents');
const listDocumentVersions = require('../../tools/list-document-versions');
const createDocument = require('../../tools/create-document');

describe('list_document_versions tool', () => {
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
    const extractDocGuid = (docName) => {
      if (docName.startsWith('s/')) {
        return docName.slice(2);
      }
      return docName;
    };
    documentService.init(getYDoc, extractDocGuid);

    // Initialize documents module
    documents.init(pool);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-test-versions', 'test-versions@example.com', 'Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Initialize tools
    listDocumentVersions.init(persistenceProvider);
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
      expect(listDocumentVersions.name).toBe('list_document_versions');
      expect(listDocumentVersions.description).toBeDefined();
      expect(listDocumentVersions.inputSchema).toBeDefined();
      expect(listDocumentVersions.inputSchema.type).toBe('object');
    });

    test('requires docGuid parameter', () => {
      expect(listDocumentVersions.inputSchema.required).toContain('docGuid');
    });

    test('has optional limit and offset parameters', () => {
      expect(listDocumentVersions.inputSchema.properties.limit).toBeDefined();
      expect(listDocumentVersions.inputSchema.properties.offset).toBeDefined();
      expect(listDocumentVersions.inputSchema.properties.limit.default).toBe(50);
      expect(listDocumentVersions.inputSchema.properties.offset.default).toBe(0);
    });

    test('has optional includeSubversions parameter', () => {
      expect(listDocumentVersions.inputSchema.properties.includeSubversions).toBeDefined();
      expect(listDocumentVersions.inputSchema.properties.includeSubversions.type).toBe('boolean');
      expect(listDocumentVersions.inputSchema.properties.includeSubversions.default).toBe(false);
    });

    test('has optional since and until parameters', () => {
      expect(listDocumentVersions.inputSchema.properties.since).toBeDefined();
      expect(listDocumentVersions.inputSchema.properties.until).toBeDefined();
      expect(listDocumentVersions.inputSchema.properties.since.type).toBe('string');
      expect(listDocumentVersions.inputSchema.properties.until.type).toBe('string');
    });
  });

  describe('handler', () => {
    beforeEach(async () => {
      // Create a test document
      const agentToken = {
        userId: testUserId,
        delegationId: 'test-delegation-id',
        agentId: 'claude-code:test',
        scopes: ['documents:write'],
      };

      const result = await createDocument.handler(
        { title: 'Test Document for Versions' },
        agentToken
      );
      testDocGuid = result.docGuid;
    });

    afterEach(async () => {
      // Cleanup document after each test
      if (testDocGuid) {
        await pool.query('DELETE FROM documents WHERE id = $1', [testDocGuid]);
        testDocGuid = null;
      }
    });

    test('lists versions for document with no edits', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid },
        agentToken
      );

      expect(result).toHaveProperty('versions');
      expect(result).toHaveProperty('totalEdits');
      expect(result).toHaveProperty('pagination');
      expect(Array.isArray(result.versions)).toBe(true);
      // New document may have initial version or be empty
      expect(result.totalEdits).toBeGreaterThanOrEqual(0);
    });

    test('enforces access control - unauthorized user', async () => {
      // Create another user
      const unauthorizedResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-unauthorized', 'unauthorized@example.com', 'Unauthorized User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      const unauthorizedUserId = unauthorizedResult.rows[0].id;

      const agentToken = {
        userId: unauthorizedUserId,
        scopes: ['documents:read'],
      };

      await expect(
        listDocumentVersions.handler({ docGuid: testDocGuid }, agentToken)
      ).rejects.toThrow('do not have access');

      // Cleanup
      await pool.query('DELETE FROM users WHERE id = $1', [unauthorizedUserId]);
    });

    test('supports pagination - first page', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid, limit: 10, offset: 0 },
        agentToken
      );

      expect(result.pagination).toHaveProperty('total');
      expect(result.pagination).toHaveProperty('limit');
      expect(result.pagination).toHaveProperty('offset');
      expect(result.pagination).toHaveProperty('hasMore');
      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.offset).toBe(0);
    });

    test('clamps limit to maximum of 100', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid, limit: 200 },
        agentToken
      );

      expect(result.pagination.limit).toBe(100);
    });

    test('clamps limit to minimum of 1', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid, limit: 0 },
        agentToken
      );

      expect(result.pagination.limit).toBe(1);
    });

    test('returns basic version fields without expensive metadata', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid },
        agentToken
      );

      // Check that versions have basic fields
      if (result.versions.length > 0) {
        const version = result.versions[0];
        expect(version).toHaveProperty('id');
        expect(version).toHaveProperty('clockStart');
        expect(version).toHaveProperty('clockEnd');
        expect(version).toHaveProperty('timestamp');
        expect(version).toHaveProperty('authors');
        // Should NOT have expensive metadata fields
        expect(version).not.toHaveProperty('editCount');
        expect(version).not.toHaveProperty('duration');
        expect(version).not.toHaveProperty('characterCount');
        expect(version).not.toHaveProperty('wordCount');
        expect(version).not.toHaveProperty('blockCount');
        expect(version).not.toHaveProperty('charactersDelta');
      }
    });

    test('supports includeSubversions parameter', async () => {
      // Make some edits to create versions
      const ydoc = getYDoc(`s/${testDocGuid}`);
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait for sync

      const fragment = ydoc.getXmlFragment('default');
      ydoc.transact(() => {
        const para = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, 'First edit');
        para.insert(0, [text]);
        fragment.insert(0, [para]);
      }, testUserId);

      await new Promise(resolve => setTimeout(resolve, 100));

      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      // Without includeSubversions
      const resultWithout = await listDocumentVersions.handler(
        { docGuid: testDocGuid, includeSubversions: false },
        agentToken
      );

      if (resultWithout.versions.length > 0) {
        expect(resultWithout.versions[0]).not.toHaveProperty('subversions');
      }

      // With includeSubversions
      const resultWith = await listDocumentVersions.handler(
        { docGuid: testDocGuid, includeSubversions: true },
        agentToken
      );

      if (resultWith.versions.length > 0) {
        expect(resultWith.versions[0]).toHaveProperty('subversions');
        expect(Array.isArray(resultWith.versions[0].subversions)).toBe(true);

        // Check subversion fields if subversions exist
        if (resultWith.versions[0].subversions.length > 0) {
          const subversion = resultWith.versions[0].subversions[0];
          // Subversions should have basic fields
          expect(subversion).toHaveProperty('id');
          expect(subversion).toHaveProperty('clockStart');
          expect(subversion).toHaveProperty('clockEnd');
          expect(subversion).toHaveProperty('timestamp');
          expect(subversion).toHaveProperty('authors');
          expect(subversion).toHaveProperty('updateCount');
          expect(subversion).toHaveProperty('previousClock');
        }

        // Check metadata fields
        expect(resultWith.versions[0]).toHaveProperty('subversionCount');
        expect(resultWith.versions[0]).toHaveProperty('hasMoreSubversions');
        expect(typeof resultWith.versions[0].subversionCount).toBe('number');
        expect(typeof resultWith.versions[0].hasMoreSubversions).toBe('boolean');

        // Subversions should be limited to 10
        expect(resultWith.versions[0].subversions.length).toBeLessThanOrEqual(10);
      }
    });

    test('filters versions by since parameter', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      // Get all versions first
      const allVersions = await listDocumentVersions.handler(
        { docGuid: testDocGuid },
        agentToken
      );

      if (allVersions.versions.length > 0) {
        // Use a time far in the future to filter out all versions
        const futureTime = new Date(Date.now() + 86400000).toISOString(); // Tomorrow

        const result = await listDocumentVersions.handler(
          { docGuid: testDocGuid, since: futureTime },
          agentToken
        );

        expect(result.versions.length).toBe(0);
        expect(result.pagination.total).toBe(0);
      }
    });

    test('filters versions by until parameter', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      // Use a time far in the past to filter out all versions
      const pastTime = new Date(0).toISOString(); // Epoch

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid, until: pastTime },
        agentToken
      );

      expect(result.versions.length).toBe(0);
      expect(result.pagination.total).toBe(0);
    });

    test('filters versions by both since and until', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const pastTime = new Date(0).toISOString();
      const futureTime = new Date(Date.now() + 86400000).toISOString();

      const result = await listDocumentVersions.handler(
        { docGuid: testDocGuid, since: pastTime, until: futureTime },
        agentToken
      );

      // Should include all versions (between past and future)
      const allVersions = await listDocumentVersions.handler(
        { docGuid: testDocGuid },
        agentToken
      );

      expect(result.versions.length).toBe(allVersions.versions.length);
    });

    test('validates time filter format', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      await expect(
        listDocumentVersions.handler(
          { docGuid: testDocGuid, since: 'invalid-date' },
          agentToken
        )
      ).rejects.toThrow('Invalid');
    });

    test('validates since must be before until', async () => {
      const agentToken = {
        userId: testUserId,
        scopes: ['documents:read'],
      };

      const now = new Date().toISOString();
      const past = new Date(Date.now() - 86400000).toISOString();

      await expect(
        listDocumentVersions.handler(
          { docGuid: testDocGuid, since: now, until: past },
          agentToken
        )
      ).rejects.toThrow("'since' time must be before 'until' time");
    });
  });
});
