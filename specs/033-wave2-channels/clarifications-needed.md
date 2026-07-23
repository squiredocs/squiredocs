# Clarifications ledger — 033-wave2-channels (spec phase)

Per the parallel-agent rules: no user interaction; each open product decision got the best
default and is recorded here as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22)**.
Overturn any of these by amending the spec before plan/implement consumes it.

## RATIFIED-BY-DEFAULT decisions

1. **Bundle + server naming: `squire-docs`** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22).
   Both new channels use `squire-docs` as the power/plugin `name`, the `mcpServers` key, and the
   deeplink `name` parameter — per the cited examples in both research-inputs files. The Claude
   channel's `squire` key is bound to `/squire:...` namespacing and the agents.md one-liner;
   neither constraint exists on Kiro/Cursor, and `squire-docs` matches the product-name standard
   more closely for storefront listings. Consequence: the docs' existing manual Kiro snippet
   (server key `squire`) stays as-is — the key is a user-local label; both paths work.

2. **Kiro channel version carrier: `version:` in POWER.md frontmatter, fallback `VERSION` file** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22). Kiro documents no version field and the
   power has no JSON manifest, but the publish version-bump guard needs a machine-readable
   version inside the bundle. Default: an extra `version:` frontmatter key (starting 1.0.0).
   Risk: undocumented frontmatter key; if a real Kiro import rejects it, the descriptor switches
   to a bundle-root `VERSION` file (guard reads whatever the descriptor declares — FR-017).

3. **Public support/author contact: `hello@squiredocs.com`** — RATIFIED-BY-DEFAULT (Sam
   pre-authorized, 2026-07-22). Used in POWER.md's License and Support section and as the Cursor
   manifest author email. Only `security@squiredocs.com` is verified to exist today, and a
   monitored support contact is a Kiro submission eligibility requirement — so creating/aliasing
   the mailbox is a hard item on the Sam ops checklist, gating submission (not merge).

4. **License: MIT for both bundles; copy distinguishes bundle from service** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-22). Matches wave 1's shipped LICENSE and satisfies Cursor's
   plugins-must-be-OSS rule. The POWER.md License section says the power itself is MIT while the
   hosted Squire Docs service is a paid product — honest, and consistent with the recorded
   self-host-is-paid/not-open-source stance.

5. **No Cursor `commands/` directory in v1** — RATIFIED-BY-DEFAULT (Sam pre-authorized,
   2026-07-22). Research notes `commands/` is optional and onboard.md "could be a command", but
   Cursor command semantics are untested by us and the onboarding value is carried by the README +
   skill + rule. Deferred to a follow-on bump once a real Cursor walk validates the bundle.

6. **Site Kiro surface is repo-link + import steps, no button** — RATIFIED-BY-DEFAULT (Sam
   pre-authorized, 2026-07-22). Research proves no embeddable Add-to-Kiro deeplink exists (the
   button is registry-page-only), falsifying the design §3 phrase "with an 'Add to Kiro' button on
   our site". The site ships the honest path: repo link + Powers panel → Add Custom Power →
   Import from GitHub steps. Design amendment owed (orchestrator) — see spec Flagged Gaps #1.

7. **Steering file split decided at plan time within FR-005/006/007 constraints** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22). The spec constrains content (standing
   loop, byte channel, token rules, Kiro-native onboarding prose, POWER.md-mapping-driven
   loading) but not the file count/names; the plan picks the split (working default: one
   sync-workflow steering file + one working-with-Squire-Docs steering file).

8. **agents.md untouched** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22). The Agent
   Surface (MCP) doc owns agents.md's contract; adding Cursor/Kiro paths there is an Agent
   Surface amendment (orchestrator), not silent drift from this feature. This feature's surfaces
   are landing.html + marketing.css + documentation/agents-and-mcp.md only, per assignment.

9. **Exact prose authored at implement time; Sam tone review is a promotion note** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22). POWER.md body, steering, the .mdc rule,
   READMEs, and site copy are new authored content constrained testably by FR-002..FR-014,
   FR-027..FR-031; the exact wording is a candidate for Sam's later tone review, recorded in
   promotion notes, never a merge blocker (FR-034).

## Flagged design/reality gaps (not decisions — need orchestrator/Sam follow-up)

- Design §3 "Add to Kiro button on our site" is falsified by research → design amendment owed.
- Kiro power-internal steering semantics partially undocumented; live DCR OAuth in Kiro IDE
  unverified (open Kiro bugs #9123/#9249) → Sam's pre-submission walk is the verification.
- Cursor submission path (email/Slack vs self-serve portal) possibly stale → confirm at submission.
- Channel-status ledger rows (design doc) updated by orchestrator after acceptance.
