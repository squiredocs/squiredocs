/**
 * Feature 058 (T046, FR-031/032/034): text that names the server is built from
 * the request's origin, falling back to APP_URL, never a hardcoded hosted
 * origin. Real handlers throughout.
 */
const { randomUUID } = require('crypto');
const { createPool, createTestUser, cleanupTestUser } = require('../../../__tests__/helpers/db');
const apiTokens = require('../../auth/api-tokens');
const delegation = require('../../auth/delegation');
const toolRegistry = require('../../tools');
const { closeRedis } = require('../../../redis');
const getToolDocumentation = require('../../tools/get-tool-documentation');
const { _resetInstanceConfigForTests } = require('../../../instance-config');
const { buildWelcomeDocNodes, WELCOME_DOC_NODES } = require('../../../onboarding/welcome-template');
const HOSTED_WELCOME_SNAPSHOT = require('../../../__tests__/fixtures/welcome-doc-nodes-hosted.json');

const pool = createPool();
const savedAppUrl = process.env.APP_URL;

function setAppUrl(v) {
  if (v === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = v;
  _resetInstanceConfigForTests();
}

afterAll(async () => {
  setAppUrl(savedAppUrl);
});

describe('get_tool_documentation rest_api', () => {
  afterEach(() => setAppUrl(savedAppUrl));

  test.each(['http://localhost:3910', 'https://docs.example.com'])('with baseUrl %s every URL names that origin', async (origin) => {
    const out = await getToolDocumentation.handler({ tool: 'rest_api' }, { baseUrl: origin });
    expect(out.documentation).not.toContain('squiredocs.com');
    expect(out.documentation).toContain(`"${origin}/api/docs/<docId>/export?format=markdown"`);
    expect(out.documentation).toContain(`${origin}/d/<docId>`);
    const urls = out.documentation.match(/https?:\/\/[^\s"'`)]+/g) || [];
    for (const u of urls) expect(u.startsWith(origin)).toBe(true);
  });

  test('a section also names the origin', async () => {
    const full = await getToolDocumentation.handler({ tool: 'export_api' }, { baseUrl: 'http://localhost:3910' });
    const withUrl = full.sections[1];
    const out = await getToolDocumentation.handler({ tool: 'rest_api', section: withUrl }, { baseUrl: 'http://localhost:3910' });
    expect(out.documentation).not.toContain('squiredocs.com');
  });

  test('with no baseUrl it falls back to APP_URL', async () => {
    setAppUrl('http://localhost:4100');
    const out = await getToolDocumentation.handler({ tool: 'rest_api' }, {});
    expect(out.documentation).not.toContain('squiredocs.com');
    expect(out.documentation).toContain('http://localhost:4100/api/docs/import?frontmatter=true');
  });
});

describe('create_access_token and import_markdown_file fall back to APP_URL', () => {
  let userId;
  let testDelegation;

  beforeAll(async () => {
    apiTokens.init(pool);
    delegation.init(pool);
    userId = await createTestUser(pool, `naming-${randomUUID().slice(0, 8)}@example.com`);
    testDelegation = await delegation.createDelegation(userId, 'naming-agent', 'Naming Agent');
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [userId]);
      await cleanupTestUser(pool, userId);
    } finally {
      await pool.end();
      await closeRedis();
    }
  });

  afterEach(() => setAppUrl(savedAppUrl));

  const principal = () => ({
    delegationId: testDelegation.id,
    userId,
    agentId: 'naming-agent',
    agentName: 'Naming Agent',
    scopes: ['documents:read', 'documents:write'],
    isAgent: true,
    // no baseUrl: the fallback is under test
  });

  test('create_access_token', async () => {
    setAppUrl('http://localhost:4200');
    const result = await toolRegistry.executeTool('create_access_token', {}, principal());
    const text = JSON.stringify(result);
    expect(text).not.toContain('squiredocs.com');
    expect(text).toContain('http://localhost:4200/api/tokens/claim');
    expect(text).toContain('http://localhost:4200/api/docs/<docId>/export?format=markdown');
  });

  test('import_markdown_file', async () => {
    setAppUrl('http://localhost:4300');
    const result = await toolRegistry.executeTool('import_markdown_file', {}, principal());
    const text = JSON.stringify(result);
    expect(text).not.toContain('squiredocs.com');
    expect(text).toContain('http://localhost:4300/api/docs/import?frontmatter=true');
  });
});

describe('welcome document template (RBD-058-22)', () => {
  test('self-hosted build names APP_URL and omits hosted-only text', () => {
    const nodes = buildWelcomeDocNodes({ appUrl: 'http://localhost:3910', hosted: false });
    const text = JSON.stringify(nodes);
    expect(text).not.toContain('squiredocs.com');
    expect(text).not.toMatch(/public beta|\$10 AI credit/);
    expect(text).not.toContain('Need help?');
    expect(text).toContain('claude mcp add --transport http squire http://localhost:3910/mcp');
    expect(text).toContain('http://localhost:3910/agents.md');
    expect(text).toContain('http://localhost:3910/documentation/agents-and-mcp');
    expect(nodes[0]).toEqual({ type: 'heading', level: 1, content: 'Welcome to Squire Docs!' });
    expect(nodes).toHaveLength(HOSTED_WELCOME_SNAPSHOT.length - 1);
  });

  test('hosted build deep-equals the pre-058 template', () => {
    const nodes = buildWelcomeDocNodes({ appUrl: 'https://squiredocs.com', hosted: true });
    expect(JSON.parse(JSON.stringify(nodes))).toEqual(HOSTED_WELCOME_SNAPSHOT);
    expect(JSON.parse(JSON.stringify(WELCOME_DOC_NODES))).toEqual(HOSTED_WELCOME_SNAPSHOT);
  });
});
