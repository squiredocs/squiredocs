# Promotion / Deploy Notes — 026-openrouter-shared-models

The code change is dormant-safe (SC-007): with no `OPENROUTER_API_KEY`, behavior is
byte-for-byte today's. Everything below is the OPERATOR go-live sequence, out of code
scope, to be folded into the currently-owed deploy stack by the merge/deploy owner
(README / docs/dev.md doc-sync happens in the merge queue — this agent does not edit
those files).

## What shipped in code (026)

- OpenRouter is now eligible to back the shared-assistant default: `serverKeyEnv:
  'OPENROUTER_API_KEY'` on the openrouter provider block (FR-001). z.ai stays
  BYOK-only (`serverKeyEnv: null`).
- Four curated gateway registry entries (FR-002/D1), authoring snapshot 2026-07-21
  from `https://openrouter.ai/api/v1/models` (unauthenticated). All ship **text-only**.
- The four existing `or-glm-*` entries' pricing + context refreshed from the same
  snapshot (FR-009/D3).
- Graceful degradation of a stored-but-ineligible shared default (FR-005/D4) — the
  rollback path — plus the U2 guard on the `AI_CHAT_MODEL` env override.
- Admin picker now groups eligible models by provider `<optgroup>` (FR-004/D2), fed by
  the additive `providers[]` field on the admin shared-model endpoint (see D7 in
  clarifications-needed.md).

## Live catalog snapshot used (2026-07-21, cents per 1M = catalog USD/token × 10^8)

| Registry key | modelId | input ¢/1M | output ¢/1M | context | catalog modalities | shipped vision |
|---|---|---|---|---|---|---|
| or-kimi-k3 | moonshotai/kimi-k3 | 300 | 1500 | 1,048,576 | text, image | text-only (deferred) |
| or-qwen3.7-max | qwen/qwen3.7-max | 147.5 | 442.5 | 1,000,000 | text | text-only |
| or-qwen3.7-plus | qwen/qwen3.7-plus | 32 | 128 | 1,000,000 | text, image | text-only (deferred) |
| or-minimax-m3 | minimax/minimax-m3 | 30 | 120 | 1,048,576 | text, image, video | text-only (deferred) |
| or-glm-4.6 | z-ai/glm-4.6 | 50 | 200 | 202,752 | text | text-only |
| or-glm-4.7 | z-ai/glm-4.7 | 40 | 175 | 202,752 | text | text-only |
| or-glm-5 | z-ai/glm-5 | 95 | 255 | 204,800 | text | text-only |
| or-glm-5.2 | z-ai/glm-5.2 | 80.36 | 252.56 | 1,048,576 | text | text-only |

`or-glm-*` drift refreshed off this read: glm-4.6 43/174→50/200; glm-4.7 40/175 (same);
glm-5 60/192 & 202,752→95/255 & 204,800; glm-5.2 93/300→80.36/252.56 (context unchanged).

## Go-live checklist (operator — Sam)

1. **Seed `OPENROUTER_API_KEY`** — prod via the hardened-cluster SOPS-seeded secrets
   flow; local in `.env`. Requires a restart (env eligibility is read at process start;
   hot-reload is out of scope). Until seeded, gateway models simply do not appear.
2. **Fund the OpenRouter account.** The shared balance is an operational resource like
   the Anthropic/Google keys — exhaustion pages the operator (FR-006/SC-005: users see a
   temporary-unavailability message, never a top-up prompt).
3. **(Optional) Select a gateway default** in the admin area's shared-model picker (now
   grouped by provider).
4. **DEFERRED — vision flags (C1 / SC-006 vision-success clause):** `or-kimi-k3`,
   `or-qwen3.7-plus`, and `or-minimax-m3` declare `image` input in the live catalog, but
   they shipped **text-only** because there was no funded shared key to verify a live
   image round-trip through the gateway (D5, fail-closed). **SC-006's vision-success
   clause is deferred to go-live.** Before flipping any `supportsImages: true`:
   - perform a live image round-trip through the gateway on that specific entry with the
     funded key, then set `supportsImages: true` on it in `chat-models.js` (remove the
     per-entry `// TODO(go-live)` comment). `or-qwen3.7-max` and all `or-glm-*` stay
     text-only per catalog. The text-only honest path (SC-006's rejection + placeholder
     clauses) is already verified by test today and needs no key.

## Rollback

Delete the `OPENROUTER_API_KEY` secret and restart. FR-005/D4 makes a stored gateway
default degrade to the env/built-in default with a logged warning — no failed user
turns, no migration to unwind. The admin UI shows the true fallback in effect.

## Post-merge review dispositions (2026-07-21)

Review of d062285 + bb39861 (Fable, read-only): lenses 1-4 and 6 CLEAN
(access control, degradation guard, registry data vs the catalog snapshot,
behavior invariants, test substance — the chat-models-byok.test.js edit
confirmed a legitimate re-pin). Two LOW findings, both FIXED same day:

- LOW-1 (AdminPage.jsx picker): a stored default whose provider key was
  removed rendered as a blank select and the promotion-notes rollback claim
  ("admin UI shows the true fallback") was unmet. Fixed: the picker now
  renders a disabled option — "<key> (unavailable — using <effective>)".
- LOW-2 (admin.test.js T014): fallback assertion depended on ambient
  AI_CHAT_MODEL. Fixed: the 026 describe now saves/deletes/restores
  AI_CHAT_MODEL and asserts the DEFAULT_MODEL_KEY constant directly.

## Go-live progress (2026-07-21)

- OPENROUTER_API_KEY seeded into the local dev .env (gitignored) from the
  key Sam provided; validated against openrouter.ai/api/v1/key — paid tier
  (is_free_tier: false), no spend limit, usage 0. The /tmp copy was removed.
- Verified locally: hasServerKey('openrouter') true; all 8 or-* entries
  shared-eligible.
- STILL OWED: prod secret via the hardened cluster's SOPS flow + deploy;
  optional supportsImages flips after a live vision round-trip.
