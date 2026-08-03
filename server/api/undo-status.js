/**
 * GET /api/docs/:docId/undo-status — log-derived undo/redo availability
 * (feature 016, US5, FR-019/RBD-6).
 *
 * Availability is derived from `agent_edits` (plus the legacy log-derivation
 * fallback) for the chat-assistant identity. No presence session is consulted
 * or created, so the answer survives session expiry and server restarts: an
 * agent edit genuinely still undoable keeps its Undo button. `canUndo` is cheap
 * availability, not a supersession proof — a fully superseded edit surfaces the
 * honest "nothing left to undo" at action time, and the client re-polls after
 * every action. Viewer role and any thrown error both stay `{ false, false }`.
 *
 * ── Why this is a module (feature 043, X4) ──────────────────────────────────
 * This handler lived inline in server/index.js, and
 * `server/__tests__/undo-status-api.test.js` tested a hand-copied replica of it
 * ("Mirror of the server/index.js endpoint handler"). A mirror passes forever
 * regardless of what production does; that copy had already drifted (it omitted
 * the `console.error` on the failure path). Extracting the handler lets the
 * suite mount the real thing behind its own fake-auth middleware — stubbing
 * *authentication* is legitimate, stubbing the *handler under test* is not.
 * The move is byte-for-byte behavior-preserving; the shape follows the
 * established `createExportRouter` / `createImportRouter` / `createTokenClaimRouter`
 * precedent in this directory.
 *
 * Dependencies are injected rather than required at module scope so a test can
 * mount the router without pulling in the auth stack.
 */
const express = require('express');
const { CHAT_AGENT_NAME } = require('../agent-identity');

/**
 * @param {object} deps
 * @param {{getRole: (docId: string, userId: string) => Promise<string|null>}} deps.documents
 * @param {{getUndoStatus: (args: object) => Promise<{canUndo: boolean, canRedo: boolean}>}} deps.undoService
 * @param {import('express').RequestHandler} deps.requireAuth
 * @returns {import('express').Router}
 */
function createUndoStatusRouter({ documents, undoService, requireAuth }) {
  const router = express.Router();

  router.get('/api/docs/:docId/undo-status', requireAuth, async (req, res) => {
    try {
      const { docId } = req.params;
      const role = await documents.getRole(docId, req.user.userId);
      if (!role || role === 'viewer') {
        return res.json({ canUndo: false, canRedo: false });
      }
      res.json(await undoService.getUndoStatus({
        docGuid: docId,
        userId: req.user.userId,
        agentName: CHAT_AGENT_NAME,
      }));
    } catch (error) {
      console.error('Error checking undo status:', error);
      res.json({ canUndo: false, canRedo: false });
    }
  });

  return router;
}

module.exports = { createUndoStatusRouter };
