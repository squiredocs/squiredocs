# Contract: drift guard + install surfaces

## Drift guard — `test/first-run/bundle-drift.test.mjs` (US3, FR-014..017)

Runs under `npm run test:first-run` (always-run CI, no new job). Imports expected bytes from `distribution/publish.mjs` — NEVER a hand-maintained fixture (INV-3).

### Assertions

1. **Byte-match every generated file** (FR-014): for each file in `expectedFiles({ endpoint: PROD_ENDPOINT })` and `expectedRegistryServer()`, the committed file under `distribution/claude-plugin/` / `distribution/mcp-registry/` MUST byte-equal the regeneration. Failure names the drifted file AND points at `node distribution/publish.mjs` (SC-003).
2. **Endpoint field exempt, everything else asserted** (FR-015): `.mcp.json` is compared with `mcpServers.squire.url` stripped from both sides; every other byte still asserted. The exemption is FIELD-scoped, not FILE-scoped.
3. **Committed endpoint pinned to prod** (FR-016): a SEPARATE assertion parses the committed `distribution/claude-plugin/.mcp.json` and asserts `mcpServers.squire.url === 'https://squiredocs.com/mcp'`. A dev URL can never ship even though the field is drift-exempt.
4. **Tamper detection** (SC-003): mutating one byte of any generated file makes assertion 1 fail; restoring makes it pass. (Covered by a test that writes a temp bundle, mutates, and checks the comparison reports the file.)
5. **Content budgets** (FR-017, R9 — re-homed from the retired `bundle-agreement.test.mjs`): `checkContentBudgets()` over `distribution/shared/` returns no problems (skill description ≤250, skill body ≤400 lines, onboard ≤300 lines). May live here or in a sibling `*.test.mjs`; MUST stay in the always-run suite.

### Retirement (FR-017, FR-020, RBD-2)

- No surviving test imports `assemble-bundle.mjs`, `check-bundle-agreement.mjs`, or references `assembled-bundle/`.
- `bundle-agreement.test.mjs` is deleted; its two assertions (committed-bundle-agrees + content-budgets) are subsumed by assertions 1-3 and 5 here.

## Install surfaces (US5, FR-022..027)

### Canonical command strings (FR-027, textually identical everywhere)

```
/plugin marketplace add squiredocs/squire-plugin
/plugin install squire
```

Retained raw one-liner for other MCP clients (FR-022):

```
claude mcp add --transport http squire https://squiredocs.com/mcp
```

### `client/public/agents.md` (FR-022/023)

- The Claude Code connect path LEADS with the plugin route (marketplace add + install) as the recommended route.
- Includes the restart-after-install caveat (FR-023): the client may need a restart before `/squire:onboard` appears.
- RETAINS `claude mcp add` for other Claude CLI contexts and MCP-native clients.
- KEEPS the existing in-session guidance (an agent reading this mid-session must not run config commands — the client loads server config at startup) coherent with the new leading path.

### `documentation/agents-and-mcp.md` (FR-024)

- Gains a per-ecosystem install section mirroring the same canonical one-liners.
- The documentation build (`client/scripts/build-documentation.mjs`) and its validation + terminology gates (`client/src/__tests__/documentation-build.test.js`) MUST stay green — "docs" never means product documentation; product name is "Squire Docs" (FR-026).

### `client/public/landing.html` (FR-025)

- Gains a "works with your coding agent" block presenting the install one-liners in the honest-confident voice, saying "Squire Docs".

### Cross-surface enforcement (FR-027, SC-005)

A test asserts the two canonical plugin lines appear verbatim in all three surface files (and the `claude mcp add` line survives in `agents.md`). Wording drift between surfaces is a defect. `agents.md`/`landing.html` are outside the doc-build terminology gate, so this cross-surface check is their coverage.

## Sam-only handoff (FR-028, carried into promotion notes at implement time)

1. Create `github.com/squiredocs/squire-plugin`, grant push access, run first `publish.mjs --publish`.
2. MCP Registry DNS challenge (Route 53 TXT, Sam pre-authorized), then first `server.json` registry publish.
3. Community directory Console-form submission; confirm signup-on-first-use OAuth servers accepted + naming constraints.
4. Deploy sequencing: deploy 030+031 to prod → push mirrors → deploy site surfaces.

## Owed orchestrator items (NOT done by this feature)

- **FR-030 / promotion-note 1**: Agent Surface (MCP) design-doc amendment (plugin one-liner + signup line) — amend the Squire doc + `node design/sync.mjs`. The served agents.md is written HERE to the intended contract; the amendment is a doc catch-up, never a content change by this feature.
- **promotion-note 6**: `docs/dev.md` first-run tooling section is stale (029/030 state) and US4's harness-default switch makes it staler; this feature's agents cannot edit `docs/dev.md`. Orchestrator docs pass owed at merge (constitution I).
- Design channel-status-table updates (Not started → Ready to submit / Listed) — orchestrator/Sam as submissions land.
