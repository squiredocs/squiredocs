/**
 * create_document teaching nudge + soft refusal (feature 019, US3/T019 —
 * FR-017..FR-021, SC-006/SC-007, contracts/teaching-surfaces.md §3).
 *
 * The trigger metric is the UTF-8 BYTE length of the markdown argument,
 * evaluated BEFORE any side effect. Thresholds are env-tunable
 * (CREATE_DOCUMENT_NUDGE_BYTES / CREATE_DOCUMENT_REFUSAL_BYTES, read at call
 * time) with pair-wise fallback to the 2,048/10,240 defaults on any invalid
 * configuration. The refusal is NEVER unconditional: allowRetyped: true is
 * honored for any caller, any size.
 */
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const Y = require('yjs');

const pool = createPool();
const persistenceProvider = createPersistence();

const documents = require('../../../documents');
const users = require('../../../auth/users');
const onboarding = require('../../../onboarding');
const createDocument = require('../../tools/create-document');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const documentService = require('../../../document-service');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../../../origin');

const pendingOperations = [];

/** ASCII markdown body of EXACTLY the given UTF-8 byte length. */
function asciiMarkdownOfBytes(bytes) {
  const prefix = '# Teaching Doc\n\n';
  const body = prefix + 'a'.repeat(bytes - Buffer.byteLength(prefix, 'utf8'));
  expect(Buffer.byteLength(body, 'utf8')).toBe(bytes);
  return body;
}

