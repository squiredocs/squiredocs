/**
 * Feature 058 (T032, FR-017, RBD-058-20/21): the production document image
 * router (server/api/document-images-routes.js) on this worker's database with
 * the local driver over a temp data directory.
 *
 * Raw-route auth widening (cookie accepted) is covered explicitly: no
 * credentials → 401, a user without access → 403, a viewer → 200 by cookie.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { randomUUID } = require('crypto');

const { createPool, createTestUser, cleanupTestUser, cleanupDocRows } = require('./helpers/db');
const { _resetInstanceConfigForTests } = require('../instance-config');
const documents = require('../documents');
const documentImages = require('../document-images');
const storage = require('../image-storage');
const { createLocalDriver } = require('../image-storage/local-driver');
const { createDocumentImagesRouter } = require('../api/document-images-routes');
const { generateAccessToken } = require('../auth/jwt');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');

let pool;
let app;
let dataDir;
const savedEnv = {};
const users = {};
const tokens = {};
const docIds = [];

function makeApp(storageImpl = storage, notifyException = jest.fn()) {
  const a = express();
  a.use(cookieParser());
  a.use(createDocumentImagesRouter({ documents, documentImages, storage: storageImpl, notifyException }));
  return a;
}

async function upload(docId, who = 'owner') {
  const res = await request(app)
    .post(`/api/docs/${docId}/images`)
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send({ mimeType: 'image/png', dataBase64: PNG.toString('base64'), filename: 'p.png' });
  return res;
}

beforeAll(async () => {
  for (const k of ['STORAGE_DRIVER', 'SQUIRE_DATA_DIR']) savedEnv[k] = process.env[k];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-docimg-routes-'));
  process.env.STORAGE_DRIVER = 'local';
  process.env.SQUIRE_DATA_DIR = dataDir;
  _resetInstanceConfigForTests();

  pool = createPool();
  documents.init(pool);
  documentImages.init(pool);

  const tag = randomUUID().slice(0, 8);
  for (const who of ['owner', 'viewer', 'stranger']) {
    const id = await createTestUser(pool, `docimg-${who}-${tag}@example.com`);
    users[who] = id;
    tokens[who] = generateAccessToken({ id, email: `docimg-${who}-${tag}@example.com`, name: who });
  }
  const docA = randomUUID();
  const docB = randomUUID();
  docIds.push(docA, docB);
  await documents.createDocument(docA, users.owner, 'Images A');
  await documents.createDocument(docB, users.owner, 'Images B');
  await documents.setRole(docA, users.viewer, 'viewer', users.owner);

  app = makeApp();
});

afterAll(async () => {
  try {
    await cleanupDocRows(pool, docIds);
    await pool.query('DELETE FROM document_images WHERE doc_id = ANY($1::uuid[])', [docIds]);
    for (const id of Object.values(users)) await cleanupTestUser(pool, id);
  } finally {
    await pool.end();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetInstanceConfigForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('upload', () => {
  test('editor-or-better gets 201 with the app URL shape', async () => {
    const res = await upload(docIds[0]);
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(new RegExp(`^/api/docs/${docIds[0]}/images/[0-9a-f-]{36}$`));
    expect(fs.existsSync(path.join(dataDir, 'images/objects/doc-images', docIds[0], res.body.id))).toBe(true);
  });

  test('a viewer cannot upload', async () => {
    const res = await upload(docIds[0], 'viewer');
    expect(res.status).toBe(403);
  });
});

describe('resolve and raw', () => {
  let imageId;
  beforeAll(async () => {
    imageId = (await upload(docIds[0])).body.id;
  });

  test('resolve as viewer returns the relative raw path, no-store', async () => {
    const res = await request(app)
      .get(`/api/docs/${docIds[0]}/images/${imageId}`)
      .set('Authorization', `Bearer ${tokens.viewer}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: `/api/docs/${docIds[0]}/images/${imageId}/raw` });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  function expectRawImage(res) {
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body)).toEqual(PNG);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  }

  const raw = () => request(app).get(`/api/docs/${docIds[0]}/images/${imageId}/raw`).buffer(true).parse((r, cb) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  test('raw with Bearer streams the bytes with the stored type and safety headers', async () => {
    expectRawImage(await raw().set('Authorization', `Bearer ${tokens.viewer}`));
  });

  test('raw with only the accessToken cookie (an <img> request) works for a viewer', async () => {
    expectRawImage(await raw().set('Cookie', `accessToken=${tokens.viewer}`));
  });

  test('raw with no credentials is 401', async () => {
    const res = await raw();
    expect(res.status).toBe(401);
  });

  test('raw with an invalid cookie is 401', async () => {
    const res = await raw().set('Cookie', 'accessToken=not-a-token');
    expect(res.status).toBe(401);
  });

  test('raw as a user without access is 403 (header and cookie)', async () => {
    expect((await raw().set('Authorization', `Bearer ${tokens.stranger}`)).status).toBe(403);
    expect((await raw().set('Cookie', `accessToken=${tokens.stranger}`)).status).toBe(403);
  });

  test('unknown image id is 404', async () => {
    const res = await request(app)
      .get(`/api/docs/${docIds[0]}/images/${randomUUID()}/raw`)
      .set('Cookie', `accessToken=${tokens.viewer}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Image not found' });
  });

  test('an image of another document is 404', async () => {
    const otherId = (await upload(docIds[1])).body.id;
    const res = await request(app)
      .get(`/api/docs/${docIds[0]}/images/${otherId}/raw`)
      .set('Cookie', `accessToken=${tokens.owner}`);
    expect(res.status).toBe(404);
  });

  test('a row whose bytes are missing from the driver is 404', async () => {
    const id = (await upload(docIds[0])).body.id;
    await storage.deleteObjects([`doc-images/${docIds[0]}/${id}`]);
    const res = await request(app)
      .get(`/api/docs/${docIds[0]}/images/${id}/raw`)
      .set('Cookie', `accessToken=${tokens.owner}`);
    expect(res.status).toBe(404);
  });

  test('bytes survive a fresh local driver over the same directory (restart)', async () => {
    const fresh = createLocalDriver({ dataDir });
    const restarted = makeApp({ ...fresh, kind: 'local' });
    const res = await request(restarted)
      .get(`/api/docs/${docIds[0]}/images/${imageId}/raw`)
      .set('Cookie', `accessToken=${tokens.viewer}`)
      .buffer(true)
      .parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body)).toEqual(PNG);
  });
});

describe('storage unusable', () => {
  const disabled = { kind: 'local', isEnabled: () => false };

  test('upload is 503', async () => {
    const a = makeApp({ ...storage.current(), ...disabled });
    const res = await request(a)
      .post(`/api/docs/${docIds[0]}/images`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ mimeType: 'image/png', dataBase64: PNG.toString('base64') });
    expect(res.status).toBe(503);
  });

  test('resolve of an existing image keeps today\'s 503', async () => {
    const id = (await upload(docIds[0])).body.id;
    const a = makeApp({ ...storage.current(), ...disabled });
    const res = await request(a)
      .get(`/api/docs/${docIds[0]}/images/${id}`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Image storage is not configured' });
  });
});

describe('S3 driver (mocked)', () => {
  const s3Stub = (enabled) => ({
    kind: 's3',
    isEnabled: () => enabled,
    getSignedGetUrl: jest.fn(async (key) => `https://bucket.s3.example/${key}?sig=1`),
    readObject: jest.fn(async () => ({ body: PNG, contentType: 'image/png' })),
  });

  test('resolve returns the presigned URL', async () => {
    const id = (await upload(docIds[0])).body.id;
    const stub = s3Stub(true);
    const res = await request(makeApp(stub))
      .get(`/api/docs/${docIds[0]}/images/${id}`)
      .set('Authorization', `Bearer ${tokens.viewer}`);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(`https://bucket.s3.example/doc-images/${docIds[0]}/${id}?sig=1`);
  });

  test('upload with no bucket is 503 (US4 scenario 7)', async () => {
    const res = await request(makeApp(s3Stub(false)))
      .post(`/api/docs/${docIds[0]}/images`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ mimeType: 'image/png', dataBase64: PNG.toString('base64') });
    expect(res.status).toBe(503);
  });
});
