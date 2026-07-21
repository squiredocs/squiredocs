# Phase 0 Research — 026-openrouter-shared-models

All product-level unknowns were resolved as RATIFIED-BY-DEFAULT in
[clarifications-needed.md](./clarifications-needed.md) (D1–D6); this file records the *technical*
decisions and mechanism choices for implementation. No open `NEEDS CLARIFICATION` remains.

## R1 — Shared eligibility mechanism (FR-001)

**Decision**: Flip `serverKeyEnv: null` → `serverKeyEnv: 'OPENROUTER_API_KEY'` on the `openrouter`
block in `server/api/ai-providers.js` (~line 508) and rewrite the three stale comments
(~506–511: "No shared server key… never the shared default", "The default (no-BYOK) client is never
used to serve a shared default") to describe the new reality. Nothing else in the provider block
changes: `defaultClient` already reads `process.env.OPENROUTER_API_KEY` (~512), `createClient`,
`validateKey`, `buildWebSearch`, `classifyOpenRouterError`, and `capabilities` are all key-agnostic.

**Rationale**: `hasServerKey(id)` (~544) already gates on `cfg.serverKeyEnv && process.env[...]`; the
admin picker filter (`sharedDefaultModels()` in `admin.js` ~25) and the PUT save-time validation
(`admin.js` ~61) both derive off `hasServerKey`. Declaring the env var is therefore *sufficient and
sole* — no allowlist/flag/toggle, satisfying the design doc's "derived, never listed" mandate.

**Alternatives rejected**: An explicit allowlist or admin toggle (violates the design doc and
FR-001, adds a second source of truth); a per-model `sharedEligible` flag (redundant with provider
server-key derivation, invites drift).

**Invariant check**: z.ai stays `serverKeyEnv: null` (BYOK-only) and is untouched (FR-001).

## R2 — Curated gateway entries + pricing/context sourcing (FR-002, FR-009, D1, D3)

**Decision**: Add four curated entries to `MODEL_DEFS` in `chat-models.js` (D1, re-verify at
implementation time): `moonshotai/kimi-k3`, `qwen/qwen3.7-max`, `qwen/qwen3.7-plus`,
`minimax/minimax-m3`. GLM already covered by the four `or-glm-*` entries — no duplication. In the
**same pass**, refresh the four `or-glm-*` entries' pricing + context from the live catalog (FR-009,
D3: e.g. `or-glm-5` 60/192 & 202,752 → live 95/255 & 204,800 observed 2026-07-21) and update the
authoring-date comment so one snapshot date covers every gateway entry.

**Sourcing procedure (an implementation task, not done at plan time)**: `curl -s
https://openrouter.ai/api/v1/models` (unauthenticated — verified reachable, HTTP 200 on 2026-07-21).
For each entry read: exact `id`, `pricing.prompt`/`pricing.completion` (USD **per token**),
`context_length`, and `architecture.input_modalities`. Convert pricing to the registry convention —
**cents per 1M tokens = USD-per-token × 10^8** (assumption confirmed against existing entries). Stamp
the authoring date in the comment (July-2026 convention already established on the block).

**Rationale**: The spec forbids hardcoding numeric pricing at spec/plan time (they cannot be kept
true); values are an authoring-time snapshot read at implementation. Catalog reachability is
confirmed, so the task is executable in the worktree without a key.

**Alternatives rejected**: Live pricing lookup at request time (out of scope, design says snapshots);
catalog mirror of all Kimi/Qwen/MiniMax models (FR-002 says curated flagship+earning-alternate only).

## R3 — Per-entry vision flags, fail-closed (FR-003, D5)

**Decision**: `openrouter` is not in `VISION_PROVIDERS` (~70), so entries default text-only. Set
`supportsImages: true` on an entry **only if** the live catalog lists `image` in
`architecture.input_modalities` **AND** a live image round-trip through the gateway succeeds during
implementation. Candidates per catalog: `kimi-k3`, `qwen3.7-plus`, `minimax-m3`. `qwen3.7-max` and
all `or-glm-*` stay text-only. If live verification cannot be performed (no funded key at plan/merge
time), ship the entry **text-only** and record the deferral in the entry comment + promotion notes;
Sam performs the live round-trip at go-live before trusting a vision flag.

