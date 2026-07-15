/**
 * Feature 010, US3 (FR-016/018/019): the attachment upload endpoint stores bytes
 * in S3 under a user-scoped key and returns a reference; chat resolves a
 * reference to model bytes only for its owner (a user cannot resolve another
 * user's key); an unconfigured S3 fails gracefully with a 503.
 */

// Mock S3 storage so no real bucket is touched. getObject echoes the key so we
// can assert which object was fetched; isEnabled is toggleable for the 503 case.
let s3Enabled = true;
const putObjectMock = jest.fn(async () => {});
jest.mock('../s3-images', () => ({
  isEnabled: () => s3Enabled,
  putObject: (...a) => putObjectMock(...a),
  getObject: jest.fn(async (key) => Buffer.from('BYTES::' + key)),
  cspImageSources: () => [],
}));

// Bypass JWT — a fake requireAuth keyed off a header.
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => { req.user = { userId: req.get('x-test-user') || 'user-a' }; next(); },
}));

const request = require('supertest');
const express = require('express');
const s3Images = require('../s3-images');
const { createChatAttachmentsRouter } = require('../api/chat-attachments');
const chat = require('../api/chat');

function buildApp() {
  const app = express();
  app.use(createChatAttachmentsRouter());
  return app;
}

const PNG = 'data:image/png;base64,' + Buffer.from('hello-png').toString('base64');

describe('chat attachments — upload endpoint (FR-016/019)', () => {
  beforeEach(() => { s3Enabled = true; putObjectMock.mockClear(); });

  it('stores bytes under chat-attachments/<userId>/… and returns a reference', async () => {
    const res = await request(buildApp())
      .post('/api/chat/attachments')
      .set('x-test-user', 'user-42')
      .send({ data: PNG, mediaType: 'image/png', filename: 'shot.png' });

    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^attachment:chat-attachments\/user-42\/[0-9a-f-]{36}$/);
    expect(res.body.mediaType).toBe('image/png');
    // Bytes uploaded to the same key the reference encodes.
    expect(putObjectMock).toHaveBeenCalledTimes(1);
    const key = res.body.reference.slice('attachment:'.length);
    expect(putObjectMock.mock.calls[0][0].key).toBe(key);
  });

  it('rejects an unsupported image type with 400', async () => {
    const res = await request(buildApp())
      .post('/api/chat/attachments')
      .set('x-test-user', 'user-42')
      .send({ data: Buffer.from('x').toString('base64'), mediaType: 'image/svg+xml' });
    expect(res.status).toBe(400);
  });

  it('rejects an oversized image with 413', async () => {
    const bytes = Buffer.alloc(16 * 1024 * 1024, 1).toString('base64'); // > 15MB
    const res = await request(buildApp())
      .post('/api/chat/attachments')
      .set('x-test-user', 'user-42')
      .send({ data: bytes, mediaType: 'image/png' });
    expect(res.status).toBe(413);
  });

  it('returns 503 with a clear message when S3 is unconfigured (FR-019)', async () => {
    s3Enabled = false;
    const res = await request(buildApp())
      .post('/api/chat/attachments')
      .set('x-test-user', 'user-42')
      .send({ data: PNG, mediaType: 'image/png' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Image storage is not configured' });
  });
});

describe('chat attachments — reference resolution & user-scope (FR-016/018)', () => {
  const ownerId = 'user-owner';
  const otherId = 'user-other';
  const ownedKey = `chat-attachments/${ownerId}/11111111-1111-1111-1111-111111111111`;
  const ownedRef = `attachment:${ownedKey}`;

  it('extractMessageImages resolves an owned reference to base64 model bytes', async () => {
    const message = { parts: [{ type: 'file', mediaType: 'image/png', url: ownedRef, filename: 'a.png' }] };
    const images = await chat.extractMessageImages(message, ownerId);
    expect(images).toHaveLength(1);
    expect(s3Images.getObject).toHaveBeenCalledWith(ownedKey);
    expect(Buffer.from(images[0].dataBase64, 'base64').toString()).toBe('BYTES::' + ownedKey);
  });

  it('extractMessageImages still handles legacy inline data URLs', async () => {
    const message = { parts: [{ type: 'file', mediaType: 'image/png', url: PNG }] };
    const images = await chat.extractMessageImages(message, ownerId);
    expect(images).toHaveLength(1);
    expect(Buffer.from(images[0].dataBase64, 'base64').toString()).toBe('hello-png');
  });

  it('a user cannot resolve another user\'s attachment key (403)', async () => {
    const message = { parts: [{ type: 'file', mediaType: 'image/png', url: ownedRef }] };
    await expect(chat.extractMessageImages(message, otherId)).rejects.toMatchObject({ status: 403 });
  });

  it('inlineDataUrls resolves owned references to Buffers, rejects cross-user', async () => {
    const owned = [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: ownedRef }] }];
    await chat.inlineDataUrls(owned, ownerId);
    expect(Buffer.isBuffer(owned[0].content[0].data)).toBe(true);
    expect(owned[0].content[0].data.toString()).toBe('BYTES::' + ownedKey);

    const foreign = [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: ownedRef }] }];
    await expect(chat.inlineDataUrls(foreign, otherId)).rejects.toMatchObject({ status: 403 });
  });
});
