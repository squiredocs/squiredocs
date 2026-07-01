/**
 * Tests for the admin email-enabled toggle and sharing-review endpoints
 * (server/api/admin.js).
 */
const request = require('supertest');
const express = require('express');
const admin = require('../api/admin');
const documents = require('../documents');
const { createPool } = require('./helpers/db');

describe('Admin: email-enabled + sharing review', () => {
  let app;
  let pool;
  let ownerId;
  let memberId;
  let docId;

  beforeAll(async () => {
    pool = createPool();
    admin.init(pool);
    documents.init(pool);

    const owner = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ('test-admin-sharing-owner', 'test-admin-sharing-owner@example.com', 'Owner')
       RETURNING id`
    );
    ownerId = owner.rows[0].id;

    const member = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ('test-admin-sharing-member', 'test-admin-sharing-member@example.com', 'Member')
       RETURNING id`
    );
    memberId = member.rows[0].id;

    docId = require('crypto').randomUUID();
    await documents.createDocument(docId, ownerId, 'Owned Doc');
    await documents.setRole(docId, memberId, 'editor');
    await documents.createInvite(docId, 'invited@example.com', 'viewer', ownerId);

    app = express();
    app.use(express.json());
    app.use('/api/admin', admin.router);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM document_share_invites WHERE doc_id = $1', [docId]);
    await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
    await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    await pool.query("DELETE FROM users WHERE email LIKE 'test-admin-sharing-%@example.com'");
    await pool.end();
  });

  describe('PATCH /:userId/email-enabled', () => {
    test('toggles the flag on and off', async () => {
      const on = await request(app)
        .patch(`/api/admin/users/${ownerId}/email-enabled`)
        .send({ emailEnabled: true });
      expect(on.status).toBe(200);
      expect(on.body.emailEnabled).toBe(true);

      const check = await pool.query('SELECT email_enabled FROM users WHERE id = $1', [ownerId]);
      expect(check.rows[0].email_enabled).toBe(true);

      const off = await request(app)
        .patch(`/api/admin/users/${ownerId}/email-enabled`)
        .send({ emailEnabled: false });
      expect(off.status).toBe(200);
      expect(off.body.emailEnabled).toBe(false);
    });

    test('rejects a non-boolean value', async () => {
      const res = await request(app)
        .patch(`/api/admin/users/${ownerId}/email-enabled`)
        .send({ emailEnabled: 'yes' });
      expect(res.status).toBe(400);
    });

    test('returns 404 for an unknown user', async () => {
      const res = await request(app)
        .patch(`/api/admin/users/${require('crypto').randomUUID()}/email-enabled`)
        .send({ emailEnabled: true });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /:userId/sharing', () => {
    test('returns invites created by the user and collaborators on owned docs', async () => {
      const res = await request(app).get(`/api/admin/users/${ownerId}/sharing`);
      expect(res.status).toBe(200);

      expect(res.body.invites.some((i) => i.email === 'invited@example.com' && i.docTitle === 'Owned Doc')).toBe(true);
      expect(res.body.shares.some((s) => s.email === 'test-admin-sharing-member@example.com' && s.role === 'editor')).toBe(true);
      // The owner themselves should not appear in their own doc's collaborator list.
      expect(res.body.shares.some((s) => s.email === 'test-admin-sharing-owner@example.com')).toBe(false);
    });

    test('returns empty lists for a user with no sharing activity', async () => {
      const res = await request(app).get(`/api/admin/users/${memberId}/sharing`);
      expect(res.status).toBe(200);
      expect(res.body.invites).toEqual([]);
      expect(res.body.shares).toEqual([]);
    });
  });
});
