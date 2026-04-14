/**
 * Tests for the Google Drive API service.
 *
 * Mocks global fetch to verify request construction (URLs, methods, headers,
 * multipart bodies) and response handling (including error mapping).
 */
const driveApi = require('../drive-api');

describe('google-docs/drive-api', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /** Build a Response-like object the API service can consume */
  function mockResponse({ ok = true, status = 200, body = {}, text = null } = {}) {
    return {
      ok,
      status,
      json: jest.fn().mockResolvedValue(body),
      text: jest.fn().mockResolvedValue(text !== null ? text : JSON.stringify(body)),
    };
  }

  describe('createGoogleDoc', () => {
    test('sends multipart request with metadata and HTML body', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({
          body: {
            id: 'gdoc-123',
            name: 'Test Doc',
            webViewLink: 'https://docs.google.com/document/d/gdoc-123',
          },
        })
      );

      const result = await driveApi.createGoogleDoc(
        'access-token',
        'Test Doc',
        '<p>Hello</p>'
      );

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = global.fetch.mock.calls[0];

      expect(url).toContain('/upload/drive/v3/files');
      expect(url).toContain('uploadType=multipart');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('Bearer access-token');
      expect(opts.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);

      // Body should contain the metadata JSON, the HTML content, and the boundary
      const body = opts.body;
      expect(body).toContain('"name":"Test Doc"');
      expect(body).toContain('"mimeType":"application/vnd.google-apps.document"');
      expect(body).toContain('<p>Hello</p>');
      expect(body).toContain('Content-Type: text/html');

      expect(result).toEqual({
        id: 'gdoc-123',
        name: 'Test Doc',
        webViewLink: 'https://docs.google.com/document/d/gdoc-123',
      });
    });

    test('throws with code FORBIDDEN on 403', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({
          ok: false,
          status: 403,
          body: { error: { message: 'Insufficient permissions' } },
        })
      );

      await expect(
        driveApi.createGoogleDoc('tok', 'Title', '<p>x</p>')
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
    });

    test('throws with code UNAUTHORIZED on 401', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({
          ok: false,
          status: 401,
          body: { error: { message: 'Invalid credentials' } },
        })
      );

      await expect(
        driveApi.createGoogleDoc('tok', 'Title', '<p>x</p>')
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('updateGoogleDoc', () => {
    test('sends PATCH with media upload and HTML body', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({
          body: {
            id: 'gdoc-abc',
            name: 'Updated',
            webViewLink: 'https://docs.google.com/document/d/gdoc-abc',
            modifiedTime: '2026-04-14T12:00:00Z',
          },
        })
      );

      const result = await driveApi.updateGoogleDoc(
        'access-token',
        'gdoc-abc',
        '<p>New content</p>'
      );

      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toContain('/upload/drive/v3/files/gdoc-abc');
      expect(url).toContain('uploadType=media');
      expect(opts.method).toBe('PATCH');
      expect(opts.headers['Content-Type']).toBe('text/html; charset=UTF-8');
      expect(opts.body).toBe('<p>New content</p>');

      expect(result.id).toBe('gdoc-abc');
      expect(result.modifiedTime).toBe('2026-04-14T12:00:00Z');
    });

    test('URL-encodes the googleDocId', async () => {
      global.fetch.mockResolvedValue(mockResponse({ body: {} }));
      await driveApi.updateGoogleDoc('tok', 'id with spaces', '<p/>');
      const [url] = global.fetch.mock.calls[0];
      expect(url).toContain('id%20with%20spaces');
    });

    test('throws NOT_FOUND on 404', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({ ok: false, status: 404, body: { error: { message: 'File not found' } } })
      );
      await expect(
        driveApi.updateGoogleDoc('tok', 'gone', '<p/>')
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('exportGoogleDoc', () => {
    test('requests export as text/html and returns body text', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({
          text: '<html><body><p>Exported content</p></body></html>',
        })
      );

      const html = await driveApi.exportGoogleDoc('access-token', 'gdoc-xyz');

      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toContain('/files/gdoc-xyz/export');
      expect(url).toContain('mimeType=text%2Fhtml');
      expect(opts.method).toBe('GET');
      expect(opts.headers.Authorization).toBe('Bearer access-token');
      expect(html).toContain('<p>Exported content</p>');
    });
  });

  describe('getGoogleDocMetadata', () => {
    test('requests only the needed fields', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({
          body: {
            id: 'gdoc-x',
            name: 'My Doc',
            modifiedTime: '2026-04-14T00:00:00Z',
            webViewLink: 'https://docs.google.com/document/d/gdoc-x',
          },
        })
      );

      const result = await driveApi.getGoogleDocMetadata('tok', 'gdoc-x');

      const [url] = global.fetch.mock.calls[0];
      expect(url).toContain('/files/gdoc-x');
      expect(url).toContain('fields=id,name,modifiedTime,webViewLink');
      expect(result.name).toBe('My Doc');
    });
  });

  describe('listGoogleDocs', () => {
    // URLSearchParams encodes spaces as '+', so decode replaces '+' → ' ' manually
    const decodeQuery = (url) => decodeURIComponent(url).replace(/\+/g, ' ');

    test('filters to Google Docs and excludes trashed items', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({ body: { files: [{ id: '1', name: 'A' }] } })
      );

      await driveApi.listGoogleDocs('tok');

      const [url] = global.fetch.mock.calls[0];
      const decoded = decodeQuery(url);
      expect(decoded).toContain("mimeType='application/vnd.google-apps.document'");
      expect(decoded).toContain('trashed=false');
    });

    test('adds name filter when query provided', async () => {
      global.fetch.mockResolvedValue(mockResponse({ body: { files: [] } }));

      await driveApi.listGoogleDocs('tok', 'my search');

      const [url] = global.fetch.mock.calls[0];
      expect(decodeQuery(url)).toContain("name contains 'my search'");
    });

    test('escapes single quotes in search query', async () => {
      global.fetch.mockResolvedValue(mockResponse({ body: { files: [] } }));

      await driveApi.listGoogleDocs('tok', "bob's docs");

      const [url] = global.fetch.mock.calls[0];
      // Should not break the query string — quotes must be escaped with backslash
      expect(decodeQuery(url)).toContain("name contains 'bob\\'s docs'");
    });

    test('clamps pageSize between 1 and 50', async () => {
      global.fetch.mockResolvedValue(mockResponse({ body: { files: [] } }));

      await driveApi.listGoogleDocs('tok', null, 500);
      let url = global.fetch.mock.calls[0][0];
      expect(url).toContain('pageSize=50');

      global.fetch.mockClear();
      await driveApi.listGoogleDocs('tok', null, 0);
      url = global.fetch.mock.calls[0][0];
      expect(url).toContain('pageSize=1');
    });

    test('passes through pageToken when provided', async () => {
      global.fetch.mockResolvedValue(mockResponse({ body: { files: [] } }));

      await driveApi.listGoogleDocs('tok', null, 10, 'next-page-xyz');

      const [url] = global.fetch.mock.calls[0];
      expect(url).toContain('pageToken=next-page-xyz');
    });

    test('returns nextPageToken from response', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({
          body: { files: [{ id: '1' }], nextPageToken: 'token-for-next-page' },
        })
      );

      const result = await driveApi.listGoogleDocs('tok');
      expect(result.nextPageToken).toBe('token-for-next-page');
    });
  });

  describe('error response handling', () => {
    test('falls back to HTTP status when error body is not JSON', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: jest.fn().mockRejectedValue(new Error('not json')),
        text: jest.fn().mockResolvedValue('Internal Server Error'),
      });

      await expect(driveApi.getGoogleDocMetadata('tok', 'x')).rejects.toMatchObject({
        code: 'API_ERROR',
        status: 500,
      });
    });

    test('includes Google error message in thrown error', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({
          ok: false,
          status: 400,
          body: { error: { message: 'Invalid field mask' } },
        })
      );

      await expect(driveApi.getGoogleDocMetadata('tok', 'x')).rejects.toThrow(
        /Invalid field mask/
      );
    });
  });
});
