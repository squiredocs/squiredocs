/**
 * REST import API tests (feature 002, T013 + T017 + T023).
 *
 * Exercises the real import router (server/api/docs-import.js) end to end:
 * the real requireAuth chain (browser-session JWTs, sk_sqd_ API tokens, scope
 * enforcement), the Yjs-backed document service, and the import module.
 *
 * POST /api/docs/import (T013): auth/scope matrix, content-type and size
 * gates, title derivation, ownership, response shape.
 * PUT /api/docs/:docId/import (T017): mode matrix, editor-role gate,
 * error matrix, attribution.
 */
const request = require('supertest');
const express = require('express');
const fs = require('fs');
const path = require('path');
const Y = require('yjs');

const { createPool, createPersistence } = require('../../server/__tests__/helpers/db');
const pool = createPool();
const persistence = createPersistence();

const documents = require('../../server/documents');
const documentService = require('../../server/document-service');
const apiTokens = require('../../server/mcp/auth/api-tokens');
const { generateAccessToken } = require('../../server/auth/jwt');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../../server/origin');
const { toMarkdown } = require('../../server/mcp/yjs/serialization');
const { createImportRouter, MAX_IMPORT_BYTES } = require('../../server/api/docs-import');

const FIXTURES = path.join(__dirname, '..', '..', 'server', '__tests__', 'fixtures', 'import');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const pendingOperations = [];

