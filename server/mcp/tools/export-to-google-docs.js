/**
 * export_to_google_docs MCP Tool
 *
 * Exports a Squire document to Google Docs. Creates a new Google Doc
 * or updates an existing linked one. The document is serialized to HTML
 * and uploaded via the Google Drive API.
 */
const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { toHTML } = require('../yjs/html-serialization');
const { getValidToken } = require('../../google-docs/google-auth');
const {
  createGoogleDoc,
  updateGoogleDoc,
  getGoogleDocMetadata,
} = require('../../google-docs/drive-api');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'export_to_google_docs';

const description = `Export a Squire document to Google Docs.

Creates a new Google Doc or updates an existing one. The document content
is converted to HTML and uploaded to Google Drive, where Google auto-converts
it to native Docs format.

If googleDocId is provided, the existing Google Doc is overwritten.
If omitted, a new Google Doc is created.

The link between the Squire doc and Google Doc is stored persistently,
so future exports can target the same Google Doc without re-specifying the ID.

Requires the user to have connected their Google Drive in Settings.

PARAMETERS:
- docGuid (required): the Squire document UUID to export
- title: title for the Google Doc (defaults to Squire doc title)
- googleDocId: existing Google Doc ID to update (omit to create new)

RETURNS:
- title: the doc's title
- url: link to the Google Doc (use this when reporting success to the user)
- googleDocId: the Google Doc ID
- squireDocGuid / squireDocUrl: the source Squire doc
- action: "created" or "updated"
- warning: present if the Google Doc was modified externally since last sync

When reporting success to the user, include the title as a link to the url.`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The Squire document UUID to export',
    },
    title: {
      type: 'string',
      description: 'Title for the Google Doc (defaults to the Squire doc title)',
    },
    googleDocId: {
      type: 'string',
      description:
        'Existing Google Doc ID to update. Omit to create a new Google Doc. ' +
        'If this doc was previously exported, the linked Google Doc ID is used automatically.',
    },
  },
  required: ['docGuid'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('export_to_google_docs tool not initialized');

  const { docGuid, title: titleOverride, googleDocId: explicitGoogleDocId } = args;
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

  // Get the Squire doc session
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Get the doc title
  const meta = ydoc.getMap('meta');
  const docTitle = titleOverride || meta.get('title') || 'Untitled';

  // Convert to HTML
  const html = toHTML(xmlFragment);

  // Check for an existing link if no explicit Google Doc ID
  let googleDocId = explicitGoogleDocId;
  if (!googleDocId) {
    const { rows } = await pool.query(
      `SELECT google_doc_id FROM google_doc_links
       WHERE doc_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [docGuid, userId]
    );
    if (rows.length > 0) {
      googleDocId = rows[0].google_doc_id;
    }
  }

  // Conflict detection: if updating an existing linked doc, check if it was
  // modified externally since our last sync
  let conflictWarning = null;
  if (googleDocId) {
    const { rows: linkRows } = await pool.query(
      `SELECT google_modified_time FROM google_doc_links
       WHERE doc_id = $1 AND google_doc_id = $2 AND user_id = $3`,
      [docGuid, googleDocId, userId]
    );
    if (linkRows.length > 0 && linkRows[0].google_modified_time) {
      try {
        const current = await getGoogleDocMetadata(accessToken, googleDocId);
        if (
          current.modifiedTime &&
          new Date(current.modifiedTime) > new Date(linkRows[0].google_modified_time)
        ) {
          conflictWarning =
            'The Google Doc was modified externally since the last sync. ' +
            'This export will overwrite those changes.';
        }
      } catch (e) {
        // Non-fatal: proceed with export even if metadata check fails
      }
    }
  }

  let result;
  if (googleDocId) {
    // Update existing Google Doc
    result = await updateGoogleDoc(accessToken, googleDocId, html);
  } else {
    // Create new Google Doc
    result = await createGoogleDoc(accessToken, docTitle, html);
  }

  // Upsert the link
  await pool.query(
    `INSERT INTO google_doc_links (doc_id, google_doc_id, google_doc_url, user_id, last_export_at, google_modified_time)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (doc_id, google_doc_id) DO UPDATE SET
       google_doc_url = EXCLUDED.google_doc_url,
       last_export_at = now(),
       google_modified_time = EXCLUDED.google_modified_time`,
    [docGuid, result.id, result.webViewLink, userId, result.modifiedTime || null]
  );

  const finalTitle = result.name || docTitle;
  const response = {
    title: finalTitle,
    url: result.webViewLink,
    googleDocId: result.id,
    squireDocGuid: docGuid,
    squireDocUrl: `${baseUrl}/d/${docGuid}`,
    action: googleDocId ? 'updated' : 'created',
    linked: true,
    message: googleDocId
      ? `Updated Google Doc "${finalTitle}" — ${result.webViewLink}`
      : `Created Google Doc "${finalTitle}" — ${result.webViewLink}`,
  };

  if (conflictWarning) {
    response.warning = conflictWarning;
  }

  return response;
}

module.exports = { init, name, description, inputSchema, handler };
