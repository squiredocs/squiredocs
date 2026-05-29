/**
 * Tests for GET /api/docs/:docId/export (Markdown export)
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const Y = require('yjs');
const documents = require('../documents');
const { toMarkdown } = require('../mcp/yjs/serialization');
const { createPool, createPersistence } = require('./helpers/db');

const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

// Mirror the sanitizeFilename helper from server/index.js
function sanitizeFilename(title) {
  const cleaned = String(title || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
  return cleaned || 'document';
}

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

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    await persistence._init();
    documents.init(pool);

    const user1 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-export-1', 'test-export-1@example.com', 'Export User 1', NULL)
       RETURNING id`
    );
    testUserId = user1.rows[0].id;

    const user2 = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('test-export-2', 'test-export-2@example.com', 'Export User 2', NULL)
       RETURNING id`
    );
    testUser2Id = user2.rows[0].id;

    authToken = jwt.sign({ userId: testUserId }, JWT_SECRET);
    authToken2 = jwt.sign({ userId: testUser2Id }, JWT_SECRET);

    app = express();

    const requireAuth = (req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
      } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    };

    // Implement the export endpoint (same logic as server/index.js)
    app.get('/api/docs/:docId/export', requireAuth, async (req, res) => {
      try {
        const { docId } = req.params;
        const { format = 'markdown' } = req.query;
        const userId = req.user.userId;

        const role = await documents.getRole(docId, userId);
        if (!role) {
          return res.status(403).json({ error: 'You do not have access to this document' });
        }

        if (format !== 'markdown' && format !== 'md') {
          return res.status(400).json({ error: `Unsupported export format: ${format}` });
        }

        const ydoc = await persistence.getYDoc(docId);
        const xmlFragment = ydoc.get('default', Y.XmlFragment);
        const title = ydoc.getMap('meta').get('title') || 'Untitled';

        const markdown = toMarkdown(xmlFragment);

        const filename = sanitizeFilename(title) + '.md';
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(markdown);
      } catch (error) {
        res.status(500).json({ error: 'Failed to export document' });
      }
    });
  });

  afterAll(async () => {
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
});
