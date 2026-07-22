# Contract: `distribution/publish.mjs` programmatic + CLI interface

The single generator/validator/pusher. Its programmatic exports are the shared source of expected bytes for the drift test and the rehearsal harness (FR-008); its CLI is the maintainer/Sam entry point (FR-009/012). Carried behavior from the retired M2 `assemble-bundle.mjs` is marked [M2].

## Programmatic exports (ESM)

```js
import {
  PROD_ENDPOINT,           // 'https://squiredocs.com/mcp' [M2]
  withGeneratedHeader,     // (sharedContent, sourceRel) → string [M2, regen string updated]
  expectedFiles,           // ({ endpoint }) → { relPath: content } for the claude-plugin bundle [M2]
  assembleBundle,          // ({ outDir, endpoint }) → { outDir, files[] } [M2]
  DEFAULT_CLAUDE_PLUGIN_DIR, // absolute path to distribution/claude-plugin
  CHANNELS,                // channel descriptors (registry-style, RBD-3)
  expectedRegistryServer,  // () → server.json content string
  validateBundles,         // () → { ok, problems[] } schema validation over all channels
} from '../../distribution/publish.mjs';
```

### `withGeneratedHeader(sharedContent, sourceRel)` [M2 — carried verbatim, regen string updated]

- Inserts the do-not-hand-edit header immediately AFTER any leading YAML frontmatter block; else at the top.
- Header names the shared source (`sourceRel`) and the regen command **`node distribution/publish.mjs`** (the one behavioral change from M2, which said `node test/first-run/assemble-bundle.mjs`).
- Byte-stable: the drift test re-derives with this exact transform (FR-005, spec Edge Case: frontmatter must stay first).

### `expectedFiles({ endpoint = PROD_ENDPOINT })` → `{ [relPath]: content }`

Returns the full claude-plugin bundle as relative-path → content, the single source both the writer and the drift guard compute from (they cannot disagree). Keys:

- `.claude-plugin/plugin.json` — name `squire`, version `1.0.0`, "Squire Docs" production copy.
- `.claude-plugin/marketplace.json` — own marketplace, production copy, plugin entry `{ name: 'squire', source: './' }`.
- `.mcp.json` — `mcpServers.squire = { type: 'http', url: endpoint }`.
- `skills/squire/SKILL.md` — `withGeneratedHeader(shared skill.md, 'distribution/shared/skill.md')`.
- `commands/onboard.md` — `withGeneratedHeader(shared onboard.md, 'distribution/shared/onboard.md')`.

Deterministic: identical `shared/` inputs → byte-identical outputs (FR-008).

### `assembleBundle({ outDir, endpoint })` → `{ outDir, files[] }`

Writes `expectedFiles({ endpoint })` under `outDir`. MUST NOT mutate `distribution/shared/` (read-only, FR-006). Used by the harness to materialize a bundle and by `--publish` to stage a mirror.

### `expectedRegistryServer()` → content string

Returns the deterministic `mcp-registry/server.json` content (`com.squiredocs/mcp`, remote streamable-HTTP, OAuth, no package/stdio). Drift-matched (FR-014).

### `validateBundles()` → `{ ok, problems[] }`

Validates every generated manifest against its pinned schema (FR-009). Each problem names the offending file and the schema violation. Offline, deterministic (FR-010). Advisory plugin-dev validator attempted where available; its absence is a `problems`-adjacent warning, never a failure (FR-011).

## CLI

```
node distribution/publish.mjs [--publish] [--out <dir>] [--endpoint <url>]
```

### Default (no `--publish`) — dry-run, MUST be offline + side-effect-free (RBD-6, FR-012)

1. Regenerate every wave-1 bundle from `shared/` into the committed `distribution/` locations (or `--out`).
2. `validateBundles()`; on any failure exit **non-zero** naming file + problem (FR-009, SC-004).
3. NEVER touches network or credentials. Exit 0 = all bundles regenerated + validated.

### `--publish` — push mode, MUST fail closed (RBD-6, FR-012/013)

Preconditions (ALL enforced before any push; missing → exit non-zero, zero side effects):

- `--publish` explicitly present.
- Mirror remotes supplied via configuration/environment (NOT committed defaults). Missing/unreachable → fail closed pre-push.

Per configured mirror:

1. Clone/fetch the mirror.
2. **Version-bump guard (FR-013)**: if regenerated content differs from the mirror's while `plugin.json.version` (or the channel's manifest version) is unchanged → **refuse**, exit non-zero, no push.
3. Commit + push with a message referencing the source-repo commit (FR-012).

**Tests/CI MUST NEVER exercise the push path against a real remote.** Push mechanism tests use **local bare-repo fixtures only** (RBD-6). Running a real publish is a Sam op (FR-028).

## Invariants (analyze must treat violations as HIGH — R10)

- **INV-1**: default invocation performs NO push and requires NO network/credentials. A default run that could push, or that resolves a committed mirror default, is a HIGH finding.
- **INV-2**: no dev endpoint or dev-only artifact is ever written into the committed bundle. The generated `.mcp.json` endpoint is `PROD_ENDPOINT`; dev rewriting lives only in the harness throwaway copy.
- **INV-3**: `expectedFiles`/`expectedRegistryServer` are the ONLY source of expected bytes; the drift test imports them (never a hand-maintained fixture), so a drift test that could pass on a hand-edited bundle is a HIGH finding.
