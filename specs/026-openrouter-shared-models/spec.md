# Feature Specification: OpenRouter-Backed Shared Default Models (Kimi, Qwen, MiniMax, GLM)

**Feature Branch**: `026-openrouter-shared-models`

**Created**: 2026-07-21

**Status**: Draft

**Input**: User description: "Add the ability to set the following model families as the default model for the shared assistant. I will provide an OpenRouter key and we can route to them with that. They can be selected as the default in the admin area (currently limited to Gemini and Anthropic): Kimi, Qwen, MiniMax, GLM."

**Design ground truth**: `design/in-app-ai-assistant.md`, section "Models, providers, BYOK" (amended in commit c9b8c73). Key mandates restated: OpenRouter becomes a shared gateway via `OPENROUTER_API_KEY`; shared eligibility is **derived** (a provider can back the shared default exactly when its server key is configured — no separate allowlist); gateway model entries live in the model registry like any other model, with pricing/context read from OpenRouter's models API at authoring time and vision support declared per entry; BYOK semantics are unchanged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin selects a gateway model as the shared default (Priority: P1)

Sam (the admin/operator) provisions a shared OpenRouter key for the deployment. The admin area's "Default model" picker — today limited to Anthropic and Google models — now also offers a curated set of Kimi, Qwen, MiniMax, and GLM models routed through OpenRouter. Sam selects one; from that point, every non-BYOK user's assistant runs on that model, billed to the shared OpenRouter key and metered against the user's in-app credits exactly like Anthropic/Google shared usage.

**Why this priority**: This is the feature. Without it nothing else matters; with only this, the feature already delivers its full core value.

**Independent Test**: With `OPENROUTER_API_KEY` set, open the admin area, confirm the new models are listed, select one, send a chat message as a non-BYOK user, and verify the reply comes from the selected model and a metered usage row is recorded at that model's registry pricing.

**Acceptance Scenarios**:

1. **Given** `OPENROUTER_API_KEY` is configured, **When** the admin opens the shared-model settings, **Then** the eligible-model list includes the curated Kimi, Qwen, MiniMax, and OpenRouter-GLM entries alongside the existing Anthropic and Google models, grouped/labeled so the admin can tell which provider backs each option.
2. **Given** the admin selects a Kimi/Qwen/MiniMax/GLM entry, **When** the setting is saved, **Then** validation accepts it (its provider now has a server key) and the response reflects the new stored and effective keys.
3. **Given** a non-BYOK user with available credits, **When** they send a chat message after the admin set an OpenRouter-gateway default, **Then** the turn is served by the selected model via the shared OpenRouter key, and usage is metered from the registry pricing for that entry.
4. **Given** `OPENROUTER_API_KEY` is **not** configured, **When** the admin opens the shared-model settings, **Then** the gateway entries are simply absent (derived eligibility), and attempting to set one via the API is rejected with the existing "no shared server key" validation error.

---

### User Story 2 - Graceful degradation when the shared key is absent or removed (Priority: P2)

A deployment without the OpenRouter key (e.g. local dev before `.env` is updated, or prod before the secret is seeded) behaves exactly as today. If the key is later **removed** while an OpenRouter-gateway model is still the stored shared default, the assistant must keep working: resolution falls back to the deployment's env/built-in default rather than crashing, attempting unauthenticated provider calls as the steady state, or silently shifting cost anywhere it shouldn't go.

**Why this priority**: Sam will deploy the code before (or independently of) provisioning the key; the feature must be safe in every ordering of code-deploy and secret-provisioning, and safe to roll back by deleting the secret.

**Independent Test**: Set a gateway model as the shared default, unset `OPENROUTER_API_KEY`, restart, and verify: the picker no longer lists gateway models, the admin settings surface shows the true effective (fallback) model, and a non-BYOK chat turn succeeds on the fallback model.

**Acceptance Scenarios**:

1. **Given** no `OPENROUTER_API_KEY`, **When** any user or admin uses the app, **Then** behavior is byte-for-byte today's behavior: gateway models absent from the shared picker, shared traffic on Anthropic/Google as before.
2. **Given** a stored shared default whose provider has lost its server key, **When** a non-BYOK user sends a chat message, **Then** the request is served by the env-override default if set, else the built-in default — no crash, no user-visible auth error as the steady state, and no BYOK key is ever drafted in.
3. **Given** the same degraded state, **When** the admin opens shared-model settings, **Then** the effective model shown is the fallback actually being used (not the stored-but-unrunnable key), so the degradation is visible rather than silent.

