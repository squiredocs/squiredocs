/**
 * Feature 017 US2 — MCP list_documents `updatedAfter` entry point.
 *
 * Contract: specs/017-search-index-efficiency/contracts/mcp-list-documents.md
 * The handler is exercised directly (init with test persistence, call
 * handler(args, { userId, baseUrl })). Searches run in fulltext mode so no
 * provider or embeddings are needed.
 */
const { createPool, createPersistence, createTestUser, cleanupTestUser } = require('./helpers/db');
const listDocuments = require('../mcp/tools/list-documents');
const toolRegistry = require('../mcp/tools');
const search = require('../search');

describe('MCP list_documents updatedAfter (017 US2)', () => {
  let pool;
  let persistence;
  let userId;
  let docOld;
  let docNew;
  let docIds;

  const OLD_TS = '2026-01-05T00:00:00Z';
  const NEW_TS = '2026-06-10T00:00:00Z';
  const CUTOFF = '2026-03-01T00:00:00Z';
  const ctx = () => ({ userId, baseUrl: 'https://test.example' });

  async function seedDoc(title, updatedAt, body) {
    const r = await pool.query(
      `INSERT INTO documents (id, title, creator_id, updated_at) VALUES (uuid_generate_v4(), $1, $2, $3) RETURNING id`,
      [title, userId, updatedAt]
    );
    const id = r.rows[0].id;
    await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, userId]);
    await pool.query(
      `INSERT INTO document_search_index (doc_id, content_text, search_vector)
       VALUES ($1, $2,
         setweight(to_tsvector('english', $3), 'A') ||
         setweight(to_tsvector('english', $2), 'B'))`,
      [id, body, title]
    );
    return id;
  }

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    await persistence._init();
    listDocuments.init(persistence);
    search.init(pool);

    userId = await createTestUser(pool, 'list-docs-updated-after@example.com');
    docOld = await seedDoc('Old Walrus Doc', OLD_TS, 'walrus migration from the old archive');
    docNew = await seedDoc('New Walrus Doc', NEW_TS, 'walrus sightings from the recent survey');
    docIds = [docOld, docNew];
    search._resetCache();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM document_search_index WHERE doc_id = ANY($1)', [docIds]);
    await pool.query('DELETE FROM document_shares WHERE doc_id = ANY($1)', [docIds]);
    await pool.query('DELETE FROM documents WHERE id = ANY($1)', [docIds]);
    await cleanupTestUser(pool, userId);
    search._resetCache();
    await persistence.destroy();
    await pool.end();
  });

  test('updatedAfter + search filters results and totals', async () => {
    const result = await listDocuments.handler(
      { search: 'walrus', searchMode: 'fulltext', updatedAfter: CUTOFF },
      ctx()
    );
    const ids = result.documents.map((d) => d.id);
    expect(ids).toContain(docNew);
    expect(ids).not.toContain(docOld);
    expect(result.pagination.total).toBe(1);
    for (const doc of result.documents) {
      expect(new Date(doc.updatedAt).getTime()).toBeGreaterThan(new Date(CUTOFF).getTime());
    }
  });

  test('updatedAfter without search is a tool error naming updatedSince (CN-3)', async () => {
    await expect(listDocuments.handler({ updatedAfter: CUTOFF }, ctx())).rejects.toThrow(
      /updatedAfter requires a content search.*updatedSince/s
    );
  });

  test('unparseable updatedAfter is a tool error', async () => {
    await expect(
      listDocuments.handler({ search: 'walrus', searchMode: 'fulltext', updatedAfter: 'not-a-timestamp' }, ctx())
    ).rejects.toThrow('updatedAfter must be a valid ISO-8601 timestamp');
  });

  test('updatedAfter + updatedSince always errors — with search', async () => {
    await expect(
      listDocuments.handler(
        { search: 'walrus', updatedAfter: CUTOFF, updatedSince: CUTOFF },
        ctx()
      )
    ).rejects.toThrow('updatedSince is not supported together with search');
  });

  test('updatedAfter + updatedSince always errors — without search', async () => {
    await expect(
      listDocuments.handler({ updatedAfter: CUTOFF, updatedSince: CUTOFF }, ctx())
    ).rejects.toThrow(/updatedAfter requires a content search/);
  });

  test('updatedSince-only list path behavior is unchanged', async () => {
    const result = await listDocuments.handler({ updatedSince: '2026-01-01T00:00:00Z' }, ctx());
    expect(result).toHaveProperty('documents');
    expect(result).toHaveProperty('pagination');
    expect(Array.isArray(result.documents)).toBe(true);
  });

  test('no-new-params search response shape unchanged (FR-022)', async () => {
    const result = await listDocuments.handler({ search: 'walrus', searchMode: 'fulltext' }, ctx());
    expect(result.pagination.total).toBe(2);
    const doc = result.documents.find((d) => d.id === docNew);
    expect(Object.keys(doc).sort()).toEqual(['id', 'role', 'score', 'snippet', 'title', 'updatedAt', 'url'].sort());
    expect(doc.url).toBe(`https://test.example/d/${docNew}`);
  });

  test('no-new-params list response shape unchanged (FR-022)', async () => {
    const result = await listDocuments.handler({}, ctx());
    expect(result.pagination.total).toBe(2);
    const doc = result.documents.find((d) => d.id === docNew);
    expect(Object.keys(doc).sort()).toEqual(
      ['id', 'title', 'url', 'role', 'createdAt', 'updatedAt', 'clock', 'lastModifiedAt', 'shareCount'].sort()
    );
  });

  test('inputSchema documents updatedAfter and its contrast with updatedSince (FR-019)', () => {
    const prop = listDocuments.inputSchema.properties.updatedAfter;
    expect(prop).toBeDefined();
    expect(prop.type).toBe('string');
    expect(prop.description).toMatch(/updatedSince/);
    expect(prop.description).toMatch(/STRICTLY AFTER/i);
    // Tool prose documents both parameters side by side
    expect(listDocuments.description).toMatch(/updatedAfter/);
    expect(listDocuments.description).toMatch(/updatedSince/);
  });

  test('MCP surface still exposes exactly 16 tools (FR-019)', () => {
    expect(toolRegistry.getToolList().length).toBe(16);
  });
});
