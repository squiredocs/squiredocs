/**
 * Import module tests (feature 002, T008/T009).
 *
 * Exercises importMarkdown end-to-end against the test database with a real
 * Yjs-backed document service (same harness as onboarding/create_document):
 * all three modes, the one-transaction/one-version-entry invariant (FR-004),
 * error-before-mutation, link sanitation through the module path (FR-022),
 * and never-lose-content over the fixture corpus (SC-002).
 */
const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const { createPool, createPersistence } = require('./helpers/db');

const pool = createPool();
const persistenceProvider = createPersistence();

const documents = require('../documents');
const documentService = require('../document-service');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../origin');
const { toMarkdown, toPlainText } = require('../mcp/yjs/serialization');
const {
  importMarkdown,
  prepareImport,
  ImportError,
  setExternalImagePass,
} = require('../markdown-import');

const FIXTURES = path.join(__dirname, 'fixtures', 'import');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const pendingOperations = [];

describe('importMarkdown', () => {
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

    const res = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-import-module-test', 'import-module-test@example.com', 'Import Module Tester')
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
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
    await persistenceProvider.destroy();
  });

  afterEach(() => setExternalImagePass(null));

  async function makeDoc(title = 'Import Target') {
    const docGuid = require('crypto').randomUUID();
    await documents.createDocument(docGuid, userId, title);
    createdDocIds.push(docGuid);
    return docGuid;
  }

  function liveFragment(docGuid) {
    return documentService.getSharedDoc(docGuid).get('default', Y.XmlFragment);
  }

  async function doImport(docGuid, markdown, options = {}) {
    const ydoc = documentService.getSharedDoc(docGuid);
    return importMarkdown(ydoc, markdown, {
      mode: 'append',
      actor: { userId },
      imageContext: { docId: docGuid },
      ...options,
    });
  }

  test('append inserts parsed blocks after existing content', async () => {
    const docGuid = await makeDoc();
    await doImport(docGuid, '# First\n\nOriginal paragraph.');
    const report = await doImport(docGuid, '## Appended\n\nNew **bold** text.');

    const md = toMarkdown(liveFragment(docGuid));
    expect(md).toMatch(/# First[\s\S]*## Appended/);
    expect(md).toContain('**bold**');
    expect(report.blocks.imported).toBe(2);
  });

  test('replace leaves exactly the new blocks and keeps doc identity/meta/title', async () => {
    const docGuid = await makeDoc('Keep This Title');
    await doImport(docGuid, '# Old\n\nOld body.');
    const ydoc = documentService.getSharedDoc(docGuid);
    ydoc.getMap('meta').set('title', 'Keep This Title');

    await doImport(docGuid, '# Fresh\n\nRegenerated.', { mode: 'replace' });

    const md = toMarkdown(liveFragment(docGuid));
    expect(md).toContain('# Fresh');
    expect(md).not.toContain('Old body');
    // Same shared doc instance (identity), meta untouched.
    expect(documentService.getSharedDoc(docGuid)).toBe(ydoc);
    expect(ydoc.getMap('meta').get('title')).toBe('Keep This Title');
    const row = await pool.query('SELECT title FROM documents WHERE id = $1', [docGuid]);
    expect(row.rows[0].title).toBe('Keep This Title');
  });

  test('replace is a single transaction: one undo step, one version entry', async () => {
    const docGuid = await makeDoc();
    await doImport(docGuid, '# Old\n\nfirst\n\nsecond\n\nthird');
    await Promise.all(pendingOperations.splice(0));

    const fragment = liveFragment(docGuid);
    const undoManager = new Y.UndoManager(fragment, {
      trackedOrigins: new Set([Object]),
    });
    const before = await pool.query(
      'SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]
    );

    await doImport(docGuid, '# New\n\nreplacement', { mode: 'replace' });
    await Promise.all(pendingOperations.splice(0));

    // One undo boundary…
    expect(undoManager.undoStack.length).toBe(1);
    // …and exactly one attributed version row for the whole replace.
    const after = await pool.query(
      'SELECT COUNT(*)::int AS n, MAX(user_id::text) AS uid FROM yjs_updates WHERE doc_guid = $1',
      [docGuid]
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    const lastRow = await pool.query(
      'SELECT user_id FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock DESC LIMIT 1',
      [docGuid]
    );
    expect(lastRow.rows[0].user_id).toBe(userId);

    // Undo restores the old body in one step.
    undoManager.undo();
    expect(toMarkdown(fragment)).toContain('# Old');
    undoManager.destroy();
  });

  test('insertAfterXPath inserts immediately after the matched block', async () => {
    const docGuid = await makeDoc();
    await doImport(docGuid, '# Title\n\nIntro.\n\n## Details\n\nEnd.');

    await doImport(docGuid, 'Inserted paragraph.', {
      mode: 'insertAfterXPath',
      insertAfterXPath: '//heading[@level=2]',
    });

    const blocks = liveFragment(docGuid).toArray().map((n) => toMarkdown(n.parent === liveFragment(docGuid) ? n : n));
    const md = toMarkdown(liveFragment(docGuid));
    expect(md).toMatch(/## Details\s+Inserted paragraph\.\s+End\./);
  });

  test('insertAfterXPath with no match throws and mutates nothing', async () => {
    const docGuid = await makeDoc();
    await doImport(docGuid, '# Only Heading');
    const before = toMarkdown(liveFragment(docGuid));
    // Feature 049 (T031/US2 AS4): the XPath resolution and its throw moved from
    // INSIDE the transaction into the COMPUTE phase, because a mutate-phase
    // throw is no longer recoverable (yjs does not roll back). Pin the
    // observable contract that move had to preserve: the same error code, the
    // same message, and a document that is BYTE-identical, not merely
    // markdown-identical.
    const beforeBytes = Y.encodeStateAsUpdate(documentService.getSharedDoc(docGuid));

    await expect(
      doImport(docGuid, 'never lands', {
        mode: 'insertAfterXPath',
        insertAfterXPath: '//heading[@level=4]',
      })
    ).rejects.toMatchObject({
      code: 'XPATH_NO_MATCH',
      message: 'No element matches XPath: //heading[@level=4]',
    });

    expect(toMarkdown(liveFragment(docGuid))).toBe(before);
    expect(Y.encodeStateAsUpdate(documentService.getSharedDoc(docGuid))).toEqual(beforeBytes);
  });

  test('empty and whitespace-only inputs are rejected before mutation', async () => {
    const docGuid = await makeDoc();
    await doImport(docGuid, 'existing');
    const before = toMarkdown(liveFragment(docGuid));

    for (const input of ['', '   \n\t\n  ']) {
      await expect(doImport(docGuid, input)).rejects.toMatchObject({ code: 'EMPTY_IMPORT' });
      await expect(
        doImport(docGuid, input, { mode: 'replace' })
      ).rejects.toMatchObject({ code: 'EMPTY_IMPORT' });
    }
    expect(toMarkdown(liveFragment(docGuid))).toBe(before);
  });

  test('frontmatter-only input is rejected (replace-to-empty impossible)', async () => {
    const docGuid = await makeDoc();
    await doImport(docGuid, 'existing content');
    const before = toMarkdown(liveFragment(docGuid));

    await expect(
      doImport(docGuid, readFixture('frontmatter-only.md'), { mode: 'replace' })
    ).rejects.toMatchObject({ code: 'EMPTY_IMPORT' });
    expect(toMarkdown(liveFragment(docGuid))).toBe(before);
  });

  test('unknown mode is rejected', async () => {
    const docGuid = await makeDoc();
    await expect(doImport(docGuid, 'x', { mode: 'insertAfterXpath' })).rejects.toMatchObject({
      code: 'INVALID_MODE',
    });
    await expect(doImport(docGuid, 'x', { mode: 'nuke' })).rejects.toMatchObject({
      code: 'INVALID_MODE',
    });
  });

  test('frontmatter squire title is surfaced and residue lands as a yaml block', async () => {
    const docGuid = await makeDoc();
    const report = await doImport(docGuid, readFixture('frontmatter-mixed.md'));
    expect(report.frontmatter.title).toBe('Mixed Frontmatter Doc');

    const md = toMarkdown(liveFragment(docGuid));
    expect(md).toContain('```yaml');
    expect(md).toContain('layout: post');
    expect(md).not.toContain('squire:');
    expect(md).toContain('# Mixed Frontmatter Doc');
  });

  test('link sanitation through the module path (fixture corpus, FR-022)', async () => {
    const docGuid = await makeDoc();
    await doImport(docGuid, readFixture('dangerous-links.md'));
    const fragment = liveFragment(docGuid);
    const md = toMarkdown(fragment);

    // Dangerous protocols: mark dropped, text kept.
    for (const text of ['javascript link', 'data link', 'vbscript link', 'file link', 'mixed-case trick', 'whitespace trick']) {
      expect(md).toContain(text);
    }
    expect(md).not.toMatch(/\]\(\s*javascript:/i);
    expect(md).not.toMatch(/\]\(\s*data:/i);
    expect(md).not.toMatch(/\]\(\s*vbscript:/i);
    expect(md).not.toMatch(/\]\(\s*file:/i);
    expect(md).not.toMatch(/JaVaScRiPt:/);

    // Allowed protocols survive as links.
    expect(md).toContain('[plain http link](http://example.com/page)');
    expect(md).toContain('[secure link](https://example.com/page)');
    expect(md).toContain('[mail link](mailto:sam@example.com)');
    expect(md).toContain('[app-relative link](/d/some-doc-guid)');
  });

  test('never-lose-content across the fixture corpus (SC-002)', async () => {
    const fixtures = ['adr-sample.md', 'unsupported-footnotes.md', 'frontmatter-malformed.md', 'crlf-bom.md'];
    for (const name of fixtures) {
      const docGuid = await makeDoc(`corpus ${name}`);
      await doImport(docGuid, readFixture(name));
      const plain = toPlainText
        ? toPlainText(liveFragment(docGuid))
        : toMarkdown(liveFragment(docGuid));

      // Spot-check signature strings from each fixture survive import.
      const signatures = {
        'adr-sample.md': ['Adopt Server-Side Markdown Import', 'One code path for every surface', 'graph TD', 'Last reviewed 2026-07-13'],
        'unsupported-footnotes.md': ['needs a citation', 'first footnote body text survives', 'longer footnote with'],
        'frontmatter-malformed.md': ['bad yaml', 'After Malformed Frontmatter', 'treated as ordinary content'],
        'crlf-bom.md': ['CRLF Document', 'windows line endings'],
      };
      for (const sig of signatures[name]) {
        expect(plain).toContain(sig);
      }
    }
  });

  test('report shape: blocks, images (all four arrays), frontmatter', async () => {
    // Hermetic: force the storage-disabled degradation path so the default
    // rehost pass never attempts DNS/network in unit tests.
    const s3Images = require('../s3-images');
    const enabledSpy = jest.spyOn(s3Images, 'isEnabled').mockReturnValue(false);
    const docGuid = await makeDoc();
    const report = await doImport(docGuid, '# Doc\n\ntext ![pic](https://ext.example.com/p.png)\n\n![gone](data:image/png;base64,AAAA)');
    enabledSpy.mockRestore();

    expect(report.blocks).toEqual({ imported: expect.any(Number) });
    // No S3 in the unit-test env ⇒ the rehost pass degrades externals with
    // reason storage-disabled (parity with the cross-doc reconciler posture).
    expect(report.images).toEqual({
      rehosted: [],
      copied: [],
      degraded: [{ src: 'https://ext.example.com/p.png', reason: 'storage-disabled' }],
      rejected: [{ src: 'data:image/png;base64,AAAA', reason: 'data-url' }],
    });
    expect(report.frontmatter).toEqual({});

    // The rehost pass degraded the external image to a plain link; data: image
    // degraded to its alt text; the stored doc has no image srcs at all.
    const md = toMarkdown(liveFragment(docGuid));
    expect(md).toContain('[pic](https://ext.example.com/p.png)');
    expect(md).toContain('gone');
    expect(md).not.toContain('data:image');
  });

  test('data: image with empty alt: payload never stored (dropped at parse)', async () => {
    // Shipped-001 contract: `![](url)` (empty alt = empty link text) loses the
    // URL inside the parser itself — it emits a bare literal `!`. The data:
    // payload therefore never reaches the import pipeline and CANNOT be
    // itemized in the report; the SC-003 invariant (zero data: srcs stored)
    // still holds. Alt-bearing data: images ARE itemized (test above).
    const docGuid = await makeDoc();
    const report = await doImport(docGuid, 'keep this\n\n![](data:image/gif;base64,R0lGODlhAQABAAAAACw=)');
    expect(report.images.rejected).toEqual([]);
    const md = toMarkdown(liveFragment(docGuid));
    expect(md).toContain('keep this');
    expect(md).not.toContain('data:');
  });

  test('a doc that is ONLY an alt-less data: image degrades to the parser literal', async () => {
    // Follows from the same shipped-001 behavior: the parser leaves a literal
    // `!` (its never-lose-content emission), which is real text content — the
    // import applies rather than rejecting as empty, and no data: src is stored.
    const docGuid = await makeDoc();
    await doImport(docGuid, 'existing');
    await doImport(docGuid, '![](data:image/gif;base64,R0lGODlhAQABAAAAACw=)', { mode: 'replace' });
    const md = toMarkdown(liveFragment(docGuid));
    expect(md).not.toContain('existing');
    expect(md).not.toContain('data:');
    expect(md.trim()).toBe('!');
  });

  test('prepareImport exposes the same pipeline for the create surfaces', async () => {
    const docGuid = await makeDoc();
    const prepared = await prepareImport(readFixture('frontmatter-squire-only.md'), {
      docId: docGuid,
      userId,
    });
    expect(prepared.frontmatter.title).toBe('Payments Redesign');
    expect(prepared.nodes.length).toBeGreaterThan(0);
    expect(prepared.images).toEqual({ rehosted: [], copied: [], degraded: [], rejected: [] });
  });

  test('external-image pass is pluggable (US4 wiring seam)', async () => {
    const docGuid = await makeDoc();
    const seen = [];
    setExternalImagePass(async (stagingFragment, ctx) => {
      seen.push(ctx);
      return { rehosted: [{ src: 'https://e.com/i.png', url: '/api/docs/x/images/y' }], degraded: [] };
    });
    const report = await doImport(docGuid, 'text ![i](https://e.com/i.png)');
    expect(seen).toEqual([{ docId: docGuid, userId }]);
    expect(report.images.rehosted).toEqual([
      { src: 'https://e.com/i.png', url: '/api/docs/x/images/y' },
    ]);
  });

  test('ImportError instances carry stable codes', () => {
    const err = new ImportError('EMPTY_IMPORT', 'msg');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('EMPTY_IMPORT');
  });
});
