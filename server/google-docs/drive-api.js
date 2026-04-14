/**
 * Google Drive API service
 *
 * Wraps the Google Drive REST API for Google Docs operations.
 * Uses undici (built into Node 22) for HTTP calls rather than the
 * heavyweight googleapis SDK.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TIMEOUT_MS = 10_000;

/**
 * Make an authenticated request to the Google API.
 * @param {string} url
 * @param {object} opts - fetch options
 * @param {string} accessToken
 * @returns {Promise<Response>}
 */
async function googleFetch(url, opts, accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...opts.headers,
  };

  const response = await fetch(url, {
    ...opts,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  return response;
}

/**
 * Handle error responses from the Google API.
 * @param {Response} response
 * @param {string} operation - description of the operation for error messages
 * @throws {Error} With code property set for known error types
 */
async function handleError(response, operation) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = { error: { message: `HTTP ${response.status}` } };
  }

  const message = body?.error?.message || `HTTP ${response.status}`;
  const err = new Error(`Google Drive API error (${operation}): ${message}`);

  if (response.status === 401) {
    err.code = 'UNAUTHORIZED';
  } else if (response.status === 403) {
    err.code = 'FORBIDDEN';
  } else if (response.status === 404) {
    err.code = 'NOT_FOUND';
  } else {
    err.code = 'API_ERROR';
  }

  err.status = response.status;
  throw err;
}

/**
 * Create a new Google Doc from HTML content.
 * Google auto-converts the HTML to native Docs format.
 *
 * @param {string} accessToken
 * @param {string} title - Document title
 * @param {string} htmlContent - HTML content to convert
 * @returns {Promise<{id: string, name: string, webViewLink: string}>}
 */
async function createGoogleDoc(accessToken, title, htmlContent) {
  // Use multipart upload: metadata + HTML body
  const boundary = '------squire_boundary_' + Date.now();
  const metadata = JSON.stringify({
    name: title,
    mimeType: 'application/vnd.google-apps.document',
  });

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
    `${htmlContent}\r\n` +
    `--${boundary}--`;

  const url = `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink,modifiedTime`;
  const response = await googleFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
    accessToken
  );

  if (!response.ok) await handleError(response, 'createGoogleDoc');
  return response.json();
}

/**
 * Update an existing Google Doc with HTML content.
 * This replaces the entire document content.
 *
 * @param {string} accessToken
 * @param {string} googleDocId - ID of the Google Doc to update
 * @param {string} htmlContent - New HTML content
 * @returns {Promise<{id: string, name: string, webViewLink: string, modifiedTime: string}>}
 */
async function updateGoogleDoc(accessToken, googleDocId, htmlContent) {
  const url = `${UPLOAD_API}/files/${encodeURIComponent(googleDocId)}?uploadType=media&fields=id,name,webViewLink,modifiedTime`;
  const response = await googleFetch(
    url,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      body: htmlContent,
    },
    accessToken
  );

  if (!response.ok) await handleError(response, 'updateGoogleDoc');
  return response.json();
}

/**
 * Export a Google Doc as HTML.
 *
 * @param {string} accessToken
 * @param {string} googleDocId - ID of the Google Doc
 * @returns {Promise<string>} HTML content
 */
async function exportGoogleDoc(accessToken, googleDocId) {
  const url = `${DRIVE_API}/files/${encodeURIComponent(googleDocId)}/export?mimeType=text%2Fhtml`;
  const response = await googleFetch(url, { method: 'GET' }, accessToken);

  if (!response.ok) await handleError(response, 'exportGoogleDoc');
  return response.text();
}

/**
 * Get metadata for a Google Doc.
 *
 * @param {string} accessToken
 * @param {string} googleDocId
 * @returns {Promise<{id: string, name: string, modifiedTime: string, webViewLink: string}>}
 */
async function getGoogleDocMetadata(accessToken, googleDocId) {
  const url = `${DRIVE_API}/files/${encodeURIComponent(googleDocId)}?fields=id,name,modifiedTime,webViewLink`;
  const response = await googleFetch(url, { method: 'GET' }, accessToken);

  if (!response.ok) await handleError(response, 'getGoogleDocMetadata');
  return response.json();
}

/**
 * List Google Docs accessible to the user.
 *
 * @param {string} accessToken
 * @param {string} [query] - Optional search query (searches file names)
 * @param {number} [pageSize=20] - Number of results (max 50)
 * @param {string} [pageToken] - Pagination token
 * @returns {Promise<{files: Array, nextPageToken?: string}>}
 */
async function listGoogleDocs(accessToken, query, pageSize = 20, pageToken) {
  const size = Math.min(Math.max(1, pageSize), 50);

  // Build query: always filter to Google Docs, optionally search by name
  let q = "mimeType='application/vnd.google-apps.document' and trashed=false";
  if (query) {
    // Escape single quotes in the query
    const escaped = query.replace(/'/g, "\\'");
    q += ` and name contains '${escaped}'`;
  }

  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,modifiedTime,webViewLink),nextPageToken',
    pageSize: String(size),
    orderBy: 'modifiedTime desc',
  });
  if (pageToken) params.set('pageToken', pageToken);

  const url = `${DRIVE_API}/files?${params}`;
  const response = await googleFetch(url, { method: 'GET' }, accessToken);

  if (!response.ok) await handleError(response, 'listGoogleDocs');
  return response.json();
}

module.exports = {
  createGoogleDoc,
  updateGoogleDoc,
  exportGoogleDoc,
  getGoogleDocMetadata,
  listGoogleDocs,
};
