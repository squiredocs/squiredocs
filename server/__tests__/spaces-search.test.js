/**
 * Spaces — search visibility (feature 053, US2 / FR-027 / SC-004).
 *
 * The design names the exact failure this suite exists to catch: "a missed leg
 * makes space documents readable but absent from search results." So a space
 * document must be findable by a member and invisible to a non-member in ALL
 * THREE modes — fulltext, semantic and hybrid — not just the one that happens
 * to be the default.
 *
 * Also pins RBD-053-14: `filter=owned` in search keeps meaning a DIRECT owner
 * share, so a space owner's passthrough does not reclassify the whole space as
 * theirs.
 */
const crypto = require('crypto');
const { createPool, cleanupTestUser } = require('./helpers/db');

const DIMS = 1536;
const vecQuery = [1, ...Array(DIMS - 1).fill(0)];
const vecMatch = [0.99, 0.01, ...Array(DIMS - 2).fill(0)];

const mockEmbed = jest.fn(async () => ({ embedding: vecQuery }));
const mockEmbedMany = jest.fn();
jest.mock('ai', () => ({
  embed: (...args) => mockEmbed(...args),
  embedMany: (...args) => mockEmbedMany(...args),
  generateObject: jest.fn(),
  jsonSchema: (s) => s,
}));
jest.mock('@ai-sdk/google', () => ({
  google: { textEmbeddingModel: jest.fn(() => 'mock-embedding-model') },
}));

const search = require('../search');
const documents = require('../documents');
const spaces = require('../spaces');

