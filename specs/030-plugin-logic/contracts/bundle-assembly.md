# Contract: Rehearsal bundle assembly + agreement check

The minimal test-harness-side assembler (`test/first-run/assemble-bundle.mjs`) and drift guard (`test/first-run/check-bundle-agreement.mjs`). Explicitly NOT `distribution/publish.mjs` (FR-020, RBD-1).

## assemble-bundle.mjs

- **Input**: `distribution/shared/skill.md`, `distribution/shared/onboard.md`; the manifest/`.mcp.json`/marketplace shape (reused from the 029 stub's structure).
- **Output**: an installable bundle directory (default `test/first-run/assembled-bundle/` or a temp dir) containing:
  - `.claude-plugin/plugin.json` (name `squire`, "Squire Docs" display copy, semver)
  - `.claude-plugin/marketplace.json`
  - `.mcp.json` (endpoint `https://squiredocs.com/mcp`; the harness templates this to the dev server in its throwaway copy at run time — this one field is exempt from the agreement check, mirroring 029's endpoint-indirection)
  - `skills/squire/SKILL.md` — generated from `shared/skill.md`, with a do-not-hand-edit header pointing at `distribution/shared/skill.md`
  - `commands/onboard.md` — generated from `shared/onboard.md`, with the same header pointing at `distribution/shared/onboard.md`
- **Invariants**: never mutates `distribution/shared/` (FR-019); produces no mirrors, submissions, per-channel manifests, or registry entries (FR-020); `distribution/` after this feature contains only `shared/`.

## check-bundle-agreement.mjs

- **Contract**: re-derive the generated content region (SKILL.md, onboard.md, and the generated header) from `distribution/shared/` and compare to the on-disk assembled bundle. Exit non-zero on any divergence (FR-021), excluding the `.mcp.json` endpoint field (the sole indirected field).
- **When it runs**: as a precondition inside the harness/matrix run (a rehearsal cannot exercise stale content — spec Edge Case), and as a standalone deterministic check in the standard suite. (The full drift-vs-shared CI test across all channel bundles is M3 — FR-021, FR-035.)
- **Effect on drift**: a hand-edited generated file (or an assembler bug) makes the check FAIL, so content drift cannot silently enter rehearsals (SC-004).

## Harness integration (FR-019)

- The harness `--bundle` default becomes the assembled bundle for M2 iteration; `--bundle <path>` still overrides (029 RBD-9 parameterization).
- The harness runs the agreement check (or assembles fresh) per run so `shared/` edits mid-iteration can never be silently skipped (spec Edge Case: shared content edited mid-iteration).
- Endpoint indirection continues via the harness throwaway-copy mechanism (029 FR-020): the harness copies the bundle to a temp dir and rewrites `.mcp.json` there; the source bundle and `shared/` are untouched.
