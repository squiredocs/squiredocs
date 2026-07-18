/**
 * Feature 010, US3 (FR-016/018/019): the attachment upload endpoint stores bytes
 * in S3 under a user-scoped key and returns a reference; chat resolves a
 * reference to model bytes only for its owner (a user cannot resolve another
 * user's key); an unconfigured S3 fails gracefully with a 503.
 */

// Mock S3 storage so no real bucket is touched. getObject echoes the key so we
// can assert which object was fetched; isEnabled is toggleable for the 503 case.
// Vars are `mock`-prefixed so jest's factory-hoist allows referencing them.
let mockS3Enabled = true;
const mockPutObject = jest.fn(async () => {});
jest.mock('../s3-images', () => ({
  isEnabled: () => mockS3Enabled,
  putObject: (...a) => mockPutObject(...a),
  getObject: jest.fn(async (key) => Buffer.from('BYTES::' + key)),
  getSignedGetUrl: jest.fn(async (key) => `https://s3.example/signed/${key}?sig=abc`),
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
  beforeEach(() => { mockS3Enabled = true; mockPutObject.mockClear(); });

  it('stores bytes under chat-attachments/<userId>/… and returns a reference', async () => {
    const res = await request(buildApp())
      .post('/api/chat/attachments')
      .set('x-test-user', 'user-42')
      .send({ data: PNG, mediaType: 'image/png', filename: 'shot.png' });

    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^attachment:chat-attachments\/user-42\/[0-9a-f-]{36}$/);
    expect(res.body.mediaType).toBe('image/png');
    // Bytes uploaded to the same key the reference encodes.
    expect(mockPutObject).toHaveBeenCalledTimes(1);
    const key = res.body.reference.slice('attachment:'.length);
    expect(mockPutObject.mock.calls[0][0].key).toBe(key);
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

  it('accepts a text/markdown attachment and returns a reference', async () => {
    const md = 'data:text/markdown;base64,' + Buffer.from('# Spec\n\nBody').toString('base64');
    const res = await request(buildApp())
      .post('/api/chat/attachments')
      .set('x-test-user', 'user-42')
      .send({ data: md, mediaType: 'text/markdown', filename: 'spec.md' });
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^attachment:chat-attachments\/user-42\/[0-9a-f-]{36}$/);
    expect(res.body.mediaType).toBe('text/markdown');
  });

  it('rejects markdown over the 5MB import limit with 413', async () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024, 97).toString('base64'); // > 5MB
    const res = await request(buildApp())
      .post('/api/chat/attachments')
      .set('x-test-user', 'user-42')
      .send({ data: bytes, mediaType: 'text/markdown' });
    expect(res.status).toBe(413);
  });

  it('still rejects non-image, non-markdown text types with 400', async () => {
    const res = await request(buildApp())
      .post('/api/chat/attachments')
      .set('x-test-user', 'user-42')
      .send({ data: Buffer.from('a,b').toString('base64'), mediaType: 'text/csv' });
    expect(res.status).toBe(400);
  });

  it('returns 503 with a clear message when S3 is unconfigured (FR-019)', async () => {
    mockS3Enabled = false;
    const res = await request(buildApp())
      .post('/api/chat/attachments')
      .set('x-test-user', 'user-42')
      .send({ data: PNG, mediaType: 'image/png' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Image storage is not configured' });
  });
});

describe('chat attachments — resolve endpoint (transcript display)', () => {
  const uuid = '33333333-3333-3333-3333-333333333333';
  const ownedRef = `attachment:chat-attachments/user-42/${uuid}`;

  beforeEach(() => { mockS3Enabled = true; s3Images.getSignedGetUrl.mockClear(); });

  it('resolves an owned reference to a presigned URL (no-store)', async () => {
    const res = await request(buildApp())
      .get('/api/chat/attachments/resolve')
      .query({ ref: ownedRef })
      .set('x-test-user', 'user-42');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(`https://s3.example/signed/chat-attachments/user-42/${uuid}?sig=abc`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(s3Images.getSignedGetUrl).toHaveBeenCalledWith(`chat-attachments/user-42/${uuid}`);
  });

  it("rejects another user's reference with 400 (never signs it)", async () => {
    const res = await request(buildApp())
      .get('/api/chat/attachments/resolve')
      .query({ ref: ownedRef })
      .set('x-test-user', 'user-other');
    expect(res.status).toBe(400);
    expect(s3Images.getSignedGetUrl).not.toHaveBeenCalled();
  });

  it('rejects a traversal reference with 400', async () => {
    const res = await request(buildApp())
      .get('/api/chat/attachments/resolve')
      .query({ ref: `attachment:chat-attachments/user-42/../user-victim/${uuid}` })
      .set('x-test-user', 'user-42');
    expect(res.status).toBe(400);
    expect(s3Images.getSignedGetUrl).not.toHaveBeenCalled();
  });

  it('rejects a missing/blank ref with 400', async () => {
    const res = await request(buildApp())
      .get('/api/chat/attachments/resolve')
      .set('x-test-user', 'user-42');
    expect(res.status).toBe(400);
  });

  it('returns 503 when S3 is unconfigured', async () => {
    mockS3Enabled = false;
    const res = await request(buildApp())
      .get('/api/chat/attachments/resolve')
      .query({ ref: ownedRef })
      .set('x-test-user', 'user-42');
    expect(res.status).toBe(503);
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

describe('markdown attachments — byte channel (import_markdown)', () => {
  const ownerId = 'user-owner';
  const mdKey = `chat-attachments/${ownerId}/22222222-2222-2222-2222-222222222222`;
  const mdRef = `attachment:${mdKey}`;

  it('extractMessageMarkdown resolves an owned markdown reference, skips images', async () => {
    const message = { parts: [
      { type: 'file', mediaType: 'image/png', url: PNG, filename: 'a.png' },
      { type: 'file', mediaType: 'text/markdown', url: mdRef, filename: 'spec.md' },
    ] };
    const files = await chat.extractMessageMarkdown(message, ownerId);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('spec.md');
    expect(Buffer.from(files[0].dataBase64, 'base64').toString()).toBe('BYTES::' + mdKey);
  });

  it('extractMessageMarkdown enforces user scope (403 on a foreign reference)', async () => {
    const message = { parts: [{ type: 'file', mediaType: 'text/markdown', url: mdRef }] };
    await expect(chat.extractMessageMarkdown(message, 'user-other')).rejects.toMatchObject({ status: 403 });
  });

  it('replaceMarkdownFileParts swaps markdown file parts for a text note, non-mutating', () => {
    const original = [
      { role: 'user', parts: [
        { type: 'text', text: 'import this please' },
        { type: 'file', mediaType: 'text/markdown', url: mdRef, filename: 'spec.md' },
        { type: 'file', mediaType: 'image/png', url: PNG, filename: 'a.png' },
      ] },
      { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
    ];
    const out = chat.replaceMarkdownFileParts(original);

    // The markdown file part became a text note naming the file and the tool
    const swapped = out[0].parts[1];
    expect(swapped.type).toBe('text');
    expect(swapped.text).toContain('spec.md');
    expect(swapped.text).toContain('import_markdown');
    // Image part and other messages untouched; original objects not mutated
    expect(out[0].parts[2]).toBe(original[0].parts[2]);
    expect(out[1]).toBe(original[1]);
    expect(original[0].parts[1].type).toBe('file');
  });
});

describe('attachmentKeyForUser — key hardening (review F7)', () => {
  const self = 'user-self';
  const uuid = '11111111-1111-1111-1111-111111111111';
  const ok = `chat-attachments/${self}/${uuid}`;

  it('accepts a well-formed owned key', () => {
    expect(chat.attachmentKeyForUser(`attachment:${ok}`, self)).toBe(ok);
  });

  it('rejects a traversal key with extra segments (403)', () => {
    // `chat-attachments/<self>/../<victim>/<uuid>` used to pass the prefix-only
    // check (segs[1] === self, segs[2] === '..' is truthy).
    const evil = `attachment:chat-attachments/${self}/../user-victim/${uuid}`;
    expect(() => chat.attachmentKeyForUser(evil, self)).toThrow(/not accessible/);
    try { chat.attachmentKeyForUser(evil, self); } catch (e) { expect(e.status).toBe(403); }
  });

  it('rejects an extra trailing segment (403)', () => {
    const evil = `attachment:${ok}/extra`;
    expect(() => chat.attachmentKeyForUser(evil, self)).toThrow(/not accessible/);
  });

  it('rejects a non-UUID final segment (403)', () => {
    const evil = `attachment:chat-attachments/${self}/not-a-uuid`;
    expect(() => chat.attachmentKeyForUser(evil, self)).toThrow(/not accessible/);
  });

  it('rejects a cross-user key (403)', () => {
    const evil = `attachment:chat-attachments/user-other/${uuid}`;
    expect(() => chat.attachmentKeyForUser(evil, self)).toThrow(/not accessible/);
  });

  it('inlineDataUrls rejects a traversal reference end-to-end (403)', async () => {
    const parts = [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png',
      data: `attachment:chat-attachments/${self}/../user-victim/${uuid}` }] }];
    await expect(chat.inlineDataUrls(parts, self)).rejects.toMatchObject({ status: 403 });
  });
});
