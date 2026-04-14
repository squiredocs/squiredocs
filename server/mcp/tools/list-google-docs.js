/**
 * list_google_docs MCP Tool
 *
 * Lists Google Docs accessible to the user. Optionally searches by name.
 * Cross-references with google_doc_links to indicate which docs are
 * already linked to Squire documents.
 */
const { getValidToken } = require('../../google-docs/google-auth');
const { listGoogleDocs } = require('../../google-docs/drive-api');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'list_google_docs';

const description = `List or search Google Docs accessible to the user.

Returns Google Docs from the user's Drive, ordered by most recently modified.
Optionally filter by name with a search query.

Each result indicates whether it's already linked to a Squire document.

Requires the user to have connected their Google Drive in Settings.

PARAMETERS:
- query: optional name-based search query
- limit: 1-50, default 20

RETURNS:
- documents: Array of { id, title, url, updatedAt, linkedSquireDocGuid, linkedSquireDocUrl }
  - id: the Google Doc ID (use with import_from_google_docs or export_to_google_docs)
  - url: direct link to open the doc in Google Docs
  - linkedSquireDocGuid: present if already imported/exported to Squire
- summary: human-readable multi-line list (one entry per doc, title + url)
- pagination: { nextPageToken, hasMore }

When presenting results to the user, include each doc's title as a link to its URL.`;

const inputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search query to filter Google Docs by name',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 20,
      description: 'Maximum number of results (default 20, max 50)',
    },
  },
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('list_google_docs tool not initialized');

  const { query, limit = 20 } = args;
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

  // Fetch from Google Drive
  const result = await listGoogleDocs(accessToken, query, limit);
  const files = result.files || [];

  if (files.length === 0) {
    return {
      documents: [],
      message: query
        ? `No Google Docs found matching "${query}"`
        : 'No Google Docs found',
    };
  }

  // Cross-reference with existing links
  const googleDocIds = files.map((f) => f.id);
  const { rows: links } = await pool.query(
    `SELECT google_doc_id, doc_id FROM google_doc_links
     WHERE user_id = $1 AND google_doc_id = ANY($2)`,
    [userId, googleDocIds]
  );

  const linkMap = new Map(links.map((l) => [l.google_doc_id, l.doc_id]));

  const documents = files.map((f) => {
    const linkedDocGuid = linkMap.get(f.id);
    return {
      // Primary fields — parallel to Squire list_documents output
      id: f.id,
      title: f.name,
      url: f.webViewLink,
      updatedAt: f.modifiedTime,
      // Squire linking info
      linkedSquireDocGuid: linkedDocGuid || null,
      linkedSquireDocUrl: linkedDocGuid ? `${baseUrl}/d/${linkedDocGuid}` : null,
    };
  });

  // Build a readable summary listing each doc with its title and link
  const summary = documents
    .map((d) => {
      const linkedNote = d.linkedSquireDocGuid ? ' [linked to Squire]' : '';
      return `- ${d.title}${linkedNote} — ${d.url}`;
    })
    .join('\n');

  return {
    documents,
    summary,
    pagination: {
      nextPageToken: result.nextPageToken || null,
      hasMore: Boolean(result.nextPageToken),
    },
    message: `Found ${documents.length} Google Doc${documents.length === 1 ? '' : 's'}${query ? ` matching "${query}"` : ''}`,
  };
}

module.exports = { init, name, description, inputSchema, handler };
