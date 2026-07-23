# Contract — Kiro/Cursor manifest field shapes + site/doc surfaces (wave 2)

**Feature**: 033-wave2-channels | **Date**: 2026-07-23

The externally-mandated field shapes the generator MUST emit and the validators MUST enforce, plus the
site/documentation surface contract. Ground truth: `research-inputs/{kiro-power-format,cursor-plugin-format}.md`.

## Kiro `POWER.md` frontmatter (required)

```yaml
name: "squire-docs"          # kebab internal id — chosen once (changing forces reinstall)
displayName: "Squire Docs — collaborative specs"
description: "…honest-confident one-liner, 'Squire Docs'…"
keywords: ["specs","spec-driven","kiro-specs","requirements","design","review","attribution", …]  # ARRAY
author: "Squire Docs"
version: "1.0.0"             # version carrier (RBD-2); not a documented Kiro field — fallback VERSION file
```

**Body sections, in order** (FR-003): Overview → When to Use This Power → Onboarding → Available
Steering Files → When to Load Steering Files (situation→file map) → Available MCP Servers → MCP
Configuration → **License and Support** (MIT license id for the power + `https://squiredocs.com/privacy`
+ support contact `hello@squiredocs.com` — the Kiro eligibility triad).

## Kiro `mcp.json`

```json
{ "mcpServers": { "squire-docs": { "type": "http", "url": "https://squiredocs.com/mcp", "disabled": false, "autoApprove": [] } } }
```

MUST NOT contain `oauth`/`oauthScopes` (DCR — FR-004). `url` is the drift-exempt endpoint field.

## Cursor `.cursor-plugin/plugin.json`

```json
{
  "name": "squire-docs",
  "displayName": "Squire Docs",
  "version": "1.0.0",
  "description": "…honest-confident, 'Squire Docs'…",
  "author": { "name": "Squire Docs", "email": "hello@squiredocs.com" },
  "homepage": "https://squiredocs.com",
  "repository": "https://github.com/squiredocs/squire-cursor-plugin",
  "license": "MIT",
  "keywords": ["spec","spec-driven","mcp","collaboration","design-docs"],
  "category": "Developer Tools"
}
```

Validates against the vendored schema: kebab `name` `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`, semver
`version`, no property outside the schema (`additionalProperties:false`).

## Cursor `mcp.json`

```json
{ "mcpServers": { "squire-docs": { "url": "https://squiredocs.com/mcp" } } }
```

Bare `url`, **NO `type` field**, no `auth` block (FR-011). `url` is the drift-exempt endpoint field.
The validator asserts the absence of `type` is correct here (and only here).

## Cursor `rules/squire-spec-loop.mdc`

```markdown
---
description: Use when working from a spec/design doc in this repo — keep the Squire Docs spec and the repo in sync (read before a run, write status back after).
alwaysApply: false
---
# Squire Docs spec loop
- Sync the repo's spec into its Squire Docs doc before a run if it changed.
- Read the spec from the doc at run start (it may carry human refinements not yet in the repo file).
- After implementing, write status + design decisions back: what shipped, what changed, what's open.
```

Agent-Requested: `description` non-empty, `alwaysApply:false`. Body consistent with `shared/skill.md`.

## Add-to-Cursor deeplink (both surfaces)

`cursor://anysphere.cursor-deeplink/mcp/install?name=squire-docs&config=eyJ1cmwiOiJodHRwczovL3NxdWlyZWRvY3MuY29tL21jcCJ9`

Byte-identical on landing + documentation; the string is the `cursorDeeplink()` output.

## Landing page (`client/public/landing.html` + `marketing.css`) — FR-027

The existing "Works with your coding agent" block (currently Claude-only) gains:
- **(a) Add to Cursor** control: an `<a href="…the exact deeplink…">` with one honest line — "connects
  the Squire Docs MCP server in Cursor; the full plugin arrives via the Cursor marketplace once listed".
- **(b) Kiro section**: links `https://github.com/squiredocs/squire-kiro-power` and gives the import
  steps verbatim: Kiro IDE → Powers panel → Add Custom Power → Import power from GitHub → paste repo
  URL → Install. **NO "Add to Kiro" button** and no implication one exists.
- Copy: honest-confident, "Squire Docs"; no claim of a listing that has not happened.

## Documentation (`documentation/agents-and-mcp.md`) — FR-028

Gains matching per-ecosystem install sections:
- **Cursor**: the deeplink (Add to Cursor) + what it installs (MCP server) + the marketplace note.
- **Kiro**: the power import steps + repo link — coexisting with the EXISTING manual Kiro `mcp.json`
  snippet (retained for config-file setup without the power; its server key stays `squire`).
- The documentation build + validation/terminology gates MUST pass.

## Cross-surface invariant (FR-029)

The deeplink string is byte-identical everywhere it appears (landing, documentation); a repo test
asserts each committed surface's deeplink equals the generator-computed `cursorDeeplink()` value —
the wave-1 cross-surface-drift rule extended to the deeplink.
