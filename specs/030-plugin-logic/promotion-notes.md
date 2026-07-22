# Promotion notes: 030-plugin-logic (M2) → M3

Obligations M2 hands forward to M3 (packaging, manifests, mirrors, publish.mjs,
wave submissions). Per FR-035, RBD-1, and the design's build-milestone gate:
**nothing here is done in M2**, and M3 must not begin until M2's exit gate is
recorded (clean full-matrix run + Sam's mechanics-and-tone sign-off — see
`exit-gate.md`, FR-034, SC-007).

## 1. Agent Surface doc gains the signup line (at ship time)

`design/agent-surface-mcp.md` (the front-door contract owner) must gain the
signup line — "signing in with Google creates the account if none exists" — in
its OAuth walkthrough guidance, as an amendment to the **Squire doc**, then
`node design/sync.mjs` (never a hand-edit of the export). Until then, `onboard.md`
carries the line without contradiction (the doc is silent on it, not opposed —
clarifications ledger gap 5, contract-crosscheck.md). M3 must not forget this: the
plugin content and the contract only fully agree once the amendment lands.

## 2. Surface updates that land WITH shipping (M3, not M2)

- **agents.md**: the Claude Code path leads with the plugin install one-liner as
  the recommended route; the raw `claude mcp add` one-liner stays for other MCP
  clients. This amends the agents.md contract the Agent Surface doc owns — lands
  there when this ships, never as silent drift.
- **/documentation/agents-and-mcp**: a per-ecosystem install section mirroring the
  one-liners.
- **Landing page**: a "works with your coding agent" block with the install
  one-liners, honest-confident voice.

## 3. Real packaging replaces the rehearsal assembly

`test/first-run/assemble-bundle.mjs` is deliberately NOT `distribution/publish.mjs`
(FR-020, RBD-1). M3 builds the real thing:

- Per-channel manifests under `distribution/` (`claude-plugin/`, `mcp-registry/
  server.json`, `kiro-power/`, `cursor-plugin/`, `gemini-extension/`,
  `codex-plugin/`) generated from `distribution/shared/`.
- Mirror repos (github.com/<org>/squire-plugin, etc.) receiving generated pushes.
- `distribution/publish.mjs`: regenerate bundles from `shared/`, validate against
  the manifest JSON schemas (+ the plugin-dev validator agent), push mirrors.
- The full **drift-vs-shared CI test across all channel bundles** replaces the
  single-bundle `check-bundle-agreement.mjs` (which guards only the rehearsal
  bundle in M2).
- MCP endpoint indirection: the shipped `.mcp.json` hardcodes
  `https://squiredocs.com/mcp`; the endpoint field stays exempt from the drift
  assertion (the harness already templates it per run).

## 4. Harness default `--bundle` moves to the shipping bundle

When `distribution/claude-plugin/` exists (M3), the 029/030 rehearsal harness's
default `--bundle` moves from the M2 assembled bundle
(`test/first-run/assemble-bundle.mjs` output) to `distribution/claude-plugin`, so
rehearsals exercise the actual shipping artifact. Until then the assembled bundle
is the default (FR-019).

## 5. Wave submissions (Sam ops within M3)

Per design D3 / channel waves — MCP Registry (wave 1, DNS challenge done per the
design's D1), Claude Code community directory (Console form), Kiro Powers, Cursor,
Gemini, Codex, MCP aggregators. All gated on M2 sign-off; nothing is published
before it.

## 6. Internal dev docs (follow-up, not assigned to any 030 task)

`docs/dev.md`'s first-run tooling section (≈ lines 477–550) still describes the
029 state: the stub plugin as the harness default, `--output-format text`, and no
matrix runner. After M2 the harness default is the assembled bundle, capture is
`stream-json`, and `test/first-run/matrix-runner.mjs` exists. No 030 task was
assigned to edit `docs/dev.md`, so it was left untouched — flag for a docs pass
(constitution I) alongside or before M3.
