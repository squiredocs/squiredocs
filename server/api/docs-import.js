/**
 * Document import API (feature 002) — the REST counterpart to docs-export.
 *
 *   POST /api/docs/import           create a new document from markdown
 *   PUT  /api/docs/:docId/import    import into an existing document
 *                                   (?mode=append|replace, default append)
 *
 * Contracts: specs/002-markdown-import-surfaces/contracts/rest-import.md.
 * Both routes are thin wrappers over server/markdown-import.js (FR-001):
 * no parsing or materialization happens here.
 *
 * Auth mirrors the export route: `requireAuth` accepts browser sessions and
 * sk_sqd_/agent tokens, and already enforces `documents:write` for scoped
 * principals on non-GET methods (research R6). The genuinely new enforcement
 * is the editor-role gate on PUT. Errors mirror export: `notifyException`,
 * and no existence oracle (missing doc ≡ no access ≡ 403).
 */
const express = require('express');
const Y = require('yjs');
const { requireAuth } = require('../auth');
const documents = require('../documents');
const documentService = require('../document-service');
const { notifyException } = require('../exception-notifier');
const { buildYjsNode } = require('../mcp/yjs/node-builder');
const { parseFrontmatter } = require('../../shared/markdown/frontmatter');
const { applySyncPush, SYNC_AGENT_NAME } = require('../markdown-sync');
const {
  importMarkdown,
  deriveImportTitle,
  ImportError,
} = require('../markdown-import');

// ---------------------------------------------------------------------------
// mode=sync (feature 004) — contracts/sync-push.md
// ---------------------------------------------------------------------------

const ON_BEHALF_OF_FIELDS = ['name', 'email', 'commit', 'url'];
const ON_BEHALF_OF_MAX = 256;

/**
 * Reconstructibility hook (D1 forward guard). Today the full update log is
 * retained, so every valid clock is reconstructible → always true. A future
 * compaction feature narrows this; tests inject a false to exercise the 410.
 */
let canReconstruct = async () => true;
function setCanReconstruct(fn) { canReconstruct = fn || (async () => true); }

