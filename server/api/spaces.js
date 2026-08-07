/**
 * Spaces REST API (feature 053) — the human surface for shared team workspaces.
 *
 * Ground truth: `design/spaces.md` § REST API; contract:
 * `specs/053-spaces/contracts/spaces-rest-api.md`. Nothing is added beyond
 * what the design specifies. All space *logic* lives in `server/spaces.js`;
 * this file is authorization plus HTTP shape.
 *
 * THE UNIVERSAL RULE (RBD-053-10 / FR-039 / invariant I11): every
 * `/api/spaces/:id*` route answers a NON-MEMBER with **404 "Space not found"**,
 * byte-identical to the answer for an id that does not exist. No 403, no
 * membership oracle. A member who lacks the *role* for an operation gets a 403
 * with a reason — membership is already established there, so distinguishing
 * leaks nothing.
 *
 * `requireAuth` already accepts user JWTs, agent OAuth JWTs and `sk_sqd_` API
 * tokens and enforces documents:read / documents:write for scoped principals,
 * so agent credentials reach these routes as their owner with no token-side
 * change (FR-046).
 *
 * The move route (`PUT /api/docs/:docId/space`) is NOT here: it lives inline in
 * server/index.js beside its sibling /api/docs routes (research R8).
 */
const express = require('express');
const { requireAuth } = require('../auth');
const { notifyException } = require('../exception-notifier');
const { buildBaseUrl } = require('../url');
const spaces = require('../spaces');
const users = require('../auth/users');
const documents = require('../documents');
const { sendSpaceInvite, sendSpaceNotification } = require('../email');

const router = express.Router();
let pool = null;

/**
 * @param {import('pg').Pool} dbPool
 */
function init(dbPool) {
  pool = dbPool;
  // spaces.init is called by server/index.js too; idempotent and harmless, but
  // doing it here keeps the router usable standalone in tests.
  spaces.init(dbPool);
}

