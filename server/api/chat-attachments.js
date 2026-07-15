/**
 * Chat attachment upload API (feature 010, US3).
 *
 * POST /api/chat/attachments — store one image's bytes in S3 so the chat body
 * carries a short reference (`attachment:<key>`) instead of inline base64,
 * closing the large-body OOM window on /api/chat (FR-016/017).
 *
 * Bytes live at `chat-attachments/<userId>/<uuid>` — ownership is encoded in the
 * key and re-verified when chat.js resolves the reference (user-scope, FR-016).
 * There is NO DB metadata row: identity is the S3 object (the plan's reference-
 * based approach; see promotion-notes.md if a schema ever proves necessary).
 *
 * Validation (mime allow-list + 15MB per-file cap) mirrors
 * document-images.storeImage. When S3 is unconfigured the upload fails
 * explicitly with a 503 (FR-019) — never a crash or silent drop.
 */
const express = require('express');
const { randomUUID } = require('crypto');
const { requireAuth } = require('../auth');
const s3Images = require('../s3-images');
const { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_BYTES } = require('../document-images');
const { notifyException } = require('../exception-notifier');

// Generous body cap for a single 15MB image carried as base64 (~33% overhead).
const ATTACHMENT_BODY_LIMIT = process.env.CHAT_ATTACHMENT_LIMIT || '25mb';

function createChatAttachmentsRouter() {
  const router = express.Router();
  const parseBody = express.json({ limit: ATTACHMENT_BODY_LIMIT });

  router.post('/api/chat/attachments', requireAuth, parseBody, async (req, res) => {
    // S3 unconfigured → explicit, graceful 503 (FR-019).
    if (!s3Images.isEnabled()) {
      return res.status(503).json({ error: 'Image storage is not configured' });
    }

    try {
      const { data, mediaType, filename } = req.body || {};
      if (typeof data !== 'string' || !data) {
        return res.status(400).json({ error: 'Missing attachment data' });
      }

      // Accept either a data: URL or raw base64; derive the mime from the data
      // URL when the caller didn't pass one explicitly.
      let base64 = data;
      let mime = typeof mediaType === 'string' ? mediaType : null;
      const m = data.match(/^data:([^;]+);base64,(.+)$/s);
      if (m) {
        mime = mime || m[1];
        base64 = m[2];
      }

      if (!mime) {
        return res.status(400).json({ error: 'Missing media type' });
      }
      if (!ALLOWED_IMAGE_MIME_TYPES.includes(mime)) {
        return res.status(400).json({ error: 'Unsupported image type' });
      }

      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) {
        return res.status(400).json({ error: 'Empty image data' });
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        return res.status(413).json({ error: 'Image exceeds the 15MB limit' });
      }

      const key = `chat-attachments/${req.user.userId}/${randomUUID()}`;
      // Upload bytes; on success return the opaque reference the chat body sends.
      await s3Images.putObject({ key, body: bytes, contentType: mime });

      return res.status(201).json({
        reference: `attachment:${key}`,
        mediaType: mime,
        filename: filename || null,
      });
    } catch (err) {
      console.error('[ChatAttachments] upload failed:', err);
      notifyException(err, { req, source: 'chat-attachments' });
      return res.status(500).json({ error: 'Failed to store attachment' });
    }
  });

  return router;
}

module.exports = { createChatAttachmentsRouter };
