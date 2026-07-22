# Research: Packaging & Distribution — M3 Wave 1

Phase 0 output. Resolves the Technical-Context unknowns and records the rationale behind the pre-settled RBD-1..7. No open NEEDS CLARIFICATION remain: every product decision took its RATIFIED-BY-DEFAULT default (Sam pre-authorized, 2026-07-22); the only genuinely open technical choice is the JSON-schema validator mechanism, resolved below.

## Decision index

| # | Decision | Source |
|---|----------|--------|
| R1 | Endpoint indirection = throwaway-copy templating; shipped `.mcp.json` hardcodes prod | RBD-1 |
| R2 | Delete the M2 assembler/bundle/agreement-check; `publish.mjs` is the one generator | RBD-2 |
| R3 | Only `claude-plugin/` + `mcp-registry/` this wave; channel-registry structure for later | RBD-3 |
| R4 | Vendor + pin manifest JSON schemas in-repo; offline validation | RBD-4 |
| R5 | First shipped version = `1.0.0` | RBD-5 |
| R6 | Publish dry-run by default; push behind `--publish` + configured remotes, fail-closed | RBD-6 |
| R7 | `server.json` validated + drift-pinned in CI; namespace ownership is a Sam op | RBD-7 |
| R8 | JSON-schema validator mechanism (the one open technical choice) | this doc |
| R9 | Content-budget checks re-homed from the retired agreement test into the drift test | this doc |
| R10 | Security posture of the publish path and shipped bundle | this doc |

## R1 — Endpoint indirection: throwaway-copy templating (RBD-1)

- **Decision**: The shipped `distribution/claude-plugin/.mcp.json` hardcodes `https://squiredocs.com/mcp`. The rehearsal harness keeps its existing throwaway-copy templating (copy bundle to temp dir, rewrite `mcpServers.squire.url` to the dev server, assert the source bundle was never mutated). The endpoint URL is the sole field exempt from the byte-match drift assertion; a separate assertion pins the committed value to prod.
- **Rationale**: The design named templating as the acceptable fallback to client-side env interpolation; the fallback is already built and integrity-checked in `rehearsal-harness.mjs` (verified: lines 190-199 copy the bundle, rewrite the endpoint, read `srcMcpBefore` to assert non-mutation). Choosing it removes any dependency on Claude Code's `.mcp.json` interpolation behavior from the shipping artifact. Implement-time verification of client interpolation is moot — nothing depends on it.
- **Alternatives rejected**: env-interpolated endpoint in the shipped file (fragile client-version dependency on a file that must Just Work on install); a separate dev `.mcp.json` variant committed (a second source of truth for the same field).

## R2 — Retire the M2 assembler; `publish.mjs` is the single generator (RBD-2)

- **Decision**: Delete `test/first-run/assemble-bundle.mjs`, `test/first-run/assembled-bundle/`, `test/first-run/check-bundle-agreement.mjs`, and `test/first-run/bundle-agreement.test.mjs` once consumers migrate. `publish.mjs` exports `expectedFiles({ endpoint })`, `assembleBundle({ outDir, endpoint })`, `PROD_ENDPOINT`, `withGeneratedHeader`, and a `DEFAULT_CLAUDE_PLUGIN_DIR` — the same programmatic surface the M2 assembler exposed, so the harness, matrix runner, and new drift test import from one module.
- **Consumers to migrate (verified against the repo)**:
  - `rehearsal-harness.mjs` line 42 `import { assembleBundle, PROD_ENDPOINT } from './assemble-bundle.mjs'` and lines 167-177 (default-bundle assembly). Repoint the import to `../../distribution/publish.mjs` and change the default to install the committed `distribution/claude-plugin` (US4/FR-018), templating the endpoint via the existing throwaway path.
  - `bundle-agreement.test.mjs` imports `checkBundleAgreement`, `checkContentBudgets`, `BUDGETS`, `assembleBundle`, `DEFAULT_BUNDLE_DIR` — this whole file is retired; its two assertions are re-expressed in `bundle-drift.test.mjs` (R9).
  - `matrix-runner.mjs` / `matrix-cells.mjs`: grep shows **no** direct assembler import (they drive the harness, which owns the bundle). Confirm at implement time that they inherit the harness default and carry no stale `assembled-bundle` path in comments/help text.
- **Rationale**: 030's own file header calls the assembler a deliberately-temporary stand-in for `publish.mjs`. One generator, one drift guard, one import surface is the design's stated end state (principle 2). Two generators reintroduce the exact drift the generated-copies rule targets.
- **Alternatives rejected**: keep `assemble-bundle.mjs` as a thin wrapper over `publish.mjs` (still two entry points, invites divergence); keep `assembled-bundle/` committed as a rehearsal fixture (a second committed bundle that can drift from the shipping one).

## R3 — Wave-1-only directories, channel-registry structure (RBD-3)

