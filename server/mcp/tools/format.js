/**
 * format MCP Tool
 *
 * Apply or remove formatting to selection.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition, getTextInSelection } = require('../yjs/cursor-operations');
const { applyMarks } = require('../yjs/text-operations');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'format';

const description = `Apply or remove formatting marks to selected text.

Requires an active selection. Use select tool first.

PARAMETERS:
- docGuid: Document UUID (required)
- add: Marks to add (optional): ["bold", "italic", "underline", "strike"]
- remove: Marks to remove (optional)
- link: {href: "url"} to add link, null to remove (optional)

RETURNS:
- success, formattedText, formattedLength`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid' },
    add: { type: 'array', items: { type: 'string', enum: ['bold', 'italic', 'underline', 'strike'] } },
    remove: { type: 'array', items: { type: 'string' } },
    link: { oneOf: [{ type: 'object', properties: { href: { type: 'string' } } }, { type: 'null' }] },
  },
  required: ['docGuid'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('format tool not initialized');

  const { docGuid, add = [], remove = [], link } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  const accessResult = await pool.query(
    `SELECT d.id, ds.role FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  if (accessResult.rows[0].role === 'viewer') {
    throw new Error('Permission denied: viewers cannot edit documents');
  }

  const sessionKey = `${userId}-${docGuid}`;
  const activeSessions = agentPresence.getActiveSessions();

  let session = null;
  for (const [sid, sess] of activeSessions.entries()) {
    if (sess.key === sessionKey) {
      session = sess;
      break;
    }
  }

  if (!session || !session.cursor) {
    throw new Error('No active session found. Use open_document first.');
  }

  const anchorPos = session.cursor.anchor;
  const headPos = session.cursor.head;
  const hasSelection = JSON.stringify(anchorPos) !== JSON.stringify(headPos);

  if (!hasSelection) {
    throw new Error('No selection. Use select tool to create a selection first.');
  }

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  const undoManager = session.undoManager;

  const selectionText = getTextInSelection(xmlFragment, anchorPos, headPos);
  const anchorResolved = resolveCursorPosition(xmlFragment, anchorPos);
  const headResolved = resolveCursorPosition(xmlFragment, headPos);

  const isForward = anchorResolved.blockIndex < headResolved.blockIndex ||
    (anchorResolved.blockIndex === headResolved.blockIndex && anchorResolved.offset < headResolved.offset);

  const startResolved = isForward ? anchorResolved : headResolved;
  const endResolved = isForward ? headResolved : anchorResolved;

  ydoc.transact(() => {
    applyMarks(xmlFragment, startResolved.blockIndex, startResolved.offset,
      endResolved.blockIndex, endResolved.offset, add, remove, link);
  }, undoManager);

  return {
    success: true,
    formattedText: selectionText,
    formattedLength: selectionText.length,
  };
}

module.exports = { init, name, description, inputSchema, handler };
