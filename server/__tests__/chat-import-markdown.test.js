/**
 * import_markdown chat tool — integration tests
 *
 * Exercises the byte-channel import path end-to-end against the test database
 * with a real Yjs-backed document service (same harness as onboarding.test.js):
 * a markdown attachment's bytes go from the message context into the importer,
 * producing a real owned document, while the tool result stays small.
 */
const { createPool, createPersistence } = require('./helpers/db');
const Y = require('yjs');

const pool = createPool();
const persistenceProvider = createPersistence();

const documents = require('../documents');
const documentService = require('../document-service');
const chatTools = require('../api/chat-tools');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../origin');

const pendingOperations = [];

function mdAttachment(filename, markdown) {
  return { filename, mediaType: 'text/markdown', dataBase64: Buffer.from(markdown).toString('base64') };
}

describe('import_markdown chat tool', () => {
  let testUserId;
  const createdDocIds = [];
  let tools;

  beforeAll(async () => {
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          const { userId, agentName } = parsed;
          pendingOperations.push(
            persistenceProvider.storeUpdate(docGuid, update, userId, agentName).catch((err) => {
              console.error(`Error persisting update for ${docGuid}:`, err);
            })
          );
        });
        try {
          const persistedYdoc = await persistenceProvider.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);
        } catch (error) {
          /* doc doesn't exist yet — fine */
        }
      },
      writeState: async () => {},
      provider: persistenceProvider,
    });

    const extractDocGuid = (docName) => (docName.startsWith('s/') ? docName.slice(2) : docName);
    documentService.init(getYDoc, extractDocGuid);
    documents.init(pool);

    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-md-import-test', 'md-import-test@example.com', 'Md Import Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    for (const docId of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    }
    await pool.query('DELETE FROM document_shares WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  afterEach(async () => {
    await Promise.all(pendingOperations);
    pendingOperations.length = 0;
  });

  function buildToolsWith(messageMarkdown) {
    return chatTools.buildImageTools(
      { userId: testUserId, agentName: 'Squire Docs Assistant' },
      { messageMarkdown }
    );
  }

  it('imports an attached markdown file as an owned document titled after the file name', async () => {
    tools = buildToolsWith([mdAttachment('payment spec.md', '# Some Heading\n\nBody text here.\n\n- item one\n- item two\n')]);
    const result = await tools.import_markdown.execute({});

    expect(result.error).toBeUndefined();
    expect(result.imported).toBe(true);
    expect(result.title).toBe('payment spec'); // file name beats the first heading
    expect(result.docGuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.url).toBe(`/d/${result.docGuid}`);
    expect(result.blocks.imported).toBeGreaterThan(0);
    createdDocIds.push(result.docGuid);

    // The document row exists, is owned by the user, and carries the title
    const doc = await pool.query('SELECT title FROM documents WHERE id = $1', [result.docGuid]);
    expect(doc.rows[0].title).toBe('payment spec');
    const share = await pool.query(
      'SELECT role FROM document_shares WHERE doc_id = $1 AND user_id = $2',
      [result.docGuid, testUserId]
    );
    expect(share.rows[0].role).toBe('owner');

    // The content actually landed in the Yjs doc (persisted via the update path)
    await Promise.all(pendingOperations);
    const ydoc = await persistenceProvider.getYDoc(result.docGuid);
    expect(ydoc.getXmlFragment('default').length).toBeGreaterThan(0);
  });

  it('honors an explicit title override', async () => {
    tools = buildToolsWith([mdAttachment('notes.md', 'Some plain notes.')]);
    const result = await tools.import_markdown.execute({ title: 'Q3 Architecture Notes' });
    expect(result.imported).toBe(true);
    expect(result.title).toBe('Q3 Architecture Notes');
    createdDocIds.push(result.docGuid);
  });

  it('errors gracefully when no markdown is attached', async () => {
    tools = buildToolsWith([]);
    const result = await tools.import_markdown.execute({});
    expect(result.imported).toBeUndefined();
    expect(result.error).toMatch(/No markdown file is attached/);
  });

  it('errors gracefully on an out-of-range attachment index', async () => {
    tools = buildToolsWith([mdAttachment('a.md', '# A')]);
    const result = await tools.import_markdown.execute({ attachmentIndex: 3 });
    expect(result.error).toMatch(/No markdown attachment at index 3/);
  });

  it('errors gracefully on an empty markdown file', async () => {
    tools = buildToolsWith([mdAttachment('empty.md', '   \n  ')]);
    const result = await tools.import_markdown.execute({});
    expect(result.error).toMatch(/empty/i);
  });
});
