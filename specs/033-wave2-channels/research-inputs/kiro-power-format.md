# Kiro Power format (researched 2026-07-22, cited)

Buildable spec for a **Kiro Power** publishing a **remote OAuth MCP** server (Squire Docs).
Sources: kiro.dev/docs/powers/create, /installation, /steering, /mcp/configuration,
kiro.dev/blog/introducing-remote-mcp, kiro.dev/powers/submit, github.com/kirodotdev/powers
(real `zapier` power).

## Artifact set (public GitHub repo → mirror `squiredocs/squire-kiro-power`)
```
POWER.md          # REQUIRED at repo root (install fails without it)
mcp.json          # optional — MCP server config
steering/         # optional — workflow guidance markdown (power-internal)
  <topic>.md
```

## POWER.md
YAML frontmatter (required fields, verbatim shape from docs + zapier power):
```yaml
---
name: "squire-docs"                 # internal id; changing it forces reinstall
displayName: "Squire Docs — collaborative specs"
description: "…one-liner…"
keywords: ["specs","spec-driven","kiro-specs","requirements","design","review","attribution","version-history","squire","docs"]   # ARRAY; trigger words that auto-load the power's context
author: "Squire Docs"
---
```
Body sections (recommended order, mirrors zapier POWER.md): Overview → When to Use This
Power → Onboarding (setup/validation, e.g. connect the MCP server / sk_sqd_ token) →
Available Steering Files → When to Load Steering Files (conditional mapping, e.g. "When
syncing a spec → load steering/specs-sync-workflow.md") → Available MCP Servers → MCP
Configuration → **License and Support** (REQUIRED for submission: license + privacy policy
link + support contact, for the power AND the Squire MCP server).

## mcp.json (remote streamable-HTTP)
Top-level `mcpServers`; remote entry uses `url` (no command/args). Real zapier example uses
`type: "http"`. Include it explicitly:
```json
{
  "mcpServers": {
    "squire-docs": {
      "type": "http",
      "url": "https://squiredocs.com/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```
- OAuth is AUTOMATIC (Kiro runs the browser flow against an OAuth-protected server).
- Squire supports **Dynamic Client Registration**, so OMIT the `oauth`/`oauthScopes` block —
  Kiro self-registers. (`oauth.clientId` is only needed for servers WITHOUT DCR; and there are
  open Kiro bugs #9123/#9249 around pre-registered clientId/oauthScopes — DCR is the safe path.)
- Sibling keys if ever needed: `headers`, `disabled`, `autoApprove`, `disabledTools`.

## steering/*.md (power-internal)
Plain markdown; loading is driven by the POWER.md "When to Load Steering Files" mapping.
(The `inclusion: always|fileMatch|manual|auto` + `fileMatchPattern` frontmatter is the KIRO
WORKSPACE steering spec for `.kiro/steering/*.md`; for power-internal files prefer the
POWER.md-mapping approach. A `fileMatch` on `.kiro/specs/**` is the natural trigger if used.)
Reframe our shared coaching Kiro-native: hosting the `.kiro/specs` files Kiro users already
generate, made a shared/attributed/two-way-synced Squire Docs doc.

## "Add to Kiro" — NONE embeddable
No documented public deeplink / `kiro://` scheme for third-party sites. The "Add to Kiro"
button exists ONLY on kiro.dev/powers registry pages. Website install path = link to the
GitHub repo + instructions: Kiro IDE → Powers panel → Add Custom Power → Import power from
GitHub → paste repo URL → Install. (So the SITE surface is repo-link + copy-paste steps, not
a magic button — until/unless accepted into the registry.)

## Submission (kiro.dev/powers/submit) — SAM OP, browser form, manual review
Form fields: first/last name, org (opt), email, 3–4 word use-case, PUBLIC GitHub repo URL,
domain description. Eligibility: complete+tested+working; unique; integrated MCP servers NOT
in beta/preview; docs include license + privacy policy + support contact; consent to Kiro
Powers Publisher T&Cs. Not scriptable, no API/manifest.

## Uncertain (flagged): power-internal steering dir mapping details; whether power-internal
steering honors `inclusion` frontmatter; live DCR success against squiredocs.com/mcp in Kiro
IDE (open OAuth bugs) — verify in a real Kiro test at some point. No kiro:// deeplink confirmed.