describe('create_document teaching thresholds', () => {
  let testUserId;
  let createdDocIds = [];

  const agentToken = () => ({
    userId: testUserId,
    delegationId: 'teaching-delegation',
    agentId: 'teaching-agent',
    agentName: 'Teaching Agent',
    scopes: ['documents:write'],
  });

  const call = (args) => createDocument.handler(args, agentToken());

  const docCount = async () => {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM documents WHERE creator_id = $1', [testUserId]);
    return r.rows[0].c;
  };

  beforeAll(async () => {
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = docName.startsWith('s/') ? docName.slice(2) : docName;
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          pendingOperations.push(
            persistenceProvider.storeUpdate(docGuid, update, parsed.userId, parsed.agentName)
              .catch((err) => console.error(`persist error for ${docGuid}:`, err))
          );
        });
        try {
          const persisted = await persistenceProvider.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), ORIGIN_DB_LOAD);
        } catch { /* fresh doc */ }
      },
      writeState: async () => {},
      provider: persistenceProvider,
    });
    documentService.init(getYDoc, (docName) => (docName.startsWith('s/') ? docName.slice(2) : docName));
    documents.init(pool);
    users.init(pool);
    onboarding.init(pool);
    createDocument.init(persistenceProvider);

    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-teaching-test', 'create-doc-teaching@example.com', 'Teaching Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    await pool.query('DELETE FROM document_shares WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  afterEach(async () => {
    delete process.env.CREATE_DOCUMENT_NUDGE_BYTES;
    delete process.env.CREATE_DOCUMENT_REFUSAL_BYTES;
    await Promise.all(pendingOperations);
    pendingOperations.length = 0;
    for (const docId of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    }
    createdDocIds = [];
  });

  describe('below the nudge threshold (FR-021 — zero behavior change)', () => {
    test('a small markdown call returns the exact pre-019 result shape, no nudge', async () => {
      const result = await call({ markdown: '# Small Doc\n\nA short body.' });
      createdDocIds.push(result.docGuid);

      // DEEP shape equality with the pre-019 result: exactly these fields.
      expect(Object.keys(result).sort()).toEqual(
        ['blocks', 'docGuid', 'images', 'message', 'title', 'url']
      );
      expect(result.message).toMatch(/^Created document "Small Doc" with \d+ imported block\(s\)$/);
      expect(result.message).not.toMatch(/api\/docs\/import/);
    });

    test('a title-only call is untouched', async () => {
      const result = await call({ title: 'Empty Doc' });
      createdDocIds.push(result.docGuid);
      expect(Object.keys(result).sort()).toEqual(['docGuid', 'message', 'title', 'url']);
      expect(result.message).toBe('Created document "Empty Doc"');
    });

    test('allowRetyped on a small call is accepted and inert', async () => {
      const result = await call({ markdown: '# Small Doc\n\nA short body.', allowRetyped: true });
      createdDocIds.push(result.docGuid);
      expect(Object.keys(result).sort()).toEqual(
        ['blocks', 'docGuid', 'images', 'message', 'title', 'url']
      );
      expect(result.message).not.toMatch(/api\/docs\/import/);
    });
  });

  describe('nudge band (FR-018)', () => {
    test('EXACTLY 2,048 bytes gets the nudge (at-or-above boundary)', async () => {
      const result = await call({ markdown: asciiMarkdownOfBytes(2048) });
      createdDocIds.push(result.docGuid);
      expect(result.message).toContain('POST /api/docs/import');
      expect(result.message).toMatch(/byte-faithful/i);
      expect(result.message).toMatch(/receipt/i);
    });

    test('an in-band body (between nudge and refusal) succeeds with the nudge appended', async () => {
      const result = await call({ markdown: asciiMarkdownOfBytes(5000) });
      createdDocIds.push(result.docGuid);
      expect(result.docGuid).toBeDefined();
      expect(result.message).toContain('Created document');
      expect(result.message).toContain('POST /api/docs/import');
    });

    test('2,047 bytes does NOT get the nudge (below the boundary)', async () => {
      const result = await call({ markdown: asciiMarkdownOfBytes(2047) });
      createdDocIds.push(result.docGuid);
      expect(result.message).not.toMatch(/api\/docs\/import/);
    });
  });

  describe('refusal (FR-019/FR-020)', () => {
    test('at the 10,240-byte boundary without allowRetyped: instructive error, NOTHING created', async () => {
      const before = await docCount();
      await expect(call({ markdown: asciiMarkdownOfBytes(10240) })).rejects.toThrow(
        /POST \/api\/docs\/import/
      );
      await expect(call({ markdown: asciiMarkdownOfBytes(10240) })).rejects.toThrow(
        /allowRetyped: true/
      );
      expect(await docCount()).toBe(before);
    });

    test('the refusal text explains the escape hatch will be honored', async () => {
      let error;
      try {
        await call({ markdown: asciiMarkdownOfBytes(12000) });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(error.message).toMatch(/allowRetyped: true/);
      expect(error.message).toMatch(/honored/i);
    });

    test('the identical call WITH allowRetyped: true succeeds and still carries the nudge', async () => {
      const result = await call({ markdown: asciiMarkdownOfBytes(10240), allowRetyped: true });
      createdDocIds.push(result.docGuid);
      expect(result.docGuid).toBeDefined();
      expect(result.message).toContain('Created document');
      expect(result.message).toContain('POST /api/docs/import');
    });
  });

  describe('UTF-8 byte metric (FR-017 / US3 scenario 6)', () => {
    test('a multi-byte body crossing 2,048 BYTES at under 2,048 CHARS gets the nudge', async () => {
      // '€' is 3 UTF-8 bytes: 700 of them ≈ 2,100 bytes at only ~715 chars.
      const body = '# Multi\n\n' + '€'.repeat(700);
      expect(body.length).toBeLessThan(2048);
      expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThanOrEqual(2048);

      const result = await call({ markdown: body });
      createdDocIds.push(result.docGuid);
      expect(result.message).toContain('POST /api/docs/import');
    });
  });

  describe('env-tunable thresholds (FR-017/RBD-3, call-time read)', () => {
    test('lowered thresholds change the trigger points without restart', async () => {
      process.env.CREATE_DOCUMENT_NUDGE_BYTES = '64';
      process.env.CREATE_DOCUMENT_REFUSAL_BYTES = '256';

      // 100 bytes: over the tuned nudge, under the tuned refusal.
      const nudged = await call({ markdown: asciiMarkdownOfBytes(100) });
      createdDocIds.push(nudged.docGuid);
      expect(nudged.message).toContain('POST /api/docs/import');

      // 300 bytes: over the tuned refusal.
      await expect(call({ markdown: asciiMarkdownOfBytes(300) })).rejects.toThrow(/allowRetyped/);
    });

    test('raised thresholds relax the defaults', async () => {
      process.env.CREATE_DOCUMENT_NUDGE_BYTES = '20000';
      process.env.CREATE_DOCUMENT_REFUSAL_BYTES = '40000';

      const result = await call({ markdown: asciiMarkdownOfBytes(11000) });
      createdDocIds.push(result.docGuid);
      expect(result.message).not.toMatch(/api\/docs\/import/);
    });

    test.each([
      ['refusal ≤ nudge', '4096', '1024'],
      ['zero', '0', '10240'],
      ['negative', '2048', '-5'],
      ['non-numeric', 'lots', '10240'],
      ['non-numeric refusal', '2048', 'soon'],
    ])('misconfiguration (%s) falls back to BOTH defaults', async (_label, nudge, refusal) => {
      process.env.CREATE_DOCUMENT_NUDGE_BYTES = nudge;
      process.env.CREATE_DOCUMENT_REFUSAL_BYTES = refusal;

      // Sub-2,048 body: no nudge (default nudge governs, whatever the config said).
      const small = await call({ markdown: asciiMarkdownOfBytes(1000) });
      createdDocIds.push(small.docGuid);
      expect(small.message).not.toMatch(/api\/docs\/import/);

      // 3,000 bytes: default nudge band (not refused even when the broken
      // config would have refused it).
      const mid = await call({ markdown: asciiMarkdownOfBytes(3000) });
      createdDocIds.push(mid.docGuid);
      expect(mid.message).toContain('POST /api/docs/import');

      // 10,240: default refusal still teaches (never refuse-everything,
      // never disable teaching).
      await expect(call({ markdown: asciiMarkdownOfBytes(10240) })).rejects.toThrow(/allowRetyped/);
    });
  });

  describe('schema (FR-020)', () => {
    test('allowRetyped is a boolean in inputSchema so the registry unknown-param check passes', () => {
      const prop = createDocument.inputSchema.properties.allowRetyped;
      expect(prop).toBeDefined();
      expect(prop.type).toBe('boolean');
      expect(prop.description).toMatch(/refusal/i);
    });
  });
});
