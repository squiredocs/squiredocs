/**
 * Document export API
 *
 * GET /api/docs/:docId/export — serialize a document to Markdown as a
 * downloadable file. Loads the latest persisted state from Postgres (source
 * of truth), so export works even when no client is connected. View access
 * is sufficient. Works with browser sessions and sk_sqd_ API tokens alike
 * (requireAuth accepts both; scoped tokens need documents:read).
 */
const express = require('express');
const Y = require('yjs');
const { requireAuth } = require('../auth');
const documents = require('../documents');
const { toMarkdown } = require('../mcp/yjs/serialization');
const { notifyException } = require('../exception-notifier');

// Sanitize a document title into a safe download filename (without extension).
// Strips characters invalid in a Content-Disposition filename / common filesystems,
// collapses whitespace, caps length, and falls back to "document" if empty.
function sanitizeFilename(title) {
  const cleaned = String(title || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
  return cleaned || 'document';
}

/**
 * Build the export router.
 * @param {object} persistence - PostgresPersistence instance
 * @returns {express.Router}
 */
function createExportRouter(persistence) {
  const router = express.Router();

  router.get('/api/docs/:docId/export', requireAuth, async (req, res) => {
    try {
      const { docId } = req.params;
      const { format = 'markdown' } = req.query;
      const userId = req.user.userId;

      // View access is sufficient (same check as history/diff)
      const role = await documents.getRole(docId, userId);
      if (!role) {
        return res.status(403).json({ error: 'You do not have access to this document' });
      }

      if (format !== 'markdown' && format !== 'md') {
        return res.status(400).json({ error: `Unsupported export format: ${format}` });
      }

      const ydoc = await persistence.getYDoc(docId);
      const xmlFragment = ydoc.get('default', Y.XmlFragment);
      const title = ydoc.getMap('meta').get('title') || 'Untitled';

      const markdown = toMarkdown(xmlFragment);

      const filename = sanitizeFilename(title) + '.md';
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(markdown);
    } catch (error) {
      console.error('Error exporting document:', error);
      notifyException(error, { req, source: 'api' });
      res.status(500).json({ error: 'Failed to export document' });
    }
  });

  return router;
}

module.exports = {
  createExportRouter,
  sanitizeFilename,
};
