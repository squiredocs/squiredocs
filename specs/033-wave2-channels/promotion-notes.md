# Promotion notes — 033-wave2-channels (Kiro Power + Cursor plugin)

Wave-2 distribution channels built, generated, validated, and surfaced. **Nothing was
published** — pushing stays a Sam-only op behind `--publish` + configured remotes.
This file records the Sam-only ops, the owed orchestrator/merge-queue items, and the
tone-review candidacy of the new prose (FR-032/033/034).

## What shipped (all 24 tasks, T001–T024)

- New `distribution/kiro-power/` bundle (v1.0.0): `POWER.md` (frontmatter version carrier),
  `mcp.json` (DCR, `type:"http"`, no `oauth`), two Kiro-native steering files.
- New `distribution/cursor-plugin/` bundle (v1.0.0): `.cursor-plugin/plugin.json`
  (schema-valid), `mcp.json` (bare `url`, no `type`), `rules/squire-spec-loop.mdc`
  (Agent-Requested), `skills/squire/SKILL.md` (shared port), MIT `LICENSE`, `README.md`.
- `publish.mjs`: two new channel descriptors, the version-carrier generalization
  (`readVersion`/`versionCarrierRel` per channel, FR-017), the `cursorDeeplink()` helper,
  and the Kiro/Cursor/`.mdc` structural validators. `CHANNELS` is now length 4.
- Vendored `distribution/schemas/cursor-plugin.schema.json` + SOURCES.md entry.
- Always-run tests generalized/added: 4-channel drift + extra-file guard + per-channel
  prod-pin; deeplink round-trip; Kiro push + POWER.md-carrier version guard + unreadable
  carrier refusal; cross-surface deeplink byte-identity.
- Surfaces: landing page (Add-to-Cursor deeplink + Kiro repo-import steps, no fake button)
  and `documentation/agents-and-mcp.md` (per-ecosystem Cursor + Kiro sections; the existing
  manual Kiro `mcp.json` snippet, server key `squire`, is retained).

## Sam-only ops checklist (gates submission, NOT merge)

1. **Create the two public mirror repos**: `github.com/squiredocs/squire-kiro-power` and
   `github.com/squiredocs/squire-cursor-plugin` (generated-push targets; do not author in them).
2. **First mirror push** (prod-pinned, from repo root, both wave-2 env vars):
   ```
   SQUIRE_MIRROR_KIRO_POWER=git@github.com:squiredocs/squire-kiro-power.git \
   SQUIRE_MIRROR_CURSOR_PLUGIN=git@github.com:squiredocs/squire-cursor-plugin.git \
     node distribution/publish.mjs --publish
   ```
   (Wave-1 mirrors ride the same command via their own env vars if pushed together.)
3. **Create/alias `hello@squiredocs.com`** — used as the Cursor manifest author email and the
   POWER.md support contact. Only `security@squiredocs.com` is verified today; a monitored
   support contact is a Kiro submission eligibility requirement (RBD-3).
4. **Kiro Powers submission** (`kiro.dev/powers/submit`, browser form, manual review): first/last
   name, org, email, 3–4-word use case, the public repo URL, domain description; consent to the
   Publisher T&Cs. **Verify live DCR-OAuth against `https://squiredocs.com/mcp` in a real Kiro
   IDE** first — open Kiro OAuth bugs #9123/#9249 around pre-registered clientId/oauthScopes make
   this the one thing the dev-pod build could not prove (neither Kiro nor Cursor is installed here).
5. **Cursor marketplace submission** (`cursor.com/marketplace/publish`): plugins must be OSS
   (LICENSE ships), manual security review; current handoff is a public repo link to the Cursor
   team (Slack or `email`) — confirm whether it has moved to a self-serve portal.

## Owed orchestrator / merge-queue items

- **Design §3 amendment (owed).** `design/plugin-marketplace-publishing.md` §3 says the site gets
  "an 'Add to Kiro' button" — falsified by research (no embeddable `kiro://` deeplink exists; the
  button is registry-page-only). The site correctly ships repo-link + import steps (RBD-6). Amend
  the Squire design doc, then `node design/sync.mjs`. Design files are off-limits to this feature's
  agents (Principle VI + assignment), so this is orchestrator merge work.
- **Agent Surface / agents.md amendment (owed, RBD-8).** Adding Cursor/Kiro install paths to the
  served `agents.md` is an Agent-Surface-doc amendment, not this feature's surface. `agents.md` was
  deliberately left untouched.
- **`docs/dev.md` wave-2 touch (owed).** If the first-run/publish docs reference the channel count
  (now four) or the wave-1-only bundle list, refresh them. Off-limits to this feature's agents.
- **Channel-status ledger rows (owed).** Flip the design doc's "Kiro Powers" / "Cursor Marketplace"
  rows from "Not started" once acceptance/listing happens (orchestrator, post-submission).

## Content / tone-review candidacy (FR-034 — note, not a blocker)

- **Exact prose owed Sam's tone review.** The `POWER.md` body, both Kiro steering files, the Cursor
  `.mdc` rule, and both READMEs are new authored content constrained testably by the FRs; the exact
  wording is a candidate for Sam's later tone review (honest-confident, "Squire Docs"). Not a merge
  blocker (RBD-9).
- **`/squire:onboard` in the Cursor `skills/squire/SKILL.md`.** The Cursor skill is the shared
  `distribution/shared/skill.md` ported near-verbatim (FR-013), and `shared/skill.md` is READ-ONLY
  (FR-015). Its one parenthetical — "(First time in a repo, run `/squire:onboard` …)" — is a
  Claude-Code-plugin mechanic that rides along with the verbatim port; `/squire:onboard` is not a
  Cursor command. The Cursor-native onboarding lives in the `.mdc` rule and the README, which carry
  no Claude-plugin command refs. If this Claude-ism should be scrubbed from the Cursor skill, that
  needs a shared-content decision (edit `shared/skill.md`, which changes the wave-1 claude-plugin
  bytes too) — recorded here rather than resolved unilaterally.

## Verification performed (no publishing)

- `npm run test:first-run` → 29/29 (incl. 4-channel drift, deeplink round-trip, Kiro push +
  version-guard, cross-surface deeplink, unreadable-carrier refusal).
- Client `documentation-build` Vitest → 20/20 (terminology gate green).
- `npm run build` (vite + documentation + blog) → green.
- `node distribution/publish.mjs` dry-run → all four channels regenerate + validate; wave-1 bundle
  bytes byte-neutral (`git diff main` on the wave-1 dirs is empty).
- Publish path exercised in tests against LOCAL bare-repo fixtures only; real `SQUIRE_MIRROR_*`
  stripped; `--publish` never run against a real remote.
