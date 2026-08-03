/**
 * create_document markdown-seeding tests (feature 002, T014).
 *
 * Verifies the optional `markdown` parameter: title derivation precedence,
 * heading retention, one attributed version-history entry for the creation,
 * the extended return shape, and the title-only regression path.
 */
const { createPool, createPersistence } = require('../../__tests__/helpers/db');
const Y = require('yjs');

const pool = createPool();
const persistenceProvider = createPersistence();

const documents = require('../../documents');
const users = require('../../auth/users');
const onboarding = require('../../onboarding');
const documentService = require('../../document-service');
const createDocument = require('../tools/create-document');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../../origin');
const { toMarkdown } = require('../yjs/serialization');
const { groupUpdatesIntoVersions } = require('../../version-history');

const pendingOperations = [];

describe('create_document with markdown', () => {
  let userId;
  const createdDocIds = [];

  beforeAll(async () => {
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          pendingOperations.push(
            persistenceProvider
              .storeUpdate(docGuid, update, parsed.userId, parsed.agentName)
              .catch((err) => console.error(`persist error for ${docGuid}:`, err))
          );
        });
        try {
          const persisted = await persistenceProvider.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), ORIGIN_DB_LOAD);
        } catch (e) {
          /* fresh doc */
        }
        // Mirrors the real createBindState's completion mark, which the 048
        // bind-readiness gate in updateDocument waits on.
        ydoc._bindComplete = true;
      },
      writeState: async () => {},
      provider: persistenceProvider,
    });
    documentService.init(getYDoc, (docName) =>
      docName.startsWith('s/') ? docName.slice(2) : docName
    );
    documents.init(pool);
    users.init(pool);
    onboarding.init(pool);
    createDocument.init(persistenceProvider);

    const res = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-create-md-test', 'create-md-test@example.com', 'Create MD Tester')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    userId = res.rows[0].id;
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    for (const docId of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docId]);
      await pool.query('DELETE FROM document_images WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    }
    await pool.query('UPDATE users SET welcome_doc_id = NULL WHERE id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await persistenceProvider.destroy();
    await pool.end();
  });

  function agentToken(overrides = {}) {
    return { userId, agentName: 'Test Agent', scopes: ['documents:read', 'documents:write'], ...overrides };
  }

  async function call(args) {
    const result = await createDocument.handler(args, agentToken());
    if (result.docGuid) createdDocIds.push(result.docGuid);
    return result;
  }

  function fragmentOf(docGuid) {
    return documentService.getSharedDoc(docGuid).get('default', Y.XmlFragment);
  }

  test('markdown-only call derives title from first heading and seeds the body', async () => {
    const result = await call({
      markdown: '# Payments Redesign\n\nIntro **bold** text.\n\n- item one\n- item two',
    });
    expect(result.title).toBe('Payments Redesign');
    expect(result.blocks).toEqual({ imported: 3 });
    expect(result.images).toEqual({ rehosted: [], copied: [], degraded: [], rejected: [] });

    const md = toMarkdown(fragmentOf(result.docGuid));
    // Heading retained in the body (FR-008).
    expect(md).toContain('# Payments Redesign');
    expect(md).toContain('**bold**');
    expect(md).toContain('- item one');

    const row = await pool.query('SELECT title FROM documents WHERE id = $1', [result.docGuid]);
    expect(row.rows[0].title).toBe('Payments Redesign');
  });

  test('explicit title beats frontmatter beats heading', async () => {
    const md = '---\nsquire:\n  title: Frontmatter Title\n---\n# Heading Title\n\nBody.';

    const explicit = await call({ title: 'Explicit Title', markdown: md });
    expect(explicit.title).toBe('Explicit Title');

    const fromFm = await call({ markdown: md });
    expect(fromFm.title).toBe('Frontmatter Title');

    const fromHeading = await call({ markdown: '# Heading Title\n\nBody.' });
    expect(fromHeading.title).toBe('Heading Title');

    const untitled = await call({ markdown: 'no headings here' });
    expect(untitled.title).toBe('Untitled');
  });

  test('creation lands as one attributed version-history entry', async () => {
    const result = await call({ markdown: '# One Entry\n\nfirst\n\nsecond' });
    await Promise.all(pendingOperations.splice(0));

    const updates = await persistenceProvider.getRecentUpdatesWithUsers(result.docGuid, 100);
    const versions = groupUpdatesIntoVersions(updates);
    expect(versions).toHaveLength(1);
    // Attributed to the acting user (agent on behalf of user).
    const rows = await pool.query(
      'SELECT DISTINCT user_id, agent_name FROM yjs_updates WHERE doc_guid = $1', [result.docGuid]
    );
    expect(rows.rows).toEqual([{ user_id: userId, agent_name: 'Test Agent' }]);
  });

  test('no empty anchor paragraph when markdown seeds real content', async () => {
    const result = await call({ markdown: '# Solid\n\nContent.' });
    const fragment = fragmentOf(result.docGuid);
    const blocks = fragment.toArray();
    expect(blocks[0].nodeName).toBe('heading');
    // No leading/trailing empty paragraph from the empty-create path.
    const texts = blocks.map((b) => toMarkdown(b));
    expect(blocks).toHaveLength(2);
  });

  test('frontmatter-only markdown seeds the empty anchor paragraph + derived title', async () => {
    const result = await call({ markdown: '---\nsquire:\n  title: FM Only\n---\n' });
    expect(result.title).toBe('FM Only');
    const fragment = fragmentOf(result.docGuid);
    expect(fragment.length).toBe(1);
    expect(fragment.get(0).nodeName).toBe('paragraph');
  });

  test('F1: body that is only a data: image falls back to an anchored doc, no orphan', async () => {
    // deriveImportTitle counts the image block BEFORE the image policy, so this
    // takes the seed-and-import path; prepareImport then drops the data: image
    // and would throw EMPTY_IMPORT. The tool must NOT surface an error while
    // leaving an empty untitled doc behind — it falls back to the anchor-only
    // shape and reports the dropped image.
    const result = await call({ markdown: '![ ](data:image/png;base64,AAAA)' });
    expect(result.docGuid).toBeTruthy();
    expect(result.title).toBe('Untitled');
    expect(result.blocks).toEqual({ imported: 0 });
    expect(result.images.rejected).toHaveLength(1);
    expect(result.images.rejected[0].reason).toBe('data-url');

    // The created doc is a real anchored doc, not a bodyless orphan.
    const fragment = fragmentOf(result.docGuid);
    expect(fragment.length).toBe(1);
    expect(fragment.get(0).nodeName).toBe('paragraph');

    // And the document row exists (was not rolled back).
    const row = await pool.query('SELECT title FROM documents WHERE id = $1', [result.docGuid]);
    expect(row.rows[0].title).toBe('Untitled');
  });

  test('title-only call unchanged (regression): empty anchor paragraph, no blocks field', async () => {
    const result = await call({ title: 'Just A Title' });
    expect(result.title).toBe('Just A Title');
    expect(result.blocks).toBeUndefined();
    expect(result.images).toBeUndefined();
    expect(result.url).toContain(`/d/${result.docGuid}`);

    const fragment = fragmentOf(result.docGuid);
    expect(fragment.length).toBe(1);
    expect(fragment.get(0).nodeName).toBe('paragraph');
  });

  test('neither title nor markdown is a validation error', async () => {
    await expect(createDocument.handler({}, agentToken())).rejects.toThrow(
      /at least one of: title, markdown/
    );
    await expect(createDocument.handler({ markdown: '   ' }, agentToken())).rejects.toThrow(
      /at least one of: title, markdown/
    );
  });

  test('inputSchema no longer hard-requires title', () => {
    expect(createDocument.inputSchema.required).toEqual([]);
    expect(createDocument.inputSchema.properties.markdown).toBeDefined();
  });
});
