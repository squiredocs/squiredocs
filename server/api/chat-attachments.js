/**
 * Chat attachment upload API (feature 010, US3).
 *
 * POST /api/chat/attachments — store one attachment's bytes in S3 so the chat
 * body carries a short reference (`attachment:<key>`) instead of inline base64,
 * closing the large-body OOM window on /api/chat (FR-016/017). Accepts the
 * image types plus text/markdown (a dropped .md file — imported into a document
 * by the assistant's import_markdown tool, never fed to the model).
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
const rateLimit = require('../rate-limit');
const s3Images = require('../s3-images');
const { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_BYTES } = require('../document-images');
const { notifyException } = require('../exception-notifier');

// Generous body cap for a single 15MB image carried as base64 (~33% overhead).
const ATTACHMENT_BODY_LIMIT = process.env.CHAT_ATTACHMENT_LIMIT || '25mb';

// Markdown attachments cap at the importer's limit (docs-import MAX_IMPORT_BYTES).
const MARKDOWN_MIME = 'text/markdown';
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;

// A chat-attachment key is exactly `chat-attachments/<userId>/<uuid>` — mirror of
// chat.js:attachmentKeyForUser. Requiring the exact shape rejects traversal and
// extra segments, and scopes resolution to the owner (feature 010 review F7).
const ATTACHMENT_SCHEME = 'attachment:';
const ATTACHMENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function attachmentKeyForUser(ref, userId) {
  if (typeof ref !== 'string' || !ref.startsWith(ATTACHMENT_SCHEME)) return null;
  const key = ref.slice(ATTACHMENT_SCHEME.length);
  const segs = key.split('/');
  if (
    segs.length !== 3 ||
    segs[0] !== 'chat-attachments' ||
    segs[1] !== userId ||
    !ATTACHMENT_UUID_RE.test(segs[2])
  ) {
    return null;
  }
  return key;
}

function createChatAttachmentsRouter() {
  const router = express.Router();
  const parseBody = express.json({ limit: ATTACHMENT_BODY_LIMIT });

  // Per-user upload budget (feature 010 review F5): the endpoint was previously
  // unmetered, so a single authenticated user could hammer 25MB PUTs to S3. The
  // limiter runs before parseBody so an over-budget request is rejected without
  // parsing the large body.
  router.post('/api/chat/attachments', requireAuth, rateLimit.perUser('upload'), parseBody, async (req, res) => {
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
      const isMarkdown = mime === MARKDOWN_MIME;
      if (!isMarkdown && !ALLOWED_IMAGE_MIME_TYPES.includes(mime)) {
        return res.status(400).json({ error: 'Unsupported attachment type' });
      }

      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) {
        return res.status(400).json({ error: 'Empty attachment data' });
      }
      if (isMarkdown && bytes.length > MAX_MARKDOWN_BYTES) {
        return res.status(413).json({ error: 'Markdown exceeds the 5MB import limit' });
      }
      if (!isMarkdown && bytes.length > MAX_IMAGE_BYTES) {
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

  // GET /api/chat/attachments/resolve?ref=attachment:<key> — resolve an uploaded
  // attachment reference to a short-lived presigned S3 URL so the transcript can
  // display it. A bare `<img src>` can't carry the Bearer token and the stored
  // reference isn't a browsable URL, so the client resolves it here first
  // (mirrors the document-image path: GET .../images/:id → { url }). Ownership is
  // enforced by the userId encoded in the key (FR-016), so a user can only
  // resolve attachments they uploaded.
  router.get('/api/chat/attachments/resolve', requireAuth, async (req, res) => {
    if (!s3Images.isEnabled()) {
      return res.status(503).json({ error: 'Image storage is not configured' });
    }
    const key = attachmentKeyForUser(req.query?.ref, req.user.userId);
    if (!key) {
      return res.status(400).json({ error: 'Invalid or inaccessible attachment reference' });
    }
    try {
      const url = await s3Images.getSignedGetUrl(key);
      res.set('Cache-Control', 'no-store');
      return res.json({ url });
    } catch (err) {
      console.error('[ChatAttachments] resolve failed:', err);
      notifyException(err, { req, source: 'chat-attachments' });
      return res.status(500).json({ error: 'Failed to resolve attachment' });
    }
  });

  return router;
}

module.exports = { createChatAttachmentsRouter };
