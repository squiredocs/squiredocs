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
});
