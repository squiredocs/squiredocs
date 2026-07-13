/**
 * Tests for GET /api/docs/:docId/export (Markdown export)
 *
 * Exercises the real export router (server/api/docs-export.js) and the real
 * requireAuth chain — including sqd_ API tokens and scope enforcement — via
 * supertest. A stub mutating route exercises the documents:write mapping.
 */
const request = require('supertest');
const express = require('express');
const Y = require('yjs');
const documents = require('../documents');
const { toMarkdown } = require('../mcp/yjs/serialization');
const { generateAccessToken } = require('../auth/jwt');
const { requireAuth } = require('../auth');
const apiTokens = require('../mcp/auth/api-tokens');
const { createExportRouter } = require('../api/docs-export');
const { createPool, createPersistence } = require('./helpers/db');

// Build a Yjs update that populates the 'default' XmlFragment with a heading +
// paragraph and sets the document title in the 'meta' map.
function buildDocUpdate(title) {
  const ydoc = new Y.Doc();
  const frag = ydoc.get('default', Y.XmlFragment);
  ydoc.transact(() => {
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', 1);
    const ht = new Y.XmlText();
    ht.insert(0, 'Hello');
    heading.insert(0, [ht]);

    const para = new Y.XmlElement('paragraph');
    const pt = new Y.XmlText();
    pt.insert(0, 'World');
    pt.format(0, 5, { bold: true });
    para.insert(0, [pt]);

    frag.insert(0, [heading, para]);

    if (title !== undefined) {
      ydoc.getMap('meta').set('title', title);
    }
  });
  return { update: Y.encodeStateAsUpdate(ydoc), frag };
}

