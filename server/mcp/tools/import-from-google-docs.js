/**
 * import_from_google_docs MCP Tool
 *
 * Imports a Google Doc into Squire. Creates a new Squire document or
 * updates an existing one. The Google Doc is exported as HTML, parsed
 * into a Yjs document, and persisted.
 *
 * After import, the document can be edited with read_document and modify
 * just like any other Squire doc.
 */
const Y = require('yjs');
const { randomUUID } = require('crypto');
const documentService = require('../../document-service');
const { fromHTML } = require('../yjs/html-serialization');
const { countBlocks } = require('../yjs/serialization');
const { getValidToken } = require('../../google-docs/google-auth');
const {
  exportGoogleDoc,
  getGoogleDocMetadata,
} = require('../../google-docs/drive-api');

let persistenceProvider = null;
let documents = null;

function init(persistence) {
  persistenceProvider = persistence;
  documents = require('../../documents');
}

const name = 'import_from_google_docs';

const description = `Import a Google Doc into Squire.

Fetches the Google Doc content and creates a new Squire document (or updates
an existing one). After import, you can read and modify the document using
the standard read_document and modify tools.

Provide a googleDocId (from list_google_docs or a Google Docs URL).
Optionally provide a docGuid to import into an existing Squire document
(this replaces its content).

Requires the user to have connected their Google Drive in Settings.

PARAMETERS:
- googleDocId (required): Google Doc ID to import
- docGuid: existing Squire doc to import into (replaces content); omit to create new
- title: title for the new Squire doc (defaults to the Google Doc title)

RETURNS:
- title: the doc's title
- url: link to the Squire document (use this when reporting success to the user)
- docGuid: the Squire document UUID (usable with read_document, modify)
- googleDocId / googleDocUrl: the source Google Doc
- action: "created" or "updated"
- blockCount: number of blocks imported

When reporting success to the user, include the title as a link to the url.`;

const inputSchema = {
  type: 'object',
  properties: {
    googleDocId: {
      type: 'string',
      description:
        'Google Doc ID to import. Found in Google Docs URLs or from list_google_docs results.',
    },
    docGuid: {
      type: 'string',
      format: 'uuid',
      description:
        'Existing Squire document to import into (replaces content). ' +
        'Omit to create a new document.',
    },
    title: {
      type: 'string',
      description: 'Title for the new Squire document (defaults to the Google Doc title)',
    },
  },
  required: ['googleDocId'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider || !documents)
    throw new Error('import_from_google_docs tool not initialized');

  const { googleDocId, docGuid: existingDocGuid, title: titleOverride } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();
  const baseUrl = agentToken.baseUrl || '';

  // Get a valid Google access token
  let accessToken;
  try {
    accessToken = await getValidToken(pool, userId);
  } catch (e) {
    if (e.code === 'NOT_CONNECTED' || e.code === 'TOKEN_ERROR' || e.code === 'EXPIRED') {
      return {
        error: e.message,
        connectUrl: `${baseUrl}/settings`,
        code: e.code,
      };
    }
    throw e;
  }

  // Fetch Google Doc metadata and content
  const [metadata, htmlContent] = await Promise.all([
    getGoogleDocMetadata(accessToken, googleDocId),
    exportGoogleDoc(accessToken, googleDocId),
  ]);

  const docTitle = titleOverride || metadata.name || 'Imported Document';

  let docGuid;
  let blockCount = 0;

  if (existingDocGuid) {
    // Import into existing Squire document (replaces content)
    docGuid = existingDocGuid;
    await documentService.updateDocument(
      docGuid,
      (ydoc) => {
        const xmlFragment = ydoc.get('default', Y.XmlFragment);
        // Clear existing content
        while (xmlFragment.length > 0) {
          xmlFragment.delete(0);
        }
        // Import HTML into the fragment
        fromHTML(htmlContent, xmlFragment);
        blockCount = xmlFragment.length;

        // Update title
        const meta = ydoc.getMap('meta');
        meta.set('title', docTitle);
      },
      { userId, agentName: agentToken.agentName }
    );

    // Update title in DB
    await pool.query('UPDATE documents SET title = $1 WHERE id = $2', [docTitle, docGuid]);
  } else {
    // Create a new Squire document
    docGuid = randomUUID();
    await documents.createDocument(docGuid, userId);
    await pool.query('UPDATE documents SET title = $1 WHERE id = $2', [docTitle, docGuid]);

    await documentService.updateDocument(
      docGuid,
      (ydoc) => {
        const xmlFragment = ydoc.get('default', Y.XmlFragment);
        fromHTML(htmlContent, xmlFragment);
        blockCount = xmlFragment.length;

        const meta = ydoc.getMap('meta');
        meta.set('title', docTitle);
      },
      { userId, agentName: agentToken.agentName }
    );
  }

  // Upsert the link
  await pool.query(
    `INSERT INTO google_doc_links (doc_id, google_doc_id, google_doc_url, user_id, last_import_at, google_modified_time)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (doc_id, google_doc_id) DO UPDATE SET
       google_doc_url = EXCLUDED.google_doc_url,
       last_import_at = now(),
       google_modified_time = EXCLUDED.google_modified_time`,
    [docGuid, googleDocId, metadata.webViewLink, userId, metadata.modifiedTime || null]
  );

  const squireUrl = `${baseUrl}/d/${docGuid}`;
  return {
    title: docTitle,
    url: squireUrl,
    docGuid,
    googleDocId,
    googleDocUrl: metadata.webViewLink,
    action: existingDocGuid ? 'updated' : 'created',
    blockCount,
    message: existingDocGuid
      ? `Imported Google Doc "${docTitle}" into existing Squire document — ${squireUrl}`
      : `Imported Google Doc "${docTitle}" as new Squire document — ${squireUrl}`,
  };
}

module.exports = { init, name, description, inputSchema, handler };
