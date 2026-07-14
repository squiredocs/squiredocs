/**
 * Drift-guard for the shipped client/public/agents.md file
 * (feature 005-agent-onboarding, US3 / FR-003 / research.md §R6).
 *
 * These are cheap grep-level string assertions: the design doc mandates that
 * every factual claim in agents.md match the implemented surface, and the
 * drift class this test targets is exactly the "flavor default flipped from
 * squire to portable but the file didn't get updated" kind. If a future
 * surface change breaks one of these, agents.md must be brought back into
 * agreement in the same commit.
 */
const fs = require('fs');
const path = require('path');

const AGENTS_MD_PATH = path.join(__dirname, '../../client/public/agents.md');

describe('agents.md drift-guard', () => {
  let content;

  beforeAll(() => {
    content = fs.readFileSync(AGENTS_MD_PATH, 'utf8');
  });

  test('(a) contains flavor=squire|portable', () => {
    expect(content).toContain('flavor=squire|portable');
  });

  test('(b) claims default portable (analyze C8: tolerant regex, not literal)', () => {
    // Per analyze finding C8, use a tolerant regex — not a literal substring —
    // so cosmetic phrasing changes (bold, extra words) don't break the guard.
    expect(content).toMatch(/default[^\n]*portable/i);
  });

  test('(c) does NOT claim default `squire` (stale correction)', () => {
    expect(content).not.toContain('default `squire`');
  });

  test('(d) contains exact claude mcp add one-liner', () => {
    expect(content).toContain(
      'claude mcp add --transport http squire https://squiredocs.com/mcp'
    );
  });

  test('(e) names each of the core tools', () => {
    for (const tool of [
      'get_tool_documentation',
      'modify',
      'create_access_token',
      'read_document',
      'list_documents',
    ]) {
      expect(content).toContain(tool);
    }
  });

  test('(f) references both sk_sqd_ and legacy sqd_ prefixes', () => {
    expect(content).toContain('sk_sqd_');
    // The legacy prefix must appear somewhere — either as `sqd_` on its own
    // or as part of `legacy sqd_`. A literal `sqd_` substring covers both.
    expect(content).toMatch(/legacy `?sqd_`?/i);
  });

  // In-session connect caveat (design amendment, Sam 2026-07-14): an agent
  // running inside a live session must NOT run the connect one-liner itself —
  // MCP clients load config at startup, so the session never sees the server.
  // agents.md must carry the user-facing terminal + restart + verify steps.
  test('(g) tells in-session agents not to run the connect command themselves', () => {
    expect(content).toMatch(/do not run\s+the command above yourself/i);
    expect(content).toMatch(/load server config at startup/i);
  });

  test('(h) gives the restart-with-context steps (--continue / --resume)', () => {
    expect(content).toContain('claude --continue');
    expect(content).toContain('claude --resume');
  });

  test('(i) gives the verify steps (claude mcp list, /mcp)', () => {
    expect(content).toContain('claude mcp list');
    expect(content).toMatch(/run `?\/mcp`?/i);
  });
});
