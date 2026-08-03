/**
 * Concurrent-edit safety for imports (feature 002, T018 — SC-006).
 *
 * - A collaborator typing while an append import is in flight loses nothing:
 *   append is pure insertion, both edit streams land (SC-006).
 * - Double-fired identical appends both apply (duplicate content is the
 *   caller's responsibility — spec Edge Cases).
 * - Replace-mode convergence (analyze rec C3): concurrent identical replaces
 *   converge to exactly one copy of the new body — no corruption, no
 *   duplicated blocks, document still structurally valid.
 */
const request = require('supertest');
const express = require('express');
const Y = require('yjs');

const { createPool, createPersistence } = require('../../server/__tests__/helpers/db');
const pool = createPool();
const persistence = createPersistence();

const documents = require('../../server/documents');
const documentService = require('../../server/document-service');
const apiTokens = require('../../server/mcp/auth/api-tokens');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin, createOrigin } = require('../../server/origin');
const { toMarkdown } = require('../../server/mcp/yjs/serialization');
const { createImportRouter } = require('../../server/api/docs-import');

const pendingOperations = [];

describe('import concurrency (SC-006)', () => {
  let app;
  let userId;
  let collaboratorId;
  let pat;
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
        // Mirrors the real createBindState's completion mark, which the 048
        // bind-readiness gate in updateDocument waits on.
        ydoc._bindComplete = true;
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
       VALUES ('test-import-conc-1', 'import-conc-1@example.com', 'Conc User 1')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`
    );
    userId = u1.rows[0].id;
    const u2 = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ('test-import-conc-2', 'import-conc-2@example.com', 'Conc User 2')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`
    );
    collaboratorId = u2.rows[0].id;
    pat = (await apiTokens.createToken(userId, 'conc token')).token;

    app = express();
    app.use(createImportRouter(persistence));
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    for (const docId of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    }
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id IN ($1, $2)', [userId, collaboratorId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userId, collaboratorId]);
    await persistence.destroy();
    await pool.end();
  });

  function put(docId, body, query = '') {
    return request(app)
      .put(`/api/docs/${docId}/import${query}`)
      .set('Authorization', `Bearer ${pat}`)
      .set('Content-Type', 'text/markdown')
      .send(body);
  }

  async function makeDoc(initialMd) {
    const res = await request(app)
      .post('/api/docs/import')
      .set('Authorization', `Bearer ${pat}`)
      .set('Content-Type', 'text/markdown')
      .send(initialMd);
    expect(res.status).toBe(201);
    createdDocIds.push(res.body.docId);
    return res.body.docId;
  }

  test('collaborator keystrokes during an append import are not lost', async () => {
    const docId = await makeDoc('# Shared Doc\n\nHuman paragraph.');
    const ydoc = documentService.getSharedDoc(docId);
    const fragment = ydoc.get('default', Y.XmlFragment);

    // Fire the append import; while its async pipeline is in flight, the
    // collaborator keeps typing into the existing paragraph.
    const importPromise = put(docId, '## Imported Section\n\nImported body text.');

    const para = fragment
      .toArray()
      .find((n) => n instanceof Y.XmlElement && n.nodeName === 'paragraph');
    const textNode = para.toArray().find((n) => n instanceof Y.XmlText);
    ydoc.transact(() => {
      textNode.insert(textNode.length, ' Typed mid-import!');
    }, createOrigin(collaboratorId));

    const res = await importPromise;
    expect(res.status).toBe(200);

    const md = toMarkdown(fragment);
    // Both edit streams intact: the keystrokes AND the imported section.
    expect(md).toContain('Human paragraph. Typed mid-import!');
    expect(md).toContain('## Imported Section');
    expect(md).toContain('Imported body text.');
  });

  test('double-fired identical appends both apply (duplicates, no corruption)', async () => {
    const docId = await makeDoc('# Webhook Target');

    const [a, b] = await Promise.all([
      put(docId, '## Progress\n\nStep done.'),
      put(docId, '## Progress\n\nStep done.'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const md = toMarkdown(documentService.getSharedDoc(docId).get('default', Y.XmlFragment));
    const occurrences = md.split('## Progress').length - 1;
    expect(occurrences).toBe(2);
    expect(md.split('Step done.').length - 1).toBe(2);
  });

  test('concurrent identical replaces converge to exactly one copy (C3)', async () => {
    const docId = await makeDoc('# Original\n\nOld body one.\n\nOld body two.');

    const replacement = '# Regenerated\n\nFresh body.\n\n- fresh item';
    const [a, b] = await Promise.all([
      put(docId, replacement, '?mode=replace'),
      put(docId, replacement, '?mode=replace'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const fragment = documentService.getSharedDoc(docId).get('default', Y.XmlFragment);
    const md = toMarkdown(fragment);

    // Converged: exactly ONE copy of the replacement, none of the original.
    expect(md.split('# Regenerated').length - 1).toBe(1);
    expect(md.split('Fresh body.').length - 1).toBe(1);
    expect(md).not.toContain('Old body');
    expect(fragment.toArray().map((n) => n.nodeName)).toEqual([
      'heading',
      'paragraph',
      'bulletList',
    ]);
  });

  test('replace vs a diverged collaborator replica merges per CRDT semantics', async () => {
    // True concurrency needs a second replica: a collaborator whose edit is
    // made against the PRE-replace state and only syncs in afterwards.
    const docId = await makeDoc('# Live Doc\n\nEditing here.');
    const ydoc = documentService.getSharedDoc(docId);
    const fragment = ydoc.get('default', Y.XmlFragment);

    // Collaborator replica diverges: adds a brand-new top-level paragraph.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(ydoc));
    const svBeforeEdit = Y.encodeStateVector(replica);
    const replicaFragment = replica.get('default', Y.XmlFragment);
    replica.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'Concurrent addition.');
      p.insert(0, [t]);
      replicaFragment.insert(replicaFragment.length, [p]);
    });
    const replicaEdit = Y.encodeStateAsUpdate(replica, svBeforeEdit);

    // The replace lands on the server first…
    const res = await put(docId, '# Replaced\n\nNew content.', '?mode=replace');
    expect(res.status).toBe(200);

    // …then the collaborator's concurrent update syncs in. CRDT merge, not an
    // error (documented Principle IV exception: edits INSIDE removed blocks
    // are lost with them — this was a new top-level block, so it survives).
    ydoc.transact(() => Y.applyUpdate(ydoc, replicaEdit), createOrigin(collaboratorId));

    const md = toMarkdown(fragment);
    expect(md).toContain('# Replaced');
    expect(md).toContain('New content.');
    expect(md).toContain('Concurrent addition.');
    expect(md).not.toContain('Editing here.');
    replica.destroy();
  });
});
