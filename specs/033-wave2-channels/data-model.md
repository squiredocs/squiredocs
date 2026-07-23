# Phase 1 Data Model — Wave 2 Distribution Channels

**Feature**: 033-wave2-channels | **Date**: 2026-07-23

"Entities" here are the generated distribution artifacts and the generator's descriptor shape — this
is a file-generation feature, not a data feature (no DB, no migration). Each entity lists its fields,
the FR it satisfies, and its validation rules.

## E1 — Channel descriptor (extended shape)

An entry in `publish.mjs`'s `CHANNELS` registry. Wave 2 adds a `readVersion` field (FR-017) to the
existing shape and adds two entries.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | stable channel id (`kiro-power`, `cursor-plugin`) |
| `outDir` | absolute path | committed output directory |
| `files(opts)` | `({endpoint}) → {relPath: content}` | pure map of every generated file |
| `endpointRel` | string \| null | rel path whose endpoint field is drift-exempt (`mcp.json` for both new channels) |
| `schemas` | `{manifestRel, file, kind}[]` | validator bindings |
| `mirrorEnv` | string | env var supplying the push remote (never a committed default) |
| **`readVersion(files)`** | **`{rel:content} → string`** | **NEW (FR-017): extracts this channel's version from its file map; total (returns semver string or throws)** |
| **`versionCarrierRel`** | **string** | **NEW: human label of the version-bearing file, for the guard's refusal message** |

**Validation rules**: `readVersion` must be the SAME function applied to fresh (in-memory) and mirror
(read-from-disk) file maps. It returns a semver string or throws; the guard treats a throw/null on the
mirror side as `mirrorVersionUnreadable` → refuse (never first-publish). Existing wave-1 descriptors
gain `readVersion: versionFromJson('.claude-plugin/plugin.json')` and
`versionFromJson('server.json')` respectively — a pure refactor of the current hardcoded branch, no
byte change to their output.

## E2 — Kiro Power bundle (`distribution/kiro-power/`) — FR-001..008

| File | Content | Rules |
|---|---|---|
| `POWER.md` | YAML frontmatter + ordered body | frontmatter: `name: "squire-docs"`, `displayName`, `description`, `keywords` (array), `author`, `version: "1.0.0"` (FR-002/008). Body sections in order (FR-003): Overview → When to Use This Power → Onboarding → Available Steering Files → When to Load Steering Files → Available MCP Servers → MCP Configuration → License and Support. License-and-Support carries license id (MIT for the power), the `https://squiredocs.com/privacy` link, and support contact `hello@squiredocs.com` (FR-003, RBD-3/4). |
| `mcp.json` | remote streamable-HTTP | `mcpServers.squire-docs` = `{ type:"http", url:"https://squiredocs.com/mcp", disabled:false, autoApprove:[] }`; NO `oauth`/`oauthScopes` (FR-004, DCR). Endpoint field drift-exempt. |
| `steering/specs-sync-workflow.md` | Kiro-native prose | standing loop + byte channel + `sk_sqd_` token rules + onboarding-as-prose (find `.kiro/specs/**` first, sync via recipe, deliver URL, teach loop). No Claude-Code mechanics (FR-005/006). Agrees with `shared/skill.md` + Agent Surface (FR-031). |
| `steering/working-with-squire-docs.md` | Kiro-native prose | what the doc is: two-way sync, attribution, revertibility; hero framing (`.kiro/specs` files become a shared/attributed/synced doc). Agrees with sources (FR-005/031). |

**Mirror**: `squiredocs/squire-kiro-power` (via `SQUIRE_MIRROR_KIRO_POWER`). **Version**: 1.0.0,
independent. **Version carrier**: POWER.md frontmatter `version:` (fallback `VERSION` file, RBD-2).

## E3 — Cursor plugin bundle (`distribution/cursor-plugin/`) — FR-009..014

