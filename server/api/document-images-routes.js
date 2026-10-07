/**
 * Document image routes (feature 058; upload and resolve moved out of
 * server/index.js unchanged, raw route new). Mounted by server/index.js and
 * by the tests, so both exercise this one implementation.
 *
 *   POST /api/docs/:docId/images                 upload (editor or owner)
 *   GET  /api/docs/:docId/images/:imageId        resolve to { url } (viewer+)
 *   GET  /api/docs/:docId/images/:imageId/raw    stream the bytes (viewer+)
 *
 * Resolve returns a short-lived presigned URL with the S3 driver, and the
 * relative raw path with the local driver (RBD-058-14), so the client needs no
 * change: it puts whatever URL resolve returns in <img src>.
 *
 * Contracts: specs/058-self-host-config/contracts/http-routes.md.
 */
const express = require('express');
const { requireAuth, requireAuthOrCookie } = require('../auth/middleware');
const { sendRawImage } = require('./raw-image');

/**
 * @param {object} deps
 * @param {object} deps.documents - server/documents.js (canEdit, hasAccess)
 * @param {object} deps.documentImages - server/document-images.js
 * @param {object} deps.storage - server/image-storage facade
 * @param {Function} deps.notifyException
 * @returns {express.Router}
 */
function createDocumentImagesRouter({ documents, documentImages, storage, notifyException }) {
  const router = express.Router();

  // API: Upload an image for a document (editor or owner)
  // Body: { filename, mimeType, dataBase64 }. Bytes go to image storage; only
  // metadata is stored in PG. Carries its own 20mb JSON parser: server/index.js
  // skips the global parser for this path.
  router.post('/api/docs/:docId/images', requireAuth, express.json({ limit: '20mb' }), async (req, res) => {
    try {
      const { docId } = req.params;
      const userId = req.user.userId;

      if (!storage.isEnabled()) {
        return res.status(503).json({ error: 'Image storage is not configured' });
      }

      // Uploading is an edit — require editor-or-better
      if (!(await documents.canEdit(docId, userId))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { filename = null, mimeType, dataBase64 } = req.body || {};
      if (!mimeType || !dataBase64) {
        return res.status(400).json({ error: 'mimeType and dataBase64 are required' });
      }

      const result = await documentImages.storeImage({
        docId, uploaderId: userId, data: Buffer.from(dataBase64, 'base64'), mimeType, filename,
      });
      res.status(201).json(result);
    } catch (error) {
      // storeImage tags validation errors with a status (400/413).
      if (error.status) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error('Error uploading document image:', error);
      notifyException(error, { req, source: 'api' });
      res.status(500).json({ error: 'Failed to upload image' });
    }
  });

  // API: Resolve a document image to a URL the browser can load (viewer-or-better).
  // S3: a short-lived presigned URL, so images load directly from S3.
  // Local: the raw route below.
  router.get('/api/docs/:docId/images/:imageId', requireAuth, async (req, res) => {
    try {
      const { docId, imageId } = req.params;
      const userId = req.user.userId;

      if (!storage.isEnabled()) {
        return res.status(503).json({ error: 'Image storage is not configured' });
      }

      if (!(await documents.hasAccess(docId, userId))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const image = await documentImages.getImage(imageId, docId);
      if (!image) {
        return res.status(404).json({ error: 'Image not found' });
      }

      const url = storage.kind === 'local'
        ? `/api/docs/${encodeURIComponent(docId)}/images/${encodeURIComponent(imageId)}/raw`
        : await storage.getSignedGetUrl(image.s3_key);
      res.set('Cache-Control', 'no-store');
      res.json({ url });
    } catch (error) {
      console.error('Error resolving document image:', error);
      notifyException(error, { req, source: 'api' });
      res.status(500).json({ error: 'Failed to resolve image' });
    }
  });

  // API: Stream a document image's bytes (viewer-or-better). Authenticates with
  // the Authorization header or the accessToken session cookie, because a
  // browser <img> sends cookies only (RBD-058-20). Same access check as resolve.
  router.get('/api/docs/:docId/images/:imageId/raw', requireAuthOrCookie, async (req, res) => {
    try {
      const { docId, imageId } = req.params;
      const userId = req.user.userId;

      if (!storage.isEnabled()) {
        return res.status(503).json({ error: 'Image storage is not configured' });
      }

      if (!(await documents.hasAccess(docId, userId))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const image = await documentImages.getImage(imageId, docId);
      if (!image) {
        return res.status(404).json({ error: 'Image not found' });
      }

      let object;
      try {
        object = await storage.readObject(image.s3_key);
      } catch (err) {
        if (err && (err.code === 'NoSuchKey' || err.name === 'NoSuchKey')) {
          return res.status(404).json({ error: 'Image not found' });
        }
        throw err;
      }
      // The row's type is authoritative: it was checked against the allow-list
      // at upload.
      return sendRawImage(res, { body: object.body, contentType: image.mime_type });
    } catch (error) {
      console.error('Error reading document image:', error);
      notifyException(error, { req, source: 'api' });
      res.status(500).json({ error: 'Failed to read image' });
    }
  });

  return router;
}

module.exports = { createDocumentImagesRouter };
