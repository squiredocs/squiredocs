/**
 * share_document MCP Tool
 *
 * Shares a document with another user by email.
 *
 * CONVERGED ON THE HUMAN PATH (feature 053, FR-029 / RBD-053-5). This tool used
 * to carry its own SQL and had drifted from `POST /api/docs/:docId/share` in
 * four ways: it was owner-only, it threw on an unknown email instead of
 * creating a pending invite, it never sent mail, and it wrote a bare INSERT
 * with no conflict clause and no grantor. All four are gone — the tool now
 * calls `shareDocumentByEmail()`, the one sharing behavior, so an agent and its
 * owner get identical results from identical inputs.
 */

const { shareDocumentByEmail } = require('../../share-service');
const users = require('../../auth/users');
const documents = require('../../documents');

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
  // Access derivation now runs through the shared documents module (feature
  // 053), so it must be wired to the same pool — the list_documents tool has
  // done this since it was written.
  if (persistence && persistence.getPool) {
    documents.init(persistence.getPool());
  }
}

/**
 * Tool definition for MCP discovery
 */
const name = 'share_document';

const description =
  'Share a document with another user by email address. Anyone with access to '
  + 'the document can share it, at most at their own level — a viewer can only '
  + 'grant viewer access. If the address has no Squire Docs account yet, a '
  + 'pending invite is created and becomes a real share the first time they '
  + 'sign in. The document owner\'s role cannot be changed. Documents that live '
  + 'in a space are already visible to every member of that space; sharing adds '
  + 'an individual grant on top of that.';

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID to share',
    },
    email: {
      type: 'string',
      format: 'email',
      description: 'Email address of the user to share with',
    },
    role: {
      type: 'string',
      enum: ['editor', 'viewer'],
      default: 'viewer',
      description: 'Permission level: "editor" can edit, "viewer" can only read',
    },
  },
  required: ['docGuid', 'email'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.email - User's email address
 * @param {string} args.role - Role to grant
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { success, message, docGuid, url, sharedWith|invited }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('share_document tool not initialized');

  const { docGuid, email, role = 'viewer' } = args;
  const userId = agentToken.userId;
  const baseUrl = agentToken.baseUrl || '';

  // The acting principal is the TOKEN'S OWNER — that is who the grant is
  // attributed to (`granted_by`), and whose email_enabled decides whether mail
  // goes out. An agent shares as its human, never as itself.
  const owner = await users.findById(userId);
  const actor = { userId, email: owner?.email, name: owner?.name };

  const { status, body } = await shareDocumentByEmail({
    actor,
    docId: docGuid,
    email,
    role,
    baseUrl,
  });

  // The service speaks HTTP; a tool speaks exceptions. Map refusals to the
  // thrown errors MCP clients expect, keeping the service's message verbatim.
  if (status >= 400) {
    throw new Error(body.error);
  }

  if (body.invite) {
    return {
      success: true,
      message: `Invited ${body.invite.email} as ${body.invite.role}. They will get access the first time they sign in.`,
      docGuid,
      url: `${baseUrl}/d/${docGuid}`,
      invited: { email: body.invite.email, role: body.invite.role, pending: true },
    };
  }

  return {
    success: true,
    message: `Shared document with ${body.user.email} as ${body.user.role}`,
    docGuid,
    url: `${baseUrl}/d/${docGuid}`,
    sharedWith: {
      email: body.user.email,
      name: body.user.name,
      role: body.user.role,
    },
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
