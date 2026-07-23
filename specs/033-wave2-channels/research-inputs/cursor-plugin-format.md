# Cursor plugin/marketplace format (researched 2026-07-22, cited)

Cursor 2.5 (2026-02-17) shipped a REAL plugin marketplace. A plugin = bundle of
rules + skills + MCP (+ optional agents/commands/hooks) with a manifest. Ground truth:
github.com/cursor/plugins (JSON schemas) + github.com/cursor/plugin-template.
Sources: cursor.com/docs/plugins, /mcp, /mcp/install-links, /context/rules,
cursor.com/marketplace/publish, cursor.com/blog/marketplace, cursor.com/marketplace-publisher-terms.

## Artifact set (public GitHub repo → mirror `squiredocs/squire-cursor-plugin`; plugin at repo root)
```
.cursor-plugin/
  plugin.json        # REQUIRED manifest
rules/
  squire-spec-loop.mdc   # coaching "standing loop" reframed as a rule
skills/
  squire/SKILL.md    # from distribution/shared/skill.md (frontmatter already valid)
mcp.json             # remote Squire MCP (filename must be exactly mcp.json)
LICENSE              # REQUIRED — plugins must be open source
README.md
```
(Components auto-discovered from default dirs rules/, skills/, and mcp.json; glob fields in
plugin.json are optional overrides.) commands/ optional (onboard.md could be a command).

## plugin.json (schema: cursor/plugins/schemas/plugin.schema.json, draft-07, additionalProperties:false)
Only `name` required. Fields: name (req, kebab `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`), displayName,
description, version (semver), author {name(req), email}, publisher, homepage(uri),
repository(uri), license (SPDX id), logo, keywords[], category, tags[], commands, agents,
skills, rules, hooks, mcpServers (path|object|array).
```json
{
  "name": "squire-docs",
  "displayName": "Squire Docs",
  "version": "1.0.0",
  "description": "The durable, attributed spec layer for agentic development — two-way sync between your repo's spec files and a live Squire Docs document.",
  "author": { "name": "Squire Docs", "email": "hello@squiredocs.com" },
  "homepage": "https://squiredocs.com",
  "repository": "https://github.com/squiredocs/squire-cursor-plugin",
  "license": "MIT",
  "keywords": ["spec","spec-driven","mcp","collaboration","design-docs"],
  "category": "Developer Tools"
}
```

## mcp.json (remote streamable-HTTP; NO `type` field in Cursor — bare `url` = remote)
```json
{ "mcpServers": { "squire-docs": { "url": "https://squiredocs.com/mcp" } } }
```
DCR (Squire has it) → Cursor runs browser OAuth automatically, stores token, no secret in file.
(An `auth` block with CLIENT_ID is ONLY for providers WITHOUT DCR — NOT needed for Squire.)

## Add-to-Cursor deeplink (SCRIPTABLE — base64 of the inner server object)
```
cursor://anysphere.cursor-deeplink/mcp/install?name=squire-docs&config=<BASE64({"url":"https://squiredocs.com/mcp"})>
```
For `{"url":"https://squiredocs.com/mcp"}` the base64 is `eyJ1cmwiOiJodHRwczovL3NxdWlyZWRvY3MuY29tL21jcCJ9`.
This is the lightweight MCP-only on-ramp for the SITE (an "Add to Cursor" button). publish.mjs
or the site can compute it from the same PROD endpoint constant.

## rules/*.mdc (frontmatter: alwaysApply bool, description string, globs comma-separated)
Reframe skill.md's standing loop as an **Agent Requested** rule (description set, alwaysApply:false):
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
skills/squire/SKILL.md = distribution/shared/skill.md near-verbatim (its frontmatter is valid).

## Submission (cursor.com/marketplace/publish) — SAM OP
Plugins must be OSS; MANUAL security review before listing. Current handoff per the official
template checklist: a PUBLIC repo link sent to the Cursor team (Slack or email)
+ the publish page. Pre-submission linter is scriptable: `node scripts/validate-template.mjs`
(from cursor/plugin-template) — we should replicate its checks (kebab name, frontmatter presence,
path integrity, manifest schema).

## Gated/uncertain (flagged): exact publish-portal form fields, the security-review rubric/SLA
and "verified" criteria (not public); whether submission moved from email/Slack to self-serve
(template still says email/Slack — treat as current).