---

### User Story 3 - BYOK users are untouched (Priority: P2)

A user with their own OpenRouter key continues to route through **their** key and account — never the new shared key — including for the newly added Kimi/Qwen/MiniMax models, which appear in their model picker under the OpenRouter group like the existing GLM entries. A user whose BYOK setup is broken still gets the loud `byok_misconfigured` rejection, never a silent fallback to the shared key.

**Why this priority**: The design doc names this invariant explicitly; violating it silently bills the operator for unmetered traffic.

**Independent Test**: With both the shared key and a user BYOK OpenRouter key configured, send a BYOK chat turn and verify the provider request used the user's key (and skipped metering); break the BYOK key reference and verify `byok_misconfigured` with no fallback.

**Acceptance Scenarios**:

1. **Given** a user with BYOK enabled on an OpenRouter model, **When** they chat, **Then** the request uses their stored key, is not metered, and ignores the shared key entirely.
2. **Given** BYOK enabled but the key/model unresolvable, **When** they chat, **Then** the request fails with `byok_misconfigured` — the presence of a shared OpenRouter key must not change this outcome.
3. **Given** the BYOK model picker, **When** the new entries are added, **Then** the OpenRouter group lists them alongside the GLM entries with labels that remain unambiguous (grouping by provider already disambiguates the duplicate GLM labels between z.ai and OpenRouter).

---

### User Story 4 - Image attachments behave honestly per model (Priority: P3)

