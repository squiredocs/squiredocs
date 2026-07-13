/**
 * modify + fromMarkdown image rehost tie-in (feature 002, US3 / T028, FR-021).
 *
 * A modify script that inserts fromMarkdown output containing an external
 * image ⇒ the post-script pass rehosts it (fake fetch) or degrades to a link.
 * A directly-authored external-src image in the same script is still STRIPPED
 * (the FR-021 boundary: only import-origin externals rehost).
 *
 * Uses the full modify harness (real isolate bundle + WS-backed doc service).
 */

// Mock S3 so image storage exercises the DB path without real object storage.
jest.mock('../../../s3-images', () => ({
  isEnabled: jest.fn(() => true),
  putObject: jest.fn(async () => {}),
  getObject: jest.fn(async () => Buffer.alloc(0)),
  copyObject: jest.fn(async () => {}),
  getSignedGetUrl: jest.fn(async () => 'https://example.com/signed'),
  deleteObjects: jest.fn(async () => {}),
  cspImageSources: jest.fn(() => []),
  GET_URL_TTL_SECONDS: 3600,
}));

// Fake the SSRF-safe fetch so no real network is touched, but route it through
// the REAL rehost pipeline (dedup, storeImage, src rewrite / degrade). We wrap
// rehostImagesInFragment to inject the fake fetch — internal callers reference
// the local safeFetchImage binding, so mocking the export alone wouldn't apply.
jest.mock('../../../image-rehost', () => {
  const actual = jest.requireActual('../../../image-rehost');
  const fakeFetch = async (src) => {
    if (src.includes('good')) return { data: Buffer.from('PNG'), mimeType: 'image/png' };
    throw new actual.PolicyError('network-error', 'down');
  };
  return {
    ...actual,
    rehostImagesInFragment: (target, ctx, opts = {}) =>
      actual.rehostImagesInFragment(target, ctx, { fetchImage: fakeFetch, ...opts }),
  };
});

const Y = require('yjs');
const WebSocket = require('ws');
const http = require('http');
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const { setupWSConnection, setPersistence, getYDoc } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../../../origin');
const documents = require('../../../documents');
const documentService = require('../../../document-service');
const toolRegistry = require('../../tools/index');
const agentPresence = require('../../agent-presence');
const { toMarkdown } = require('../../yjs/serialization');
const documentImages = require('../../../document-images');

const pool = createPool();
const persistence = createPersistence();
const pendingOperations = [];
const extractDocGuid = (n) => (n.startsWith('s/') ? n.slice(2) : n);

