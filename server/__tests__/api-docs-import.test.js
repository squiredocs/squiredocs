/**
 * Tests for POST /api/docs/import (Markdown create) — feature 002.
 *
 * Exercises the real import router (server/api/docs-import.js) and the real
 * requireAuth chain via supertest, against a live documentService wired to the
 * y-websocket shared-doc + Postgres persistence (mirroring
 * create-document-markdown.test.js). Focused on the create/POST path — the
 * PUT path is owned by feature 004.
 */
const request = require('supertest');
const express = require('express');
const Y = require('yjs');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');

const documents = require('../documents');
const users = require('../auth/users');
const documentService = require('../document-service');
const apiTokens = require('../mcp/auth/api-tokens');
const { generateAccessToken } = require('../auth/jwt');
const { toMarkdown } = require('../mcp/yjs/serialization');
const { createImportRouter } = require('../api/docs-import');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../origin');
const { parseFrontmatter } = require('../../shared/markdown/frontmatter');
const { createPool, createPersistence } = require('./helpers/db');

describe('API: POST /api/docs/import', () => {
  let app;
  let pool;
  let persistence;
  let userId;
  let authToken;
  const pendingOperations = [];
  const createdDocIds = [];

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    await persistence._init();

    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          pendingOperations.push(
            persistence
              .storeUpdate(docGuid, update, parsed.userId, parsed.agentName)
              .catch((err) => console.error(`persist error for ${docGuid}:`, err))
          );
        });
        try {
          const persisted = await persistence.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), ORIGIN_DB_LOAD);
        } catch (e) {
          /* fresh doc */
        }
      },
      writeState: async () => {},
      provider: persistence,
    });
    documentService.init(getYDoc, (docName) =>
      docName.startsWith('s/') ? docName.slice(2) : docName
    );
    documents.init(pool);
    users.init(pool);
    apiTokens.init(pool);

    const user = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-import-1', 'test-import-1@example.com', 'Import User 1', NULL)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, email, name, picture, is_admin`
    );
    userId = user.rows[0].id;
    authToken = generateAccessToken(user.rows[0]);

    app = express();
    app.use(createImportRouter(persistence));
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    for (const docId of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docId]);
      await pool.query('DELETE FROM document_images WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await persistence.destroy();
    await pool.end();
  });

  function post(markdown, query = '') {
    return request(app)
      .post(`/api/docs/import${query}`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('Content-Type', 'text/markdown')
      .send(markdown);
  }

  function fragmentOf(docId) {
    return documentService.getSharedDoc(docId).get('default', Y.XmlFragment);
  }

  test('creates a document from markdown (happy path)', async () => {
    const res = await post('# Import Me\n\nSome **body** text.\n\n- one\n- two');
    expect(res.status).toBe(201);
    createdDocIds.push(res.body.docId);
    expect(res.body.title).toBe('Import Me');
    expect(res.body.blocks).toEqual({ imported: 3 });
    expect(res.body.images).toEqual({ rehosted: [], copied: [], degraded: [], rejected: [] });

    const md = toMarkdown(fragmentOf(res.body.docId));
    expect(md).toContain('# Import Me');
    expect(md).toContain('**body**');
  });

  test('F1: body that is only a data: image falls back to an anchored doc, no orphan', async () => {
    // deriveImportTitle counts the image block BEFORE the image policy, so this
    // takes the seed-and-import path; prepareImport then drops the data: image
    // and would throw EMPTY_IMPORT. The route must NOT 400 and leave an empty
    // untitled doc behind — it falls back to the anchor-only shape and returns
    // 201 with the dropped image itemized.
    const res = await post('![ ](data:image/png;base64,AAAA)');
    expect(res.status).toBe(201);
    createdDocIds.push(res.body.docId);
    expect(res.body.title).toBe('Untitled');
    expect(res.body.blocks).toEqual({ imported: 0 });
    expect(res.body.images.rejected).toHaveLength(1);
    expect(res.body.images.rejected[0].reason).toBe('data-url');

    // The created doc is a real anchored doc, not a bodyless orphan.
    const fragment = fragmentOf(res.body.docId);
    expect(fragment.length).toBe(1);
    expect(fragment.get(0).nodeName).toBe('paragraph');

    // The document row exists and is queryable (was not rolled back).
    const row = await pool.query('SELECT title FROM documents WHERE id = $1', [res.body.docId]);
    expect(row.rows[0].title).toBe('Untitled');
  });

  test('empty body is rejected with 400 (before any doc is created)', async () => {
    const res = await post('   \n  \n');
    expect(res.status).toBe(400);
  });

  // Design §1.2.1 — verification receipt + born-syncable creation.
  describe('import receipts (design §1.2.1)', () => {
    function put(docId, markdown, query = '') {
      return request(app)
        .put(`/api/docs/${docId}/import${query}`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Content-Type', 'text/markdown')
        .send(markdown);
    }

    test('POST returns the canonical markdown receipt (portable, no frontmatter by default)', async () => {
      const res = await post('# Receipt Doc\n\nBody with **bold** text.');
      expect(res.status).toBe(201);
      createdDocIds.push(res.body.docId);

      expect(res.body.markdown).toContain('# Receipt Doc');
      expect(res.body.markdown).toContain('**bold**');
      expect(res.body.markdown.startsWith('---')).toBe(false);
      // Exact-comparison contract: the receipt IS the canonical re-export.
      expect(res.body.markdown).toBe(
        toMarkdown(fragmentOf(res.body.docId), { flavor: 'portable', lossy: new Set() })
      );
    });

    test('POST ?frontmatter=true stamps the receipt as a sync baseline (born syncable)', async () => {
      const res = await post('# Born Syncable\n\nHello.', '?frontmatter=true');
      expect(res.status).toBe(201);
      createdDocIds.push(res.body.docId);

      expect(res.body.markdown.startsWith('---')).toBe(true);
      const { squire, body } = parseFrontmatter(res.body.markdown);
      expect(squire.docGuid).toBe(res.body.docId);
      expect(squire.clock).toBe(res.body.clock);
      expect(squire.flavor).toBe('portable');
      expect(body).toContain('# Born Syncable');
    });

    test('PUT append returns a receipt reflecting the post-import state', async () => {
      const created = await post('# Put Receipt\n\nOriginal.');
      expect(created.status).toBe(201);
      createdDocIds.push(created.body.docId);

      const res = await put(created.body.docId, 'Appended paragraph.', '?mode=append&frontmatter=1');
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('append');

      const { squire, body } = parseFrontmatter(res.body.markdown);
      expect(squire.docGuid).toBe(created.body.docId);
      expect(squire.clock).toBe(res.body.clock);
      expect(body).toContain('Original.');
      expect(body).toContain('Appended paragraph.');
    });

    test('unknown flavor / frontmatter values are rejected with 400 naming accepted values', async () => {
      const badFlavor = await post('# X', '?flavor=fancy');
      expect(badFlavor.status).toBe(400);
      expect(badFlavor.body.error).toContain('Accepted values: squire, portable');

      const badFm = await post('# X', '?frontmatter=yes');
      expect(badFm.status).toBe(400);
      expect(badFm.body.error).toContain('Accepted values: true, false, 1, 0');
    });
  });
});