Each new gateway entry declares whether it accepts images. On a vision-capable entry (per OpenRouter's declared input modalities), image attachments work. On a text-only entry, the existing honest-failure path applies: the UI gates attachments and the server pre-flight rejects with `model_no_image_support`; historical image parts in the transcript are replaced with placeholders rather than crashing the provider.

**Why this priority**: This is the guardrail that made GLM usable as a text-only model (chat image attachment fix, 2026-07-18); new text-only entries must ride it, and new vision entries must not be needlessly gated.

**Independent Test**: Attach an image on a vision-flagged entry (succeeds) and on a text-only entry (honest `model_no_image_support` gate); load a transcript containing images under a text-only shared default (no crash).

**Acceptance Scenarios**:

1. **Given** the shared default is a gateway entry flagged vision-capable, **When** a user sends an image attachment, **Then** the model receives and answers about the image.
2. **Given** the shared default is a text-only gateway entry, **When** a user tries to attach an image, **Then** the UI gate and server pre-flight reject it with the existing `model_no_image_support` error, and prior transcript image parts are replaced with placeholders on the outgoing request.

---

### Edge Cases

- **Shared OpenRouter key runs out of credits**: OpenRouter's 402 / "insufficient credits" shapes classify as `insufficient_credits`; because the turn is non-BYOK, the existing orchestration maps this to `provider_overloaded` for the user (they are never told to top up an account they don't own) and **notifies the operator** (012 D3). This must demonstrably hold for the openrouter provider, since Sam will run shared traffic on this key.
- **Key present but invalid/rotated-away at OpenRouter**: provider 401/403 classifies as `invalid_key` on a shared (non-BYOK) turn → internal + operator notify per the existing taxonomy. No new codes.
- **Env key added/removed without restart**: eligibility is read from the environment; the deployment's normal restart-on-config-change applies. The spec requires correctness after restart; hot-reload of env keys is out of scope.
- **Stored default references a registry key that a later release removed**: existing behavior (unknown key → built-in default with a logged warning) already covers it; unchanged.
- **Admin picker label collisions**: the OpenRouter GLM entries reuse the z.ai GLM labels; in the shared picker z.ai never appears (no server key), so no collision — but the picker must still communicate provider identity (grouping), both for clarity and to stay correct if labels ever overlap across eligible providers.
- **OpenRouter catalog drift**: model IDs, pricing, and context windows change over time. Registry entries snapshot the catalog at authoring time (the established convention); the existing `or-glm-*` entries have already drifted from the live catalog and are refreshed as part of this feature (FR-009).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (Shared gateway eligibility — derived, not listed)**: The OpenRouter provider MUST become eligible to back the shared default exactly by declaring its server key environment variable (`serverKeyEnv: 'OPENROUTER_API_KEY'` in `server/api/ai-providers.js`). No allowlist, feature flag, or admin toggle may be introduced: the existing derived mechanism (`hasServerKey` → admin picker filter → save-time validation) MUST be the only gate. The now-stale comments on the openrouter provider ("BYOK-only", "never a shared default", "the default client is never used to serve a shared default") MUST be rewritten to describe the new reality. The z.ai provider MUST remain BYOK-only (`serverKeyEnv: null`) and untouched.
- **FR-002 (Curated gateway model entries)**: The model registry (`MODEL_DEFS` in `server/api/chat-models.js`) MUST gain a small curated set of OpenRouter-routed entries for the Kimi (`moonshotai/*`), Qwen (`qwen/*`), and MiniMax (`minimax/*`) families — the flagship model per family plus at most one fast/alternate variant where it clearly makes sense — not the whole OpenRouter catalog. GLM is already covered by the existing `or-glm-*` entries and MUST NOT be duplicated. Exact model IDs, pricing (converted to the registry's cents-per-1M-tokens convention), and context windows MUST be read from OpenRouter's live models API (`https://openrouter.ai/api/v1/models`, unauthenticated) **at implementation time** and annotated with the authoring date, per the July-2026 convention the existing `or-glm-*` comments establish. The curated selection ratified by default (see ledger D1; re-verify against the live catalog at implementation time) is: `moonshotai/kimi-k3`, `qwen/qwen3.7-max`, `qwen/qwen3.7-plus`, `minimax/minimax-m3`.
- **FR-003 (Per-entry vision flags)**: openrouter is not a vision provider by default (`VISION_PROVIDERS`), so gateway entries default to text-only. Each new entry MUST declare `supportsImages: true` explicitly if and only if the live models API lists `image` among its input modalities **and** image input is verified working through the gateway during implementation (fail closed to text-only if not — ledger D5). Text-only entries MUST be verified (by test) to ride the existing honest-failure path: UI attachment gating, the server `model_no_image_support` pre-flight, and `replaceUnsupportedImageParts` for historical transcript images.
- **FR-004 (Admin picker behavior)**: The admin shared-default picker MUST include the gateway entries automatically whenever `OPENROUTER_API_KEY` is set (no picker code may hardcode providers or models), and MUST present eligible models grouped by provider (as the BYOK selector already does) so provider identity is visible; save-time validation remains the existing derived `hasServerKey` check. The BYOK model selector MUST NOT be degraded: new entries appear under its OpenRouter group with unambiguous presentation.
- **FR-005 (Graceful degradation of a stored-but-ineligible default)**: When the stored shared default's provider has no server key (e.g. `OPENROUTER_API_KEY` removed), non-BYOK model resolution MUST fall back gracefully — env override (`AI_CHAT_MODEL`) if set, else the built-in default — with a logged warning, instead of instantiating an unauthenticated client as the steady state. This fallback MUST NOT touch the BYOK path (a BYOK user's misconfiguration still fails loudly) and MUST NOT bill any BYOK key. The admin settings read endpoint MUST report the true effective model (the fallback actually in use), so degradation is visible in the admin UI.
- **FR-006 (Shared-key exhaustion stays an operator incident)**: The existing classification MUST demonstrably hold for the shared OpenRouter key: OpenRouter 402 / credit-exhaustion shapes classify as `insufficient_credits`, and on a non-BYOK turn the orchestration maps this to `provider_overloaded` for the user with operator notification (012 D3). This feature adds a test asserting that mapping for provider `openrouter` on a shared turn; the taxonomy, classifier, and orchestration code themselves are unchanged.
- **FR-007 (Metering unchanged)**: Shared (non-BYOK) usage on gateway models MUST be metered exactly like all shared usage — cache-aware token pricing from the registry entry into the usage log, quota/credit enforcement unchanged. BYOK requests continue to skip metering. No metering code changes are expected; a test MUST assert a shared gateway turn produces a usage row at the entry's registry pricing.
- **FR-008 (BYOK invariants preserved)**: A user's OpenRouter BYOK choice MUST continue to route through their own key (never the shared key), and `byok_misconfigured` MUST continue to reject loudly with no silent fallback to the shared key — explicitly re-asserted by test now that a shared OpenRouter key exists (the scenario the invariant was written for).
- **FR-009 (Refresh existing gateway entries)**: The existing `or-glm-*` entries' pricing and context windows MUST be refreshed from the same live models API read in FR-002 (observed drift: e.g. `or-glm-5` registry pricing/context no longer matches the live catalog), keeping one authoring-date convention across all gateway entries.
- **FR-010 (Scope guard)**: No database migration. No changes to the error taxonomy, chat streaming/transport, or orchestration beyond tests. The following are OFF-LIMITS to this feature (feature 025 owns them concurrently): `specs/025-durable-chat-errors/`, `server/api/chat.js`, `server/api/chat-store.js`, and client chat contexts/components. Expected touch set: `server/api/ai-providers.js`, `server/api/chat-models.js`, admin picker presentation (`client/src/pages/AdminPage.jsx`), and tests.