- **Decision**: Create only `distribution/claude-plugin/` and `distribution/mcp-registry/`. `publish.mjs` is organized as a list/map of channel descriptors (each: id, output dir, list of generated files with their derivations, schema bindings, optional mirror-remote key). Adding a wave-2/3 channel later = adding one descriptor, not rearchitecting.
- **Rationale**: D3 makes the waves sequential; YAGNI (constitution III) rejects empty placeholders that `publish.mjs` and the drift test would have to special-case, and an empty dir mirrored to a public repo is a bad storefront. The flagged design-vs-code layout gap (spec §Flagged Gaps) is a non-contradiction — the milestones make the layout incremental.
- **Alternatives rejected**: empty placeholder dirs for `kiro-power/` etc. (special-casing + bad storefront); a monolithic non-extensible generator (rearchitecture cost pushed onto 033+).

## R4 / R8 — Manifest JSON schemas: vendor, pin, validate offline

- **Decision (R4)**: Vendor pinned schema copies under `distribution/schemas/`, each annotated in `distribution/schemas/SOURCES.md` with its upstream URL + retrieval date + refresh procedure (re-fetch, diff, bump). `publish.mjs` validates each generated manifest against its pinned schema offline and deterministically. Upstream drift is caught at Sam's real submission (a human-in-the-loop gate) and by the advisory plugin-dev validator where available.
- **Decision (R8 — validator mechanism)**: **Prefer an already-present JSON-schema validator in the repo dependency tree** (e.g. `ajv`, commonly transitively present via tooling). At implement time, probe `node -e "require.resolve('ajv')"`; if resolvable, use it (draft-07/2020-12 as the pinned schemas declare). **If no validator resolves**, `publish.mjs` ships a small self-contained structural validator covering exactly what the pinned schemas assert for these few manifests: required keys, types, `name` pattern (`^[a-z0-9-]+$` for the plugin, reverse-DNS `^[a-z0-9.-]+/[a-z0-9-]+$` for the registry), semver `version`, and the remote/transport/OAuth shape of `server.json`. The schemas are small and pinned, so a hand-rolled structural check is deterministic and dependency-free — the safer default for an offline CI gate. **Do not add a new production dependency solely for this** without confirming it is dev-scoped; the gate must not enlarge the app's runtime dependency surface.
- **Rationale**: A gate that can fail for network reasons is not authoritative (RBD-4); pinning matches how the repo treats other external contracts. Preferring an existing validator avoids reinventing JSON-schema semantics; the structural fallback avoids a network/dependency foot-gun when none exists.
- **Alternatives rejected**: fetch schemas at validation time (flaky, non-deterministic, offline pod breaks); add a heavyweight validator as a new prod dependency (enlarges runtime surface for a tooling gate).
- **FR-011 note**: `publish.mjs` MUST attempt the plugin-dev validator agent where available and treat absence as a reported warning, never a failure; it MUST NOT depend on a first-party `claude plugin validate` CLI verb (none exists). The JSON-schema validation is the authoritative gate; the agent is advisory freshness backstop.

## R5 — First shipped version 1.0.0 (RBD-5)

- **Decision**: `plugin.json.version = "1.0.0"`; `server.json` mirrors the same version where its schema carries one. The design's bump-on-any-change rule counts from there.
- **Rationale**: Content is M2-signed-off and the flow prod-tested (030+031); `0.x` reads as "not ready" in listing surfaces and fights the honest-confident voice for content that IS ready (marketing-tone standard). Semver majors remain for a future contract break.
- **Alternatives rejected**: carry the M2 rehearsal `0.1.0` (undersells signed-off content).

## R6 — Publish dry-run by default; push fail-closed (RBD-6) — SECURITY-LOAD-BEARING

- **Decision**: Default `node distribution/publish.mjs` = regenerate + validate only, no network, no credentials, no side effects. Pushing requires **both** an explicit `--publish` flag **and** mirror remotes supplied via configuration/environment (never a committed default that could resolve for a pipeline agent). Missing/unreachable targets fail closed *before* any push. The version-unchanged-but-content-changed check (FR-013) runs in the publish path against the mirror clone and refuses. Tests exercise the push mechanism against **local bare-repo fixtures only**, never a real remote; CI never runs the publish path at all.
- **Rationale**: A script whose default invocation pushes to public repos is a foot-gun for CI, tests, and pipeline agents. This mirrors the fail-closed, positive-flag posture the project just adopted for dev endpoints (commit 2b9d6be: `ENABLE_DEV_ENDPOINTS` positive flag, never a `NODE_ENV !==` negative). The mechanism is complete enough that Sam's first real publish needs zero new code.
- **Alternatives rejected**: push-by-default with a `--dry-run` opt-out (dangerous default); committed mirror-remote defaults (an agent or CI could resolve and push them).

## R7 — server.json verified structurally; namespace is a Sam op (RBD-7)

- **Decision**: CI validates `server.json` against the pinned registry schema (structure, `com.squiredocs/mcp` name format, remote/streamable-HTTP transport shape, OAuth declaration, no package/stdio artifact) and the drift test pins it to regeneration. Namespace ownership, `mcp-publisher` login, the DNS-challenge TXT record, and the actual publish are exclusively Sam-op checklist items (the design pre-authorizes temporary Route 53 access for the TXT step).
- **Rationale**: Verifies everything verifiable without external identity; the design assigns identity proof to Sam explicitly. Shipping a structurally wrong `server.json` would waste the one-time DNS-challenge session.

