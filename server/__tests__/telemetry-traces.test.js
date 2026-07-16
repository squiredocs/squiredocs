/**
 * US2 — distributed traces (feature 014, FR-002/003/004/005/023).
 *
 * Proven with in-process capture (no network exporter):
 *   • an HTTP request touching PG + Redis produces ONE trace with the server
 *     span (route-template identity) plus child pg + ioredis spans — exercised in
 *     a CHILD PROCESS with the real server boot order (telemetry.start() before
 *     http/express/pg/ioredis load) because the jest worker pre-loads those
 *     modules, which defeats OTel's require-hook auto-instrumentation in-process;
 *   • a collaboration sync op produces an op-level span with document.guid;
 *   • an MCP tool call produces a span with mcp.tool.name / outcome / duration.
 *
 * installCapture() runs at MODULE LOAD for the in-process manual-span tests.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const capture = require('./helpers/telemetry-capture');
capture.installCapture();

const { withSpan } = require('../telemetry/spans');
const { getTestDatabaseUrl } = require('./helpers/db');

afterAll(async () => {
  await capture.shutdown();
});

beforeEach(() => capture.reset());

describe('HTTP → PG → Redis single trace (real boot order, child process)', () => {
  test('one request yields a server span (route template) + child pg/redis spans on one trace', () => {
    const outPath = path.join(os.tmpdir(), `otel-e2e-${process.pid}-${Date.now()}.json`);
    const child = spawnSync(
      process.execPath,
      [path.join(__dirname, 'helpers', 'otel-e2e-child.js'), outPath],
      {
        env: {
          ...process.env,
          DATABASE_URL: getTestDatabaseUrl(),
          REDIS_HOST: process.env.REDIS_HOST || 'localhost',
        },
        timeout: 30000,
        encoding: 'utf8',
      }
    );
    expect(child.status).toBe(0);

    const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    fs.unlinkSync(outPath);
    expect(result.error).toBeUndefined();
    const spans = result.spans;
    expect(spans.length).toBeGreaterThan(0);

    // Server span carries the ROUTE TEMPLATE, never the concrete path/query.
    const serverSpan = spans.find((s) => s.kind === 1 && s.attributes['http.route']);
    expect(serverSpan).toBeDefined();
    expect(serverSpan.attributes['http.route']).toBe('/api/docs/:docId');

    // pg + redis child spans share the server span's trace.
    const traceId = serverSpan.traceId;
    const sameTrace = spans.filter((s) => s.traceId === traceId);
    expect(sameTrace.find((s) => s.attributes['db.system'] === 'postgresql')).toBeDefined();
    expect(sameTrace.find((s) => s.attributes['db.system'] === 'redis')).toBeDefined();

    // FR-003: the concrete path/query never appears in any span attribute.
    const serialized = JSON.stringify(spans.map((s) => s.attributes));
    expect(serialized).not.toContain('SENTINEL_QUERY');
    expect(serialized).not.toContain('doc-abc-123');
  });
});

describe('collaboration sync span (FR-004)', () => {
  test('withSpan records document.guid + operation + outcome + duration', () => {
    withSpan(
      'collab.operation',
      { 'document.guid': 'doc-guid-777', 'collab.operation': 'markdown.sync' },
      () => 'done'
    );
    const span = capture.getSpans().find((s) => s.name === 'collab.operation');
    expect(span).toBeDefined();
    expect(span.attributes['document.guid']).toBe('doc-guid-777');
    expect(span.attributes['collab.operation']).toBe('markdown.sync');
    expect(span.attributes.outcome).toBe('success');
    expect(typeof span.attributes.duration_ms).toBe('number');
  });
});

describe('MCP tool span (FR-005)', () => {
  test('executeTool records mcp.tool.name / agent.id / user.id / outcome / duration', async () => {
    const toolRegistry = require('../mcp/tools');
    const token = { userId: 'user-1', agentId: 'agent-9', scopes: ['documents:read'] };
    await toolRegistry.executeTool('get_tool_documentation', { tool: 'modify' }, token);

    const span = capture.getSpans().find((s) => s.name === 'mcp.tool.execute');
    expect(span).toBeDefined();
    expect(span.attributes['mcp.tool.name']).toBe('get_tool_documentation');
    expect(span.attributes['agent.id']).toBe('agent-9');
    expect(span.attributes['user.id']).toBe('user-1');
    expect(span.attributes.outcome).toBe('success');
    expect(typeof span.attributes.duration_ms).toBe('number');
  });
});