**Rationale**: The 2026-07-18 image-attachment incident is exactly what an unverified vision flag
causes (blank renders / provider crash on image parts). Text-only is the safe failure mode (honest
`model_no_image_support` gate + `replaceUnsupportedImageParts`), so the flag is *earned* by
verification. Video/audio modalities in the catalog are ignored — the app only attaches images.

**Deferral reality (promotion note)**: No funded shared OpenRouter key exists at plan time, so the
implementer likely cannot complete the live image round-trip in the worktree. Default action:
**ship all new entries text-only**, leave a clearly-commented TODO per candidate entry, and list
"flip vision flags after live round-trip" in the go-live checklist. This keeps the feature correct
and never over-promises vision. (This is the conservative reading of D5 for the parallel pipeline.)

## R4 — FR-005 resolution-degradation design (the load-bearing decision, D4)

**Problem**: Today `resolveSharedDefaultKey(storedKey)` (`chat-models.js` ~288) returns
`storedKey || AI_CHAT_MODEL || DEFAULT_MODEL_KEY` with **no eligibility check**. If a stored gateway
default's provider loses its server key (operator deletes `OPENROUTER_API_KEY` — the *rollback path*),
this returns the unrunnable stored key; `resolveModel` then instantiates an openai-compatible client
with an `undefined` key, and every non-BYOK turn fails at the provider with an auth error. The
fallback at `resolveChatModel` ~338 only catches an *unknown* key, not a *known-but-ineligible* one.

**Decision**: Add the eligibility check **inside `resolveSharedDefaultKey`** so both consumers fix in
one place:
1. `resolveChatModel` (non-BYOK path, ~334) — the actual serving resolution.
2. `admin.js` GET/PUT `effectiveModelKey` (~39, ~73) — the admin-visible effective model.

New logic (shape, not final code):
```
function resolveSharedDefaultKey(storedKey) {
  if (storedKey) {
    const def = MODEL_DEFS.find(d => d.key === storedKey);
    if (def && hasServerKey(def.provider)) return storedKey;      // eligible → use it
    // stored default is unknown OR its provider lost its server key → degrade
    console.warn(`[Chat] Stored shared default "${storedKey}" is ineligible `
      + `(unknown or provider "${def?.provider}" has no server key); falling back.`);
  }
  return process.env.AI_CHAT_MODEL || DEFAULT_MODEL_KEY;   // env override → built-in default
}
```
`chat-models.js` gains `hasServerKey` to its `require('./ai-providers')` import.

**Why here (not in `resolveChatModel`)**: `resolveSharedDefaultKey` is the single key-resolution
point already shared by serving and admin display; degrading here makes the admin UI show the *true*
fallback in effect (FR-005 / SC-003) for free, keeping the "degradation is visible, not silent"
guarantee. Placing it only in `resolveChatModel` would leave the admin GET reporting the stale,
unrunnable stored key.

**Safety invariants (verified against code)**:
- BYOK path is **untouched**: `resolveSharedDefaultKey` is only called on the non-BYOK branch
  (`resolveChatModel` ~334, after the `if (isByok && byokSettings)` block returns). A BYOK
  misconfiguration still returns `{ error: 'byok_misconfigured' }` and never reaches this function.
- No BYOK key is ever drafted in — the fallback is strictly between operator-funded defaults
  (`AI_CHAT_MODEL` / `claude-opus`), the exact mirror of the existing unknown-key fallback.
- The `AI_CHAT_MODEL` env override is itself trusted (operator-set); if it too were ineligible the
  built-in `DEFAULT_MODEL_KEY` (`claude-opus`, an always-load-bearing Anthropic key) is the terminal
  fallback. Not recursively re-validated — matches today's contract and avoids surprising loops.

**Alternatives rejected**: (a) degrade only in the picker (D4 explicitly rejects — every shared turn
would still fail at the provider); (b) a try/catch around the provider call to fall back on auth
error (turns a config problem into a per-request runtime cost + hides it from admin); (c) clear the
stored setting on key removal (a write with no trigger; the config can change out-of-band via env).

## R5 — Admin picker provider grouping (FR-004, D2)