| File | Content | Rules |
|---|---|---|
| `.cursor-plugin/plugin.json` | manifest | `name:"squire-docs"` (kebab `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`), `version:"1.0.0"` (semver), `displayName`+`description` ("Squire Docs", honest-confident), `author:{name:"Squire Docs", email:"hello@squiredocs.com"}`, `license:"MIT"`, `repository:"https://github.com/squiredocs/squire-cursor-plugin"`, `homepage:"https://squiredocs.com"`, optional `keywords`/`category`. NO property outside the vendored schema (additionalProperties:false) (FR-010). |
| `mcp.json` | remote | `mcpServers.squire-docs` = `{ url:"https://squiredocs.com/mcp" }` — bare url, **NO `type` field**, no `auth` block (FR-011, Cursor convention). Endpoint field drift-exempt. |
| `rules/squire-spec-loop.mdc` | Agent-Requested rule | frontmatter: `description` (non-empty, when-to-apply), `alwaysApply: false`; body restates the standing loop consistent with `shared/skill.md`, Cursor-adapted (no Claude-plugin command refs) (FR-012). |
| `skills/squire/SKILL.md` | from `shared/skill.md` | near-verbatim: shared frontmatter + body byte-faithful, plus the `withGeneratedHeader` header after frontmatter (FR-013). |
| `LICENSE` | MIT | same single-source `licenseText()` as wave 1 (holder + year single-sourced) (FR-014). |
| `README.md` | prose | what the plugin is, what installing does (MCP + rule + skill), OAuth/first-use (browser sign-in; Google is find-or-create), where ground truth lives (generated from this repo — do not PR the mirror) (FR-014). |

**Mirror**: `squiredocs/squire-cursor-plugin` (via `SQUIRE_MIRROR_CURSOR_PLUGIN`). **Version**: 1.0.0,
independent. **Version carrier**: `.cursor-plugin/plugin.json` `version`.

## E4 — Vendored Cursor schema (`distribution/schemas/cursor-plugin.schema.json`) — FR-020

Byte-verbatim copy of `https://raw.githubusercontent.com/cursor/plugins/main/schemas/plugin.schema.json`
(draft-07, `additionalProperties:false`). Distinct filename from the hand-authored Claude
`plugin.schema.json` (no collision). SOURCES.md gains an entry: upstream URL, retrieved 2026-07-23,
used for `distribution/cursor-plugin/.cursor-plugin/plugin.json`, refresh via the existing procedure.

## E5 — Add-to-Cursor deeplink — FR-019/025/029

`cursor://anysphere.cursor-deeplink/mcp/install?name=squire-docs&config=<base64({"url":PROD_ENDPOINT})>`.
Computed by the exported `cursorDeeplink()` helper from `PROD_ENDPOINT` (single source). For prod:
`config=eyJ1cmwiOiJodHRwczovL3NxdWlyZWRvY3MuY29tL21jcCJ9`. Embedded byte-identically on the landing
page and documentation; asserted by the round-trip test (decode → `{url: PROD_ENDPOINT}`) and the
cross-surface byte-identity test.

## E6 — Mirror env vars

`SQUIRE_MIRROR_KIRO_POWER`, `SQUIRE_MIRROR_CURSOR_PLUGIN` — never committed, fail-closed when absent,
joined with the wave-1 pair (`SQUIRE_MIRROR_CLAUDE_PLUGIN`, `SQUIRE_MIRROR_MCP_REGISTRY`) in the
`--publish` fail-closed message and the `mirrorRemoteFor` resolution.

## Cross-entity invariants

- **Server key `squire-docs`** on both new channels (name, `mcpServers` key, deeplink `name` param) —
  RBD-1. The wave-1 claude-plugin key stays `squire`; the docs' existing manual Kiro snippet (key
  `squire`) is left unchanged (Flagged Gap #6).
- **Independent versions**: all four channels version independently; changing one bumps only its
  carrier (FR-016/017).
- **Endpoint single-sourced**: every `mcp.json` url + the deeplink + the registry remote all derive
  from `PROD_ENDPOINT`.
- **Content truth**: every behavioral claim in POWER.md/steering/`.mdc`/READMEs/site copy agrees with
  `design/agent-surface-mcp.md` + `distribution/shared/` (FR-031) — two-way sync, attribution,
  revertibility, byte channel, token handling, OAuth-creates-account.
