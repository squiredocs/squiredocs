/**
 * Feature 058 (T033, FR-018): chat attachments on the local driver, through the
 * real facade, the real router, and the real requireAuth / requireAuthOrCookie
 * with real session JWTs. The S3 path stays covered by chat-attachments.test.js
 * (mocked driver), which is unchanged apart from the module path.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { randomUUID } = require('crypto');

const { _resetInstanceConfigForTests } = require('../instance-config');
const { createChatAttachmentsRouter } = require('../api/chat-attachments');
const { generateAccessToken } = require('../auth/jwt');

const PNG_BYTES = Buffer.from('local-png-bytes');
const PNG = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

const saved = {};
let dataDir;
let app;
const owner = { id: randomUUID(), email: 'att-owner@example.com', name: 'Owner' };
const other = { id: randomUUID(), email: 'att-other@example.com', name: 'Other' };
const ownerToken = generateAccessToken(owner);
const otherToken = generateAccessToken(other);

beforeAll(() => {
  for (const k of ['STORAGE_DRIVER', 'SQUIRE_DATA_DIR', 'RL_FORCE_MEMORY']) saved[k] = process.env[k];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-chat-att-'));
  process.env.STORAGE_DRIVER = 'local';
  process.env.SQUIRE_DATA_DIR = dataDir;
  process.env.RL_FORCE_MEMORY = '1';
  _resetInstanceConfigForTests();
  app = express();
  app.use(cookieParser());
  app.use(createChatAttachmentsRouter());
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetInstanceConfigForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const binary = (req) => req.buffer(true).parse((r, cb) => {
  const c = [];
  r.on('data', (d) => c.push(d));
  r.on('end', () => cb(null, Buffer.concat(c)));
});

async function uploadAs(token, data = PNG, mediaType = 'image/png') {
  const res = await request(app)
    .post('/api/chat/attachments')
    .set('Authorization', `Bearer ${token}`)
    .send({ data, mediaType });
  expect(res.status).toBe(201);
  return res.body.reference;
}

test('upload then resolve returns the relative raw route', async () => {
  const ref = await uploadAs(ownerToken);
  expect(ref).toMatch(new RegExp(`^attachment:chat-attachments/${owner.id}/[0-9a-f-]{36}$`));
  const res = await request(app)
    .get('/api/chat/attachments/resolve')
    .query({ ref })
    .set('Authorization', `Bearer ${ownerToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ url: `/api/chat/attachments/raw?ref=${encodeURIComponent(ref)}` });
  expect(res.headers['cache-control']).toBe('no-store');
});

test('raw as owner streams the bytes with the stored type, by cookie and by Bearer', async () => {
  const ref = await uploadAs(ownerToken);
  for (const auth of [['Cookie', `accessToken=${ownerToken}`], ['Authorization', `Bearer ${ownerToken}`]]) {
    const res = await binary(request(app).get('/api/chat/attachments/raw').query({ ref }).set(...auth));
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body)).toEqual(PNG_BYTES);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  }
});

test("raw for another user's key is 400", async () => {
  const ref = await uploadAs(ownerToken);
  const res = await request(app).get('/api/chat/attachments/raw').query({ ref }).set('Cookie', `accessToken=${otherToken}`);
  expect(res.status).toBe(400);
});

test('raw with no credentials is 401', async () => {
  const ref = await uploadAs(ownerToken);
  const res = await request(app).get('/api/chat/attachments/raw').query({ ref });
  expect(res.status).toBe(401);
});

test('a markdown attachment is 404 on the raw route', async () => {
  const md = Buffer.from('# hello').toString('base64');
  const ref = await uploadAs(ownerToken, md, 'text/markdown');
  const res = await request(app).get('/api/chat/attachments/raw').query({ ref }).set('Cookie', `accessToken=${ownerToken}`);
  expect(res.status).toBe(404);
});

test('an owned but missing object is 404', async () => {
  const ref = `attachment:chat-attachments/${owner.id}/${randomUUID()}`;
  const res = await request(app).get('/api/chat/attachments/raw').query({ ref }).set('Cookie', `accessToken=${ownerToken}`);
  expect(res.status).toBe(404);
});