describe('API: GET /api/docs/:docId/export', () => {
  let app;
  let pool;
  let persistence;
  let testUserId;
  let testUser2Id;
  let docId;
  let authToken;
  let authToken2;
  let patDefault;
  let patReadOnly;
  let patWriteOnly;

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    await persistence._init();
    documents.init(pool);
    apiTokens.init(pool);

    const user1 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-export-1', 'test-export-1@example.com', 'Export User 1', NULL)
       RETURNING id, email, name, picture, is_admin`
    );
    testUserId = user1.rows[0].id;

    const user2 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-export-2', 'test-export-2@example.com', 'Export User 2', NULL)
       RETURNING id, email, name, picture, is_admin`
    );
    testUser2Id = user2.rows[0].id;

    // Real browser-session JWTs (no scopes claim)
    authToken = generateAccessToken(user1.rows[0]);
    authToken2 = generateAccessToken(user2.rows[0]);

    // Real sqd_ API tokens through the real auth chain
    patDefault = (await apiTokens.createToken(testUserId, 'test default')).token;
    patReadOnly = (await apiTokens.createToken(testUserId, 'test read-only', {
      scopes: ['documents:read'],
    })).token;
    patWriteOnly = (await apiTokens.createToken(testUserId, 'test write-only', {
      scopes: ['documents:write'],
    })).token;

    app = express();
    app.use(createExportRouter(persistence));
    // Stub mutating route to exercise the documents:write scope mapping
    app.post('/api/docs/:docId/touch', requireAuth, (req, res) => res.json({ ok: true }));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id IN ($1, $2)', [testUserId, testUser2Id]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [testUserId, testUser2Id]);
    await persistence.destroy();
    await pool.end();
  });

  beforeEach(async () => {
    docId = require('crypto').randomUUID();
  });

  afterEach(async () => {
    await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
    await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    await persistence.clearDocument(docId);
  });

  async function seedDoc(ownerId, title) {
    await documents.createDocument(docId, ownerId);
    const { update } = buildDocUpdate(title);
    await persistence.storeUpdate(docId, update, ownerId);
  }

  test('requires authentication', async () => {
    const res = await request(app).get(`/api/docs/${docId}/export`);
    expect(res.status).toBe(401);
  });

  test('returns 403 when the user has no access', async () => {
    await seedDoc(testUserId, 'Owner Only');
    const res = await request(app)
      .get(`/api/docs/${docId}/export`)
      .set('Authorization', `Bearer ${authToken2}`);
    expect(res.status).toBe(403);
  });

  test('exports markdown with download headers for the owner', async () => {
    await seedDoc(testUserId, 'My Doc');
    const res = await request(app)
      .get(`/api/docs/${docId}/export?format=markdown`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toBe('attachment; filename="My Doc.md"');

    // Body should match the serializer output exactly
    const { frag } = buildDocUpdate('My Doc');
    expect(res.text).toBe(toMarkdown(frag));
    expect(res.text).toContain('# Hello');
    expect(res.text).toContain('**World**');
  });

  test('allows a viewer to export a shared document', async () => {
    await seedDoc(testUserId, 'Shared Doc');
    await documents.setRole(docId, testUser2Id, 'viewer');

    const res = await request(app)
      .get(`/api/docs/${docId}/export`)
      .set('Authorization', `Bearer ${authToken2}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('# Hello');
  });

  test('rejects unsupported formats with 400', async () => {
    await seedDoc(testUserId, 'My Doc');
    const res = await request(app)
      .get(`/api/docs/${docId}/export?format=pdf`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
  });

  test('sanitizes illegal filename characters', async () => {
    await seedDoc(testUserId, 'a/b:c*d?"<>|');
    const res = await request(app)
      .get(`/api/docs/${docId}/export`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    const disposition = res.headers['content-disposition'];
    expect(disposition).toMatch(/^attachment; filename=".*\.md"$/);
    expect(disposition).not.toMatch(/[\/\\:*?"<>|]\.md/);
  });

  test('exports titles with non-Latin-1 characters (RFC 5987 filename*)', async () => {
    await seedDoc(testUserId, 'Squire Design Docs — Index');
    const res = await request(app)
      .get(`/api/docs/${docId}/export`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    const disposition = res.headers['content-disposition'];
    // ASCII fallback in filename=, full title percent-encoded in filename*=
    expect(disposition).toBe(
      'attachment; filename="Squire Design Docs _ Index.md"; ' +
      "filename*=UTF-8''Squire%20Design%20Docs%20%E2%80%94%20Index.md"
    );
    expect(res.text).toContain('# Hello');
  });

  describe('sqd_ API tokens (personal access tokens)', () => {
    test('exports end to end with a default-scope token', async () => {
      await seedDoc(testUserId, 'PAT Doc');
      const res = await request(app)
        .get(`/api/docs/${docId}/export?format=markdown`)
        .set('Authorization', `Bearer ${patDefault}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/markdown');
      expect(res.headers['content-disposition']).toBe('attachment; filename="PAT Doc.md"');
      expect(res.text).toContain('# Hello');
    });

    test('read-only token can export', async () => {
      await seedDoc(testUserId, 'Read Scope Doc');
      const res = await request(app)
        .get(`/api/docs/${docId}/export`)
        .set('Authorization', `Bearer ${patReadOnly}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('# Hello');
    });

    test('read-only token gets 403 INSUFFICIENT_SCOPE on a mutating route', async () => {
      const res = await request(app)
        .post(`/api/docs/${docId}/touch`)
        .set('Authorization', `Bearer ${patReadOnly}`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'Insufficient scope',
        code: 'INSUFFICIENT_SCOPE',
        required: 'documents:write',
        granted: ['documents:read'],
      });
    });

    test('write-only token gets 403 on export but 200 on a mutating route', async () => {
      await seedDoc(testUserId, 'Write Scope Doc');

      const exportRes = await request(app)
        .get(`/api/docs/${docId}/export`)
        .set('Authorization', `Bearer ${patWriteOnly}`);
      expect(exportRes.status).toBe(403);
      expect(exportRes.body.code).toBe('INSUFFICIENT_SCOPE');
      expect(exportRes.body.required).toBe('documents:read');

      const touchRes = await request(app)
        .post(`/api/docs/${docId}/touch`)
        .set('Authorization', `Bearer ${patWriteOnly}`);
      expect(touchRes.status).toBe(200);
    });

    test('browser-session JWTs are not scope-restricted', async () => {
      const res = await request(app)
        .post(`/api/docs/${docId}/touch`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
    });

    test('a legacy sqd_-prefixed token still exports through the REST chain', async () => {
      const crypto = require('crypto');
      const legacyToken = 'sqd_' + crypto.randomBytes(30).toString('base64url');
      const legacyHash = crypto.createHash('sha256').update(legacyToken).digest('hex');
      await pool.query(
        `INSERT INTO mcp_api_tokens (user_id, name, token_prefix, token_hash, scopes)
         VALUES ($1, 'legacy', $2, $3, ARRAY['documents:read'])`,
        [testUserId, legacyToken.substring(0, 8), legacyHash]
      );

      await seedDoc(testUserId, 'Legacy Token Doc');
      const res = await request(app)
        .get(`/api/docs/${docId}/export`)
        .set('Authorization', `Bearer ${legacyToken}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('# Hello');
    });
  });

  describe('tokens minted via create_access_token', () => {
    let mintedToken;
    let mintedRecordId;

    beforeEach(async () => {
      // Mint through the real tool handler as a PAT principal
      const parentRecord = await apiTokens.verifyToken(patDefault);
      const toolRegistry = require('../mcp/tools');
      const result = await toolRegistry.executeTool('create_access_token', {}, {
        userId: testUserId,
        agentId: `api-token:${parentRecord.id}`,
        agentName: 'Export Test Agent',
        scopes: parentRecord.scopes,
        isAgent: true,
        apiTokenId: parentRecord.id,
        baseUrl: 'http://localhost',
      });
      mintedToken = result.token;
      mintedRecordId = (await apiTokens.verifyToken(mintedToken)).id;
    });

    test('minted token exports until expiry, 401 after', async () => {
      await seedDoc(testUserId, 'Minted Token Doc');

      const okRes = await request(app)
        .get(`/api/docs/${docId}/export`)
        .set('Authorization', `Bearer ${mintedToken}`);
      expect(okRes.status).toBe(200);
      expect(okRes.text).toContain('# Hello');

      await pool.query(
        "UPDATE mcp_api_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
        [mintedRecordId]
      );

      const expiredRes = await request(app)
        .get(`/api/docs/${docId}/export`)
        .set('Authorization', `Bearer ${mintedToken}`);
      expect(expiredRes.status).toBe(401);
    });

    test('minted token is read-only by default: 403 on a mutating route', async () => {
      const res = await request(app)
        .post(`/api/docs/${docId}/touch`)
        .set('Authorization', `Bearer ${mintedToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
    });

    test('revoking the parent PAT revokes the minted token', async () => {
      await seedDoc(testUserId, 'Cascade Doc');
      const parentRecord = await apiTokens.getTokenById(
        (await apiTokens.getTokenById(mintedRecordId)).minted_by_api_token_id
      );

      await apiTokens.revokeToken(parentRecord.id, testUserId);

      const res = await request(app)
        .get(`/api/docs/${docId}/export`)
        .set('Authorization', `Bearer ${mintedToken}`);
      expect(res.status).toBe(401);

      // Re-create the parent PAT for any later tests that use patDefault
      patDefault = (await apiTokens.createToken(testUserId, 'test default')).token;
    });
  });
});
