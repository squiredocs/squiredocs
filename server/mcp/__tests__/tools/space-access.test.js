/**
 * MCP tools reach space members too (feature 053, FR-028).
 *
 * Six inline `document_shares` joins used to live under server/mcp/. Each one
 * was its own answer to "may this user act here", and each would have needed
 * teaching about spaces separately — the design's named failure mode. They now
 * all route through documents.getRole / documents.hasAccess, i.e. the
 * document_access view.
 *
 * This suite proves the reroute from the OUTSIDE: a space member with NO direct
 * share can drive each tool, and a non-member still gets the byte-identical
 * error string agents are trained on.
 */
const crypto = require('crypto');
const Y = require('yjs');
const {
  createPool,
  createPersistence,
  cleanupTestUser,
  cleanupDocRows,
} = require('../../../__tests__/helpers/db');

const documents = require('../../../documents');
const spaces = require('../../../spaces');
const users = require('../../../auth/users');
const documentService = require('../../../document-service');
const setDocumentTitle = require('../../tools/set-document-title');
const setDocumentVersionName = require('../../tools/set-document-version-name');
const listDocumentVersions = require('../../tools/list-document-versions');
const listDocuments = require('../../tools/list-documents');

const NO_ACCESS = 'Document not found or you do not have access';

describe('MCP tools and space membership', () => {
  let pool;
  let persistence;
  const createdUsers = [];
  const createdDocs = [];
  const createdSpaces = [];

  let author;
  let member; // space editor, no direct share
  let viewerMember; // space viewer, no direct share
  let stranger;
  let spaceId;
  let spaceDoc;

  const token = (userId) => ({ userId, baseUrl: 'https://test.example' });

  async function makeUser(label) {
    const user = await users.findOrCreateUser({
      googleId: `mcpsp-${label}-${crypto.randomUUID()}`,
      email: `mcpsp-${label}-${crypto.randomUUID()}@example.com`,
      name: `MCP ${label}`,
      picture: null,
    });
    createdUsers.push(user.id);
    return user;
  }

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    documents.init(pool);
    spaces.init(pool);
    users.init(pool);

    // Local Y.Docs, marked bound the way a completed bindState would — enough
    // for the title tool's write path without a websocket server.
    const ydocs = new Map();
    documentService.init(
      (name) => {
        const guid = name.startsWith('s/') ? name.slice(2) : name;
        if (!ydocs.has(guid)) {
          const doc = new Y.Doc();
          doc._bindComplete = true;
          ydocs.set(guid, doc);
        }
        return ydocs.get(guid);
      },
      (name) => (name.startsWith('s/') ? name.slice(2) : name)
    );

    for (const tool of [setDocumentTitle, setDocumentVersionName, listDocumentVersions, listDocuments]) {
      tool.init(persistence);
    }

    author = await makeUser('author');
    member = await makeUser('member');
    viewerMember = await makeUser('viewer');
    stranger = await makeUser('stranger');

    const space = await spaces.createSpace('MCP Space', author.id);
    spaceId = space.id;
    createdSpaces.push(spaceId);
    await spaces.inviteMember(spaceId, member.email, 'editor', author.id);
    await spaces.inviteMember(spaceId, viewerMember.email, 'viewer', author.id);

    spaceDoc = crypto.randomUUID();
    createdDocs.push(spaceDoc);
    await documents.createDocument(spaceDoc, author.id, 'Space Document', spaceId);
  });

  afterAll(async () => {
    await cleanupDocRows(pool, createdDocs);
    await pool.query('DELETE FROM document_versions WHERE doc_id = ANY($1::uuid[])', [createdDocs]);
    await pool.query('DELETE FROM document_shares WHERE doc_id = ANY($1::uuid[])', [createdDocs]);
    await pool.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [createdDocs]);
    await pool.query('DELETE FROM space_members WHERE space_id = ANY($1::uuid[])', [createdSpaces]);
    await pool.query('DELETE FROM spaces WHERE id = ANY($1::uuid[])', [createdSpaces]);
    for (const id of createdUsers) await cleanupTestUser(pool, id);
    await pool.end();
  });

  describe('set_document_title', () => {
    test('a space EDITOR with no direct share can retitle', async () => {
      const res = await setDocumentTitle.handler(
        { docGuid: spaceDoc, title: 'Retitled by a space member' },
        token(member.id)
      );
      expect(res.success).toBe(true);
      expect(res.title).toBe('Retitled by a space member');
      // …and still holds no direct share.
      const { rows } = await pool.query(
        'SELECT 1 FROM document_shares WHERE doc_id = $1 AND user_id = $2',
        [spaceDoc, member.id]
      );
      expect(rows).toHaveLength(0);
    });

    test('a space VIEWER is refused with the unchanged edit-permission message', async () => {
      await expect(
        setDocumentTitle.handler({ docGuid: spaceDoc, title: 'Nope' }, token(viewerMember.id))
      ).rejects.toThrow('You do not have edit permission for this document');
    });

    test('a non-member gets the unchanged not-found message', async () => {
      await expect(
        setDocumentTitle.handler({ docGuid: spaceDoc, title: 'Nope' }, token(stranger.id))
      ).rejects.toThrow(NO_ACCESS);
    });
  });

  describe('list_document_versions', () => {
    test('a space member (viewer+) can list versions', async () => {
      const res = await listDocumentVersions.handler({ docGuid: spaceDoc }, token(viewerMember.id));
      expect(Array.isArray(res.versions)).toBe(true);
    });

    test('a non-member gets the unchanged not-found message', async () => {
      await expect(
        listDocumentVersions.handler({ docGuid: spaceDoc }, token(stranger.id))
      ).rejects.toThrow(NO_ACCESS);
    });
  });

  describe('set_document_version_name', () => {
    test('a space member (viewer+) can name a version', async () => {
      // Naming a version needs edit history to name; the access check under
      // test runs before that, so a single persisted update is enough.
      await pool.query(
        `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id) VALUES ($1, 0, $2, $3)
         ON CONFLICT DO NOTHING`,
        [spaceDoc, Buffer.from([0, 0]), author.id]
      );
      const res = await setDocumentVersionName.handler(
        { docGuid: spaceDoc, name: 'Named by a space member' },
        token(viewerMember.id)
      );
      expect(res.success).toBe(true);
    });

    test('a non-member gets the unchanged not-found message', async () => {
      await expect(
        setDocumentVersionName.handler({ docGuid: spaceDoc, name: 'Nope' }, token(stranger.id))
      ).rejects.toThrow(NO_ACCESS);
    });
  });

  describe('list_documents (FR-047 / RBD-053-8)', () => {
    test('a space member sees the document, with its space attached', async () => {
      const res = await listDocuments.handler({}, token(member.id));
      const row = res.documents.find((d) => d.id === spaceDoc);
      expect(row).toBeDefined();
      expect(row.role).toBe('editor');
      expect(row.space).toEqual({ id: spaceId, name: 'MCP Space' });
    });

    test('a non-member sees nothing', async () => {
      const res = await listDocuments.handler({}, token(stranger.id));
      expect(res.documents.map((d) => d.id)).not.toContain(spaceDoc);
    });

    test('space=<id> and space=personal scope the list', async () => {
      const personalDoc = crypto.randomUUID();
      createdDocs.push(personalDoc);
      await documents.createDocument(personalDoc, author.id, 'Author personal');

      const inSpace = await listDocuments.handler({ space: spaceId }, token(author.id));
      expect(inSpace.documents.map((d) => d.id)).toEqual([spaceDoc]);

      const personal = await listDocuments.handler({ space: 'personal' }, token(author.id));
      const ids = personal.documents.map((d) => d.id);
      expect(ids).toContain(personalDoc);
      expect(ids).not.toContain(spaceDoc);
    });

    test("filter=owned still means a DIRECT owner share (RBD-053-7)", async () => {
      const curator = await makeUser('curator');
      await spaces.inviteMember(spaceId, curator.email, 'owner', author.id);
      const res = await listDocuments.handler({ filter: 'owned' }, token(curator.id));
      expect(res.documents.map((d) => d.id)).not.toContain(spaceDoc);
      // …though the unfiltered list shows it, at the passthrough role.
      const all = await listDocuments.handler({}, token(curator.id));
      expect(all.documents.find((d) => d.id === spaceDoc).role).toBe('owner');
    });

    test('the `space` parameter is DECLARED, or validateToolArgs would reject it', () => {
      expect(listDocuments.inputSchema.properties.space).toBeDefined();
      expect(listDocuments.inputSchema.properties.space.type).toBe('string');
      expect(listDocuments.description).toMatch(/space/);
    });
  });
});
