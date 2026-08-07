/**
 * Document sharing — ONE behavior, for humans and for agents (feature 053,
 * FR-029 / RBD-053-5).
 *
 * Extracted verbatim in behavior from the body of `POST /api/docs/:docId/share`
 * in `server/index.js`, and now called by both that route and the MCP
 * `share_document` tool. Before this existed the tool had its own SQL and had
 * drifted in four ways: owner-only, no pending invites, no email, and a bare
 * INSERT with no conflict clause. Re-implementing those four inside the tool
 * would have produced a second sharing implementation that drifts again on the
 * next change; extracting the one that already worked produces exactly one.
 *
 * This is also where `granted_by` is stamped for the human sharing paths (D8),
 * where the per-user `email_enabled` gate is read FRESH so an admin toggle takes
 * effect immediately, and where "a viewer may only grant viewer" lives (D6).
 *
 * Returns `{ status, body }` rather than touching `res`, so the same function
 * serves an Express route and an MCP tool with no HTTP types in either.
 */

const documents = require('./documents');
const users = require('./auth/users');
const { sendShareInvite, sendShareNotification } = require('./email');

/**
 * Share a document with an email address.
 *
 * Ordered exactly as the original route, so every status code and message is
 * preserved byte-for-byte:
 *   1. missing email                      → 400
 *   2. invalid role / 'owner'             → 400  (the document owner role stays
 *                                                 ungrantable; only the SPACE
 *                                                 owner role is grantable)
 *   3. actor has no access                → 403  (access is now the EFFECTIVE
 *                                                 role, so a space editor may
 *                                                 share a space document)
 *   4. viewer granting above viewer       → 403
 *   5. unknown address                    → 201 pending invite
 *   6. self-share                         → 400
 *   7. target is the owner                → 400
 *   8. otherwise                          → 201 share
 *
 * @param {object} opts
 * @param {{userId: string, email?: string, name?: string}} opts.actor - the
 *   acting principal: `req.user` for REST, the token's owner for MCP
 * @param {string} opts.docId
 * @param {string} opts.email - recipient address
 * @param {string} [opts.role='editor']
 * @param {string} opts.baseUrl - origin used to build the document link
 * @returns {Promise<{status: number, body: object}>}
 */
async function shareDocumentByEmail({ actor, docId, email, role = 'editor', baseUrl }) {
  if (!email) {
    return { status: 400, body: { error: 'email is required' } };
  }

  if (!documents.ROLES[role] || role === 'owner') {
    return { status: 400, body: { error: 'Invalid role. Use "editor" or "viewer"' } };
  }

  const actorRole = await documents.getRole(docId, actor.userId);
  if (!actorRole) {
    return { status: 403, body: { error: 'You do not have access to this document' } };
  }

  // Viewers can only add other viewers (D6 — thresholds unchanged by spaces).
  if (actorRole === 'viewer' && role !== 'viewer') {
    return { status: 403, body: { error: 'Viewers can only share with viewer access' } };
  }

  const doc = await documents.getDocument(docId);
  const docUrl = `${baseUrl}/d/${docId}`;

  // Outbound share email is gated per-user (off by default during beta).
  // Read the flag fresh from the DB so an admin toggle takes effect immediately.
  const inviter = await users.findById(actor.userId);
  const canEmail = !!inviter?.email_enabled;
  const inviterName = actor.name || inviter?.name;
  const inviterEmail = actor.email || inviter?.email;

  const targetUser = await documents.findUserByEmail(email);

  // Not a registered user yet — create a pending invite and email them.
  if (!targetUser) {
    if (inviterEmail && inviterEmail.toLowerCase() === email.toLowerCase()) {
      return { status: 400, body: { error: 'Cannot share with yourself' } };
    }

    await documents.createInvite(docId, email, role, actor.userId);

    // Awaited so the send completes before we respond — otherwise an in-flight
    // send is silently dropped if the pod is shutting down (e.g. mid-deploy).
    // sendEmail never throws, so this can't fail the request. Suppressed when
    // the inviter isn't trusted; the invite is still recorded.
    if (canEmail) {
      await sendShareInvite({
        to: email,
        docTitle: doc?.title,
        inviterName,
        docUrl,
        replyTo: inviterEmail,
      });
    }

    return { status: 201, body: { invite: { email, role, pending: true } } };
  }

  if (targetUser.id === actor.userId) {
    return { status: 400, body: { error: 'Cannot share with yourself' } };
  }

  const targetRole = await documents.getRole(docId, targetUser.id);
  if (targetRole === 'owner') {
    return { status: 400, body: { error: "Cannot change owner's role" } };
  }

  // D8: the acting user is the grantor. A role change IS a new grant.
  const share = await documents.setRole(docId, targetUser.id, role, actor.userId);

  if (canEmail) {
    await sendShareNotification({
      to: targetUser.email,
      docTitle: doc?.title,
      inviterName,
      docUrl,
      replyTo: inviterEmail,
    });
  }

  return {
    status: 201,
    body: {
      user: {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        picture: targetUser.picture,
        role: share.role,
      },
    },
  };
}

module.exports = { shareDocumentByEmail };