describe('Spaces and search', () => {
  let pool;
  let savedApiKey;
  const createdUsers = [];
  const createdDocs = [];
  const createdSpaces = [];

  let owner; // creates the space and the documents
  let member; // space editor, no direct share
  let curator; // space OWNER, no direct share — the passthrough case
  let stranger; // no membership, no share
  let spaceId;
  let spaceDoc;
  let personalDoc;

  async function makeUser(label) {
    const { rows } = await pool.query(
      'INSERT INTO users (google_id, email, name) VALUES ($1, $2, $3) RETURNING id',
      [`ss-${label}-${crypto.randomUUID()}`, `ss-${label}-${crypto.randomUUID()}@example.com`, `SS ${label}`]
    );
    createdUsers.push(rows[0].id);
    return rows[0].id;
  }

  async function seedDoc(title, ownerId, body, spaceOf = null) {
    const docId = crypto.randomUUID();
    createdDocs.push(docId);
    await documents.createDocument(docId, ownerId, title, spaceOf);
    await pool.query(
      `INSERT INTO document_search_index (doc_id, content_text, search_vector)
       VALUES ($1, $2,
         setweight(to_tsvector('english', $3), 'A') ||
         setweight(to_tsvector('english', $2), 'B'))`,
      [docId, body, title]
    );
    await pool.query(
      'INSERT INTO document_embeddings (doc_id, chunk_index, chunk_text, embedding) VALUES ($1, 0, $2, $3)',
      [docId, body, JSON.stringify(vecMatch)]
    );
    return docId;
  }

  beforeAll(async () => {
    pool = createPool();
    documents.init(pool);
    spaces.init(pool);
    search.init(pool);

    savedApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key-spaces-search';

    owner = await makeUser('owner');
    member = await makeUser('member');
    curator = await makeUser('curator');
    stranger = await makeUser('stranger');

    const space = await spaces.createSpace('Search Space', owner);
    spaceId = space.id;
    createdSpaces.push(spaceId);
    await pool.query(
      "INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, 'editor', $3)",
      [spaceId, member, owner]
    );
    await pool.query(
      "INSERT INTO space_members (space_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $3)",
      [spaceId, curator, owner]
    );

    spaceDoc = await seedDoc(
      'Narwhal Migration Plan',
      owner,
      'narwhal migration corridors mapped across the arctic shelf',
      spaceId
    );
    personalDoc = await seedDoc(
      'Narwhal Personal Notes',
      owner,
      'narwhal sightings noted privately by the author'
    );
    search._resetCache();
  });

  afterAll(async () => {
    if (savedApiKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = savedApiKey;

    await pool.query('DELETE FROM document_embeddings WHERE doc_id = ANY($1::uuid[])', [createdDocs]);
    await pool.query('DELETE FROM document_search_index WHERE doc_id = ANY($1::uuid[])', [createdDocs]);
    await pool.query('DELETE FROM document_shares WHERE doc_id = ANY($1::uuid[])', [createdDocs]);
    await pool.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [createdDocs]);
    await pool.query('DELETE FROM space_members WHERE space_id = ANY($1::uuid[])', [createdSpaces]);
    await pool.query('DELETE FROM spaces WHERE id = ANY($1::uuid[])', [createdSpaces]);
    for (const id of createdUsers) await cleanupTestUser(pool, id);
    search._resetCache();
    await pool.end();
  });

  const MODES = ['fulltext', 'semantic', 'hybrid'];

  describe.each(MODES)('mode=%s', (mode) => {
    test('a space member finds the space document (FR-027)', async () => {
      const results = await search.searchDocuments(member, 'narwhal migration', { mode });
      expect(results.rows.map((r) => r.doc_id)).toContain(spaceDoc);
    });

    test('a non-member finds nothing (SC-004)', async () => {
      const results = await search.searchDocuments(stranger, 'narwhal migration', { mode });
      expect(results.rows).toEqual([]);
    });

    test('the member sees the effective role and the space name on the row', async () => {
      const results = await search.searchDocuments(member, 'narwhal migration', { mode });
      const row = results.rows.find((r) => r.doc_id === spaceDoc);
      expect(row.role).toBe('editor');
      expect(row.space_id).toBe(spaceId);
      expect(row.space_name).toBe('Search Space');
    });
  });

  describe('filter semantics (RBD-053-14)', () => {
    test("filter=owned excludes documents the caller only owns THROUGH a space", async () => {
      const results = await search.searchDocuments(curator, 'narwhal migration', {
        mode: 'fulltext',
        filter: 'owned',
      });
      expect(results.rows.map((r) => r.doc_id)).not.toContain(spaceDoc);
      // …while the unfiltered search does find it, at the passthrough role.
      const all = await search.searchDocuments(curator, 'narwhal migration', { mode: 'fulltext' });
      const row = all.rows.find((r) => r.doc_id === spaceDoc);
      expect(row).toBeDefined();
      expect(row.role).toBe('owner');
    });

    test('filter=shared_with_me INCLUDES a space-only document', async () => {
      const results = await search.searchDocuments(member, 'narwhal migration', {
        mode: 'fulltext',
        filter: 'shared_with_me',
      });
      expect(results.rows.map((r) => r.doc_id)).toContain(spaceDoc);
    });

    test('filter=owned still finds a directly owned document', async () => {
      const results = await search.searchDocuments(owner, 'narwhal', {
        mode: 'fulltext',
        filter: 'owned',
      });
      expect(results.rows.map((r) => r.doc_id).sort()).toEqual([spaceDoc, personalDoc].sort());
    });
  });

  describe('space scope (FR-026)', () => {
    test('space=<id> narrows to that space; space=personal excludes it', async () => {
      const inSpace = await search.searchDocuments(owner, 'narwhal', { mode: 'fulltext', space: spaceId });
      expect(inSpace.rows.map((r) => r.doc_id)).toEqual([spaceDoc]);

      const personal = await search.searchDocuments(owner, 'narwhal', { mode: 'fulltext', space: 'personal' });
      expect(personal.rows.map((r) => r.doc_id)).toEqual([personalDoc]);
    });

    test('omitting the scope is identical to space=all', async () => {
      const omitted = await search.searchDocuments(owner, 'narwhal', { mode: 'fulltext' });
      const all = await search.searchDocuments(owner, 'narwhal', { mode: 'fulltext', space: 'all' });
      expect(all.rows.map((r) => r.doc_id)).toEqual(omitted.rows.map((r) => r.doc_id));
      expect(all.pagination).toEqual(omitted.pagination);
    });

    test('the scope applies in semantic and hybrid modes too', async () => {
      for (const mode of ['semantic', 'hybrid']) {
        const res = await search.searchDocuments(owner, 'narwhal', { mode, space: spaceId });
        expect(res.rows.map((r) => r.doc_id)).toEqual([spaceDoc]);
      }
    });
  });

  describe('visibility follows the document', () => {
    test('moving a space document out hides it from the member immediately, with no reindex', async () => {
      const doc = await seedDoc('Narwhal Transient', owner, 'narwhal transient study group', spaceId);
      expect((await search.searchDocuments(member, 'transient', { mode: 'fulltext' })).rows
        .map((r) => r.doc_id)).toContain(doc);

      await spaces.moveDocument(owner, doc, null);

      expect((await search.searchDocuments(member, 'transient', { mode: 'fulltext' })).rows).toEqual([]);
      expect((await search.searchDocuments(owner, 'transient', { mode: 'fulltext' })).rows
        .map((r) => r.doc_id)).toContain(doc);
    });
  });
});
