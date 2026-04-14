/**
 * Tests for import_from_google_docs MCP tool.
 *
 * Mocks drive-api, google-auth, document-service, and documents module.
 * Uses real DB to verify link upsertion and title updates.
 */
const { createPool, createTestUser, cleanupTestUser } = require('../../../__tests__/helpers/db');
const Y = require('yjs');

// Mock external dependencies
jest.mock('../../../google-docs/drive-api', () => ({
  exportGoogleDoc: jest.fn(),
  getGoogleDocMetadata: jest.fn(),
}));
jest.mock('../../../google-docs/google-auth', () => ({
  getValidToken: jest.fn(),
}));
jest.mock('../../../document-service', () => ({
  updateDocument: jest.fn(),
}));
jest.mock('../../../documents', () => ({
  init: jest.fn(),
  createDocument: jest.fn(),
}));

const driveApi = require('../../../google-docs/drive-api');
const googleAuth = require('../../../google-docs/google-auth');
const documentService = require('../../../document-service');
const documents = require('../../../documents');
const importTool = require('../../tools/import-from-google-docs');

const pool = createPool();

describe('import_from_google_docs tool', () => {
  let userId;
  let existingDocGuid;

  beforeAll(async () => {
    userId = await createTestUser(pool, `import-gdoc-test-${Date.now()}@example.com`);

    // Create a pre-existing Squire document for the "import into existing" path
    const docResult = await pool.query(
      `INSERT INTO documents (id, creator_id, title) VALUES (uuid_generate_v4(), $1, 'Existing Doc') RETURNING id`,
      [userId]
    );
    existingDocGuid = docResult.rows[0].id;

    importTool.init({ getPool: () => pool });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM google_doc_links WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [userId]);
    await cleanupTestUser(pool, userId);
    await pool.end();
  });

  beforeEach(async () => {
    driveApi.exportGoogleDoc.mockReset();
    driveApi.getGoogleDocMetadata.mockReset();
    googleAuth.getValidToken.mockReset();
    documentService.updateDocument.mockReset();
    documents.createDocument.mockReset();

    // Default: updateDocument invokes the callback with a real Y.Doc
    documentService.updateDocument.mockImplementation(async (docGuid, updateFn) => {
      const ydoc = new Y.Doc();
      updateFn(ydoc);
    });

    // Default: createDocument inserts a documents row so later UPDATE succeeds
    documents.createDocument.mockImplementation(async (docGuid, uid) => {
      await pool.query(
        `INSERT INTO documents (id, creator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [docGuid, uid]
      );
    });

    await pool.query('DELETE FROM google_doc_links WHERE user_id = $1', [userId]);
  });

  const agentToken = (overrides = {}) => ({
    userId,
    delegationId: 'test-delegation',
    agentId: 'claude-code:test',
    agentName: 'Test Agent',
    scopes: ['documents:write'],
    baseUrl: 'https://squiredocs.com',
    ...overrides,
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(importTool.name).toBe('import_from_google_docs');
      expect(importTool.description).toBeDefined();
      expect(importTool.inputSchema.required).toContain('googleDocId');
    });
  });

  describe('authorization', () => {
    test('returns error with connectUrl when not connected', async () => {
      const err = new Error('Not connected');
      err.code = 'NOT_CONNECTED';
      googleAuth.getValidToken.mockRejectedValue(err);

      const result = await importTool.handler(
        { googleDocId: 'gdoc-abc' },
        agentToken()
      );

      expect(result.code).toBe('NOT_CONNECTED');
      expect(result.connectUrl).toBe('https://squiredocs.com/settings');
      expect(driveApi.exportGoogleDoc).not.toHaveBeenCalled();
    });
  });

  describe('creating a new Squire document', () => {
    test('creates new doc and parses HTML content', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.getGoogleDocMetadata.mockResolvedValue({
        id: 'gdoc-source',
        name: 'Source Doc',
        webViewLink: 'https://docs.google.com/d/gdoc-source',
        modifiedTime: '2026-04-14T12:00:00Z',
      });
      driveApi.exportGoogleDoc.mockResolvedValue(
        '<h1>Imported</h1><p>Content from Google</p>'
      );

      const result = await importTool.handler(
        { googleDocId: 'gdoc-source' },
        agentToken()
      );

      // Output structure: title + url (to Squire) + blockCount
      expect(result.title).toBe('Source Doc');
      expect(result.docGuid).toBeDefined();
      expect(result.url).toBe(`https://squiredocs.com/d/${result.docGuid}`);
      expect(result.googleDocId).toBe('gdoc-source');
      expect(result.googleDocUrl).toBe('https://docs.google.com/d/gdoc-source');
      expect(result.action).toBe('created');
      expect(result.blockCount).toBeGreaterThan(0);
      expect(result.message).toContain('Source Doc');
      expect(result.message).toContain(result.url);

      // Created a new document row
      expect(documents.createDocument).toHaveBeenCalledWith(result.docGuid, userId);

      // Cleanup
      await pool.query('DELETE FROM documents WHERE id = $1', [result.docGuid]);
    });

    test('uses provided title override', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.getGoogleDocMetadata.mockResolvedValue({
        id: 'gdoc-x',
        name: 'Google Doc Name',
        webViewLink: 'url',
      });
      driveApi.exportGoogleDoc.mockResolvedValue('<p>x</p>');

      const result = await importTool.handler(
        { googleDocId: 'gdoc-x', title: 'My Override' },
        agentToken()
      );

      expect(result.title).toBe('My Override');

      // Verify title was set in the DB
      const { rows } = await pool.query(
        `SELECT title FROM documents WHERE id = $1`,
        [result.docGuid]
      );
      expect(rows[0].title).toBe('My Override');

      await pool.query('DELETE FROM documents WHERE id = $1', [result.docGuid]);
    });

    test('upserts a google_doc_link on success', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.getGoogleDocMetadata.mockResolvedValue({
        id: 'gdoc-link-test',
        name: 'Doc',
        webViewLink: 'https://docs.google.com/d/gdoc-link-test',
        modifiedTime: '2026-04-14T12:00:00Z',
      });
      driveApi.exportGoogleDoc.mockResolvedValue('<p>content</p>');

      const result = await importTool.handler(
        { googleDocId: 'gdoc-link-test' },
        agentToken()
      );

      const { rows } = await pool.query(
        `SELECT google_doc_id, google_doc_url, last_import_at, google_modified_time
         FROM google_doc_links WHERE doc_id = $1 AND user_id = $2`,
        [result.docGuid, userId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].google_doc_id).toBe('gdoc-link-test');
      expect(rows[0].google_doc_url).toBe('https://docs.google.com/d/gdoc-link-test');
      expect(rows[0].last_import_at).not.toBeNull();

      await pool.query('DELETE FROM documents WHERE id = $1', [result.docGuid]);
    });

    test('falls back to default title when metadata has no name', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.getGoogleDocMetadata.mockResolvedValue({
        id: 'gdoc-no-name',
        webViewLink: 'url',
      });
      driveApi.exportGoogleDoc.mockResolvedValue('<p>x</p>');

      const result = await importTool.handler(
        { googleDocId: 'gdoc-no-name' },
        agentToken()
      );

      expect(result.title).toBe('Imported Document');

      await pool.query('DELETE FROM documents WHERE id = $1', [result.docGuid]);
    });
  });

  describe('importing into an existing Squire document', () => {
    test('replaces content of existing doc', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.getGoogleDocMetadata.mockResolvedValue({
        id: 'gdoc-y',
        name: 'From Google',
        webViewLink: 'https://docs.google.com/d/gdoc-y',
      });
      driveApi.exportGoogleDoc.mockResolvedValue('<h2>New Content</h2>');

      const result = await importTool.handler(
        { googleDocId: 'gdoc-y', docGuid: existingDocGuid },
        agentToken()
      );

      expect(result.docGuid).toBe(existingDocGuid);
      expect(result.action).toBe('updated');
      expect(result.message).toContain('existing Squire document');

      // No new document should be created
      expect(documents.createDocument).not.toHaveBeenCalled();

      // Title should be updated in DB
      const { rows } = await pool.query(
        `SELECT title FROM documents WHERE id = $1`,
        [existingDocGuid]
      );
      expect(rows[0].title).toBe('From Google');
    });

    test('clears existing Yjs content before importing', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.getGoogleDocMetadata.mockResolvedValue({
        id: 'gdoc-z', name: 'X', webViewLink: 'url',
      });
      driveApi.exportGoogleDoc.mockResolvedValue('<p>replacement</p>');

      // Replace the default mock to capture the Yjs doc mutation
      let capturedFragment;
      documentService.updateDocument.mockImplementation(async (docGuid, updateFn) => {
        const ydoc = new Y.Doc();
        const frag = ydoc.get('default', Y.XmlFragment);
        // Seed with pre-existing content that should be cleared
        const oldPara = new Y.XmlElement('paragraph');
        const oldText = new Y.XmlText();
        oldText.insert(0, 'OLD CONTENT TO BE REMOVED');
        oldPara.insert(0, [oldText]);
        frag.insert(0, [oldPara]);

        updateFn(ydoc);

        capturedFragment = frag;
      });

      await importTool.handler(
        { googleDocId: 'gdoc-z', docGuid: existingDocGuid },
        agentToken()
      );

      // After import, the old content should be gone
      const { toPlainText } = require('../../yjs/serialization');
      const text = toPlainText(capturedFragment);
      expect(text).not.toContain('OLD CONTENT TO BE REMOVED');
      expect(text).toContain('replacement');
    });
  });

  describe('API call sequencing', () => {
    test('fetches metadata and content in parallel', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.getGoogleDocMetadata.mockResolvedValue({
        id: 'gdoc-parallel', name: 'Doc', webViewLink: 'url',
      });
      driveApi.exportGoogleDoc.mockResolvedValue('<p/>');

      const result = await importTool.handler(
        { googleDocId: 'gdoc-parallel' },
        agentToken()
      );

      expect(driveApi.getGoogleDocMetadata).toHaveBeenCalledWith(
        'access-token',
        'gdoc-parallel'
      );
      expect(driveApi.exportGoogleDoc).toHaveBeenCalledWith(
        'access-token',
        'gdoc-parallel'
      );

      await pool.query('DELETE FROM documents WHERE id = $1', [result.docGuid]);
    });
  });
});
