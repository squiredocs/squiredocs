/**
 * Onboarding / welcome flow
 *
 * On login, a not-yet-"engaged" user is sent to their own seeded welcome
 * document (with the AI assistant primed to greet them). "Engaged" means the
 * user owns a document — other than their welcome doc — that has content.
 * Once engaged we stamp users.onboarded_at and the flow stops triggering.
 *
 * See migration 1783000000000_add-onboarding-to-users.js for the schema.
 */
const documents = require('./documents');
const documentService = require('./document-service');
const users = require('./auth/users');
const { buildYjsNode } = require('./mcp/yjs/node-builder');
const { WELCOME_DOC_TITLE, WELCOME_DOC_NODES } = require('./onboarding/welcome-template');

// Attribution shown for the seeded content (mirrors the chat assistant author).
const AGENT_NAME = 'Squire Docs Assistant';

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

function ensurePool() {
  if (!pool) throw new Error('Onboarding module not initialized. Call init(pool) first.');
  return pool;
}

/**
 * Create and seed a personal welcome document for a user. Idempotent: if the
 * user already has a welcome_doc_id it is returned unchanged. Safe against
 * concurrent logins via the conditional write in users.setWelcomeDocId — a
 * losing racer deletes its orphan doc and returns the winner's id.
 * @param {string} userId
 * @returns {Promise<string>} the welcome document's guid
 */
async function seedWelcomeDoc(userId) {
  const existing = await users.findById(userId);
  if (existing?.welcome_doc_id) return existing.welcome_doc_id;

  // Create the record + owner share and seed the welcome content in one step
  // (shared with the create_document MCP tool). Content persists through the
  // normal Yjs update path and would broadcast to any connected client — no
  // live websocket session required.
  const docGuid = await documentService.createSeededDocument({
    userId,
    title: WELCOME_DOC_TITLE,
    nodes: WELCOME_DOC_NODES.map(buildYjsNode),
    agentName: AGENT_NAME,
  });

  // Claim the welcome_doc_id; if another concurrent login already claimed one,
  // drop our orphan and use theirs.
  const winner = await users.setWelcomeDocId(userId, docGuid);
  if (winner && winner !== docGuid) {
    await documents.deleteDocument(docGuid).catch(() => {});
    return winner;
  }
  return docGuid;
}

/**
 * Whether the user owns a document (other than their welcome doc) that has
 * content — i.e. at least one persisted Yjs update. Cheap EXISTS check.
 * @param {string} userId
 * @param {string|null} welcomeDocId - excluded from the check (may be null)
 * @returns {Promise<boolean>}
 */
async function isEngaged(userId, welcomeDocId) {
  const { rows } = await ensurePool().query(
    `SELECT 1
       FROM document_shares ds
       JOIN yjs_updates yu ON yu.doc_guid = ds.doc_id
      WHERE ds.user_id = $1 AND ds.role = 'owner'
        AND ($2::uuid IS NULL OR ds.doc_id <> $2)
      LIMIT 1`,
    [userId, welcomeDocId || null]
  );
  return rows.length > 0;
}

/**
 * Resolve the onboarding state for a user, used by both login (seed=true) and
 * the /auth/me probe (seed=false). Flips users.onboarded_at once engaged so
 * future checks short-circuit. Only seeds a welcome doc for users who are not
 * yet engaged, so existing/active users never get one.
 * @param {object} user - full user row (must include onboarded_at, welcome_doc_id)
 * @param {object} [opts]
 * @param {boolean} [opts.seed=false] - create a welcome doc if missing
 * @returns {Promise<{welcomeDocId: string|null, onboarded: boolean}>}
 */
async function resolveOnboarding(user, { seed = false } = {}) {
  if (user.onboarded_at) {
    return { welcomeDocId: user.welcome_doc_id || null, onboarded: true };
  }

  // Engagement check first so already-active users never get a welcome doc seeded.
  if (await isEngaged(user.id, user.welcome_doc_id)) {
    await users.markOnboarded(user.id);
    return { welcomeDocId: user.welcome_doc_id || null, onboarded: true };
  }

  let welcomeDocId = user.welcome_doc_id || null;
  if (!welcomeDocId && seed) {
    try {
      welcomeDocId = await seedWelcomeDoc(user.id);
    } catch (e) {
      console.error('[Onboarding] Failed to seed welcome doc:', e);
    }
  }
  return { welcomeDocId, onboarded: false };
}

/**
 * Stamp onboarded_at because the user just created a real (non-welcome)
 * document — i.e. they're now engaged by definition. Called from the
 * user-initiated document-creation paths (the POST /api/docs endpoint and the
 * create_document MCP tool) so the flag reflects engagement at the moment it
 * happens, rather than lagging until the user's next login or /auth/me probe.
 *
 * Idempotent (users.markOnboarded only writes when onboarded_at IS NULL) and
 * best-effort: it must never block or fail document creation, so callers can
 * fire-and-forget and errors are swallowed here.
 *
 * Deliberately NOT called from seedWelcomeDoc — creating the welcome doc is not
 * engagement, and is the one creation path that must leave the flag unset.
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function markEngagedFromDocCreation(userId) {
  if (!userId) return;
  try {
    await users.markOnboarded(userId);
  } catch (e) {
    console.error('[Onboarding] Failed to stamp onboarded_at on doc creation:', e);
  }
}

/**
 * DEV ONLY: reset a user's onboarding state and reseed a fresh welcome doc, so
 * the full welcome flow can be re-triggered on demand even for an "engaged"
 * user. Deletes the previous welcome doc, clears the onboarding columns, and
 * returns the new welcome doc guid.
 * @param {string} userId
 * @returns {Promise<string>} the new welcome document's guid
 */
async function resetForDev(userId) {
  const user = await users.findById(userId);
  const prev = user?.welcome_doc_id;
  if (prev) {
    await ensurePool().query('DELETE FROM yjs_updates WHERE doc_guid = $1', [prev]).catch(() => {});
    await documents.deleteDocument(prev).catch(() => {});
  }
  await ensurePool().query(
    'UPDATE users SET welcome_doc_id = NULL, onboarded_at = NULL WHERE id = $1',
    [userId]
  );
  return seedWelcomeDoc(userId);
}

module.exports = {
  init,
  seedWelcomeDoc,
  isEngaged,
  resolveOnboarding,
  markEngagedFromDocCreation,
  resetForDev,
};
