/**
 * Tests for list_google_docs MCP tool.
 *
 * Mocks drive-api and google-auth, exercises the handler with a real DB
 * to verify link cross-referencing and error handling.
 */
const { createPool, createTestUser, cleanupTestUser } = require('../../../__tests__/helpers/db');

// Mock Drive API and Google Auth
jest.mock('../../../google-docs/drive-api', () => ({
  listGoogleDocs: jest.fn(),
}));
jest.mock('../../../google-docs/google-auth', () => ({
  getValidToken: jest.fn(),
}));

const driveApi = require('../../../google-docs/drive-api');
const googleAuth = require('../../../google-docs/google-auth');
const listGoogleDocs = require('../../tools/list-google-docs');

const pool = createPool();

describe('list_google_docs tool', () => {
  let userId;
  let testDocId;

  beforeAll(async () => {
    userId = await createTestUser(pool, `list-gdoc-test-${Date.now()}@example.com`);

    // Create a Squire document for link testing
    const docResult = await pool.query(
      `INSERT INTO documents (id, creator_id) VALUES (uuid_generate_v4(), $1) RETURNING id`,
      [userId]
    );
    testDocId = docResult.rows[0].id;

    listGoogleDocs.init({ getPool: () => pool });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM google_doc_links WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM documents WHERE id = $1', [testDocId]);
    await cleanupTestUser(pool, userId);
    await pool.end();
  });

  beforeEach(async () => {
    driveApi.listGoogleDocs.mockReset();
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
      expect(listGoogleDocs.name).toBe('list_google_docs');
      expect(listGoogleDocs.description).toBeDefined();
      expect(listGoogleDocs.inputSchema.type).toBe('object');
    });

    test('query and limit are optional', () => {
      expect(listGoogleDocs.inputSchema.required).toBeUndefined();
    });
  });

  describe('handler', () => {
    test('returns error with connectUrl when not connected', async () => {
      const err = new Error('Google Drive is not connected. Connect in Settings.');
      err.code = 'NOT_CONNECTED';
      googleAuth.getValidToken.mockRejectedValue(err);

      const result = await listGoogleDocs.handler({}, agentToken());

      expect(result.error).toMatch(/not connected/i);
      expect(result.code).toBe('NOT_CONNECTED');
      expect(result.connectUrl).toBe('https://squiredocs.com/settings');
      expect(driveApi.listGoogleDocs).not.toHaveBeenCalled();
    });

    test('returns error with connectUrl when token has error status', async () => {
      const err = new Error('Access revoked');
      err.code = 'TOKEN_ERROR';
      googleAuth.getValidToken.mockRejectedValue(err);

      const result = await listGoogleDocs.handler({}, agentToken());

      expect(result.code).toBe('TOKEN_ERROR');
      expect(result.connectUrl).toBe('https://squiredocs.com/settings');
    });

    test('lists Google Docs with parallel-to-Squire field names', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.listGoogleDocs.mockResolvedValue({
        files: [
          {
            id: 'gdoc-1',
            name: 'First Doc',
            modifiedTime: '2026-04-14T10:00:00Z',
            webViewLink: 'https://docs.google.com/document/d/gdoc-1',
          },
          {
            id: 'gdoc-2',
            name: 'Second Doc',
            modifiedTime: '2026-04-13T10:00:00Z',
            webViewLink: 'https://docs.google.com/document/d/gdoc-2',
          },
        ],
      });

      const result = await listGoogleDocs.handler({}, agentToken());

      expect(result.documents).toHaveLength(2);
      // Verify parallel-to-Squire field names (id, title, url, updatedAt)
      expect(result.documents[0]).toMatchObject({
        id: 'gdoc-1',
        title: 'First Doc',
        url: 'https://docs.google.com/document/d/gdoc-1',
        updatedAt: '2026-04-14T10:00:00Z',
        linkedSquireDocGuid: null,
      });
      expect(result.message).toContain('Found 2 Google Docs');
    });

    test('includes human-readable summary with title and link per doc', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.listGoogleDocs.mockResolvedValue({
        files: [
          { id: 'gdoc-1', name: 'Alpha', webViewLink: 'https://docs.google.com/d/gdoc-1' },
          { id: 'gdoc-2', name: 'Beta', webViewLink: 'https://docs.google.com/d/gdoc-2' },
        ],
      });

      const result = await listGoogleDocs.handler({}, agentToken());

      expect(result.summary).toContain('Alpha');
      expect(result.summary).toContain('https://docs.google.com/d/gdoc-1');
      expect(result.summary).toContain('Beta');
      expect(result.summary).toContain('https://docs.google.com/d/gdoc-2');
    });

    test('annotates linked documents with Squire doc info', async () => {
      // Create a link between testDocId and gdoc-linked
      await pool.query(
        `INSERT INTO google_doc_links (doc_id, google_doc_id, user_id)
         VALUES ($1, 'gdoc-linked', $2)`,
        [testDocId, userId]
      );

      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.listGoogleDocs.mockResolvedValue({
        files: [
          {
            id: 'gdoc-linked',
            name: 'Linked Doc',
            webViewLink: 'https://docs.google.com/d/gdoc-linked',
          },
          {
            id: 'gdoc-unlinked',
            name: 'Unlinked Doc',
            webViewLink: 'https://docs.google.com/d/gdoc-unlinked',
          },
        ],
      });

      const result = await listGoogleDocs.handler({}, agentToken());

      const linked = result.documents.find((d) => d.id === 'gdoc-linked');
      const unlinked = result.documents.find((d) => d.id === 'gdoc-unlinked');

      expect(linked.linkedSquireDocGuid).toBe(testDocId);
      expect(linked.linkedSquireDocUrl).toBe(`https://squiredocs.com/d/${testDocId}`);
      expect(unlinked.linkedSquireDocGuid).toBeNull();

      // Summary should indicate linked state
      expect(result.summary).toContain('Linked Doc [linked to Squire]');
    });

    test('returns empty list when no matching docs', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.listGoogleDocs.mockResolvedValue({ files: [] });

      const result = await listGoogleDocs.handler({ query: 'nonexistent' }, agentToken());

      expect(result.documents).toEqual([]);
      expect(result.message).toMatch(/No Google Docs found matching "nonexistent"/);
    });

    test('passes query and limit to drive-api', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.listGoogleDocs.mockResolvedValue({ files: [] });

      await listGoogleDocs.handler({ query: 'project report', limit: 5 }, agentToken());

      expect(driveApi.listGoogleDocs).toHaveBeenCalledWith(
        'access-token',
        'project report',
        5
      );
    });

    test('returns pagination with nextPageToken and hasMore', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.listGoogleDocs.mockResolvedValue({
        files: [{ id: '1', name: 'A', webViewLink: 'url' }],
        nextPageToken: 'next-page',
      });

      const result = await listGoogleDocs.handler({}, agentToken());
      expect(result.pagination.nextPageToken).toBe('next-page');
      expect(result.pagination.hasMore).toBe(true);
    });

    test('pagination.hasMore is false when no next page', async () => {
      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.listGoogleDocs.mockResolvedValue({
        files: [{ id: '1', name: 'A', webViewLink: 'url' }],
      });

      const result = await listGoogleDocs.handler({}, agentToken());
      expect(result.pagination.hasMore).toBe(false);
    });

    test('only cross-references links owned by the current user', async () => {
      // Create a link owned by a different user
      const otherUserId = await createTestUser(pool, `other-user-${Date.now()}@example.com`);
      const otherDocResult = await pool.query(
        `INSERT INTO documents (id, creator_id) VALUES (uuid_generate_v4(), $1) RETURNING id`,
        [otherUserId]
      );
      const otherDocId = otherDocResult.rows[0].id;
      await pool.query(
        `INSERT INTO google_doc_links (doc_id, google_doc_id, user_id)
         VALUES ($1, 'gdoc-shared-id', $2)`,
        [otherDocId, otherUserId]
      );

      googleAuth.getValidToken.mockResolvedValue('access-token');
      driveApi.listGoogleDocs.mockResolvedValue({
        files: [{ id: 'gdoc-shared-id', name: 'Shared', webViewLink: 'url' }],
      });

      const result = await listGoogleDocs.handler({}, agentToken());

      // The calling user hasn't linked this doc — should show as unlinked
      expect(result.documents[0].id).toBe('gdoc-shared-id');
      expect(result.documents[0].linkedSquireDocGuid).toBeNull();

      // Cleanup
      await pool.query('DELETE FROM google_doc_links WHERE user_id = $1', [otherUserId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [otherDocId]);
      await cleanupTestUser(pool, otherUserId);
    });
  });
});