describe('REST import API', () => {
  let app;
  let ownerId;
  let otherId;
  let ownerJwt;
  let otherJwt;
  let patDefault; // documents:read + documents:write
  let patReadOnly; // documents:read only
  const createdDocIds = [];

  beforeAll(async () => {
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
    apiTokens.init(pool);

    const u1 = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ('test-import-1', 'test-import-api-1@example.com', 'Import User 1')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, email, name, is_admin`
    );
    ownerId = u1.rows[0].id;
    const u2 = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ('test-import-2', 'test-import-api-2@example.com', 'Import User 2')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, email, name, is_admin`
    );
    otherId = u2.rows[0].id;

    ownerJwt = generateAccessToken(u1.rows[0]);
    otherJwt = generateAccessToken(u2.rows[0]);
    patDefault = (await apiTokens.createToken(ownerId, 'import default')).token;
    patReadOnly = (await apiTokens.createToken(ownerId, 'import read-only', {
      scopes: ['documents:read'],
    })).token;

    app = express();
    app.use(createImportRouter(persistence));
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    const docs = await pool.query(
      'SELECT id FROM documents WHERE creator_id IN ($1, $2)', [ownerId, otherId]
    );
    for (const row of [...docs.rows.map((r) => r.id), ...createdDocIds]) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [row]);
      await pool.query('DELETE FROM document_images WHERE doc_id = $1', [row]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [row]);
      await pool.query('DELETE FROM documents WHERE id = $1', [row]);
    }
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id IN ($1, $2)', [ownerId, otherId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [ownerId, otherId]);
    await persistence.destroy();
    await pool.end();
  });

  function post(body, { auth = `Bearer ${patDefault}`, type = 'text/markdown', query = '' } = {}) {
    let req = request(app).post(`/api/docs/import${query}`);
    if (auth) req = req.set('Authorization', auth);
    return req.set('Content-Type', type).send(body);
  }

  function put(docId, body, { auth = `Bearer ${patDefault}`, type = 'text/markdown', query = '' } = {}) {
    let req = request(app).put(`/api/docs/${docId}/import${query}`);
    if (auth) req = req.set('Authorization', auth);
    return req.set('Content-Type', type).send(body);
  }

  function fragmentOf(docId) {
    return documentService.getSharedDoc(docId).get('default', Y.XmlFragment);
  }

  // ==========================================================================
  // POST /api/docs/import (T013)
  // ==========================================================================
  describe('POST /api/docs/import', () => {
    test('401 without a token', async () => {
      const res = await post('# Doc', { auth: null });
      expect(res.status).toBe(401);
    });

    test('403 INSUFFICIENT_SCOPE for a documents:read-only token', async () => {
      const res = await post('# Doc', { auth: `Bearer ${patReadOnly}` });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
      expect(res.body.required).toBe('documents:write');
      expect(res.body.granted).toEqual(['documents:read']);
    });

    test('415 for unsupported content types', async () => {
      const res = await post('{"markdown": "# Doc"}', { type: 'application/json' });
      expect(res.status).toBe(415);
    });

    test('413 over the 5 MB cap; exactly at cap succeeds', async () => {
      const paragraph = 'lorem ipsum dolor sit amet '.repeat(64) + '\n\n';
      let body = '# Big Doc\n\n';
      while (body.length < MAX_IMPORT_BYTES - paragraph.length) body += paragraph;
      // Pad to EXACTLY the cap.
      body += 'x'.repeat(MAX_IMPORT_BYTES - body.length);
      expect(Buffer.byteLength(body)).toBe(MAX_IMPORT_BYTES);

      const atCap = await post(body);
      expect(atCap.status).toBe(201);
      createdDocIds.push(atCap.body.docId);

      const overCap = await post(body + 'y');
      expect(overCap.status).toBe(413);
    }, 30000);

    test('400 for an empty or whitespace-only body', async () => {
      expect((await post('')).status).toBe(400);
      expect((await post('   \n\t  ')).status).toBe(400);
    });

    test('frontmatter title wins and residue lands as a yaml block', async () => {
      const res = await post(readFixture('frontmatter-mixed.md'));
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Mixed Frontmatter Doc');
      createdDocIds.push(res.body.docId);

      const md = toMarkdown(fragmentOf(res.body.docId));
      expect(md).toContain('```yaml');
      expect(md).toContain('layout: post');
      expect(md).not.toContain('squire:');
      // The title-donor heading stays in the body.
      expect(md).toContain('# Mixed Frontmatter Doc');
    });

    test('explicit ?title= beats frontmatter', async () => {
      const res = await post(readFixture('frontmatter-mixed.md'), {
        query: `?title=${encodeURIComponent('Explicit Wins')}`,
      });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Explicit Wins');
      createdDocIds.push(res.body.docId);
    });

    test('first-heading title fallback', async () => {
      const res = await post('# Payments Redesign\n\nIntro paragraph.');
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Payments Redesign');
      createdDocIds.push(res.body.docId);
      // Heading retained in the body (FR-008).
      expect(toMarkdown(fragmentOf(res.body.docId))).toContain('# Payments Redesign');
    });

    test('Untitled fallback when no title source exists', async () => {
      const res = await post('Just a plain paragraph, no heading.');
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Untitled');
      createdDocIds.push(res.body.docId);
    });

    test('frontmatter-only body creates an empty doc with derived title (spec edge case)', async () => {
      const res = await post(readFixture('frontmatter-only.md'));
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Frontmatter Only Document');
      expect(res.body.blocks).toEqual({ imported: 0 });
      createdDocIds.push(res.body.docId);
      // Seeded empty anchor paragraph, nothing else.
      const fragment = fragmentOf(res.body.docId);
      expect(fragment.length).toBe(1);
      expect(fragment.get(0).nodeName).toBe('paragraph');
    });

    test('acting user owns the created document', async () => {
      const res = await post('# Mine');
      expect(res.status).toBe(201);
      createdDocIds.push(res.body.docId);
      const row = await pool.query('SELECT creator_id FROM documents WHERE id = $1', [res.body.docId]);
      expect(row.rows[0].creator_id).toBe(ownerId);
      const role = await documents.getRole(res.body.docId, ownerId);
      expect(role).toBe('owner');
    });

    test('response shape: docId, title, url, clock, blocks, images', async () => {
      const res = await post('# Shape\n\nBody with a [link](https://example.com).');
      expect(res.status).toBe(201);
      createdDocIds.push(res.body.docId);
      expect(res.body).toEqual({
        docId: expect.any(String),
        title: 'Shape',
        url: `/d/${res.body.docId}`,
        clock: expect.any(Number),
        blocks: { imported: 2 },
        images: { rehosted: [], copied: [], degraded: [], rejected: [] },
      });
      expect(res.body.clock).toBeGreaterThanOrEqual(1);
    });

    test('browser-session JWT principals are accepted (no scope array)', async () => {
      const res = await post('# Session Doc', { auth: `Bearer ${ownerJwt}` });
      expect(res.status).toBe(201);
      createdDocIds.push(res.body.docId);
    });

    test('text/plain is accepted', async () => {
      const res = await post('# Plain Type\n\nvia text/plain', { type: 'text/plain' });
      expect(res.status).toBe(201);
      createdDocIds.push(res.body.docId);
    });
  });

  // ==========================================================================
  // PUT /api/docs/:docId/import (T017)
  // ==========================================================================
  describe('PUT /api/docs/:docId/import', () => {
    let docId;

    beforeEach(async () => {
      const res = await post('# Base\n\nOriginal body.');
      expect(res.status).toBe(201);
      docId = res.body.docId;
      createdDocIds.push(docId);
    });

    test('append (default mode) preserves prior content and returns a new clock', async () => {
      const before = await put(docId, '## Progress\n\nDone step 1.');
      expect(before.status).toBe(200);
      expect(before.body.mode).toBe('append');
      expect(before.body.docId).toBe(docId);
      expect(before.body.blocks).toEqual({ imported: 2 });

      const md = toMarkdown(fragmentOf(docId));
      expect(md).toMatch(/# Base[\s\S]*Original body\.[\s\S]*## Progress[\s\S]*Done step 1\./);

      // Prior attribution untouched: original rows still attributed to owner.
      await Promise.all(pendingOperations.splice(0));
      const rows = await pool.query(
        'SELECT user_id FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock', [docId]
      );
      expect(rows.rows.every((r) => r.user_id === ownerId)).toBe(true);
      expect(before.body.clock).toBe(rows.rows.length - 1); // clock starts at 0
    });

    test('replace leaves exactly the new blocks, one undo step, attributed to actor', async () => {
      await Promise.all(pendingOperations.splice(0));
      const beforeRows = await pool.query(
        'SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docId]
      );

      const fragment = fragmentOf(docId);
      const undoManager = new Y.UndoManager(fragment, { trackedOrigins: new Set([Object]) });

      const res = await put(docId, '# Fresh\n\nRegenerated.', { query: '?mode=replace' });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('replace');

      const md = toMarkdown(fragment);
      expect(md).toContain('# Fresh');
      expect(md).not.toContain('Original body');

      expect(undoManager.undoStack.length).toBe(1);
      undoManager.destroy();

      await Promise.all(pendingOperations.splice(0));
      const afterRows = await pool.query(
        'SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docId]
      );
      expect(afterRows.rows[0].n).toBe(beforeRows.rows[0].n + 1);
      const last = await pool.query(
        'SELECT user_id FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock DESC LIMIT 1', [docId]
      );
      expect(last.rows[0].user_id).toBe(ownerId);
    });

    test('viewer role gets 403 and the document is unchanged', async () => {
      await documents.setRole(docId, otherId, 'viewer');
      const before = toMarkdown(fragmentOf(docId));
      const res = await put(docId, 'nope', { auth: `Bearer ${otherJwt}` });
      expect(res.status).toBe(403);
      expect(toMarkdown(fragmentOf(docId))).toBe(before);
    });

    test('editor role passes the gate', async () => {
      await documents.setRole(docId, otherId, 'editor');
      const res = await put(docId, '## From Editor', { auth: `Bearer ${otherJwt}` });
      expect(res.status).toBe(200);
      // Attributed to the acting editor.
      await Promise.all(pendingOperations.splice(0));
      const last = await pool.query(
        'SELECT user_id FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock DESC LIMIT 1', [docId]
      );
      expect(last.rows[0].user_id).toBe(otherId);
    });

    test('documents:read-only token gets 403 INSUFFICIENT_SCOPE', async () => {
      const res = await put(docId, 'x', { auth: `Bearer ${patReadOnly}` });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
    });

    test('unknown mode → 400, document unchanged', async () => {
      const before = toMarkdown(fragmentOf(docId));
      const res = await put(docId, 'x', { query: '?mode=nuke' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('nuke');
      expect(toMarkdown(fragmentOf(docId))).toBe(before);
    });

    test('insertAfterXPath is not a REST mode (FR-015)', async () => {
      const res = await put(docId, 'x', { query: '?mode=insertAfterXPath' });
      expect(res.status).toBe(400);
    });

    test('empty body → 400, document unchanged', async () => {
      const before = toMarkdown(fragmentOf(docId));
      const res = await put(docId, '');
      expect(res.status).toBe(400);
      expect(toMarkdown(fragmentOf(docId))).toBe(before);
    });

    test('frontmatter-only body → 400 (effectively empty, CN-11)', async () => {
      const before = toMarkdown(fragmentOf(docId));
      const res = await put(docId, readFixture('frontmatter-only.md'), { query: '?mode=replace' });
      expect(res.status).toBe(400);
      expect(toMarkdown(fragmentOf(docId))).toBe(before);
    });

    test('missing document → 403 (no existence oracle)', async () => {
      const res = await put(require('crypto').randomUUID(), 'x');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('You do not have access to this document');
    });

    test('401 without a token', async () => {
      const res = await put(docId, 'x', { auth: null });
      expect(res.status).toBe(401);
    });

    test('415 wrong content type', async () => {
      const res = await put(docId, '{}', { type: 'application/json' });
      expect(res.status).toBe(415);
    });

    test('text/plain accepted', async () => {
      const res = await put(docId, 'plain append', { type: 'text/plain' });
      expect(res.status).toBe(200);
    });

    test('owner passes the editor gate', async () => {
      const res = await put(docId, '## Owner Appends', { auth: `Bearer ${ownerJwt}` });
      expect(res.status).toBe(200);
    });
  });
});
