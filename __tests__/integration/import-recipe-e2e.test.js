/**
 * import_markdown_file end-to-end recipe test (feature 019, US1/T008 —
 * SC-002/SC-003, research R6).
 *
 * The recipe is a real shell command, so this suite starts a REAL listening
 * HTTP server (app.listen(0)) — supertest's in-process transport cannot serve
 * curl — mounts the real token-claim, import, and export routers, calls the
 * tool handler with baseUrl pointing at the listening port, substitutes the
 * FILE= placeholder, and executes the returned command via bash with a
 * sandboxed HOME (so ~/.squire/token never touches the real home).
 *
 * Verifies: byte-faithful import per the receipt contract, receipt
 * write-back giving the file squire: frontmatter, a subsequent mode=sync
 * push succeeding (US1 scenario 3), the sync-intent recipe targeting the
 * existing document, one-shot claim semantics on a re-run, and no
 * sk_sqd_/content in the tool payload (SC-003 regression).
 */
const request = require('supertest');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const Y = require('yjs');

const { createPool, createPersistence } = require('../../server/__tests__/helpers/db');
const pool = createPool();
const persistence = createPersistence();

const documents = require('../../server/documents');
const documentService = require('../../server/document-service');
const apiTokens = require('../../server/mcp/auth/api-tokens');
const delegation = require('../../server/mcp/auth/delegation');
const documentImages = require('../../server/document-images');
const toolRegistry = require('../../server/mcp/tools');
const { getYDoc, setPersistence } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../../server/origin');
const { createImportRouter } = require('../../server/api/docs-import');
const { createExportRouter } = require('../../server/api/docs-export');
const { createTokenClaimRouter } = require('../../server/api/token-claim');
const { closeRedis } = require('../../server/redis');

const pendingOperations = [];

const SOURCE_MARKDOWN = [
  '# Recipe E2E Doc',
  '',
  'Hello from the import recipe end-to-end test.',
  '',
  '- item one',
  '- item two',
  '',
].join('\n');

function runBash(command, env) {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-c', command],
      { env, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr })
    );
  });
}

/** Substitute the FILE= placeholder line (the one edit the agent makes). */
function withFile(command, filePath) {
  const lines = command.split('\n');
  expect(lines[0]).toMatch(/^FILE=/);
  lines[0] = `FILE=${filePath}`;
  return lines.join('\n');
}

/** Parse the squire: frontmatter block of a written-back file. */
function parseSquireFrontmatter(text) {
  expect(text.startsWith('---\n')).toBe(true);
  const end = text.indexOf('\n---\n', 4);
  const block = text.slice(4, end);
  const docGuid = (block.match(/docGuid:\s*"?([0-9a-f-]{36})"?/) || [])[1];
  const clock = Number((block.match(/clock:\s*(\d+)/) || [])[1]);
  return { docGuid, clock, body: text.slice(end + 5) };
}

