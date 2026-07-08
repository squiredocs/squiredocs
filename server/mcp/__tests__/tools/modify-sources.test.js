/**
 * modify tool sourceDocGuids tests.
 *
 * Covers validation of the sourceDocGuids parameter, per-source access
 * control (viewer suffices, unshared fails fast), and the end-to-end
 * multi-document concatenation flow: sources loaded from the DB, exposed
 * read-only in the sandbox, content cloned into the target with formatting
 * intact, sources never modified, and target rollback when a script fails.
 */

// Mock S3 so cross-doc image copies exercise the DB + reconcile logic without
// real object storage. Must be declared before the tool registry loads.
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

const { randomUUID } = require('crypto');
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
const { toMarkdown, loadYDoc } = require('../../yjs/serialization');
const documentImages = require('../../../document-images');
const s3Images = require('../../../s3-images');
const { imageUrl } = require('../../../image-url');

const pool = createPool();
const persistence = createPersistence();
const pendingOperations = [];

const extractDocGuid = (docName) =>
  docName.startsWith('s/') ? docName.slice(2) : docName;

const NONEXISTENT_GUID = '00000000-0000-4000-8000-000000000000';
const NONEXISTENT_GUID_2 = '00000000-0000-4000-8000-000000000001';

describe('modify sourceDocGuids (read-only source documents)', () => {
  let testUserId;
  let otherUserId;
  let httpServer;
  let wss;
  const createdDocIds = [];

  beforeAll(async () => {
    // Serialize storeUpdate per doc: a streamed modify persists many updates
    // in a burst, and concurrent inserts race for clocks (production absorbs
    // this with an outer retryWithBackoff; tests need determinism instead —
    // a dropped update leaves a gap that makes loadYDoc truncate the doc).
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
       VALUES (uuid_generate_v4(), 'google-modify-sources-test', 'modify-sources@test.local', 'Modify Sources Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = u.rows[0].id;

    const u2 = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-modify-sources-other', 'modify-sources-other@test.local', 'Other Sources User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    otherUserId = u2.rows[0].id;

    httpServer = http.createServer();
    wss = new WebSocket.Server({ server: httpServer, verifyClient: () => true });
    wss.on('connection', (ws, req) => {
      ws.userId = testUserId;
      ws.agentName = 'Test Agent';
      setupWSConnection(ws, req, { gc: false });
    });
    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        const port = httpServer.address().port;
        process.env.WS_PORT = port;
        process.env.WS_HOST = 'localhost';
        process.env.WS_PROTOCOL = 'ws';
        resolve();
      });
    });
  });

  afterAll(async () => {
    agentPresence.clearUserSessions(testUserId);
    agentPresence.clearUserSessions(otherUserId);
    await new Promise((r) => setTimeout(r, 100));
    wss.close();
    await new Promise((r) => httpServer.close(r));
    await new Promise((r) => setTimeout(r, 100));
    await Promise.all(pendingOperations);
    pendingOperations.length = 0;
    for (const docId of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [otherUserId]);
    await pool.end();
    await persistence.destroy();
  }, 15000);

  const agentToken = (userId = testUserId) => ({
    userId,
    agentId: 'test-agent',
    agentName: 'Test Agent',
    delegationId: 'test-delegation',
    scopes: ['documents:write'],
    rawToken: 'test-token-' + Date.now(),
  });

  async function flushPersistence() {
    await new Promise((r) => setTimeout(r, 150));
    await Promise.all(pendingOperations);
  }

  // Create a doc (optionally owned by another user) and seed it with a script.
  // Sources are loaded from yjs_updates, so seeded content must actually land
  // in the DB before a doc can be used as a source — the WS-sync → storeUpdate
  // path is async, so poll until the expected text is readable from the DB.
  async function seedDoc(title, script, ownerUserId = testUserId, waitForText = null) {
    const create = toolRegistry.getTool('create_document');
    const modify = toolRegistry.getTool('modify');
    const created = await create.handler({ title }, agentToken(ownerUserId));
    createdDocIds.push(created.docGuid);
    await flushPersistence();
    if (script) {
      await modify.handler({ docGuid: created.docGuid, script }, agentToken(ownerUserId));
      await flushPersistence();
      if (waitForText) {
        const deadline = Date.now() + 10000;
        while (!(await sourceMarkdown(created.docGuid)).includes(waitForText)) {
          if (Date.now() > deadline) {
            throw new Error(`seedDoc: "${waitForText}" never persisted for ${title}`);
          }
          await new Promise((r) => setTimeout(r, 100));
          await flushPersistence();
        }
      }
    }
    return created.docGuid;
  }

  async function sourceMarkdown(docGuid) {
    const ydoc = await loadYDoc(pool, docGuid);
    const md = toMarkdown(ydoc.get('default', Y.XmlFragment));
    ydoc.destroy();
    return md;
  }

  // Poll the DB view of a doc until `predicate(fragment)` holds, then return
  // the (destroyed-safe) snapshot of its top-level nodes for assertions. The
  // WS-sync → storeUpdate path is async, and end-of-handler mutations (e.g.
  // image reconciliation) land in the DB just after the handler returns.
  async function waitForDocState(docGuid, predicate, what) {
    const deadline = Date.now() + 10000;
    for (;;) {
      const d = await loadYDoc(pool, docGuid);
      const frag = d.get('default', Y.XmlFragment);
      if (predicate(frag)) return d;
      d.destroy();
      if (Date.now() > deadline) throw new Error(`waitForDocState: ${what} never persisted for ${docGuid}`);
      await new Promise((r) => setTimeout(r, 100));
      await flushPersistence();
    }
  }

  // The WS-sync → storeUpdate path is async and a modify streams many
  // incremental updates, so poll until the DB view contains the expected text.
  async function docMarkdownContaining(docGuid, needle) {
    const deadline = Date.now() + 10000;
    let md = await sourceMarkdown(docGuid);
    while (!md.includes(needle) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      await flushPersistence();
      md = await sourceMarkdown(docGuid);
    }
    return md;
  }

  const RICH_SEED = (label) => `
    export default function edit(doc) {
      appendBlocks(doc, [
        { type: 'heading', level: 2, content: '${label} Heading' },
        { type: 'paragraph', content: [
          'Text with ',
          { text: 'bold', attrs: { bold: true } },
          ' from ${label}'
        ]},
        { type: 'bulletList', items: ['${label} item one', '${label} item two'] },
      ]);
    }
  `;

  describe('schema and validation', () => {
    test('inputSchema exposes sourceDocGuids as an optional capped array', () => {
      const modify = toolRegistry.getTool('modify');
      const prop = modify.inputSchema.properties.sourceDocGuids;
      expect(prop).toBeDefined();
      expect(prop.type).toBe('array');
      expect(prop.maxItems).toBe(10);
      expect(modify.inputSchema.required).not.toContain('sourceDocGuids');
    });

    test('rejects more than 10 source docs', async () => {
      const modify = toolRegistry.getTool('modify');
      const tooMany = Array.from({ length: 11 }, (_, i) =>
        `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`);
      await expect(modify.handler({
        docGuid: NONEXISTENT_GUID,
        script: 'export default function edit(doc) {}',
        sourceDocGuids: tooMany,
      }, agentToken())).rejects.toThrow(/at most 10 documents \(got 11\)/);
    });

    test('rejects the target docGuid appearing in sourceDocGuids', async () => {
      const modify = toolRegistry.getTool('modify');
      await expect(modify.handler({
        docGuid: NONEXISTENT_GUID,
        script: 'export default function edit(doc) {}',
        sourceDocGuids: [NONEXISTENT_GUID],
      }, agentToken())).rejects.toThrow(/must not include the target docGuid/);
    });

    test('rejects non-UUID entries, listing them', async () => {
      const modify = toolRegistry.getTool('modify');
      await expect(modify.handler({
        docGuid: NONEXISTENT_GUID,
        script: 'export default function edit(doc) {}',
        sourceDocGuids: ['not-a-uuid', NONEXISTENT_GUID_2],
      }, agentToken())).rejects.toThrow(/invalid UUIDs: not-a-uuid/);
    });

    test('rejects a non-array sourceDocGuids', async () => {
      const modify = toolRegistry.getTool('modify');
      await expect(modify.handler({
        docGuid: NONEXISTENT_GUID,
        script: 'export default function edit(doc) {}',
        sourceDocGuids: NONEXISTENT_GUID_2,
      }, agentToken())).rejects.toThrow(/must be an array/);
    });
  });

  describe('access control', () => {
    test('fails fast listing ALL inaccessible guids, and target is unchanged', async () => {
      const modify = toolRegistry.getTool('modify');
      const targetGuid = await seedDoc('Sources Access Target', RICH_SEED('Target'), testUserId, 'Target Heading');
      const mdBefore = await sourceMarkdown(targetGuid);

      let error;
      try {
        await modify.handler({
          docGuid: targetGuid,
          script: 'export default function edit(doc) { doc.delete(0, doc.length); }',
          sourceDocGuids: [NONEXISTENT_GUID, NONEXISTENT_GUID_2],
        }, agentToken());
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
      expect(error.message).toMatch(/Source documents not found or not accessible/);
      expect(error.message).toContain(NONEXISTENT_GUID);
      expect(error.message).toContain(NONEXISTENT_GUID_2);

      await flushPersistence();
      expect(await sourceMarkdown(targetGuid)).toBe(mdBefore);
    }, 30000);

    test("another user's un-shared doc is not accessible as a source", async () => {
      const modify = toolRegistry.getTool('modify');
      const privateGuid = await seedDoc('Private Other Doc', RICH_SEED('Private'), otherUserId, 'Private Heading');
      const targetGuid = await seedDoc('Sources Unshared Target', null);

      await expect(modify.handler({
        docGuid: targetGuid,
        script: 'export default function edit(doc) {}',
        sourceDocGuids: [privateGuid],
      }, agentToken())).rejects.toThrow(/not found or not accessible/);
    }, 30000);

    test('viewer access to a source is sufficient', async () => {
      const modify = toolRegistry.getTool('modify');
      const sharedGuid = await seedDoc('Viewer Shared Doc', RICH_SEED('Shared'), otherUserId, 'Shared Heading');
      await pool.query(
        `INSERT INTO document_shares (doc_id, user_id, role)
         VALUES ($1, $2, 'viewer') ON CONFLICT (doc_id, user_id) DO UPDATE SET role = 'viewer'`,
        [sharedGuid, testUserId]
      );
      const targetGuid = await seedDoc('Viewer Source Target', null);

      const result = await modify.handler({
        docGuid: targetGuid,
        script: `
          export default function edit(doc) {
            doc.insert(doc.length, cloneBlocks(sources['${sharedGuid}']));
          }
        `,
        sourceDocGuids: [sharedGuid],
      }, agentToken());

      expect(result.changed).toBe(true);
      expect(result.sourceDocGuids).toEqual([sharedGuid]);

      expect(await docMarkdownContaining(targetGuid, 'Shared Heading')).toContain('Shared Heading');
    }, 30000);
  });

  describe('multi-document concatenation', () => {
    test('concatenates three docs in order with formatting intact; sources unchanged', async () => {
      const modify = toolRegistry.getTool('modify');
      const srcA = await seedDoc('Concat Source A', RICH_SEED('Alpha'), testUserId, 'Alpha Heading');
      const srcB = await seedDoc('Concat Source B', RICH_SEED('Beta'), testUserId, 'Beta Heading');
      const srcC = await seedDoc('Concat Source C', RICH_SEED('Gamma'), testUserId, 'Gamma Heading');
      const targetGuid = await seedDoc('Concat Target', null);

      const srcMdBefore = {
        [srcA]: await sourceMarkdown(srcA),
        [srcB]: await sourceMarkdown(srcB),
        [srcC]: await sourceMarkdown(srcC),
      };

      // Duplicate srcB in the list to verify dedupe preserves order
      const result = await modify.handler({
        docGuid: targetGuid,
        script: `
          export default function edit(doc) {
            for (const guid of Object.keys(sources)) {
              doc.insert(doc.length, cloneBlocks(sources[guid]));
              appendBlocks(doc, [{ type: 'horizontalRule' }]);
            }
          }
        `,
        sourceDocGuids: [srcA, srcB, srcB, srcC],
      }, agentToken());

      expect(result.changed).toBe(true);
      expect(result.sourceDocGuids).toEqual([srcA, srcB, srcC]);

      await flushPersistence();
      // The final source's blocks land last — once they're visible, the
      // whole concatenation has persisted.
      const targetMd = await docMarkdownContaining(targetGuid, 'Gamma Heading');

      // All three docs present, in input order, exactly once
      const posAlpha = targetMd.indexOf('Alpha Heading');
      const posBeta = targetMd.indexOf('Beta Heading');
      const posGamma = targetMd.indexOf('Gamma Heading');
      expect(posAlpha).toBeGreaterThanOrEqual(0);
      expect(posBeta).toBeGreaterThan(posAlpha);
      expect(posGamma).toBeGreaterThan(posBeta);
      expect(targetMd.indexOf('Beta Heading')).toBe(targetMd.lastIndexOf('Beta Heading'));

      // Formatting (bold mark) and list structure survive the clone
      expect(targetMd).toContain('**bold**');
      expect(targetMd).toContain('- Alpha item one');

      // Sources are untouched
      for (const guid of [srcA, srcB, srcC]) {
        expect(await sourceMarkdown(guid)).toBe(srcMdBefore[guid]);
      }
    }, 60000);

    test('script that mutates a source fails and the target rolls back', async () => {
      const modify = toolRegistry.getTool('modify');
      const srcGuid = await seedDoc('Rollback Source', RICH_SEED('Rollback'), testUserId, 'Rollback Heading');
      const targetGuid = await seedDoc('Rollback Target', RICH_SEED('Existing'), testUserId, 'Existing Heading');
      const targetMdBefore = await sourceMarkdown(targetGuid);
      const srcMdBefore = await sourceMarkdown(srcGuid);

      // Write to the target first, THEN mutate the source — proves the
      // partial target write is rolled back as one undo step.
      let error;
      try {
        await modify.handler({
          docGuid: targetGuid,
          script: `
            export default function edit(doc) {
              appendBlocks(doc, [{ type: 'paragraph', content: 'should be rolled back' }]);
              sources['${srcGuid}'].delete(0, 1);
            }
          `,
          sourceDocGuids: [srcGuid],
        }, agentToken());
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
      expect(error.message).toMatch(new RegExp(`Source document ${srcGuid} is read-only`));

      await flushPersistence();
      expect(await sourceMarkdown(targetGuid)).toBe(targetMdBefore);
      expect(await sourceMarkdown(srcGuid)).toBe(srcMdBefore);
    }, 30000);
  });

  describe('cross-document images', () => {
    // Seed a doc containing an image node pointing at its own docId.
    // Raw Y is needed — appendBlocks has no image block type by design.
    const IMAGE_SEED = (src) => `
      export default function edit(doc) {
        const img = new Y.XmlElement('image');
        img.setAttribute('src', '${src}');
        img.setAttribute('alt', 'chart');
        doc.insert(doc.length, [img]);
      }
    `;

    test('cloned images are copied into the target and the src rewritten (one copy per source image)', async () => {
      const modify = toolRegistry.getTool('modify');
      const srcGuid = await seedDoc('Image Source Doc', null);

      // Image row + node in the source doc
      const imageId = randomUUID();
      const srcImageUrl = imageUrl(srcGuid, imageId);
      await documentImages.createImage({
        id: imageId,
        docId: srcGuid,
        uploaderId: testUserId,
        mimeType: 'image/png',
        filename: 'chart.png',
        byteSize: 1234,
        s3Key: `doc-images/${srcGuid}/${imageId}`,
      });
      await modify.handler({ docGuid: srcGuid, script: IMAGE_SEED(srcImageUrl) }, agentToken());
      await flushPersistence();
      // Sources load from the DB — wait until the image node has persisted
      (await waitForDocState(srcGuid,
        f => f.toArray().some(n => n.nodeName === 'image'), 'source image node')).destroy();

      const targetGuid = await seedDoc('Image Copy Target', null);
      s3Images.copyObject.mockClear();

      // Clone the image twice — repeated references share one copy
      const result = await modify.handler({
        docGuid: targetGuid,
        script: `
          export default function edit(doc) {
            const imgs = xpath('//image', sources['${srcGuid}']);
            doc.insert(doc.length, cloneBlocks(imgs));
            doc.insert(doc.length, cloneBlocks(imgs));
          }
        `,
        sourceDocGuids: [srcGuid],
      }, agentToken());

      expect(result.changed).toBe(true);
      expect(result.imageErrors).toBeUndefined();
      expect(result.imagesCopied).toHaveLength(1);
      expect(result.imagesCopied[0].from).toBe(srcImageUrl);
      const newUrl = result.imagesCopied[0].to;
      expect(newUrl).toMatch(new RegExp(`^/api/docs/${targetGuid}/images/`));

      // Both cloned nodes point at the single target-doc copy (the rewrite is
      // the handler's final mutation — poll until it reaches the DB). The
      // predicate must require the nodes to EXIST, not just satisfy every():
      // before the modify persists, the DB view of the doc is empty and an
      // every() over zero nodes passes vacuously.
      const targetDoc = await waitForDocState(targetGuid,
        f => {
          const imgs = f.toArray().filter(n => n.nodeName === 'image');
          return imgs.length === 2 && imgs.every(n => n.getAttribute('src') === newUrl);
        },
        'rewritten image srcs');
      const frag = targetDoc.get('default', Y.XmlFragment);
      const imageNodes = frag.toArray().filter(n => n.nodeName === 'image');
      expect(imageNodes).toHaveLength(2);
      for (const node of imageNodes) {
        expect(node.getAttribute('src')).toBe(newUrl);
        expect(node.getAttribute('alt')).toBe('chart');
      }
      targetDoc.destroy();

      // Exactly one new metadata row, and one S3 object copy to a fresh key
      const rows = await pool.query(
        'SELECT * FROM document_images WHERE doc_id = $1', [targetGuid]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].mime_type).toBe('image/png');
      expect(rows.rows[0].byte_size).toBe(1234);
      expect(s3Images.copyObject).toHaveBeenCalledTimes(1);
      expect(s3Images.copyObject).toHaveBeenCalledWith(
        `doc-images/${srcGuid}/${imageId}`,
        `doc-images/${targetGuid}/${rows.rows[0].id}`
      );

      // Source doc's image row is untouched
      const srcRows = await pool.query(
        'SELECT id FROM document_images WHERE doc_id = $1', [srcGuid]);
      expect(srcRows.rows.map(r => r.id)).toEqual([imageId]);
    }, 30000);

    test('images from inaccessible docs or with missing rows are stripped and reported', async () => {
      const modify = toolRegistry.getTool('modify');
      const privateGuid = await seedDoc('Image Private Doc', null, otherUserId);
      const accessibleGuid = await seedDoc('Image Rowless Doc', null);
      const targetGuid = await seedDoc('Image Strip Target', null);

      const inaccessibleSrc = imageUrl(privateGuid, randomUUID());
      // Accessible doc, but no document_images row behind the id
      const missingRowSrc = imageUrl(accessibleGuid, randomUUID());

      const result = await modify.handler({
        docGuid: targetGuid,
        script: `
          export default function edit(doc) {
            appendBlocks(doc, [{ type: 'paragraph', content: 'kept' }]);
            for (const src of ['${inaccessibleSrc}', '${missingRowSrc}']) {
              const img = new Y.XmlElement('image');
              img.setAttribute('src', src);
              doc.insert(doc.length, [img]);
            }
          }
        `,
      }, agentToken());

      expect(result.changed).toBe(true);
      expect(result.imagesCopied).toBeUndefined();
      expect(result.imageErrors).toEqual(expect.arrayContaining([
        expect.objectContaining({ src: inaccessibleSrc }),
        expect.objectContaining({ src: missingRowSrc }),
      ]));
      expect(result.message).toMatch(/removed/);

      // Both image nodes stripped; the paragraph survives (strips are the
      // handler's final mutation — poll until they reach the DB). "Zero image
      // nodes" alone is vacuously true while the doc's updates haven't
      // persisted yet (empty DB view) — also require the paragraph content,
      // which proves the modify actually landed. This raced in CI (run
      // 28895138424): the poll returned the pre-persist empty doc and the
      // 'kept' assertion read "".
      const targetDoc = await waitForDocState(targetGuid,
        f => toMarkdown(f).includes('kept')
          && f.toArray().filter(n => n.nodeName === 'image').length === 0,
        'stripped image nodes with content persisted');
      const frag = targetDoc.get('default', Y.XmlFragment);
      expect(toMarkdown(frag)).toContain('kept');
      targetDoc.destroy();

      // No rows created in the target
      const rows = await pool.query(
        'SELECT id FROM document_images WHERE doc_id = $1', [targetGuid]);
      expect(rows.rows).toHaveLength(0);
    }, 30000);
  });
});