## R9 — Content-budget checks re-home into the drift test

- **Decision**: The retired `check-bundle-agreement.mjs` carries `checkContentBudgets()` + `BUDGETS` (skill description ≤250 chars, skill body ≤400 lines, onboard ≤300 lines — RBD-13 from 030). These are NOT bundle-drift checks but `distribution/shared/` context-budget guards; they must not be lost when the agreement check is deleted (FR-017 "no loss of coverage"). Re-home them into `bundle-drift.test.mjs` (or a sibling `content-budgets.test.mjs` under `test/first-run/`, whichever keeps them in the always-run suite) so the two `bundle-agreement.test.mjs` assertions survive.
- **Rationale**: FR-017 requires the retirement to lose no coverage. The budgets guard the M2-signed-off shared content that this feature consumes read-only; they belong wherever the shared content is validated in the always-run suite.
- **Alternatives rejected**: drop the budgets (loses coverage, violates FR-017); leave them in a stranded file importing the retired assembler (breaks the suite).

## R10 — Security posture (constitution V — highest-risk area)

Three properties the plan treats as security-load-bearing; the analyze stage must escalate any violation to HIGH:

1. **`publish.mjs` cannot push by default** (R6). Default run touches no network and no credentials; push needs `--publish` + externally-configured remotes and fails closed otherwise. This is the same fail-closed posture as the dev-endpoint fix (2b9d6be).
2. **No dev endpoint or dev-only artifact ships in the bundle.** The committed `.mcp.json` endpoint is pinned to `https://squiredocs.com/mcp` by a dedicated assertion (FR-016); the drift exemption covers only that one field and every other byte is still asserted (FR-015). The endpoint rewrite lives exclusively in the harness's throwaway copy — the source bundle is never mutated (integrity check, R1).
3. **The drift test cannot pass on a hand-edited bundle.** Every generated file is byte-matched to a fresh `publish.mjs` regeneration from `shared/` (FR-014); a one-byte hand-edit fails CI naming the file and the regen command (SC-003). The endpoint exemption is field-scoped, not file-scoped, so it cannot mask a hand-edit elsewhere in `.mcp.json`.

**Not in scope / no new surface**: no auth endpoint, no ACL, no ingestion surface, no live-document mutation, no server code. The 031 consent-collapse security floor (localhost-only auto-issue) is prior work, unaffected here.

## Cross-surface command-string contract (FR-027, SC-005)

The plugin install one-liners MUST be textually identical across the served `agents.md`, `documentation/agents-and-mcp.md`, and `client/public/landing.html`. To make "identical" enforceable rather than hoped-for, the canonical strings are fixed here and every surface uses them verbatim:

```
/plugin marketplace add squiredocs/squire-plugin
/plugin install squire
```

Plus the restart-after-install caveat (FR-023) on every surface that carries the plugin route, and the retained raw one-liner for other MCP clients (FR-022):

```
claude mcp add --transport http squire https://squiredocs.com/mcp
```

A lightweight cross-surface assertion (a first-run-suite or doc-build test that greps all three surfaces for the two canonical plugin lines) is the enforcement; wording drift is a defect (FR-027). Note: `agents.md` and `landing.html` live under `client/public/` and are not part of the documentation-build terminology gate — the cross-surface check is what covers them; the terminology/validation gate covers `documentation/agents-and-mcp.md` (FR-024).

## Verified repo facts (grounding)

- `npm run test:first-run` = `node --test test/first-run/*.test.mjs`; CI runs it at `.github/workflows/test.yml` lines 63-64 (always-run). New drift test named `*.test.mjs` under `test/first-run/` is picked up automatically — no CI change (spec Assumption).
- The M2 `withGeneratedHeader` transform (assemble-bundle.mjs lines 41-50) inserts the do-not-hand-edit header AFTER leading YAML frontmatter; the drift test must re-derive with this exact transform (spec Edge Case). Carried verbatim into `publish.mjs`, with the regen command string updated to `node distribution/publish.mjs`.
- The M2 manifest shapes (plugin.json, marketplace.json, mcp.json) are the proven reference (spec Assumption). Changes for M3: version 0.1.0→1.0.0, marketplace/plugin copy from rehearsal framing → production copy, add `mcp-registry/server.json`.
- Served `agents.md` Connect section (lines 11-60) currently leads with `claude mcp add`; US5 makes the plugin route lead for Claude Code while keeping `claude mcp add` for other clients and preserving the in-session "don't run config mid-session" guidance.
- `documentation/agents-and-mcp.md` Connecting section (lines 10-42) is the insertion point for the per-ecosystem install section; the doc build + terminology gate (`client/src/__tests__/documentation-build.test.js`, `client/scripts/build-documentation.mjs`) must stay green.
- Landing page (`client/public/landing.html`) has a "Connects to your favorite AI" section (line 143) and a "Specs your agents can read" block (line 205) — the "works with your coding agent" install block slots alongside these.