describe('import recipe end-to-end (SC-002)', () => {
  jest.setTimeout(90_000);

  let app;
  let server;
  let baseUrl;
  let userId;
  let agentDelegation;
  let tmpHome;
  let workDir;
  const createdDocIds = [];

  const agentToken = () => ({
    delegationId: agentDelegation.id,
    userId,
    agentId: 'recipe-e2e-agent',
    agentName: 'Recipe E2E Agent',
    scopes: ['documents:read', 'documents:write'],
    isAgent: true,
    baseUrl,
  });

  const recipe = (args = {}) => toolRegistry.executeTool('import_markdown_file', args, agentToken());

  const shellEnv = () => ({ ...process.env, HOME: tmpHome });

  const readToken = () => fs.readFileSync(path.join(tmpHome, '.squire', 'token'), 'utf8').trim();

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
      },
      writeState: async () => {},
      provider: persistence,
    });
    documentService.init(getYDoc, (docName) =>
      docName.startsWith('s/') ? docName.slice(2) : docName
    );
    documents.init(pool);
    apiTokens.init(pool);
    delegation.init(pool);
    documentImages.init(pool);

    const u = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ('recipe-e2e', 'recipe-e2e@example.com', 'Recipe E2E User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    userId = u.rows[0].id;
    agentDelegation = await delegation.createDelegation(userId, 'recipe-e2e-agent', 'Recipe E2E Agent');

    app = express();
    app.use(createTokenClaimRouter());
    app.use(createImportRouter(persistence));
    app.use(createExportRouter(persistence));

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-e2e-home-'));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-e2e-work-'));
  });

  afterAll(async () => {
    await Promise.all(pendingOperations);
    if (server) await new Promise((resolve) => server.close(resolve));
    const docs = await pool.query('SELECT id FROM documents WHERE creator_id = $1', [userId]);
    for (const row of [...docs.rows.map((r) => r.id), ...createdDocIds]) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [row]);
      await pool.query('DELETE FROM document_images WHERE doc_id = $1', [row]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [row]);
      await pool.query('DELETE FROM documents WHERE id = $1', [row]);
    }
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await persistence.destroy();
    await pool.end();
    await closeRedis();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  let filePath;
  let docGuid;
  let createCommand; // kept to prove one-shot on a re-run

  test('create intent: one shell invocation imports the file byte-faithfully and writes the receipt back', async () => {
    filePath = path.join(workDir, 'recipe-doc.md');
    fs.writeFileSync(filePath, SOURCE_MARKDOWN);

    const result = await recipe({});
    expect(result.intent).toBe('create');

    // SC-003 regression: no token, no file content in the tool payload.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk_sqd_');
    expect(serialized).not.toContain('Hello from the import recipe');
    expect((serialized.match(/one_time_use_/g) || []).length).toBe(1);

    createCommand = withFile(result.command, filePath);
    const run = await runBash(createCommand, shellEnv());
    expect(run.error).toBeNull();
    expect(run.stdout).toContain('Imported');
    expect(run.stdout).toContain('valid mode=sync baseline');
    // The token never appears in the command's output.
    expect(run.stdout).not.toContain('sk_sqd_');

    // The token landed at the sandboxed ~/.squire/token.
    const token = readToken();
    expect(token).toMatch(/^sk_sqd_/);

    // The file was overwritten with a frontmattered receipt.
    const written = fs.readFileSync(filePath, 'utf8');
    const fm = parseSquireFrontmatter(written);
    expect(fm.docGuid).toBeDefined();
    expect(Number.isInteger(fm.clock)).toBe(true);
    docGuid = fm.docGuid;
    createdDocIds.push(docGuid);

    // Byte fidelity per the receipt contract: the canonical export equals the
    // receipt written to disk, and the body carries the source content.
    const exported = await request(app)
      .get(`/api/docs/${docGuid}/export?format=markdown&frontmatter=true`)
      .set('Authorization', `Bearer ${token}`);
    expect(exported.status).toBe(200);
    expect(exported.text).toBe(written);
    expect(fm.body).toContain('Hello from the import recipe end-to-end test.');
    expect(fm.body).toContain('- item one');
  });

  test('sync intent variant: the recipe targets the existing document and pushes the file edits', async () => {
    // Edit the receipt-stamped file.
    fs.appendFileSync(filePath, '\nA second paragraph added on disk.\n');

    const result = await recipe({ docGuid, intent: 'sync' });
    expect(result.intent).toBe('sync');
    expect(result.docGuid).toBe(docGuid);
    expect(result.command).toContain(`/api/docs/${docGuid}/import?mode=sync&frontmatter=true`);

    const run = await runBash(withFile(result.command, filePath), shellEnv());
    expect(run.error).toBeNull();
    expect(run.stdout).toContain('Imported');

    // The document gained the on-disk edit, and the file was re-stamped with
    // a fresh receipt (new baseline clock).
    const token = readToken();
    const exported = await request(app)
      .get(`/api/docs/${docGuid}/export?format=markdown`)
      .set('Authorization', `Bearer ${token}`);
    expect(exported.status).toBe(200);
    expect(exported.text).toContain('A second paragraph added on disk.');

    const restamped = parseSquireFrontmatter(fs.readFileSync(filePath, 'utf8'));
    expect(restamped.docGuid).toBe(docGuid);
  });

  test('the written-back file is a valid mode=sync baseline for a plain push (US1 scenario 3)', async () => {
    const edited = fs.readFileSync(filePath, 'utf8') + '\nThird paragraph, pushed directly.\n';
    const token = readToken();

    const res = await request(app)
      .put(`/api/docs/${docGuid}/import?mode=sync`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/markdown')
      .send(edited);

    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain('Third paragraph, pushed directly.');
  });

  test('re-running the original command fails at the claim step (one-shot) with the built-in message', async () => {
    const run = await runBash(createCommand, shellEnv());
    expect(run.error).not.toBeNull();
    expect(run.stdout).toContain('claim failed');
    expect(run.stdout).toContain('import_markdown_file');
    // Nothing was double-imported: the doc list for this user still has one doc.
    const docs = await pool.query('SELECT id FROM documents WHERE creator_id = $1', [userId]);
    expect(docs.rows).toHaveLength(1);
  });
});
