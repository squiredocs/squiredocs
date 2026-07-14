# Contract: agents.md content

Feature `005-agent-onboarding`. Defines the required content shape of the
public `agents.md` file served at `/agents.md`.

## Path and serving

- File path in the repo: `client/public/agents.md`.
- Served at: `https://squiredocs.com/agents.md` (production) and equivalent
  path in dev (`http://localhost:5173/agents.md` via Vite, and via
  `express.static(clientBuildPath)` in the built app).
- No authentication required.
- No HTML shell — served as `text/markdown`.

## Baseline

- **Start from** the draft at
  `.claude/worktrees/agent-afbf7ebe180bd7de3/client/public/agents.md`
  (RATIFIED-BY-DEFAULT D2 — adopt the baseline; correct known drift; verify
  claim-by-claim).

## Required content (FR-002 five mandated elements)

The shipped file MUST contain each of these:

1. **The MCP endpoint URL** — `https://squiredocs.com/mcp`, shown in code
   block form.
2. **Exact connect one-liner(s)** — MUST include the exact string
   `claude mcp add --transport http squire https://squiredocs.com/mcp`, and
   generic guidance for other MCP-native clients (endpoint URL + OAuth
   discovery).
3. **Both credential options** —
   - OAuth 2.0 with PKCE (mention the discovery chain briefly), and
   - `sk_sqd_` personal access tokens (with the note that legacy `sqd_`
     tokens remain valid), created from Settings.
4. **Tool orientation** including the imperative to call
   `get_tool_documentation` before writing a first `modify` script.
5. **The REST export/import recipe** — sample `curl` invocation using the
   Bearer token, and pointers to `POST /api/docs/import` and
   `PUT /api/docs/:docId/import`. Import size caps and image report
   behavior must be mentioned or linked.

## Corrections from the draft

- **REST export flavor default**: the draft's `flavor=squire|portable (default
  squire)` MUST be changed to `flavor=squire|portable (default portable)` — the
  shipped default is `portable` on every format (see
  `server/api/docs-export.js:185`).
- **Bundle default flavor**: the draft's "bundle defaults to `portable`" note
  can be simplified to note bundle also defaults to portable (same as every
  format now), with frontmatter still on by default for bundles.
- **Connect one-liner**: the draft lacks the explicit
  `claude mcp add --transport http squire https://squiredocs.com/mcp` — add it.

## Verification (FR-003)

`server/__tests__/agents-md-claims.test.js` reads the shipped file from disk
and asserts (see research.md §R6):

1. Contains `flavor=squire|portable`.
2. Contains substring `default \`portable\``.
3. Does NOT contain `default \`squire\``.
4. Contains the exact string
   `claude mcp add --transport http squire https://squiredocs.com/mcp`.
5. Names each of: `get_tool_documentation`, `modify`, `create_access_token`,
   `read_document`, `list_documents`.
6. References both `sk_sqd_` and `sqd_` prefixes.

If a future surface change breaks any of these assertions, the file MUST be
brought back into agreement (design-doc mandate: drift is a bug).

## Non-goals

- Not a marketing document — no tone changes beyond the corrections above.
- Not a comprehensive tool reference — the design doc guides callers to
  `get_tool_documentation` for that.
- Not localized (English only).
