# Vendored manifest schemas — provenance & refresh (RBD-4, FR-010)

`distribution/publish.mjs` validates every generated manifest against a **pinned,
in-repo** copy of its schema — offline and deterministically. A gate that can
fail for network reasons is not authoritative (RBD-4), so the schemas live here,
not fetched at validation time. This file records where each came from and how to
refresh it.

Validator note (T002): `ajv` is **not** resolvable in this repo's dependency tree
(`node -e "require.resolve('ajv')"` throws). Per research R8, `publish.mjs` uses a
small **self-contained structural validator** covering exactly what these pinned
schemas assert for these few manifests — no new production dependency. These
schema files are the documented contract the structural validator is written
against, and the artifacts Sam diffs at a real submission.

## `server.schema.json` — Official MCP Registry `server.json`

- **Upstream**: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
- **Retrieved**: 2026-07-22 (byte-vendored verbatim, HTTP 200). Migrated from the
  2025-09-29 schema (deprecated) — the only change to `server.json` was the `$schema`
  URL; ServerDetail required fields (name/description/version) and the streamable-http
  `remotes[]` shape are identical, so no structural change was needed. Registry version
  bumped 1.0.1→1.0.2 for the republish; the Claude plugin is unaffected (stays 1.0.1).
- **Used for**: `distribution/mcp-registry/server.json` (`com.squiredocs/mcp`).
- **Note**: The registry format has no dedicated OAuth field — remote MCP OAuth is
  discovered via the server's well-known chain (RFC 9728). We declare the remote
  streamable-HTTP transport in `remotes[]` and record the OAuth posture under the
  schema-sanctioned `_meta["io.modelcontextprotocol.registry/publisher-provided"]`
  extension point (`additionalProperties: true`), so the file stays valid against
  this exact upstream schema at Sam's real submission (R7 — do not waste the
  one-time DNS-challenge session on a structurally-wrong file).

## `cursor-plugin.schema.json` — Cursor plugin manifest (`.cursor-plugin/plugin.json`)

- **Upstream**: `https://raw.githubusercontent.com/cursor/plugins/main/schemas/plugin.schema.json`
- **Retrieved**: 2026-07-23 (byte-vendored verbatim, HTTP 200). Draft-07,
  `additionalProperties: false`, `required: ["name"]` with the kebab `name` pattern
  `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`. Distinct filename from the hand-authored Claude
  `plugin.schema.json` (no collision — Cursor's manifest lives at
  `.cursor-plugin/plugin.json`, a different path and shape).
- **Used for**: `distribution/cursor-plugin/.cursor-plugin/plugin.json` (`squire-docs`).
- **Note**: The structural validator in `publish.mjs` (`validateCursorPlugin`) enforces
  this schema's `required`/`additionalProperties:false` intent by deriving its allowed
  top-level keys from this vendored file's `properties` — a hand-added manifest key
  outside the schema is a validation failure, not a silent pass.

## `plugin.schema.json` — Claude Code plugin manifest (`.claude-plugin/plugin.json`)

- **Upstream**: none. Anthropic ships the `plugin-dev` plugin with scaffolding and
  a validator, but publishes **no standalone JSON Schema file** for the manifest
  (probed 2026-07-22: `raw.githubusercontent.com/anthropics/claude-code/.../plugin.schema.json`
  → HTTP 404).
- **Provenance**: **hand-authored** to the documented manifest shape (name pattern
  `^[a-z0-9-]+$` for command namespacing, semver `version`, optional
  `description`/`author`). Marked pinned because it is the offline contract; the
  authoritative freshness check is the advisory `plugin-dev` validator at Sam's
  submission (FR-011), not this file.

## `marketplace.schema.json` — Claude Code marketplace manifest (`.claude-plugin/marketplace.json`)

- **Upstream**: none (same as `plugin.schema.json` — no standalone schema published).
- **Provenance**: **hand-authored** to the documented marketplace shape (`name`,
  `owner.name`, `plugins[]` each with `name` + `source`).

## Refresh procedure (re-fetch + diff + bump)

When an upstream schema changes (or Anthropic starts publishing plugin schemas):

1. Re-fetch the upstream URL above to a scratch file.
2. `diff` it against the vendored copy here.
3. If it changed, update the vendored copy, adjust `publish.mjs`'s structural
   validator to match any new/changed required constraints, re-run
   `node distribution/publish.mjs` (regenerate + validate) and `npm run test:first-run`.
4. Bump the `Retrieved` date above and note the change.
5. For the hand-authored plugin/marketplace schemas: if Anthropic publishes an
   official schema, replace the hand-authored copy with the vendored upstream one
   and record its URL + retrieval date here.