/** Parse on-behalf-of provenance from headers / query (mode=sync only, D6). */
function parseOnBehalfOf(req) {
  const out = {};
  for (const field of ON_BEHALF_OF_FIELDS) {
    const cap = field[0].toUpperCase() + field.slice(1);
    let v = req.get(`X-Squire-On-Behalf-Of-${cap}`);
    if (v == null) {
      const q = req.query[`onBehalfOf${cap}`];
      if (typeof q === 'string') v = q;
    }
    if (typeof v === 'string' && v.length > 0) {
      out[field] = v.slice(0, ON_BEHALF_OF_MAX); // length-cap (D6)
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A sync rejection body (FR-015, R6). */
function syncError(res, status, code, message) {
  return res.status(status).json({
    error: code,
    message,
    guidance: 'Re-pull the document (re-export) and re-apply your edits on a fresh baseline.',
  });
}

/**
 * Handle a mode=sync push: validate baseline/identity, dispatch to the sync
 * engine, shape the receipt. Auth/editor-role were already enforced by the
 * caller (no privileged path — FR-003).
 */
async function handleSyncPush(persistence, req, res, docId, user) {
  const markdown = typeof req.body === 'string' ? req.body : '';
  const { squire, body } = parseFrontmatter(markdown);

  // Doc identity (FR-002): reject a file that names a different document.
  if (squire && squire.docGuid != null && String(squire.docGuid) !== String(docId)) {
    return syncError(res, 409, 'sync_doc_mismatch',
      'The file\'s frontmatter names a different document than the request target.');
  }

  // Baseline resolution (D3): explicit param overrides frontmatter clock.
  let baselineClock;
  if (req.query.baselineClock !== undefined) baselineClock = Number(req.query.baselineClock);
  else if (squire && squire.clock !== undefined) baselineClock = Number(squire.clock);

  if (baselineClock === undefined) {
    return syncError(res, 400, 'sync_baseline_missing',
      'No baseline clock: provide squire.clock frontmatter or the baselineClock parameter.');
  }
  const currentClock = (await persistence.pool.query(
    'SELECT MAX(clock)::int AS clock FROM yjs_updates WHERE doc_guid = $1', [docId]
  )).rows[0].clock;
  if (!Number.isInteger(baselineClock) || baselineClock < 0 ||
      currentClock == null || baselineClock > currentClock) {
    return res.status(400).json({
      error: 'sync_baseline_invalid',
      message: 'The baseline clock is malformed, negative, or beyond the document\'s current clock.',
      guidance: 'Re-pull the document (re-export) and re-apply your edits on a fresh baseline.',
      currentClock: currentClock == null ? 0 : currentClock,
    });
  }
  if (!(await canReconstruct(persistence, docId, baselineClock))) {
    return res.status(410).json({
      error: 'sync_baseline_unavailable',
      message: 'The document can no longer be reconstructed at that baseline clock.',
      guidance: 'Re-pull the document (re-export) and re-apply your edits on a fresh baseline.',
      currentClock,
    });
  }

  const flavor = (squire && squire.flavor === 'portable') ? 'portable' : 'squire';
  const receipt = await applySyncPush(persistence, docId, {
    body, // frontmatter-stripped body — the engine diffs against the doc's body
    baselineClock,
    flavor,
    userId: user.userId,
    agentName: SYNC_AGENT_NAME,
    onBehalfOf: parseOnBehalfOf(req),
    getSharedDoc: documentService.getSharedDoc,
  });
  return res.status(200).json(receipt);
}

// CN-1: markdown bodies are capped at 5 MB, rejected before parsing.
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const IMPORT_CONTENT_TYPES = ['text/markdown', 'text/plain'];

/** 415 gate — only unambiguous text bodies are accepted (CN-2). */
function requireMarkdownContentType(req, res, next) {
  if (req.is(IMPORT_CONTENT_TYPES)) return next();
  res.status(415).json({
    error: 'Unsupported content type: send the markdown body as text/markdown or text/plain',
  });
}

/** Map body-parser failures to the contract's status codes. */
// eslint-disable-next-line no-unused-vars
function bodyErrorHandler(err, req, res, next) {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Markdown body exceeds the 5 MB import limit' });
  }
  if (err) {
    return res.status(400).json({ error: 'Could not read the request body' });
  }
  next();
}

/**
 * Wait until the shared in-memory doc has absorbed the persisted state.
 * y-websocket's getYDoc fires bindState WITHOUT awaiting it, so a freshly
 * fetched shared doc can briefly be empty — harmless for pure insertion
 * (append), but `replace` must never delete a half-loaded body. bindState
 * applies the whole persisted state in ONE applyUpdate, so "loaded" is
 * exactly "the shared doc's state vector covers the persisted doc's structs":
 * the missing-diff update then encodes zero clients (first varint byte 0).
 */
async function waitForDocLoaded(persistence, docId, ydoc, timeoutMs = 5000) {
  const persisted = await persistence.getYDoc(docId);
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const missing = Y.encodeStateAsUpdate(persisted, Y.encodeStateVector(ydoc));
      if (missing.length === 0 || missing[0] === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for document ${docId} to load`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    persisted.destroy();
  }
}

/** Current update-row count and clock (clock starts at 0; null when empty). */
async function readClockState(persistence, docId) {
  const result = await persistence.getPool().query(
    'SELECT COUNT(*)::int AS rows, MAX(clock)::int AS clock FROM yjs_updates WHERE doc_guid = $1',
    [docId]
  );
  return { rows: result.rows[0].rows, clock: result.rows[0].clock };
}

/**
 * Read the document clock after an import. Persistence writes are initiated
 * (not awaited) by the update listener, so poll until at least `minRows`
 * update rows have landed for the doc, then return the clock.
 */
async function waitForClock(persistence, docId, minRows, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readClockState(persistence, docId);
    if (state.rows >= minRows || Date.now() > deadline) return state.clock ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Actor attribution for the import transaction (agent tokens carry a name). */
function actorFrom(user) {
  return { userId: user.userId, agentName: user.agentName || null };
}

/**
 * Build the import router.
 * @param {object} persistence - PostgresPersistence instance
 * @returns {express.Router}
 */
function createImportRouter(persistence) {
  const router = express.Router();
  const parseBody = express.text({
    type: IMPORT_CONTENT_TYPES,
    limit: MAX_IMPORT_BYTES,
    defaultCharset: 'utf-8',
  });
  const chain = [requireAuth, requireMarkdownContentType, parseBody, bodyErrorHandler];

  // -------------------------------------------------------------------------
  // POST /api/docs/import — create a new document from markdown (FR-012)
  // -------------------------------------------------------------------------
  router.post('/api/docs/import', ...chain, async (req, res) => {
    try {
      const markdown = typeof req.body === 'string' ? req.body : '';
      if (!markdown.trim()) {
        return res.status(400).json({ error: 'Empty markdown body' });
      }
      const userId = req.user.userId;

      // Title precedence: ?title= → frontmatter squire title → first heading
      // → Untitled (FR-008). Derivation lives in the import module.
      const derived = deriveImportTitle(markdown);
      const explicit = typeof req.query.title === 'string' ? req.query.title.trim() : '';
      const title = explicit || derived.title || 'Untitled';

      let docId;
      let blocks = { imported: 0 };
      let images = { rehosted: [], copied: [], degraded: [], rejected: [] };
      let minRows = 1; // the seeding transaction

      if (!derived.hasBody) {
        // Frontmatter-only create (spec §Edge Cases): seeded empty anchor
        // paragraph + derived title; nothing to import.
        docId = await documentService.createSeededDocument({
          userId,
          title,
          nodes: [buildYjsNode({ type: 'paragraph' })],
          agentName: req.user.agentName || null,
        });
      } else {
        // Create first (image staging needs the document row), then import
        // through the single module path. The two updates land inside one
        // version-history session (same author, same instant).
        docId = await documentService.createSeededDocument({
          userId,
          title,
          nodes: [],
          agentName: req.user.agentName || null,
        });
        const ydoc = documentService.getSharedDoc(docId);
        const report = await importMarkdown(ydoc, markdown, {
          mode: 'append',
          actor: actorFrom(req.user),
          imageContext: { docId },
        });
        blocks = report.blocks;
        images = report.images;
        minRows = 2; // seed + import
      }

      const clock = await waitForClock(persistence, docId, minRows);
      return res.status(201).json({ docId, title, url: `/d/${docId}`, clock, blocks, images });
    } catch (error) {
      if (error instanceof ImportError && error.code === 'EMPTY_IMPORT') {
        return res.status(400).json({ error: error.message });
      }
      console.error('Error importing document (create):', error);
      notifyException(error, { req, source: 'api' });
      return res.status(500).json({ error: 'Failed to import document' });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/docs/:docId/import — import into an existing document (FR-011)
  // -------------------------------------------------------------------------
  router.put('/api/docs/:docId/import', ...chain, async (req, res) => {
    try {
      const { docId } = req.params;
      const userId = req.user.userId;

      // Editor-role gate; export parity: no existence oracle (FR-011/13).
      const allowed = await documents.hasRole(docId, userId, 'editor');
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this document' });
      }

      // Mode: append (default) | replace | sync (feature 004). The sync push has
      // its own contract (baseline replay); auth above is the same trust
      // boundary — no privileged path (FR-003).
      const mode = req.query.mode === undefined ? 'append' : String(req.query.mode);
      if (mode === 'sync') {
        return await handleSyncPush(persistence, req, res, docId, req.user);
      }
      if (mode !== 'append' && mode !== 'replace') {
        return res.status(400).json({ error: `Unknown import mode: ${mode} (use append or replace or sync)` });
      }

      const markdown = typeof req.body === 'string' ? req.body : '';
      if (!markdown.trim()) {
        return res.status(400).json({ error: 'Empty markdown body' });
      }

      const pre = await readClockState(persistence, docId);
      const ydoc = documentService.getSharedDoc(docId);
      await waitForDocLoaded(persistence, docId, ydoc);

      const report = await importMarkdown(ydoc, markdown, {
        mode,
        actor: actorFrom(req.user),
        imageContext: { docId },
      });

      const clock = await waitForClock(persistence, docId, pre.rows + 1);
      // Additive-extensible response (CN-12): feature 004 adds fields here.
      return res.status(200).json({
        docId,
        mode,
        clock,
        blocks: report.blocks,
        images: report.images,
      });
    } catch (error) {
      if (error instanceof ImportError && error.code === 'EMPTY_IMPORT') {
        return res.status(400).json({ error: error.message });
      }
      console.error('Error importing into document:', error);
      notifyException(error, { req, source: 'api' });
      return res.status(500).json({ error: 'Failed to import into document' });
    }
  });

  return router;
}

module.exports = {
  createImportRouter,
  MAX_IMPORT_BYTES,
  parseOnBehalfOf,
  setCanReconstruct,
};
