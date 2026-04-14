/**
 * Tests for export_to_google_docs MCP tool.
 *
 * Mocks agent-presence, Drive API, and google-auth.
 * Exercises the handler with a real DB to verify link upsertion,
 * conflict detection, and output structure.
 */
const { createPool, createTestUser, cleanupTestUser } = require('../../../__tests__/helpers/db');
const Y = require('yjs');

// Mock external dependencies
jest.mock('../../agent-presence', () => ({
  getOrCreateSession: jest.fn(),
}));
jest.mock('../../../google-docs/drive-api', () => ({
  createGoogleDoc: jest.fn(),
  updateGoogleDoc: jest.fn(),
  getGoogleDocMetadata: jest.fn(),
}));
jest.mock('../../../google-docs/google-auth', () => ({
  getValidToken: jest.fn(),
}));

const agentPresence = require('../../agent-presence');
const driveApi = require('../../../google-docs/drive-api');
const googleAuth = require('../../../google-docs/google-auth');
const exportTool = require('../../tools/export-to-google-docs');

const pool = createPool();

/** Build a Y.Doc with known content and return a mock session object */
function buildMockSession(docTitle = 'Test Doc', content = [{ type: 'paragraph', text: 'Hello' }]) {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  const meta = doc.getMap('meta');
  meta.set('title', docTitle);

  for (const block of content) {
    const el = new Y.XmlElement(block.type);
    if (block.level) el.setAttribute('level', String(block.level));
    const text = new Y.XmlText();
    text.insert(0, block.text);
    el.insert(0, [text]);
    frag.insert(frag.length, [el]);
  }

  return {
    provider: { doc },
    sessionId: 'test-session',
    agentInfo: { name: 'test-agent' },
  };
}

