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

  // (d) reworded for feature 009 / RD-9: the BARE (uncredentialed) one-liner
  // survives ONLY in the MCP-native OAuth-discovery channel, where the client's
  // OAuth supplies the credential. It must not appear in any shell-first or
  // credential-holding path. The bare standalone form ends with `/mcp` on its
  // own code line (newline right after), distinguishing it from the credentialed
  // `/mcp \` --header continuation.
  test('(d) the bare claude mcp add one-liner appears only in the OAuth-discovery channel', () => {
    const bareStandalone = /claude mcp add --transport http squire https:\/\/squiredocs\.com\/mcp\n/;
    const oauthStart = content.indexOf('### 3. MCP-native OAuth discovery');
    expect(oauthStart).toBeGreaterThan(-1);
    const beforeOauth = content.slice(0, oauthStart);
    const oauthChannel = content.slice(oauthStart);
    expect(oauthChannel).toMatch(bareStandalone);
    expect(beforeOauth).not.toMatch(bareStandalone);
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

  // OAuth walkthrough guidance (design amendment, Sam 2026-07-14): agents
  // walking a user through browser OAuth must print the auth URL bare on its
  // own line, pre-warn about the localhost callback connection error on
  // remote sessions, and say to paste the full address-bar URL back.
  test('(j) tells agents to print the auth URL bare on its own line', () => {
    expect(content).toMatch(/bare,? on its own line/i);
    expect(content).toMatch(/numbered list/i);
  });

  test('(k) pre-warns that the localhost callback error is expected', () => {
    expect(content).toMatch(/connection error/i);
    expect(content).toMatch(/this is expected/i);
  });

  test('(l) says to paste the full address-bar callback URL back', () => {
    expect(content).toMatch(/address bar/i);
    expect(content).toMatch(/callback\?code=/);
    expect(content).toMatch(/paste it as\s+their next message/i);
  });

  // Feature 008-mcp-login-bootstrap (research R12): the login bootstrap is the
  // recommended in-session path; these pins keep agents.md truthful about the
  // new surface. Tolerant regexes per the C8 precedent above.
  test('(m) names both login and login_status', () => {
    expect(content).toContain('`login`');
    expect(content).toContain('`login_status`');
  });

  test('(n) frames login as the recommended path for in-session agents', () => {
    // Tolerant of line wrapping between the two phrases.
    expect(content).toMatch(/recommended path[\s\S]{0,60}inside a\s+session/i);
  });

  test('(o) mentions the /activate verification page', () => {
    expect(content).toMatch(/\/activate/);
  });

  // (p) updated for feature 009 / RD-4: the emitted claim recipe and docs name
  // the canonical /api/login/claim path (the alias is a compatibility note only).
  test('(p) documents the claim mechanics (canonical endpoint, file, 0600)', () => {
    expect(content).toContain('/api/login/claim');
    expect(content).not.toContain('/api/mcp/login/claim');
    expect(content).toMatch(/writes the credential to a file/i);
    expect(content).toMatch(/0600/);
  });

  test('(q) carries the credential-handling rule (never print/echo/paste)', () => {
    expect(content).toMatch(/never print, echo, or paste/i);
  });

  test('(r) states the tool count is eighteen', () => {
    expect(content).toMatch(/eighteen/i);
  });

  // (s)/(t): the curl bootstrap section. Added after a live onboarding failure
  // (2026-07-15): an agent with a shell but no attached MCP server read
  // agents.md and concluded `claude mcp add` was a hard prerequisite for the
  // login flow — it never tried the anonymous JSON-RPC endpoint with curl.
  test('(s) documents the no-MCP-client curl bootstrap with a JSON-RPC login call', () => {
    expect(content).toContain('No MCP connection? Bootstrap with curl');
    expect(content).toMatch(/curl -s -X POST https:\/\/squiredocs\.com\/mcp[\s\S]*"name":"login"/);
    expect(content).toMatch(/needs no MCP client\s+attachment/i);
    expect(content).toContain("registering the server is a prerequisite; it isn't");
  });

  test('(t) shows credentialed registration (--header) and the REST-only alternative', () => {
    expect(content).toMatch(/claude mcp add --transport http squire https:\/\/squiredocs\.com\/mcp \\\n\s+--header "Authorization: Bearer/);
    expect(content).toMatch(/Work over REST immediately/);
  });

  // (u)-(y): feature 009 — the file is now a choose-your-channel guide. Shell-
  // first REST login leads; the three /api/login/* endpoints are documented;
  // registration is stated to be optional; credential-holders are steered to the
  // --header form only; and the GET /api/docs list recipe is a documented surface.

  test('(u) is structured as a choose-your-channel guide, shell-first leading', () => {
    expect(content).toContain('## Choose your channel');
    expect(content).toMatch(/a shell is all you need/i);
    expect(content).toMatch(/nothing to install/i);
    const restChannel = content.indexOf('### 1. Log in over REST');
    const registerChannel = content.indexOf('### 2. Register the MCP server');
    const oauthChannel = content.indexOf('### 3. MCP-native OAuth discovery');
    expect(restChannel).toBeGreaterThan(-1);
    // Shell-first REST comes before credentialed registration and OAuth discovery.
    expect(restChannel).toBeLessThan(registerChannel);
    expect(registerChannel).toBeLessThan(oauthChannel);
  });

  test('(v) documents the three REST login endpoints with runnable curl', () => {
    expect(content).toContain('/api/login/start');
    expect(content).toContain('/api/login/status');
    expect(content).toContain('/api/login/claim');
    expect(content).toMatch(/curl -fsS -X POST https:\/\/squiredocs\.com\/api\/login\/start/);
  });

  test('(w) states that registering an MCP server is NOT a prerequisite', () => {
    expect(content).toMatch(/registering an MCP server is NOT a prerequisite/i);
  });

  test('(x) steers credential-holders to the --header form only (credentialed-only rule, RD-9)', () => {
    expect(content).toMatch(/only recommended registration form/i);
    expect(content).toMatch(/always pass the credential with\s+`?--header`?/i);
  });

  test('(y) documents the GET /api/docs list recipe (G1)', () => {
    expect(content).toContain('`GET /api/docs`');
    expect(content).toMatch(/list (the )?documents/i);
    expect(content).toMatch(/curl -fsS -H "Authorization: Bearer sk_sqd_\.\.\." "https:\/\/squiredocs\.com\/api\/docs"/);
  });
});
