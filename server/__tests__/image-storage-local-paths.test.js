/**
 * Feature 058 (T034, FR-015): every other image byte path works on the local
 * driver, through the real modules: bundle export, cross-document copy,
 * markdown-import rehosting, the assistant's view_image tool, and document
 * deletion. The S3-mocked cases in each module's own suite are unchanged.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Y = require('yjs');
const { randomUUID } = require('crypto');

const { createPool, createTestUser, cleanupTestUser, cleanupDocRows } = require('./helpers/db');
const { _resetInstanceConfigForTests } = require('../instance-config');
const documents = require('../documents');
const documentImages = require('../document-images');
const storage = require('../image-storage');
const { collectBundleAssets } = require('../api/docs-export');
const { rehostImagesInFragment } = require('../image-rehost');
const { buildImageTools } = require('../api/chat-tools');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

let pool;
let dataDir;
let userId;
const docIds = [randomUUID(), randomUUID()];
const saved = {};

const objectFile = (key) => path.join(dataDir, 'images', 'objects', key);

beforeAll(async () => {
  for (const k of ['STORAGE_DRIVER', 'SQUIRE_DATA_DIR']) saved[k] = process.env[k];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-local-paths-'));
  process.env.STORAGE_DRIVER = 'local';
  process.env.SQUIRE_DATA_DIR = dataDir;
  _resetInstanceConfigForTests();

  pool = createPool();
  documents.init(pool);
  documentImages.init(pool);
  userId = await createTestUser(pool, `local-paths-${randomUUID().slice(0, 8)}@example.com`);
  for (const id of docIds) await documents.createDocument(id, userId, 'Local paths');
});

afterAll(async () => {
  try {
    await cleanupDocRows(pool, docIds);
    await pool.query('DELETE FROM document_images WHERE doc_id = ANY($1::uuid[])', [docIds]);
    await cleanupTestUser(pool, userId);
  } finally {
    await pool.end();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetInstanceConfigForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the facade is on the local driver for this suite', () => {
  expect(storage.kind).toBe('local');
  expect(storage.isEnabled()).toBe(true);
});

test('bundle export includes the image bytes', async () => {
  const { id, url } = await documentImages.storeImage({ docId: docIds[0], uploaderId: userId, data: PNG, mimeType: 'image/png' });
  const md = `# Title\n\n![alt](${url})\n`;
  const out = await collectBundleAssets(md, docIds[0], 'title');
  expect(out.assets).toEqual([{ name: `assets/title/${id}.png`, data: PNG }]);
  expect(out.markdown).toContain(`./assets/title/${id}.png`);
});

test('document copy copies the object', async () => {
  const src = await documentImages.storeImage({ docId: docIds[0], uploaderId: userId, data: PNG, mimeType: 'image/png' });
  const copy = await documentImages.copyImage({
    sourceImageId: src.id, sourceDocId: docIds[0], targetDocId: docIds[1], uploaderId: userId,
  });
  expect(copy).toBeTruthy();
  const row = await documentImages.getImage(copy.id, docIds[1]);
  expect(fs.readFileSync(objectFile(row.s3_key))).toEqual(PNG);
  expect(await storage.readObject(row.s3_key)).toEqual({ body: PNG, contentType: 'image/png' });
});

test('markdown-import rehost stores the fetched bytes', async () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  const img = new Y.XmlElement('image');
  img.setAttribute('src', 'https://images.example.com/pic.png');
  fragment.insert(0, [img]);

  const report = await rehostImagesInFragment(fragment, { docId: docIds[0], userId }, {
    fetchImage: async () => ({ data: PNG, mimeType: 'image/png' }),
  });
  expect(report.degraded).toEqual([]);
  expect(report.rehosted).toHaveLength(1);
  const newSrc = img.getAttribute('src');
  const imageId = newSrc.split('/').pop();
  const row = await documentImages.getImage(imageId, docIds[0]);
  expect(fs.readFileSync(objectFile(row.s3_key))).toEqual(PNG);
});

test("the assistant's view_image tool reads the bytes", async () => {
  const { id } = await documentImages.storeImage({ docId: docIds[0], uploaderId: userId, data: PNG, mimeType: 'image/png' });
  const tools = buildImageTools({ userId, agentName: 'Assistant' }, { docGuid: docIds[0] });
  const output = await tools.view_image.execute({ imageId: id });
  expect(output).toMatchObject({ imageId: id, viewed: true });
  const modelOutput = await tools.view_image.toModelOutput({ output });
  expect(modelOutput.type).toBe('content');
  expect(modelOutput.value[1]).toEqual({ type: 'image-data', data: PNG.toString('base64'), mediaType: 'image/png' });
});

test('document deletion removes the files', async () => {
  const docId = randomUUID();
  docIds.push(docId);
  await documents.createDocument(docId, userId, 'To delete');
  const a = await documentImages.storeImage({ docId, uploaderId: userId, data: PNG, mimeType: 'image/png' });
  const b = await documentImages.storeImage({ docId, uploaderId: userId, data: PNG, mimeType: 'image/gif' });
  const keys = await documentImages.listKeysForDoc(docId);
  expect(keys).toHaveLength(2);
  for (const k of keys) expect(fs.existsSync(objectFile(k))).toBe(true);

  await documentImages.deleteImageBytesForDoc(docId);

  for (const k of keys) {
    expect(fs.existsSync(objectFile(k))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'images', 'meta', `${k}.json`))).toBe(false);
  }
  expect([a.id, b.id]).toHaveLength(2);
});
