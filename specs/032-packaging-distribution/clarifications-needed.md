# Clarifications Ledger: 032-packaging-distribution

Design ground truth: `design/plugin-marketplace-publishing.md` (ratified 2026-07-21), M3 wave 1 only;
M2→M3 obligations in `specs/030-plugin-logic/promotion-notes.md`. Per constitution VI, unanswered
product decisions get the best default, recorded here — never decided silently, never blocking.

## RATIFIED-BY-DEFAULT decisions (Sam pre-authorized, 2026-07-22)

### RBD-1 — Endpoint indirection stays throwaway-copy templating; no env-interpolation dependency

- **Question**: The design (MCP endpoint indirection, M3) says "verify at implement time that Claude Code's `.mcp.json` supports env interpolation; if it does not, the harness templates a throwaway copy." Which mechanism does the shipped bundle rely on?
- **Why it matters**: If the shipped `.mcp.json` used an env-interpolated endpoint, every installing user's client would need the variable resolved (or a fallback default) — a fragile dependency on client behavior for a file that must Just Work on install. If it hardcodes prod, the harness needs another dev path.
- **Default chosen**: The shipped `.mcp.json` hardcodes `https://squiredocs.com/mcp` (asserted by test, FR-016). The harness keeps its existing, already-built throwaway-copy templating (verified in `test/first-run/rehearsal-harness.mjs`: copies the bundle to a temp dir, rewrites the endpoint, asserts the source was not mutated). The endpoint URL field is the sole drift-assertion exemption (FR-015). No env interpolation in the shipped artifact; implement-time verification of client interpolation is moot because nothing depends on it.
- **Rationale**: The design named templating as the acceptable fallback; it is already implemented, integrity-checked, and exercised by every rehearsal since 029. Choosing the proven mechanism removes a client-version behavioral dependency from the shipping artifact entirely.

### RBD-2 — assemble-bundle.mjs and assembled-bundle/ are deleted, not kept as wrappers

- **Question**: The assignment says "update/retire the M2 `assemble-bundle.mjs`/`assembled-bundle` as appropriate." Retire fully, or keep as a thin wrapper over publish.mjs?
- **Why it matters**: Two generators (or a generator plus wrapper) reintroduces exactly the two-sources-of-truth drift the design's generated-copies rule targets; but deletion must not orphan the harness, agreement check, or matrix runner that import from it.
- **Default chosen**: Delete `test/first-run/assemble-bundle.mjs`, `test/first-run/assembled-bundle/`, and `test/first-run/check-bundle-agreement.mjs` (+ its test) once their consumers are migrated. `publish.mjs` exports the programmatic expected-files/assemble API (same pattern as the M2 assembler) and the harness, matrix runner, and new drift test all import from it. The proven M2 shapes and header transform are carried into `publish.mjs`, preserving behavior.
- **Rationale**: 030's RBD-1 explicitly framed the assembler as a deliberately-temporary stand-in for publish.mjs ("the real thing" is M3, per its own file header). One generator, one drift guard, one import surface is the design's stated end state.

### RBD-3 — No wave-2/3 placeholder directories

- **Question**: The design's repo layout draws `kiro-power/`, `cursor-plugin/`, `gemini-extension/`, `codex-plugin/` under `distribution/`. Create empty placeholders now, or nothing until their features?
- **Why it matters**: Placeholders would make `publish.mjs` and the drift test either special-case empty dirs or validate nothing; and an empty dir mirrored to a public repo is a bad storefront first impression.
- **Default chosen**: Create only `claude-plugin/` and `mcp-registry/` (FR-029). `publish.mjs` is structured so a later feature adds a channel by adding a generator entry, not by rearchitecting. Wave-2/3 dirs arrive with features 033+.
- **Rationale**: D3 makes the waves sequential and the milestones incremental; YAGNI (constitution III) rejects scaffolding for unbuilt channels, especially with Cursor's requirements still an open design question.

### RBD-4 — Manifest JSON schemas are vendored and pinned in-repo

- **Question**: The schema validation is "the authoritative gate," but the plugin/marketplace/server.json schemas live upstream (Anthropic plugin schemas, MCP registry schema). Fetch at validation time or vendor pinned copies?
- **Why it matters**: Network fetches make the authoritative CI gate flaky and non-deterministic (and the dev pod may be offline); but pinned copies can silently age against upstream.
- **Default chosen**: Vendor pinned schema copies in-repo (under the distribution tooling, each annotated with its upstream source URL and retrieval date) so `publish.mjs` validates offline and deterministically (FR-010). A documented refresh step (re-fetch and diff) lives in the publish script's usage notes; the plugin-dev validator agent (run where available, advisory) is the freshness backstop, and real submissions surface any upstream drift at the marketplace's own gate.
- **Rationale**: A gate that can fail for network reasons is not authoritative; pinning matches how this repo treats other external contracts. Worst case of staleness is caught at submission — a Sam op with a human in the loop.

### RBD-5 — Shipping bundle's first published version is 1.0.0

- **Question**: `plugin.json` needs a semver. The M2 rehearsal bundle used 0.1.0 ("only needs to install"); what does the real bundle ship as?
- **Why it matters**: This is the first version users' clients ever see and the baseline every bump-on-change increments from; 0.x can read as "not ready" in listing surfaces, which fights the honest-confident voice for content that IS signed off.
- **Default chosen**: `1.0.0` for the first published bundle. The content is M2-signed-off and the flow prod-tested (030+031); the design's versioning rule (bump on any change to shared content or manifests) starts counting from there. `server.json` mirrors the same version where the registry schema carries one.
- **Rationale**: The marketing-tone standard is honest but confident — the plugin does what it says; shipping it as 1.0.0 is the honest claim. Semver majors remain available for a future contract break.

### RBD-6 — Publish is dry-run by default; pushing requires an explicit flag and preconfigured targets

- **Question**: The design says `publish.mjs` "commit[s]-and-push[es] each mirror repo," but running a real publish is a Sam op and the pipeline must never push. Where is the line drawn in the script's interface?
- **Why it matters**: A script whose default invocation pushes to public repos is a foot-gun for CI, tests, and pipeline agents; but the mechanism must be complete enough that Sam's first real publish needs zero new code.
- **Default chosen**: Default invocation = regenerate + validate only, no network (FR-012). Pushing requires an explicit `--publish` opt-in AND mirror remotes supplied via configuration/environment (never committed defaults that could resolve for an agent); missing/unreachable targets fail closed pre-push. The version-unchanged-but-content-changed check (FR-013) runs in the publish path against the mirror clone. Tests cover the mechanism against local bare-repo fixtures, never real remotes.
- **Rationale**: Implements the full design mechanism while making the dangerous half impossible to trigger accidentally — the same fail-closed posture the project adopted for dev endpoints.

### RBD-7 — server.json is validated in CI but its registry namespace claims are exercised only at Sam's publish

- **Question**: `server.json`'s reverse-DNS name `com.squiredocs/mcp` is only provable via the registry's domain-verification challenge, which is a Sam op. What does this feature verify about it?
- **Why it matters**: CI cannot complete domain verification, but shipping a structurally wrong `server.json` would waste the one-time DNS-challenge session.
- **Default chosen**: CI validates `server.json` against the pinned registry schema (structure, name format, remote/transport shape, OAuth declaration) and the drift test pins it to regeneration. Namespace ownership, `mcp-publisher` login, and the actual publish are exclusively the Sam-op checklist items; the spec's handoff lists the Route 53 TXT step Sam pre-authorized in the design.
- **Rationale**: Verifies everything verifiable without external identity; the design already assigns identity proof to Sam explicitly.
