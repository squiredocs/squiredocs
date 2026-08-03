/**
 * Cross-document image reconciliation on the sync-push path (feature 004, F1).
 *
 * A push that materializes an image node pointing at a DIFFERENT document must
 * run the SAME access-checked copy-or-strip policy import uses (FR-020): if the
 * pusher can read the source doc the image is copied into the target and the src
 * rewritten; otherwise the node is stripped (never leave a reference the author
 * couldn't read). S3 is mocked so the copy exercises the DB + reconcile logic
 * without real object storage — mirrors modify-sources.test.js.
 */

// Must be declared before the modules that read s3-images load.
jest.mock('../../server/s3-images', () => ({
  isEnabled: jest.fn(() => true),
  putObject: jest.fn(async () => {}),
  getObject: jest.fn(async () => Buffer.alloc(0)),
  copyObject: jest.fn(async () => {}),
  getSignedGetUrl: jest.fn(async () => 'https://example.com/signed'),
  deleteObjects: jest.fn(async () => {}),
  cspImageSources: jest.fn(() => []),
  GET_URL_TTL_SECONDS: 3600,
}));

const request = require('supertest');
const express = require('express');
const Y = require('yjs');
const { randomUUID } = require('crypto');

const { createPool, createPersistence } = require('../../server/__tests__/helpers/db');
const pool = createPool();
const persistence = createPersistence();

const documents = require('../../server/documents');
const documentService = require('../../server/document-service');
const documentImages = require('../../server/document-images');
const apiTokens = require('../../server/mcp/auth/api-tokens');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../../server/origin');
const { toMarkdown, buildFrontmatter } = require('../../server/mcp/yjs/serialization');
const { imageUrl } = require('../../server/image-url');
const { createImportRouter } = require('../../server/api/docs-import');

const pendingOperations = [];
async function drain() { await Promise.all(pendingOperations.splice(0)); }

function fileFor(docId, clock, body) {
  const fm = buildFrontmatter({
    docGuid: docId, title: 'T', clock,
    exportedAt: '2026-01-01T00:00:00Z', lastModifiedBy: '', flavor: 'squire',
  });
  return fm + '\n' + body;
}

async function currentBody(docId) {
  const doc = await persistence.getYDoc(docId);
  const md = toMarkdown(doc.get('default', Y.XmlFragment));
  doc.destroy();
  return md;
}
async function maxClock(docId) {
  const r = await pool.query('SELECT MAX(clock)::int AS c FROM yjs_updates WHERE doc_guid=$1', [docId]);
  return r.rows[0].c;
}

describe('sync-push cross-doc image reconciliation (mode=sync)', () => {
  let app;
  let pusherId; let strangerId; let pusherPat;
  const createdDocIds = [];

  beforeAll(async () => {
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          pendingOperations.push(
            persistence.storeUpdate(docGuid, update, parsed.userId, parsed.agentName)
              .catch((err) => console.error(`persist error for ${docGuid}:`, err))
          );
        });
        try {
          const persisted = await persistence.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), ORIGIN_DB_LOAD);
        } catch { /* fresh doc */ }
        // Mirrors the real createBindState's completion mark, which the 048
        // bind-readiness gate in updateDocument waits on.
        ydoc._bindComplete = true;
      },
      writeState: async () => {},
      provider: persistence,
    });
    documentService.init(getYDoc, (docName) => (docName.startsWith('s/') ? docName.slice(2) : docName));
    documents.init(pool);
    documentImages.init(pool);
    apiTokens.init(pool);

    const u1 = await pool.query(
      `INSERT INTO users (google_id, email, name) VALUES ('xdoc-1','xdoc-push@example.com','Pusher')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
    pusherId = u1.rows[0].id;
    const u2 = await pool.query(
      `INSERT INTO users (google_id, email, name) VALUES ('xdoc-2','xdoc-stranger@example.com','Stranger')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
    strangerId = u2.rows[0].id;
    pusherPat = (await apiTokens.createToken(pusherId, 'xdoc default')).token;

    app = express();
    app.use(createImportRouter(persistence));
  });

  afterAll(async () => {
    await drain();
    for (const id of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [id]);
      await pool.query('DELETE FROM document_images WHERE doc_id = $1', [id]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [id]);
      await pool.query('DELETE FROM documents WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id IN ($1,$2)', [pusherId, strangerId]);
    await pool.query('DELETE FROM users WHERE id IN ($1,$2)', [pusherId, strangerId]);
    await persistence.destroy();
    await pool.end();
  });

  /** Seed a doc owned by `ownerId` with a markdown body; returns { docId, clock, body }. */
  async function seedDoc(ownerId, body) {
    const docId = await documentService.createSeededDocument({
      userId: ownerId, title: 'Doc',
      nodes: require('../../server/mcp/yjs/pm-json-to-nodes').pmJsonToNodes(
        require('../../shared/markdown').markdownToPm(body)
      ),
    });
    createdDocIds.push(docId);
    await drain();
    return { docId, clock: await maxClock(docId), body: await currentBody(docId) };
  }

  /** Create an image row on `docId` and return its app URL. */
  async function seedImage(docId, uploaderId) {
    const id = randomUUID();
    await documentImages.createImage({
      id, docId, uploaderId, mimeType: 'image/png', filename: 'chart.png',
      byteSize: 1234, s3Key: `doc-images/${docId}/${id}`,
    });
    return imageUrl(docId, id);
  }

  function put(docId, body) {
    return request(app)
      .put(`/api/docs/${docId}/import?mode=sync`)
      .set('Authorization', `Bearer ${pusherPat}`)
      .set('Content-Type', 'text/markdown')
      .send(body);
  }

  test('cross-doc image the pusher CAN read → copied into the target, src rewritten', async () => {
    // Source doc owned by the stranger, with an image; pusher granted viewer.
    const source = await seedDoc(strangerId, '# Source\n\nsource body');
    const srcUrl = await seedImage(source.docId, strangerId);
    await documents.setRole(source.docId, pusherId, 'viewer');

    const target = await seedDoc(pusherId, '# Target\n\ntarget body');
    const res = await put(target.docId, fileFor(target.docId, target.clock,
      target.body + `\n\n![chart](${srcUrl})`));
    await drain();

    expect(res.status).toBe(200);
    expect(res.body.images.copied).toHaveLength(1);
    expect(res.body.images.copied[0].from).toBe(srcUrl);
    const newUrl = res.body.images.copied[0].to;
    expect(newUrl).toMatch(new RegExp(`^/api/docs/${target.docId}/images/`));
    expect(res.body.images.rejected).toEqual([]);

    const after = await currentBody(target.docId);
    expect(after).toContain(newUrl);
    expect(after).not.toContain(srcUrl); // the source-doc URL never persisted
  });

  test('cross-doc image the pusher CANNOT read → stripped, itemized in the receipt', async () => {
    const source = await seedDoc(strangerId, '# Secret\n\nsecret body');
    const srcUrl = await seedImage(source.docId, strangerId);
    // no share to the pusher

    const target = await seedDoc(pusherId, '# Target2\n\ntarget body');
    const res = await put(target.docId, fileFor(target.docId, target.clock,
      target.body + `\n\n![leak](${srcUrl})`));
    await drain();

    expect(res.status).toBe(200);
    expect(res.body.images.copied).toEqual([]);
    expect(res.body.images.rejected).toEqual([
      { src: srcUrl, reason: 'source document not accessible' },
    ]);
    const after = await currentBody(target.docId);
    expect(after).not.toContain(srcUrl); // reference stripped, not leaked
  });
});