/** Consistent 500 handling, matching every other route in the app. */
function fail(res, req, error, message) {
  if (error && typeof error.status === 'number') {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(`[Spaces] ${message}:`, error);
  notifyException(error, { req, source: 'api' });
  return res.status(500).json({ error: message });
}

/**
 * Resolve the caller's membership, or answer 404 and return null.
 * Every :id route starts here — that is what makes the non-member response
 * uniform rather than a rule each handler has to remember.
 * @returns {Promise<string|null>} the caller's role, or null if already answered
 */
async function requireMembership(req, res) {
  // A malformed id is a space that does not exist, and I11 says that is a 404.
  // Without this the id reaches a uuid column, Postgres raises 22P02, and the
  // caller gets a 500 plus an exception notification (post-merge review L1).
  if (!documents.isUuid(req.params.id)) {
    res.status(404).json({ error: 'Space not found' });
    return null;
  }

  const role = await spaces.getMemberRole(req.params.id, req.user.userId);
  if (!role) {
    res.status(404).json({ error: 'Space not found' });
    return null;
  }
  return role;
}

/** Owner-only gate for a caller already known to be a member. */
function requireOwner(role, res) {
  if (role !== 'owner') {
    res.status(403).json({ error: 'Only a space owner can do that' });
    return false;
  }
  return true;
}

/**
 * POST / — create a space. Any authenticated user; no caps (RBD-053-6).
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const space = await spaces.createSpace(req.body?.name, req.user.userId);
    res.status(201).json({ space });
  } catch (error) {
    fail(res, req, error, 'Failed to create space');
  }
});

/**
 * GET / — the caller's spaces. Membership-scoped by construction.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    res.json({ spaces: await spaces.getSpacesForUser(req.user.userId) });
  } catch (error) {
    fail(res, req, error, 'Failed to list spaces');
  }
});

/**
 * GET /:id — detail: the space, its members, its pending invites and its
 * document count. Any member; non-member 404.
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!(await requireMembership(req, res))) return;
    const detail = await spaces.getSpaceDetail(req.params.id, req.user.userId);
    if (!detail) return res.status(404).json({ error: 'Space not found' });
    res.json(detail);
  } catch (error) {
    fail(res, req, error, 'Failed to load space');
  }
});

/**
 * PATCH /:id — rename. Owner only.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const role = await requireMembership(req, res);
    if (!role) return;
    if (!requireOwner(role, res)) return;
    const space = await spaces.renameSpace(req.params.id, req.body?.name);
    if (!space) return res.status(404).json({ error: 'Space not found' });
    res.json({ space });
  } catch (error) {
    fail(res, req, error, 'Failed to rename space');
  }
});

/**
 * DELETE /:id — delete. Owner only.
 * Members and invites cascade; documents revert to personal and ARE NOT
 * DELETED (FR-024). The response carries the count the confirm dialog states.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const role = await requireMembership(req, res);
    if (!role) return;
    if (!requireOwner(role, res)) return;
    const { deleted, documentsReverted } = await spaces.deleteSpace(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Space not found' });
    res.json({ deleted: true, documentsReverted });
  } catch (error) {
    fail(res, req, error, 'Failed to delete space');
  }
});

/**
 * POST /:id/members — invite by email.
 *
 * Any member may invite, at MOST their own role (FR-008/FR-009) — which is what
 * makes `owner` grantable only by an owner. Existing account → immediate
 * membership; unknown address → a pending invite converted at first login.
 *
 * Mail is gated on the INVITER'S `email_enabled`, read fresh so an admin toggle
 * takes effect immediately — and the membership or invite is granted whether or
 * not mail is sent (FR-021).
 */
router.post('/:id/members', requireAuth, async (req, res) => {
  try {
    const callerRole = await requireMembership(req, res);
    if (!callerRole) return;

    const { email, role = 'viewer' } = req.body || {};
    spaces.validateRole(role); // throws SpaceError(400), mapped by fail()
    if (documents.ROLES[role] > documents.ROLES[callerRole]) {
      return res.status(403).json({ error: 'You cannot grant a role above your own' });
    }

    const result = await spaces.inviteMember(req.params.id, email, role, req.user.userId);

    const space = await spaces.getSpace(req.params.id);
    const inviter = await users.findById(req.user.userId);
    const canEmail = !!inviter?.email_enabled;
    if (canEmail && result.raised) {
      const spaceUrl = `${buildBaseUrl(req)}/space/${req.params.id}`;
      const send = result.kind === 'invite' ? sendSpaceInvite : sendSpaceNotification;
      // Awaited for the same reason document sharing awaits: an in-flight send
      // is dropped if the pod is shutting down mid-deploy. sendEmail never
      // throws, so this cannot fail the request.
      await send({
        to: result.kind === 'invite' ? result.invite.email : result.member.email,
        spaceName: space?.name,
        inviterName: req.user.name || inviter?.name,
        spaceUrl,
        replyTo: req.user.email || inviter?.email,
      });
    }

    res.status(201).json(
      result.kind === 'invite' ? { invite: result.invite } : { member: result.member }
    );
  } catch (error) {
    fail(res, req, error, 'Failed to invite to space');
  }
});

/**
 * PUT /:id/members/:userId — change a member's role. Owner only.
 * Demoting the last owner → 409 with the shared guidance (FR-010).
 */
router.put('/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    const role = await requireMembership(req, res);
    if (!role) return;
    if (!requireOwner(role, res)) return;
    const member = await spaces.setMemberRole(
      req.params.id,
      req.params.userId,
      req.body?.role,
      req.user.userId
    );
    res.json({ member });
  } catch (error) {
    fail(res, req, error, 'Failed to change member role');
  }
});

/**
 * DELETE /:id/members/:userId — remove a member, or leave.
 *
 * `:userId === caller` is LEAVING and any member may do it; removing anyone
 * else is owner-only. Either way the last owner is refused (FR-010). Only the
 * membership row goes: the member's direct shares survive (FR-022).
 */
router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    const role = await requireMembership(req, res);
    if (!role) return;
    const leaving = req.params.userId === req.user.userId;
    if (!leaving && !requireOwner(role, res)) return;
    const removed = await spaces.removeMember(req.params.id, req.params.userId);
    if (!removed) return res.status(404).json({ error: 'Member not found' });
    res.json({ removed: true });
  } catch (error) {
    fail(res, req, error, 'Failed to remove member');
  }
});

/**
 * DELETE /:id/invites — revoke a pending invite. Owner only (RBD-053-4).
 * Idempotent: revoking an invite that is not there still succeeds.
 */
router.delete('/:id/invites', requireAuth, async (req, res) => {
  try {
    const role = await requireMembership(req, res);
    if (!role) return;
    if (!requireOwner(role, res)) return;
    if (!req.body?.email) return res.status(400).json({ error: 'email is required' });
    await spaces.revokeInvite(req.params.id, req.body.email);
    res.json({ revoked: true });
  } catch (error) {
    fail(res, req, error, 'Failed to revoke invite');
  }
});

module.exports = { init, router };