**Decision**: Replace the flat `<select>` of bare labels in `AdminPage.jsx` (~258–270) with
provider `<optgroup>`s, mirroring the exact pattern `SettingsPage.jsx` (~273–283) uses for the BYOK
selector. To supply provider labels (the models list carries provider *id* but not label), extend the
admin shared-model endpoint response (`admin.js` GET & PUT) with an additive **`providers`** array of
`{ id, label }` for the eligible providers — built from `listProviders()` filtered by `hasServerKey`,
the same source `sharedDefaultModels()` already filters on. The client groups `models` by
`provider === p.id` under each `<optgroup label={p.label}>`. The "Deployment default" option and the
`modelLabel` fallback line stay label-only (names one concrete effective model — no ambiguity).

**Rationale**: Grouping is the established in-app convention for provider identity and future-proofs
against label collisions (the OpenRouter GLM entries reuse z.ai's bare "GLM-x" labels; z.ai is
filtered out of the *shared* picker today, but grouping keeps it correct if two eligible providers
ever overlap). Reusing `listProviders()` on the server keeps provider labels single-sourced rather
than duplicating an id→label map in the client.

**Contract note / spec tension (surfaced for analyze)**: The spec Assumptions say the settings API
contract is "unchanged apart from the models list naturally growing" and calls the grouping change
"presentation-only". Adding a `providers` array is an **additive, backward-compatible** server change
(existing fields untouched; unknown-field-tolerant consumers unaffected), but it is technically a
contract addition, mildly at odds with the "presentation-only" wording. Chosen deliberately: it
mirrors the BYOK selector precisely and avoids a duplicated client-side label map. Recorded as a
LOW-severity wording inconsistency in the analyze report; the alternative (derive labels client-side
from a hardcoded map) was rejected as a second source of truth for provider labels.

**Alternatives rejected**: hardcoding provider id→label in the client (drift risk, violates "no
hardcoded providers" spirit of FR-004); adding provider label onto each model row (denormalized,
larger payload, still needs client grouping logic).

## R6 — Shared-key error classification & metering & BYOK (FR-006, FR-007, FR-008) — tests only

**Decision**: No production code change to the classifier, taxonomy, orchestration, or metering.
`classifyOpenRouterError` (`ai-providers.js` ~373–380) already maps 402 / credit shapes →
`insufficient_credits`, 401/403 → `invalid_key`, 429/502/503 → `overloaded`. The non-BYOK
orchestration already maps a shared-turn `insufficient_credits` → `provider_overloaded` for the user
+ operator notify (012 D3), and metering already prices shared turns from the registry entry. This
feature adds **tests** asserting these hold for provider `openrouter` on a *shared* turn:
- FR-006: a shared-turn openrouter 402 → user sees `provider_overloaded`, operator notified.
- FR-007: a shared gateway turn writes exactly one `ai_usage_log` row at the entry's registry
  pricing; a BYOK turn writes none.
- FR-008: a BYOK openrouter turn uses the *user's* key (never `OPENROUTER_API_KEY`) and skips
  metering; a broken BYOK ref returns `byok_misconfigured` with **no** fallback even though a shared
  key now exists.

**Rationale**: The design doc names these as invariants; the presence of a shared OpenRouter key is
the exact scenario FR-008 was written for, so they must be *re-asserted by test*, not assumed. The
tests must live in `server/api/__tests__/` (NOT in the 025-owned `chat.js`/`chat-store.js` — assert
at the classifier / resolution / usage-log seam, or via existing chat test harness helpers that don't
require editing the fenced files).

**Fence check (FR-010)**: Verify during task execution that the metering/orchestration assertions can
be written against existing seams (`classifyProviderError`, `resolveChatModel`, the usage-log writer,
existing chat test helpers) **without editing** `chat.js` or `chat-store.js`. If a test genuinely
cannot be written without touching a fenced file, STOP and surface it (do not edit the fenced file).

## R7 — Deployment / dormancy (FR-010 scope guard, D6)

**Decision**: No migration, no taxonomy/transport change. Feature ships dormant-safe: with no
`OPENROUTER_API_KEY`, `hasServerKey('openrouter')` is false → gateway entries filtered out of the
shared picker, save-time validation rejects setting one, existing behavior is byte-for-byte today's
(SC-007). Code deploys first in the currently-owed deploy stack; go-live is Sam's operator step (seed
the SOPS secret in prod + `.env` locally, fund the account, optionally select a gateway default).
Rollback = delete the secret (FR-005 makes a stored gateway default degrade gracefully).

**Rationale**: Derived eligibility makes any deploy/provision ordering safe by construction — the
merge queue is never coupled to a secret only Sam can mint.
