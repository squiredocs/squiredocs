/**
 * Bundle export tests (feature 003, T024 — FR-017..FR-021, SC-004,
 * contracts/bundle-zip-layout.md).
 *
 * Exercises the real export router + real document_images rows against the
 * test DB, with S3 mocked per the existing image-test pattern. Zip output is
 * verified with a minimal central-directory reader (also an implicit
 * structural-validity check of the archive).
 */

jest.mock('../image-storage', () => ({
  isEnabled: jest.fn(() => true),
  getObject: jest.fn(),
}));

const zlib = require('zlib');
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const Y = require('yjs');
const documents = require('../documents');
const documentImages = require('../document-images');
const imageStorage = require('../image-storage');
const { generateAccessToken } = require('../auth/jwt');
const { createExportRouter, slugifyDocTitle } = require('../api/docs-export');
const { parseFrontmatter } = require('../../shared/markdown/frontmatter');
const { createPool, createPersistence } = require('./helpers/db');

// --- minimal zip reader ------------------------------------------------------

/** Parse a zip buffer into { name → Buffer } using the central directory. */
function readZip(buffer) {
  const entries = {};
  // Find EOCD (0x06054b50), scan backwards
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('no EOCD — not a zip');
  const count = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central header');
    const method = buffer.readUInt16LE(off + 10);
    const compressedSize = buffer.readUInt32LE(off + 20);
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    const localOff = buffer.readUInt32LE(off + 42);
    const name = buffer.toString('utf8', off + 46, off + 46 + nameLen);
    // Local header: 30 fixed + name + extra (local extra may differ from central)
    const lNameLen = buffer.readUInt16LE(localOff + 26);
    const lExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buffer.slice(dataStart, dataStart + compressedSize);
    entries[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function binaryBody(req) {
  return req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

// --- fixtures ----------------------------------------------------------------

const imageUrl = (docId, imageId) => `/api/docs/${docId}/images/${imageId}`;

function buildImageDocUpdate(title, imageSrcs, alt = 'pic') {
  const ydoc = new Y.Doc();
  const frag = ydoc.get('default', Y.XmlFragment);
  ydoc.transact(() => {
    const blocks = [];
    const para = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'Doc with images');
    para.insert(0, [t]);
    blocks.push(para);
    for (const src of imageSrcs) {
      const img = new Y.XmlElement('image');
      img.setAttribute('src', src);
      img.setAttribute('alt', alt);
      blocks.push(img);
    }
    frag.insert(0, blocks);
    if (title !== undefined) ydoc.getMap('meta').set('title', title);
  });
  return Y.encodeStateAsUpdate(ydoc);
}

describe('API: GET /api/docs/:docId/export?format=bundle', () => {
  let app;
  let pool;
  let persistence;
  let userId;
  let otherUserId;
  let authToken;
  let otherToken;
  let docId;

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    await persistence._init();
    documents.init(pool);
    documentImages.init(pool);

    const u1 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-bundle-1', 'test-bundle-1@example.com', 'Bundle User', NULL)
       RETURNING id, email, name, picture, is_admin`
    );
    userId = u1.rows[0].id;
    authToken = generateAccessToken(u1.rows[0]);

    const u2 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-bundle-2', 'test-bundle-2@example.com', 'No Access', NULL)
       RETURNING id, email, name, picture, is_admin`
    );
    otherUserId = u2.rows[0].id;
    otherToken = generateAccessToken(u2.rows[0]);

    app = express();
    app.use(createExportRouter(persistence));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userId, otherUserId]);
    await persistence.destroy();
    await pool.end();
  });

  beforeEach(async () => {
    docId = crypto.randomUUID();
    docCreated = false;
    imageStorage.isEnabled.mockReturnValue(true);
    imageStorage.getObject.mockImplementation(async (key) => Buffer.from(`bytes-of:${key}`));
  });

  afterEach(async () => {
    await pool.query('DELETE FROM document_images WHERE doc_id = $1', [docId]);
    await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
    await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    await persistence.clearDocument(docId);
    jest.clearAllMocks();
  });

  let docCreated = false;

  async function ensureDoc() {
    if (!docCreated) {
      await documents.createDocument(docId, userId);
      docCreated = true;
    }
  }

  async function seedImageRow(imageId, mime = 'image/png') {
    await ensureDoc(); // FK: document_images.doc_id → documents.id
    await documentImages.createImage({
      id: imageId,
      docId,
      uploaderId: userId,
      mimeType: mime,
      filename: 'orig.png',
      byteSize: 10,
      s3Key: `doc-images/${docId}/${imageId}`,
    });
  }

  async function seedDoc(title, imageSrcs, alt) {
    await ensureDoc();
    await persistence.storeUpdate(docId, buildImageDocUpdate(title, imageSrcs, alt), userId);
  }

  async function fetchBundle(query = 'format=bundle', token = authToken) {
    const res = await binaryBody(
      request(app)
        .get(`/api/docs/${docId}/export?${query}`)
        .set('Authorization', `Bearer ${token}`)
    );
    return res;
  }

  test('zip contains the markdown + one asset per image, refs rewritten, map complete', async () => {
    const img1 = crypto.randomUUID();
    const img2 = crypto.randomUUID();
    await seedImageRow(img1, 'image/png');
    await seedImageRow(img2, 'image/jpeg');
    await seedDoc('Payments Redesign', [imageUrl(docId, img1), imageUrl(docId, img2)]);

    const res = await fetchBundle();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="Payments Redesign.zip"');

    const entries = readZip(res.body);
    const slug = slugifyDocTitle('Payments Redesign');
    expect(Object.keys(entries).sort()).toEqual([
      'Payments Redesign.md',
      `assets/${slug}/${img1}.png`,
      `assets/${slug}/${img2}.jpg`,
    ].sort());

    const md = entries['Payments Redesign.md'].toString('utf8');
    expect(md).toContain(`./assets/${slug}/${img1}.png`);
    expect(md).toContain(`./assets/${slug}/${img2}.jpg`);
    expect(md).not.toContain(`/api/docs/${docId}/images/`);

    // asset bytes come from S3 by s3_key
    expect(entries[`assets/${slug}/${img1}.png`].toString()).toBe(`bytes-of:doc-images/${docId}/${img1}`);

    // frontmatter: bundle defaults (portable + frontmatter on) and images map
    const { squire } = parseFrontmatter(md);
    expect(squire.flavor).toBe('portable');
    expect(squire.images).toEqual({
      [`./assets/${slug}/${img1}.png`]: img1,
      [`./assets/${slug}/${img2}.jpg`]: img2,
    });
    // every map key appears in the body as a rewritten ref (US4-AS2)
    for (const rel of Object.keys(squire.images)) {
      expect(md).toContain(`](${rel})`);
    }
  });

  test('bracketed alt text: image is still escaped, rewritten, and bundled (F4)', async () => {
    const img = crypto.randomUUID();
    await seedImageRow(img, 'image/png');
    // Alt with literal brackets would close the `![...]` span early and hide
    // the reference from the scanner unless the serializer escapes them.
    await seedDoc('Charts', [imageUrl(docId, img)], 'chart [v2]');

    const res = await fetchBundle();
    expect(res.status).toBe(200);
    const entries = readZip(res.body);
    const slug = slugifyDocTitle('Charts');
    // The asset was collected (proves the scanner matched the escaped ref).
    expect(Object.keys(entries)).toContain(`assets/${slug}/${img}.png`);

    const md = entries['Charts.md'].toString('utf8');
    // Alt is escaped and well-formed; the ref is rewritten to the bundle path.
    expect(md).toContain(`![chart \\[v2\\]](./assets/${slug}/${img}.png)`);
    expect(md).not.toContain(`/api/docs/${docId}/images/`);

    const { squire } = parseFrontmatter(md);
    expect(squire.images).toEqual({ [`./assets/${slug}/${img}.png`]: img });
  });

  test('duplicate references: one asset, one map entry, all refs rewritten', async () => {
    const img = crypto.randomUUID();
    await seedImageRow(img);
    await seedDoc('Dup Doc', [imageUrl(docId, img), imageUrl(docId, img)]);

    const res = await fetchBundle();
    const entries = readZip(res.body);
    const slug = slugifyDocTitle('Dup Doc');
    expect(Object.keys(entries)).toHaveLength(2); // md + one asset
    const md = entries['Dup Doc.md'].toString('utf8');
    const rewritten = md.match(new RegExp(`\\./assets/${slug}/${img}\\.png`, 'g'));
    expect(rewritten.length).toBeGreaterThanOrEqual(2); // both refs + map key
    const { squire } = parseFrontmatter(md);
    expect(Object.keys(squire.images)).toHaveLength(1);
  });

  test('no images: valid zip with just the markdown (US4-AS3)', async () => {
    await seedDoc('Plain Doc', []);
    const res = await fetchBundle();
    expect(res.status).toBe(200);
    const entries = readZip(res.body);
    expect(Object.keys(entries)).toEqual(['Plain Doc.md']);
    const { squire } = parseFrontmatter(entries['Plain Doc.md'].toString('utf8'));
    expect(squire.images).toBeUndefined(); // no rewritten refs → key omitted
  });

  test('per-image degradation: failed S3 fetch keeps the app URL, omits asset+map (FR-021)', async () => {
    const good = crypto.randomUUID();
    const bad = crypto.randomUUID();
    await seedImageRow(good);
    await seedImageRow(bad);
    imageStorage.getObject.mockImplementation(async (key) => {
      if (key.includes(bad)) throw new Error('NoSuchKey');
      return Buffer.from(`bytes-of:${key}`);
    });
    await seedDoc('Partial Doc', [imageUrl(docId, good), imageUrl(docId, bad)]);

    const res = await fetchBundle();
    expect(res.status).toBe(200);
    const entries = readZip(res.body);
    const slug = slugifyDocTitle('Partial Doc');
    expect(Object.keys(entries).sort()).toEqual([
      'Partial Doc.md',
      `assets/${slug}/${good}.png`,
    ].sort());
    const md = entries['Partial Doc.md'].toString('utf8');
    expect(md).toContain(`./assets/${slug}/${good}.png`);
    expect(md).toContain(imageUrl(docId, bad)); // original URL kept
    const { squire } = parseFrontmatter(md);
    expect(squire.images).toEqual({ [`./assets/${slug}/${good}.png`]: good });
  });

  test('missing document_images row: image skipped, export succeeds', async () => {
    const ghost = crypto.randomUUID(); // no row seeded
    await seedDoc('Ghost Doc', [imageUrl(docId, ghost)]);
    const res = await fetchBundle();
    expect(res.status).toBe(200);
    const entries = readZip(res.body);
    expect(Object.keys(entries)).toEqual(['Ghost Doc.md']);
    expect(entries['Ghost Doc.md'].toString('utf8')).toContain(imageUrl(docId, ghost));
  });

  test('storage disabled: valid bundle with zero assets, refs untouched', async () => {
    const img = crypto.randomUUID();
    await seedImageRow(img);
    imageStorage.isEnabled.mockReturnValue(false);
    await seedDoc('No Storage', [imageUrl(docId, img)]);

    const res = await fetchBundle();
    expect(res.status).toBe(200);
    const entries = readZip(res.body);
    expect(Object.keys(entries)).toEqual(['No Storage.md']);
    expect(entries['No Storage.md'].toString('utf8')).toContain(imageUrl(docId, img));
  });

  test('foreign-doc image URLs are left untouched and excluded (FR-017)', async () => {
    const foreignDoc = crypto.randomUUID();
    const foreignImg = crypto.randomUUID();
    const mine = crypto.randomUUID();
    await seedImageRow(mine);
    await seedDoc('Scoped Doc', [imageUrl(docId, mine), imageUrl(foreignDoc, foreignImg)]);

    const res = await fetchBundle();
    const entries = readZip(res.body);
    const slug = slugifyDocTitle('Scoped Doc');
    expect(Object.keys(entries).sort()).toEqual([
      'Scoped Doc.md',
      `assets/${slug}/${mine}.png`,
    ].sort());
    const md = entries['Scoped Doc.md'].toString('utf8');
    expect(md).toContain(imageUrl(foreignDoc, foreignImg)); // untouched
    const { squire } = parseFrontmatter(md);
    expect(Object.keys(squire.images)).toEqual([`./assets/${slug}/${mine}.png`]);
  });

  test('determinism: two exports have identical entry names and rewritten refs (SC-004)', async () => {
    const img1 = crypto.randomUUID();
    const img2 = crypto.randomUUID();
    await seedImageRow(img1);
    await seedImageRow(img2, 'image/webp');
    await seedDoc('Stable Doc', [imageUrl(docId, img1), imageUrl(docId, img2)]);

    const [a, b] = [await fetchBundle(), await fetchBundle()];
    const ea = readZip(a.body);
    const eb = readZip(b.body);
    expect(Object.keys(ea)).toEqual(Object.keys(eb)); // names AND order
    const stripExportedAt = (s) => s.replace(/^ {2}exportedAt: .*$/m, '');
    expect(stripExportedAt(ea['Stable Doc.md'].toString('utf8')))
      .toBe(stripExportedAt(eb['Stable Doc.md'].toString('utf8')));
  });

  test('bundle defaults are overridable: flavor=squire&frontmatter=false (FR-020)', async () => {
    const img = crypto.randomUUID();
    await seedImageRow(img);
    await seedDoc('Override Doc', [imageUrl(docId, img)]);

    const res = await fetchBundle('format=bundle&flavor=squire&frontmatter=false');
    expect(res.status).toBe(200);
    const entries = readZip(res.body);
    const md = entries['Override Doc.md'].toString('utf8');
    expect(md.startsWith('---')).toBe(false); // no frontmatter
    const slug = slugifyDocTitle('Override Doc');
    expect(md).toContain(`./assets/${slug}/${img}.png`); // assets still bundled
  });

  test('requester without view access gets 403, same as markdown export', async () => {
    await seedDoc('Private Doc', []);
    const [bundle, markdown] = [
      await fetchBundle('format=bundle', otherToken),
      await request(app).get(`/api/docs/${docId}/export`).set('Authorization', `Bearer ${otherToken}`),
    ];
    expect(bundle.status).toBe(403);
    expect(markdown.status).toBe(403);
  });

  describe('slugifyDocTitle edge cases (FR-019)', () => {
    test('derivation never throws and falls back to "doc"', () => {
      expect(slugifyDocTitle('')).toBe('doc');
      expect(slugifyDocTitle(null)).toBe('doc');
      expect(slugifyDocTitle(undefined)).toBe('doc');
      expect(slugifyDocTitle('日本語のみ')).toBe('doc');
      expect(slugifyDocTitle('!!! ???')).toBe('doc');
    });

    test('normalizes diacritics, case, separators; caps at 60', () => {
      expect(slugifyDocTitle('Café Décor — Übersicht!')).toBe('cafe-decor-ubersicht');
      expect(slugifyDocTitle('Hello World')).toBe('hello-world');
      expect(slugifyDocTitle('A'.repeat(200)).length).toBeLessThanOrEqual(60);
    });
  });
});