describe('modify + fromMarkdown rehost tie-in', () => {
  let userId;
  let httpServer;
  let wss;
  const createdDocIds = [];

  beforeAll(async () => {
    const persistQueues = new Map();
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = extractDocGuid(docName);
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          const prev = persistQueues.get(docGuid) || Promise.resolve();
          const next = prev
            .then(() => persistence.storeUpdate(docGuid, update, parsed.userId, parsed.agentName))
            .catch((err) => console.error(`persist err ${docGuid}:`, err));
          persistQueues.set(docGuid, next);
          pendingOperations.push(next);
        });
        try {
          const persisted = await persistence.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), ORIGIN_DB_LOAD);
        } catch (_) { /* new doc */ }
      },
      writeState: async () => {},
      provider: persistence,
    });

    documentService.init(getYDoc, extractDocGuid);
    documents.init(pool);
    documentImages.init(pool);
    toolRegistry.init(persistence);
    agentPresence.init(persistence);

    const u = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-modify-fm-rehost', 'modify-fm-rehost@test.local', 'FM Rehost User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`
    );
    userId = u.rows[0].id;

    httpServer = http.createServer();
    wss = new WebSocket.Server({ server: httpServer, verifyClient: () => true });
    wss.on('connection', (ws, req) => {
      ws.userId = userId;
      ws.agentName = 'Test Agent';
      setupWSConnection(ws, req, { gc: false });
    });
    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        process.env.WS_PORT = httpServer.address().port;
        process.env.WS_HOST = 'localhost';
        process.env.WS_PROTOCOL = 'ws';
        resolve();
      });
    });
  });

  afterAll(async () => {
    agentPresence.clearUserSessions(userId);
    await new Promise((r) => setTimeout(r, 100));
    wss.close();
    await new Promise((r) => httpServer.close(r));
    await new Promise((r) => setTimeout(r, 100));
    await Promise.all(pendingOperations);
    for (const docId of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docId]);
      await pool.query('DELETE FROM document_images WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
    await persistence.destroy();
  }, 15000);

  const agentToken = () => ({
    userId,
    agentId: 'test-agent',
    agentName: 'Test Agent',
    delegationId: 'test-delegation',
    scopes: ['documents:write'],
    rawToken: 'test-token-' + Date.now(),
  });

  async function flush() {
    await new Promise((r) => setTimeout(r, 150));
    await Promise.all(pendingOperations);
  }

  async function makeDoc() {
    const created = await toolRegistry.getTool('create_document').handler(
      { title: 'FM Rehost Doc' }, agentToken()
    );
    createdDocIds.push(created.docGuid);
    await flush();
    return created.docGuid;
  }

  function liveFragment(docGuid) {
    return documentService.getSharedDoc(docGuid).get('default', Y.XmlFragment);
  }

  test('fromMarkdown external image is rehosted; direct appendBlocks external is stripped', async () => {
    const docGuid = await makeDoc();
    const script = `
      export default function edit(doc) {
        // Import-origin image (via fromMarkdown) → should be rehosted.
        doc.insert(doc.length, fromMarkdown("![diagram](https://good.example.com/d.png)"));
        // Directly-authored external image → should be stripped (FR-021 boundary).
        appendBlocks(doc, [
          { type: 'image', src: 'https://direct.example.com/x.png', alt: 'direct' }
        ]);
      }
    `;
    const result = await toolRegistry.getTool('modify').handler(
      { docGuid, script }, agentToken()
    );
    await flush();

    // Rehost report present; one app-image row created for the doc.
    expect(result.imagesRehosted).toEqual([
      { src: 'https://good.example.com/d.png', url: expect.stringMatching(new RegExp(`^/api/docs/${docGuid}/images/`)) },
    ]);
    const rows = await pool.query('SELECT uploader_id FROM document_images WHERE doc_id = $1', [docGuid]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].uploader_id).toBe(userId);

    // The directly-authored external image was stripped and reported.
    expect(result.imageErrors && result.imageErrors.length).toBeGreaterThanOrEqual(1);

    const md = toMarkdown(liveFragment(docGuid));
    // Rehosted image now carries an app URL; no external srcs remain anywhere.
    expect(md).toContain(`![diagram](${result.imagesRehosted[0].url})`);
    expect(md).not.toContain('https://good.example.com');
    expect(md).not.toContain('https://direct.example.com');
    // No transient marker leaks into the stored document.
    expect(md).not.toContain('data-import-origin');
  });

  test('fromMarkdown external image that fails to fetch degrades to a plain link', async () => {
    const docGuid = await makeDoc();
    const script = `
      export default function edit(doc) {
        doc.insert(doc.length, fromMarkdown("![offline](https://bad.example.com/x.png)"));
      }
    `;
    const result = await toolRegistry.getTool('modify').handler(
      { docGuid, script }, agentToken()
    );
    await flush();

    expect(result.imagesRehosted).toBeUndefined();
    expect(result.imagesDegraded).toEqual([
      { src: 'https://bad.example.com/x.png', reason: 'network-error' },
    ]);
    const md = toMarkdown(liveFragment(docGuid));
    // Degraded to a plain link — text kept, href = original.
    expect(md).toContain('[offline](https://bad.example.com/x.png)');
    expect(md).not.toMatch(/!\[offline\]/);
  });
});