### Key Entities

- **Model registry entry**: key, provider, namespaced gateway model ID, label, pricing (cents per 1M tokens, in/out), context window, per-entry vision flag. Gateway entries are ordinary registry entries — nothing distinguishes them structurally.
- **Provider configuration**: per-provider key storage, server-key environment variable (the sole shared-eligibility signal), client factories, key validation, error classification, web-search strategy, capabilities.
- **Shared default model setting**: the admin-selected model key persisted in app settings (existing row, existing migration 1789000000000 — no schema change); resolution order BYOK choice → stored default → env override → built-in default.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the shared OpenRouter key configured, the admin sees Kimi, Qwen, MiniMax, and GLM models in the shared-default picker and can select any of them in one action; the selection persists and is reported back as both stored and effective.
- **SC-002**: After the admin selects a gateway model, a non-BYOK user's next chat turn is answered by that model and produces exactly one metered usage record priced from the registry entry; BYOK turns produce none.
- **SC-003**: Removing the shared key (and restarting) hides all gateway models from the picker and degrades a stored gateway default to the deployment's fallback model with zero failed user turns attributable to the missing key in the steady state, and the admin UI shows the true fallback in effect.
- **SC-004**: BYOK OpenRouter users' turns continue to bill their own account in all configurations, verified by tests asserting the shared key is never used on a BYOK turn and `byok_misconfigured` never falls back.
- **SC-005**: Shared-key credit exhaustion on OpenRouter surfaces to users as a temporary-unavailability message (never a top-up instruction) and notifies the operator, verified by test.
- **SC-006**: Image attachments succeed on vision-flagged gateway entries and are rejected with the existing honest error on text-only entries; transcripts containing images never crash a text-only gateway model.
- **SC-007**: A deployment that never sets the key behaves identically to today (full backward compatibility), verified by running the existing admin/model test suites with no key present.

## Assumptions

- OpenRouter's OpenAI-compatible chat-completions endpoint behaves the same under the shared key as under BYOK keys — the existing client factory, reasoning-content parsing, web-search wrapper, and error classifier are key-agnostic (the shared-client code path already exists; only eligibility changes).
- The curated model selection is a product call ratified by default in the ledger (D1); Sam can amend it before implementation. Family coverage (one flagship each) satisfies the verbatim request; breadth is deliberately not a goal.
- Pricing conversion convention: OpenRouter reports USD per token; registry stores cents per 1M tokens (multiply by 10^8). Authoring-time snapshot, not live pricing — consistent with every existing entry.
- Prompt caching, provider-executed web search, and reasoning-history stripping capabilities for openrouter remain as declared today; no capability changes ship with this feature.
- The admin picker grouping change is presentation-only; the settings API contract (modelKey/effectiveModelKey/models) is unchanged apart from the models list naturally growing.

## Dependencies & Deployment Notes (promotion notes)

- **Operator prerequisite (out of code scope, blocking go-live)**: Sam must provision `OPENROUTER_API_KEY` — in production via the SOPS-seeded secrets flow for the hardened cluster, and locally in `.env` — before the feature is user-visible. Until then the feature is dormant by design: gateway models simply don't appear (SC-007). Record this in the deploy checklist alongside the currently-owed deploy stack.
- Rollback is config-level: deleting the secret reverts the deployment to today's behavior (with FR-005 guaranteeing a stored gateway default degrades gracefully); no migration to unwind.
- The shared OpenRouter account needs credits; exhaustion pages the operator (FR-006) — treat the OpenRouter balance as an operational resource like the Anthropic/Google keys.

## Out of Scope

- Any OpenRouter catalog sync/automation (entries are authored snapshots, per design).
- New shared keys for other BYOK-only providers (OpenAI, z.ai stay BYOK-only).
- Changes to credits/quota policy, error taxonomy, chat streaming, or anything owned by feature 025.
- Hot-reload of environment keys without restart.
- Per-model admin pricing overrides or usage dashboards.
