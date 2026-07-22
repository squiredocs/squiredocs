# Promotion notes — 032 Packaging & Distribution (M3 wave 1)

What the feature built stops at **"ready to submit."** Everything below is owed at
promotion/merge and is NOT done by this feature's agents (barred or external).

## Sam-only handoff (FR-028, contracts/drift-and-surfaces.md §Sam-only)

Nothing is published until 030+031 are deployed to prod (the marketplaces' first
impression must be the tuned flow). In order:

1. **Mirror-repo creation + first publish.** Create `github.com/squiredocs/squire-plugin`
   (and a mirror for the registry channel), grant push access, then run the first real push:
   ```
   SQUIRE_MIRROR_CLAUDE_PLUGIN=git@github.com:squiredocs/squire-plugin.git \
   SQUIRE_MIRROR_MCP_REGISTRY=git@github.com:squiredocs/squire-mcp-registry.git \
     node distribution/publish.mjs --publish
   ```
   The mechanism is complete and fixture-tested — no new code needed. Default runs
   never push; `--publish` fails closed without these env-configured remotes.
2. **MCP Registry DNS challenge + first registry publish.** `mcp-publisher` login,
   the Route 53 TXT record for the `com.squiredocs` namespace (Sam pre-authorized
   temporary access), then publish `distribution/mcp-registry/server.json`.
3. **Community-directory Console submission.** Free individual account, Console form;
   confirm the directory accepts a plugin whose MCP server requires signup-on-first-use
   OAuth, and any additional naming constraints (`squire`/`squiredocs` expected safe).
4. **Deploy sequencing.** Deploy 030+031 to prod → push mirrors (step 1) → deploy the
   site surfaces (agents.md, documentation, landing).

## Owed orchestrator / merge-queue items (barred here — constitution I & VI)

- **FR-030 — Agent Surface (MCP) design-doc amendment.** The served `agents.md`
  Claude Code path now LEADS with the plugin one-liner (`/plugin marketplace add
  squiredocs/squire-plugin` + `/plugin install squire`) and the signup-on-first-use
  line. The [Squire Agent Surface (MCP)] design doc owns the front-door contract, so
  the amendment lands there — **amend the Squire doc, then `node design/sync.mjs`**
  (never hand-edit `design/*`). This is a doc catch-up to what shipped, not a content
  change by this feature.
- **`docs/dev.md` first-run tooling refresh.** `docs/dev.md`'s first-run section is
  already stale (030 note 6) and US4 makes it staler: the M2 assembler
  (`test/first-run/assemble-bundle.mjs`, `assembled-bundle/`, `check-bundle-agreement.mjs`,
  `bundle-agreement.test.mjs`) is DELETED; the rehearsal harness now defaults to the
  committed `distribution/claude-plugin` shipping bundle; `node distribution/publish.mjs`
  is the single generator/validator; the drift guard is `test/first-run/bundle-drift.test.mjs`.
  This feature's agents cannot edit `docs/dev.md` — orchestrator docs pass owed at merge.
- **Design channel-status-table updates.** `design/plugin-marketplace-publishing.md`
  bottom table (Not started → Ready to submit / Listed) — orchestrator/Sam as
  submissions land; via the Squire doc + `node design/sync.mjs`, never a hand-edit.

## Post-merge review dispositions (2026-07-22, Fable — all FIXED, b321c56)

Adversarial review verdict: core safety architecture sound (no default push,
fail-closed remotes, non-vacuous byte-level drift guard, prod-pinned committed
bundle, submission-ready manifests). Two reproduced HIGH leaks + fixes:

- **HIGH — publish path could ship a dev endpoint.** `--endpoint <dev> --out d
  --publish` staged a dev `.mcp.json` past all three validators (validateBundles
  hardcodes PROD_ENDPOINT, so it validated bytes that were not what got pushed).
  FIXED: `publishMirrors` no longer takes an `endpoint` — the push path is always
  prod-pinned; the CLI refuses `--publish` combined with `--out` or a non-prod
  `--endpoint` (exit 2). Regression test added.
- **HIGH — test suite could push to a real remote.** publish-mechanism tests
  inherited real `SQUIRE_MIRROR_*` env; a runner with those exported (one habit
  away from the documented publish vars) would push server.json to the real
  GitHub mirror while the test passed. FIXED: tests strip all `SQUIRE_MIRROR_*`
  and assert configured-channel count == fixture count.
- **MEDIUM — drift extra-file blind spot** → drift now walks both committed dirs
  and fails on any file the generator does not emit.
- **MEDIUM — mirror never pruned** → the mirror clone is cleared (except .git)
  before staging, so a removed generated file does not linger live.
- **LOW** — version-downgrade + unreadable-manifest guards; scratch clones
  gitignored; robust CLI-entry check.

All owed items unchanged (Sam-only publish ops + deploy sequencing below).
