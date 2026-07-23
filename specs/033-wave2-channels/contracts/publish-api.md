# Contract — `distribution/publish.mjs` programmatic API (wave-2 delta)

**Feature**: 033-wave2-channels | **Date**: 2026-07-23

This documents ONLY the wave-2 additions/changes to the `publish.mjs` public surface. Everything the
wave-1 contract (`specs/032-packaging-distribution/contracts/publish-api.md`) pins stays true and
unchanged. Consumers: the drift test, the publish-mechanism test, the deeplink round-trip test, and
the site surfaces (which embed the deeplink helper's output).

## Unchanged exports (wave 1 — still exported, same behavior)

`PROD_ENDPOINT`, `withGeneratedHeader`, `expectedFiles`, `assembleBundle`,
`DEFAULT_CLAUDE_PLUGIN_DIR`, `CHANNELS`, `expectedRegistryServer`, `validateBundles`,
`generateAll`, `publishMirrors`, `mirrorRemoteFor`, `REPO_ROOT`, `SHARED_DIR`, `SCHEMAS_DIR`,
`SHIP_VERSION`, `REGISTRY_VERSION`, `DEFAULT_MCP_REGISTRY_DIR`.

## New / changed exports

### `CHANNELS` — now length 4

Two descriptors appended: `kiro-power`, `cursor-plugin`. Adding them MUST NOT change the generated
bytes of `claude-plugin` or `mcp-registry` (drift test proves this). Each new descriptor:

```
{
  id: 'kiro-power' | 'cursor-plugin',
  outDir: DEFAULT_KIRO_POWER_DIR | DEFAULT_CURSOR_PLUGIN_DIR,   // new exported path constants
  files: ({ endpoint = PROD_ENDPOINT } = {}) => ({ relPath: content, ... }),  // pure
  endpointRel: 'mcp.json',
  schemas: [ ...structural validator bindings... ],
  mirrorEnv: 'SQUIRE_MIRROR_KIRO_POWER' | 'SQUIRE_MIRROR_CURSOR_PLUGIN',
  readVersion: (files) => string,          // NEW — FR-017
  versionCarrierRel: 'POWER.md' | '.cursor-plugin/plugin.json',  // NEW — for refusal messages
}
```

### `readVersion(files) → string` (NEW, on every descriptor — FR-017)

- **Total**: returns a semver string, or throws if the carrier file is absent/malformed in the given
  map. Applied identically to the fresh (in-memory) map and the mirror (read-from-disk) map.
- Helpers: `versionFromJson(rel)` → `files => JSON.parse(files[rel]).version`;
  `versionFromFrontmatter(rel, key='version')` → parses the `^---\n...\n---\n` block, returns the key.
- Wave-1 descriptors: `claude-plugin` uses `versionFromJson('.claude-plugin/plugin.json')`,
  `mcp-registry` uses `versionFromJson('server.json')` — replacing the hardcoded
  `id === 'mcp-registry' ? ... : ...` branch in `diffAgainstMirror`. Values unchanged (1.0.1 / 1.0.2).

### `diffAgainstMirror(channel, mirrorDir)` (CHANGED internally — FR-017)

- Fresh version: `channel.readVersion(channel.files({ endpoint: PROD_ENDPOINT }))`.
- Mirror version: read the carrier file(s) named by the channel from `mirrorDir` into a `{rel:content}`
  map, then `channel.readVersion(thatMap)`.
- **Guard semantics unchanged**: absent carrier → `mirrorVersion = null` (first publish, allowed);
  present-but-throws/null → `mirrorVersionUnreadable = true` → refuse; else compare.
- Return shape gains no breaking change; `versionRel` label becomes `channel.versionCarrierRel`.
- **Invariant (security)**: the guard's three refusals — content-change-without-bump, non-forward
  bump, present-but-unreadable — MUST fire for all four channels. No weakening.

### `cursorDeeplink({ name, endpoint } = {}) → string` (NEW — FR-019)

- Returns `cursor://anysphere.cursor-deeplink/mcp/install?name=${name}&config=${b64}`.
- Defaults: `name = CURSOR_SERVER_KEY` (`'squire-docs'`), `endpoint = PROD_ENDPOINT`.
- `b64 = Buffer.from(JSON.stringify({ url: endpoint })).toString('base64')`.
- PURE, no disk/network. Derived from `PROD_ENDPOINT` — never a second hardcoded URL.
- **Round-trip invariant (FR-025)**: base64-decoding the `config` query param yields exactly
  `{"url": PROD_ENDPOINT}`; the `name` param equals `CURSOR_SERVER_KEY`.

### `validateBundles()` (extended — FR-021/022/023)

- Now validates all four channels. New validator kinds registered in `VALIDATORS`:
  - `cursor-plugin` → `validateCursorPlugin(obj)`: kebab name pattern, semver version, author shape,
    license string, homepage/repository strings, **reject top-level keys not in the vendored schema's
    `properties`** (additionalProperties:false).
  - `cursor-mcp` → `validateCursorMcp(obj)`: `mcpServers.squire-docs` present with a bare https `url`
    and **no `type` field** (the Cursor-specific correct shape).
  - `kiro-power` → `validateKiroPower(files)`: POWER.md frontmatter fields (incl. `keywords` array,
    `version` semver) + ordered body sections + License-and-Support (license + privacy link + support
    contact); `mcp.json` shape (`type:"http"`, https url, no `oauth`).
  - `mdc-rule` → `validateMdcRule(content)`: frontmatter `description` non-empty, `alwaysApply:false`.
- Return shape unchanged: `{ ok, problems[], warnings[] }`; each problem names channel + file + issue.
- Offline, deterministic, dependency-free (ajv still absent).

### New exported constants

`DEFAULT_KIRO_POWER_DIR`, `DEFAULT_CURSOR_PLUGIN_DIR` (absolute paths), `CURSOR_SERVER_KEY`
(`'squire-docs'`), `KIRO_SERVER_KEY` (`'squire-docs'`), and the two new channel versions
(`KIRO_POWER_VERSION = '1.0.0'`, `CURSOR_PLUGIN_VERSION = '1.0.0'`) — each channel versions
independently (FR-016).

## CLI — unchanged surface, wider coverage

`node distribution/publish.mjs` (dry-run) now regenerates + validates 4 channels. `--publish`,
`--out`, `--endpoint` behave exactly as wave 1; the `--publish`-with-`--out`/non-prod-`--endpoint`
refusal (exit 2) and the fail-closed no-remotes refusal (now naming all four env vars) are unchanged
in mechanism.
