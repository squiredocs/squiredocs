# Clarifications & Recorded Decisions — 026-openrouter-shared-models

No user interaction was available during specification. Per Constitution Principle VI
and Sam's pre-authorization (2026-07-21), each open product decision below was resolved
with the best default and recorded as RATIFIED-BY-DEFAULT. Overturn any of these by
amending the spec before planning/implementation.

---

## D1 — Curated model set: flagships plus one earning alternate (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: Sam named four families (Kimi, Qwen, MiniMax, GLM) but no specific models. Which exact OpenRouter entries ship?

**Why it matters**: The registry is a curated product surface, not a catalog mirror; every entry appears in the admin picker and the BYOK selector forever after.

**Default**: From the live OpenRouter catalog (verified 2026-07-21 against `https://openrouter.ai/api/v1/models`; re-verify at implementation time): `moonshotai/kimi-k3` (Kimi flagship, 1M context), `qwen/qwen3.7-max` (Qwen flagship), `qwen/qwen3.7-plus` (Qwen fast/vision alternate — cheaper, 1M context, image-capable), `minimax/minimax-m3` (MiniMax flagship, 1M context). GLM is already covered by the four existing `or-glm-*` entries — no additions.

**Rationale**: One flagship per family satisfies the verbatim request. Qwen earns the single alternate slot: `qwen3.7-plus` is meaningfully cheaper AND adds vision where the flagship is text-only — a real capability trade-off, not menu padding. Kimi's nearest alternates are a prior generation (`kimi-k2.6`) or code-specialized (`kimi-k2.7-code`); MiniMax has no current fast variant of m3 — neither "clearly makes sense" per the brief's bar, so they are omitted.

## D2 — Admin picker gains provider grouping (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: The admin shared-default picker is a flat `<select>` of bare labels (`AdminPage.jsx:258-270`). With three-plus providers and ~15 eligible models, and with the `or-glm-*` labels being bare family names ("GLM-5.2"), how should provider identity be communicated?

**Default**: Group options by provider (`<optgroup>`), reusing the exact pattern the BYOK selector already uses (`SettingsPage.jsx:273-283`). Model labels themselves are unchanged. The `modelLabel` fallback for the "Deployment default" line stays label-only (no ambiguity: it names one concrete effective model).

**Rationale**: A flat list of "GLM-5.2" next to "Claude Opus 4.8" hides that one is routed through a gateway billed differently; grouping is the established in-app convention for exactly this problem, costs one small presentation change, and future-proofs against genuine label collisions if another eligible provider ever overlaps names. No collision exists today in the shared picker (z.ai is filtered out by derived eligibility), and the BYOK selector is already collision-safe via its optgroups — verified, not degraded.

## D3 — Refresh drifted or-glm-* pricing/context in the same pass (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: The existing `or-glm-*` entries no longer match the live OpenRouter catalog (e.g. `or-glm-5`: registry 60/192 cents per 1M and 202,752 context vs. live 95/255 and 204,800 as of 2026-07-21). Refresh them here, or leave them frozen?

**Default**: Refresh them from the same implementation-time API read that authors the new entries (spec FR-009), updating the authoring-date comment.

**Rationale**: These entries are about to price real shared-key metering (they were BYOK-only when authored; drift only misbilled the user's own account, now it misbills Sam's credit ledger). One consistent authoring snapshot across all gateway entries is the design doc's stated convention.

## D4 — Stored-but-ineligible default must degrade in resolution, not just in the picker (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: Today, if a stored shared default's provider loses its server key, `resolveSharedDefaultKey` still returns the stored key and `resolveModel` happily instantiates a client with an undefined key — every non-BYOK turn then fails at the provider with an auth error. Acceptable, or must resolution itself degrade?

**Default**: Resolution must degrade (spec FR-005): a non-BYOK resolution whose stored key's provider fails the server-key check falls back env-override → built-in default, with a logged warning; the admin read endpoint reports the true effective (fallback) model. BYOK resolution is untouched.

