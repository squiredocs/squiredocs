# Quickstart / Validation Guide: Packaging & Distribution — M3 Wave 1

Runnable scenarios that prove the feature works end to end. All commands run from the repo root in the dev pod. No network, no credentials, no publishing.

## Prerequisites

- Node.js (the runtime `test/first-run/*.mjs` already uses).
- `distribution/shared/{skill.md,onboard.md}` present (M2 output) and unchanged.

## 1. Regenerate + validate all bundles (US2, FR-008/009, SC-004)

```
node distribution/publish.mjs
```

Expected: regenerates `distribution/claude-plugin/**` and `distribution/mcp-registry/server.json` from `shared/`, validates each manifest against the pinned schemas, prints a pass/fail line per bundle, exits 0. Runs fully offline. If the plugin-dev validator agent is unavailable, that is a warning line, not a failure (FR-011).

Negative check: temporarily break a manifest (e.g. blank the `version` in the generated `plugin.json` derivation) → the run exits non-zero naming the offending file and the schema problem (FR-009). Restore.

## 2. Publish path fails closed without configuration (US2, FR-012, RBD-6) — SECURITY

```
node distribution/publish.mjs --publish        # no mirror remotes configured
```

Expected: refuses cleanly with a clear message, ZERO side effects, no network touched (SC: dangerous half impossible to trigger accidentally). The default run in step 1 must have performed no push. Push-mechanism tests use local bare-repo fixtures only — never a real remote.

## 3. Drift guard catches hand-edits (US3, FR-014/016, SC-002/003)

```
npm run test:first-run
```

Expected: green, including `bundle-drift.test.mjs` (every generated file byte-matches regeneration; `.mcp.json` endpoint pinned to `https://squiredocs.com/mcp`) and the re-homed content-budget checks.

Tamper check:
```
# hand-edit one byte of a generated file
printf '\n' >> distribution/claude-plugin/skills/squire/SKILL.md
npm run test:first-run    # FAILS, naming the drifted file + `node distribution/publish.mjs`
git checkout distribution/claude-plugin/skills/squire/SKILL.md   # restore
npm run test:first-run    # green again
```

Endpoint-exemption check: rewriting ONLY `mcpServers.squire.url` in a harness throwaway copy does not fail drift (field exempt), but the committed bundle's endpoint is still pinned to prod by a separate assertion — a committed dev URL fails (FR-015/016).

## 4. Rehearsal harness uses the shipping bundle (US4, FR-018..021)

```
node test/first-run/rehearsal-harness.mjs --server http://localhost:3001
```

Expected: with no `--bundle`, the harness installs from `distribution/claude-plugin` (not the retired M2 assembly), templates a throwaway copy with the dev endpoint, verifies the source bundle under `distribution/` is unmutated (source-integrity check), and completes a graded rehearsal. `--bundle <dir>` still overrides. The full first-run suite is green with no references to `assemble-bundle.mjs` / `assembled-bundle/` (FR-020/021).

```
grep -rn "assemble-bundle\|assembled-bundle\|check-bundle-agreement" test/ && echo "STALE REF FOUND" || echo "clean"
```
Expected: `clean` (retirement complete, FR-017/020).

## 5. Install one-liners on all three surfaces (US5, FR-022..027, SC-005)

```
cd client && npm run build      # or the documentation build entry the repo uses
```

Expected: the documentation build (validation + terminology gates) passes with the new per-ecosystem install section in `agents-and-mcp`. Then verify cross-surface identical strings:

```
grep -F "/plugin marketplace add squiredocs/squire-plugin" client/public/agents.md documentation/agents-and-mcp.md client/public/landing.html
grep -F "/plugin install squire" client/public/agents.md documentation/agents-and-mcp.md client/public/landing.html
grep -F "claude mcp add --transport http squire https://squiredocs.com/mcp" client/public/agents.md
```
Expected: the two plugin lines appear in all three files (verbatim, FR-027); the `claude mcp add` line survives in `agents.md` for other clients (FR-022). A cross-surface test enforces this so drift is a defect.

## 6. Full acceptance (SC-007)

```
npm run test:first-run && (cd client && npm run build)
```
Expected: both green; the retired M2 assembly path fully absent; the client build passes after the surface edits.

## What this guide does NOT do

- No `--publish` against a real remote (Sam op, FR-028).
- No registry publish, directory submission, DNS change, or mirror-repo creation (Sam-only handoff, see contracts/drift-and-surfaces.md).
- No edit to `docs/dev.md`, `README.md`, or `design/*` (owed orchestrator work; barred here).