describe('export_to_google_docs tool', () => {
  let userId;
  let testDocGuid;

  beforeAll(async () => {
    userId = await createTestUser(pool, `export-gdoc-test-${Date.now()}@example.com`);

    // Create a Squire document row (the actual Yjs doc content comes from our mock)
    const docResult = await pool.query(
      `INSERT INTO documents (id, creator_id) VALUES (uuid_generate_v4(), $1) RETURNING id`,
      [userId]
    );
    testDocGuid = docResult.rows[0].id;

    exportTool.init({ getPool: () => pool });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM google_doc_links WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM documents WHERE id = $1', [testDocGuid]);
    await cleanupTestUser(pool, userId);
    await pool.end();
  });

  beforeEach(async () => {
    agentPresence.getOrCreateSession.mockReset();
    driveApi.createGoogleDoc.mockReset();
    driveApi.updateGoogleDoc.mockReset();
    driveApi.getGoogleDocMetadata.mockReset();
    googleAuth.getValidToken.mockReset();
    await pool.query('DELETE FROM google_doc_links WHERE user_id = $1', [userId]);
  });

  const agentToken = (overrides = {}) => ({
    userId,
    delegationId: 'test-delegation',
    agentId: 'claude-code:test',
    scopes: ['documents:read'],
    baseUrl: 'https://squiredocs.com',
    ...overrides,
  });

  describe('schema', () => {
    test('has correct tool definition', () => {
      expect(exportTool.name).toBe('export_to_google_docs');
      expect(exportTool.description).toBeDefined();
      expect(exportTool.inputSchema.required).toContain('docGuid');
    });
  });

  describe('authorization', () => {
    test('returns error with connectUrl when not connected', async () => {
      const err = new Error('Not connected');
      err.code = 'NOT_CONNECTED';
      googleAuth.getValidToken.mockRejectedValue(err);

      const result = await exportTool.handler({ docGuid: testDocGuid }, agentToken());

      expect(result.code).toBe('NOT_CONNECTED');
      expect(result.connectUrl).toBe('https://squiredocs.com/settings');
      expect(driveApi.createGoogleDoc).not.toHaveBeenCalled();
      expect(agentPresence.getOrCreateSession).not.toHaveBeenCalled();
    });

    test('returns error with connectUrl when token errored', async () => {
      const err = new Error('Revoked');
      err.code = 'TOKEN_ERROR';
      googleAuth.getValidToken.mockRejectedValue(err);

      const result = await exportTool.handler({ docGuid: testDocGuid }, agentToken());
      expect(result.code).toBe('TOKEN_ERROR');
    });
  });

  describe('creating a new Google Doc', () => {
    test('creates a new doc when no link exists', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      agentPresence.getOrCreateSession.mockResolvedValue(buildMockSession('My Export'));
      driveApi.createGoogleDoc.mockResolvedValue({
        id: 'new-gdoc-1',
        name: 'My Export',
        webViewLink: 'https://docs.google.com/document/d/new-gdoc-1',
        modifiedTime: '2026-04-14T12:00:00Z',
      });

      const result = await exportTool.handler({ docGuid: testDocGuid }, agentToken());

      expect(driveApi.createGoogleDoc).toHaveBeenCalledTimes(1);
      expect(driveApi.updateGoogleDoc).not.toHaveBeenCalled();

      // Output structure: title + link + action
      expect(result.title).toBe('My Export');
      expect(result.url).toBe('https://docs.google.com/document/d/new-gdoc-1');
      expect(result.googleDocId).toBe('new-gdoc-1');
      expect(result.squireDocGuid).toBe(testDocGuid);
      expect(result.squireDocUrl).toBe(`https://squiredocs.com/d/${testDocGuid}`);
      expect(result.action).toBe('created');
      expect(result.message).toContain('My Export');
      expect(result.message).toContain('https://docs.google.com/document/d/new-gdoc-1');
    });

    test('uploads HTML derived from the Yjs doc', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      agentPresence.getOrCreateSession.mockResolvedValue(
        buildMockSession('Doc', [
          { type: 'heading', level: 1, text: 'Title' },
          { type: 'paragraph', text: 'Body text' },
        ])
      );
      driveApi.createGoogleDoc.mockResolvedValue({
        id: 'gdoc', name: 'Doc', webViewLink: 'url',
      });

      await exportTool.handler({ docGuid: testDocGuid }, agentToken());

      const [, title, html] = driveApi.createGoogleDoc.mock.calls[0];
      expect(title).toBe('Doc');
      expect(html).toContain('<h1>Title</h1>');
      expect(html).toContain('<p>Body text</p>');
    });

    test('uses title override when provided', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      agentPresence.getOrCreateSession.mockResolvedValue(buildMockSession('Original'));
      driveApi.createGoogleDoc.mockResolvedValue({
        id: 'gdoc', name: 'Overridden', webViewLink: 'url',
      });

      await exportTool.handler(
        { docGuid: testDocGuid, title: 'Overridden' },
        agentToken()
      );

      expect(driveApi.createGoogleDoc).toHaveBeenCalledWith(
        'access-token',
        'Overridden',
        expect.any(String)
      );
    });

    test('upserts a google_doc_link on success', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      agentPresence.getOrCreateSession.mockResolvedValue(buildMockSession());
      driveApi.createGoogleDoc.mockResolvedValue({
        id: 'gdoc-linked',
        name: 'Doc',
        webViewLink: 'https://docs.google.com/d/gdoc-linked',
        modifiedTime: '2026-04-14T12:00:00Z',
      });

      await exportTool.handler({ docGuid: testDocGuid }, agentToken());

      const { rows } = await pool.query(
        `SELECT google_doc_id, google_doc_url, last_export_at, google_modified_time
         FROM google_doc_links WHERE doc_id = $1 AND user_id = $2`,
        [testDocGuid, userId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].google_doc_id).toBe('gdoc-linked');
      expect(rows[0].google_doc_url).toBe('https://docs.google.com/d/gdoc-linked');
      expect(rows[0].last_export_at).not.toBeNull();
    });
  });

  describe('updating an existing Google Doc', () => {
    test('updates when explicit googleDocId is provided', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      agentPresence.getOrCreateSession.mockResolvedValue(buildMockSession());
      driveApi.updateGoogleDoc.mockResolvedValue({
        id: 'existing-gdoc',
        name: 'Existing',
        webViewLink: 'https://docs.google.com/d/existing-gdoc',
        modifiedTime: '2026-04-14T12:00:00Z',
      });

      const result = await exportTool.handler(
        { docGuid: testDocGuid, googleDocId: 'existing-gdoc' },
        agentToken()
      );

      expect(driveApi.updateGoogleDoc).toHaveBeenCalledWith(
        'access-token',
        'existing-gdoc',
        expect.any(String)
      );
      expect(driveApi.createGoogleDoc).not.toHaveBeenCalled();
      expect(result.action).toBe('updated');
      expect(result.message).toContain('Updated Google Doc');
    });

    test('reuses existing link when no explicit ID', async () => {
      // Seed a link
      await pool.query(
        `INSERT INTO google_doc_links (doc_id, google_doc_id, google_doc_url, user_id)
         VALUES ($1, 'previously-linked', 'https://docs.google.com/d/previously-linked', $2)`,
        [testDocGuid, userId]
      );

      googleAuth.getValidToken.mockResolvedValue('access-token');
      agentPresence.getOrCreateSession.mockResolvedValue(buildMockSession());
      driveApi.updateGoogleDoc.mockResolvedValue({
        id: 'previously-linked', name: 'Doc', webViewLink: 'url',
      });

      await exportTool.handler({ docGuid: testDocGuid }, agentToken());

      expect(driveApi.updateGoogleDoc).toHaveBeenCalledWith(
        'access-token',
        'previously-linked',
        expect.any(String)
      );
    });
  });

  describe('conflict detection', () => {
    test('warns when Google Doc was modified externally since last sync', async () => {
      await pool.query(
        `INSERT INTO google_doc_links (doc_id, google_doc_id, user_id, google_modified_time)
         VALUES ($1, 'conflict-gdoc', $2, '2026-04-01T00:00:00Z')`,
        [testDocGuid, userId]
      );

      googleAuth.getValidToken.mockResolvedValue('access-token');
      agentPresence.getOrCreateSession.mockResolvedValue(buildMockSession());
      driveApi.getGoogleDocMetadata.mockResolvedValue({
        id: 'conflict-gdoc',
        modifiedTime: '2026-04-13T00:00:00Z',
      });
      driveApi.updateGoogleDoc.mockResolvedValue({
        id: 'conflict-gdoc', name: 'Doc', webViewLink: 'url',
        modifiedTime: '2026-04-14T00:00:00Z',
      });

      const result = await exportTool.handler(
        { docGuid: testDocGuid, googleDocId: 'conflict-gdoc' },
        agentToken()
      );

      expect(result.warning).toMatch(/modified externally/i);
    });

    test('no warning when our sync time is newer', async () => {
      await pool.query(
        `INSERT INTO google_doc_links (doc_id, google_doc_id, user_id, google_modified_time)
         VALUES ($1, 'fresh-gdoc', $2, '2026-04-14T00:00:00Z')`,
        [testDocGuid, userId]
      );

      googleAuth.getValidToken.mockResolvedValue('access-token');
      agentPresence.getOrCreateSession.mockResolvedValue(buildMockSession());
      driveApi.getGoogleDocMetadata.mockResolvedValue({
        modifiedTime: '2026-04-13T00:00:00Z',
      });
      driveApi.updateGoogleDoc.mockResolvedValue({
        id: 'fresh-gdoc', name: 'x', webViewLink: 'url',
      });

      const result = await exportTool.handler(
        { docGuid: testDocGuid, googleDocId: 'fresh-gdoc' },
        agentToken()
      );

      expect(result.warning).toBeUndefined();
    });

    test('proceeds with export even if metadata check fails', async () => {
      await pool.query(
        `INSERT INTO google_doc_links (doc_id, google_doc_id, user_id, google_modified_time)
         VALUES ($1, 'meta-fail-gdoc', $2, '2026-04-01T00:00:00Z')`,
        [testDocGuid, userId]
      );

      googleAuth.getValidToken.mockResolvedValue('access-token');
      agentPresence.getOrCreateSession.mockResolvedValue(buildMockSession());
      driveApi.getGoogleDocMetadata.mockRejectedValue(new Error('Network blip'));
      driveApi.updateGoogleDoc.mockResolvedValue({
        id: 'meta-fail-gdoc', name: 'x', webViewLink: 'url',
      });

      const result = await exportTool.handler(
        { docGuid: testDocGuid, googleDocId: 'meta-fail-gdoc' },
        agentToken()
      );

      expect(result.warning).toBeUndefined();
      expect(driveApi.updateGoogleDoc).toHaveBeenCalled();
    });
  });
});