**Rationale**: This state was previously unreachable in practice (Anthropic/Google keys are load-bearing for the whole deployment; the OpenRouter key is deliberately optional and removable as the feature's rollback path). "Delete the secret to roll back" is only a safe operator story if the stored default degrades instead of failing every shared turn. Silent-fallback concerns don't apply: this is the non-BYOK path falling back between two operator-funded defaults, the exact mirror of the existing unknown-key fallback one line below it.

## D5 — Vision flags: trust the catalog, verify live, fail closed (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: `kimi-k3`, `qwen3.7-plus`, and `minimax-m3` declare image input in the OpenRouter catalog. Enable `supportsImages: true` on them for shared traffic sight-unseen?

**Default**: Set `supportsImages: true` only where the catalog declares image input AND a live image round-trip through the gateway is verified during implementation; if verification fails for an entry, ship it text-only (riding the existing `model_no_image_support` gate + `replaceUnsupportedImageParts` path) and note it in the entry comment. `qwen3.7-max` and all `or-glm-*` entries stay text-only per catalog.

**Rationale**: The 2026-07-18 image-attachment incident (blank renders, GLM crashing on image parts) is exactly what an unverified vision flag causes. Text-only is the safe failure mode — honest error, no crash — so the flag is earned by verification, not by catalog metadata alone. Video/audio modalities in the catalog are ignored; the app only attaches images.

## D6 — Key provisioning is an operator step; the feature ships dormant (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: Sam said "I will provide an OpenRouter key" — sequencing between code deploy and key provisioning is unspecified.

**Default**: The feature ships fully dormant-safe: with no `OPENROUTER_API_KEY`, behavior is identical to today (SC-007), so code can deploy first in the currently-owed deploy stack. Go-live is the operator step recorded in the spec's promotion notes: seed the secret via the hardened cluster's SOPS flow for prod and `.env` locally, fund the OpenRouter account, then (optionally) select a gateway default in the admin area. Rollback = delete the secret (D4 makes that graceful).

**Rationale**: Derived eligibility makes any deploy/provision ordering safe by construction; encoding that as the plan avoids coupling the merge queue to a secret only Sam can mint.

## D7 — Admin shared-model response gains an additive `providers[]` field (RATIFIED-BY-DEFAULT, recorded at implementation 2026-07-21)

**Question / deviation**: The spec Assumptions call the picker-grouping change "presentation-only" and say the settings API contract is "unchanged apart from the models list naturally growing" (contract doc echoes this). Implementing the provider `<optgroup>` grouping (D2/FR-004) the way the BYOK selector already does it requires the client to know each eligible provider's *label*, which the `models` rows (id-only `provider`) don't carry. The chosen mechanism adds an additive `providers: [{ id, label }]` array to BOTH the GET and PUT `/settings/shared-model` responses, sourced from `listProviders()` filtered by `hasServerKey` — the same derivation `sharedDefaultModels()` uses.

**Default (deviation, ratified)**: KEEP the additive `providers[]` field. It is backward-compatible (no existing field changed or removed; unknown-field-tolerant consumers unaffected) and single-sources provider labels on the server rather than duplicating an id→label map in the client. This is a deliberate, minor deviation from the "contract unchanged" wording — recorded here rather than silently shipped. The research artifact (R5) flagged it as a LOW-severity wording inconsistency; this addendum ratifies it.

**Rationale**: Mirrors the BYOK selector exactly (`SettingsPage.jsx`), avoids a second source of truth for provider labels, and future-proofs against label collisions between eligible providers (the OpenRouter GLM entries reuse z.ai's bare "GLM-x" labels). The alternative — a hardcoded client-side provider map — was rejected as drift-prone and contrary to FR-004's "no hardcoded providers" spirit. Contract doc `contracts/admin-shared-model.md` already documents the field as `NEW (additive)`, so the two artifacts are consistent; only the spec Assumptions wording is superseded by this addendum.

## D1 addendum — Kimi K2 series added (RATIFIED by Sam's direct request, 2026-07-21)

Sam asked for "the Kimi 2 series as choices too" while testing the merged
feature. Added the current-generation K2 line from the same live catalog
source: or-kimi-k2.7-code (82/375), or-kimi-k2.6 (68.4/342), or-kimi-k2.5
(57/285), or-kimi-k2-thinking (60/250), all 262,144 context, all shipped
text-only per D5 (k2-thinking is text-only in the catalog; the rest carry
the go-live vision TODO). Older superseded snapshots (kimi-k2, kimi-k2-0905)
deliberately omitted — flag to Sam if he wants them as well. All four IDs
smoke-tested live on the shared key (5-token completion, OK).
