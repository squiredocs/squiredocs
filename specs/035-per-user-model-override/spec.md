# Feature Specification: Per-User Chat Model Override

**Feature Branch**: `035-per-user-model-override`

**Created**: 2026-07-26

**Status**: Draft

**Input**: User description: "The ability through the admin interface to set the model for each user. Everyone will default to the default model, whatever that currently is at the time, but I can override that for specific users by selecting another model for them."

**Design ground truth**: `design/in-app-ai-assistant.md` — the amended "Model resolution" sentence and the "Per-user model override (035)" paragraph in the Models/providers/BYOK section; plus `design/authentication-and-sharing.md` — Admin area capabilities list (constitution Principle VI). Where this spec and those documents disagree, the design docs win; gaps found while writing this spec are flagged in `clarifications-needed.md`, never resolved silently.

## Background

Every user of the shared (non-BYOK) in-app assistant currently runs on one global model: the admin-selected shared default, with deployment/built-in fallbacks behind it. There is no way to give a single user a different model — to route a heavy user onto a cheaper model, trial a new gateway model with one account before making it the default, or park a problem account on a smaller model — without changing the model for everyone at once.

This feature adds an admin-set, per-user override slot to the model resolution chain. Every account starts (and stays, unless touched) on the shared default *dynamically* — when the admin changes the shared default, every non-overridden user follows it immediately; the override is never a snapshot. For a specific user the admin can pin a different model from the same eligible set the shared-default picker offers. The override applies only to the shared server-key path: a user's active BYOK choice always wins (they are billing their own key), and a misconfigured BYOK setup still fails loudly rather than falling back to any shared key. The affected user is never shown that an override exists.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin pins a model for one user (Priority: P1)

The admin opens the admin user list, expands a specific user's row, and selects a model for that user from a picker offering the same models the shared-default picker offers. From that user's next assistant conversation turn onward, their assistant runs on the pinned model — while every other user continues on the shared default. The user's experience is otherwise unchanged: same credits, same limits, no visible indication that anything was pinned.

**Why this priority**: This is the entire feature — the ability to route one user onto a different model without touching anyone else. Includes the storage, the resolution-chain insertion, the admin API, and the admin picker.

**Independent Test**: As admin, pin a non-default model for user A. A's next assistant turn runs on the pinned model (observable in server logs/usage records); user B's turn still runs on the shared default. A non-admin request to the same management endpoint is rejected.

**Acceptance Scenarios**:

1. **Given** a user with no override on the shared-key path, **When** the admin selects a model for that user from the per-user picker, **Then** the choice is saved and that user's next assistant turn uses the selected model.
2. **Given** a user with an override set, **When** any other user starts an assistant turn, **Then** the other user still gets the shared default — the override affects only the one account.
3. **Given** the admin per-user picker, **When** it is opened, **Then** it offers exactly the models eligible to back the shared default (same derived rule as the shared-default picker: known model whose provider has a shared server key), plus a "Default" choice.
4. **Given** an attempt to store a model key that is unknown or not eligible for the shared-key path, **When** the admin management endpoint receives it, **Then** the request is rejected with a clear error and nothing is stored.
5. **Given** a non-admin authenticated user (or an unauthenticated caller), **When** they call the per-user override management endpoint, **Then** the request is denied and no override is read or changed.
6. **Given** a user with an override, **When** that user uses the assistant, **Then** nothing in their experience (settings, chat UI, API responses available to them) discloses that an override exists or which model was pinned.

---

### User Story 2 - Everyone defaults to the default, dynamically (Priority: P2)

A user with no override simply follows the shared default — and keeps following it as the admin changes the shared default over time. When the admin clears a previously set override ("Default" in the picker), that user immediately rejoins the shared default, including any changes made to it while the override was in place.

**Why this priority**: "Everyone will default to the default model, whatever that currently is at the time" is the stated contract; the clear path is what makes the override reversible and safe to use.

**Independent Test**: With no override set, change the shared default and confirm the user's next turn follows it. Pin an override, change the shared default again, clear the override — the user's next turn runs on the *new* shared default, not the one in force when the override was set.

**Acceptance Scenarios**:

1. **Given** a user with no override, **When** the admin changes the shared default model, **Then** the user's next assistant turn uses the new shared default — no per-user action needed.
2. **Given** a user with an override set, **When** the admin changes the shared default, **Then** the overridden user is unaffected and continues on their pinned model.
3. **Given** a user with an override set, **When** the admin clears it (selects "Default"), **Then** the user's next assistant turn uses whatever the shared default resolves to at that moment.
4. **Given** all existing accounts at the moment this feature ships, **When** the feature is deployed, **Then** every account behaves exactly as before: no override, following the shared default dynamically.

---

### User Story 3 - The override never breaks a chat and never touches BYOK (Priority: P3)

The override is a routing preference, not a failure mode. A user whose BYOK is active keeps using their own key and chosen model — the override lies dormant. A user whose BYOK is misconfigured still gets the loud BYOK-misconfiguration error, never a silent fallback onto any shared key. And if a stored override goes stale — the model was removed from the registry, or its provider's shared key was withdrawn from the deployment — the user's chat quietly falls back to the shared default (with a server-side log for the operator) instead of failing.

**Why this priority**: Guardrails on an admin convenience feature. Nothing here is user-visible when things are healthy, but each rail prevents a regression of a hard-won invariant (BYOK isolation, graceful shared-path degradation).

**Independent Test**: Pin an override for a BYOK-active user and confirm their turns still run on their own key/model; break their BYOK config and confirm the misconfiguration error still surfaces (no shared fallback). Separately, store a valid override, then make it ineligible (remove the provider's shared key in a test environment); the user's next turn runs on the shared default and a warning is logged.

**Acceptance Scenarios**:

1. **Given** a user with active BYOK and a stored override, **When** they use the assistant, **Then** their own BYOK model and key are used; the override has no effect.
2. **Given** a user whose BYOK is enabled but misconfigured, **When** they use the assistant, **Then** they receive the existing BYOK-misconfiguration error; neither their override nor the shared default is used, and nothing is billed to the shared key.
3. **Given** a stored override that is no longer eligible (unknown model key, or its provider no longer has a shared server key), **When** the user starts an assistant turn, **Then** the turn proceeds on the shared default and the fallback is logged server-side; the chat never fails because of the override.
4. **Given** a BYOK-active user with a dormant override, **When** that user later disables BYOK, **Then** their next shared-path turn uses the pinned override.

---

### Edge Cases

- Admin sets an override for a user mid-conversation: the override takes effect on the user's next turn; in-flight turns finish on the model they started with.
- The pinned model equals the current shared default: allowed and meaningful — the user is now pinned and will *not* follow future shared-default changes until cleared.
- A stored override becomes ineligible and later becomes eligible again (e.g. the provider's shared key is restored): the stored value is never auto-cleared, so the override simply resumes working — fallback is dynamic, per turn.
- The admin views a user whose stored override is currently ineligible: the admin UI shows the stored value flagged as unavailable (and what the user is actually getting), mirroring how the shared-default picker presents an unavailable stored default — it does not silently display "Default".
- Admin sets an override on their own account: allowed; no special-casing.
- Concurrent admin edits to the same user's override: last write wins; the management endpoint returns the stored state so the UI can reconcile.
- User deletion: the override is part of the user record and disappears with it; no orphaned state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each user account MUST carry an optional per-user chat model override — a single model key or empty. Empty is the universal default: all pre-existing accounts and all newly created accounts have no override.
- **FR-002**: The assistant's model resolution for a turn MUST follow this precedence: active BYOK choice → admin-set per-user override → admin-set shared default → deployment default → built-in default.
- **FR-003**: The override MUST apply only to the shared server-key path. A user's active BYOK configuration always wins, and a misconfigured BYOK setup MUST continue to fail with the existing loud BYOK-misconfiguration error — it MUST NOT fall back to the per-user override or any shared key.
- **FR-004**: A user with no override MUST follow the shared default *dynamically*: every change to the shared default (or its downstream fallbacks) applies to them on their next turn. The system MUST NOT snapshot the default onto user accounts.
- **FR-005**: Override eligibility MUST be the same derived rule used by the shared-default picker: a known registry model whose provider has a configured shared server key. There is no separate per-user eligibility list to maintain.
- **FR-006**: At resolution time, a stored override that is unknown or currently ineligible MUST be skipped with a server-side warning log, and the turn MUST proceed on the shared-default resolution — a stale override never fails a chat and is never silently persisted away (it may become valid again).
- **FR-007**: The admin API MUST allow setting a user's override to a specific model key and clearing it. Setting MUST validate the key at write time against the same eligibility rule (FR-005) and reject unknown or ineligible keys with a clear error; clearing MUST return the user to the default (FR-004).
- **FR-008**: All per-user override management surfaces (read and write) MUST be admin-only, enforced with the same admin gate as the rest of the admin API; non-admin and unauthenticated requests MUST be denied.
- **FR-009**: The admin user list MUST present a per-user model picker (in the per-user detail/expanded area) offering the eligible model set from FR-005 plus a "Default" choice representing no override; a user with no override displays as "Default".
- **FR-010**: When a stored override is currently ineligible, the admin UI MUST surface that state (stored value shown as unavailable, with the effective outcome) rather than misrepresenting the user as on "Default".
- **FR-011**: The override MUST NOT be visible to the user it applies to: no non-admin page, setting, API response, or assistant behavior may disclose that an override exists or which model was pinned. (Existing user-visible BYOK surfaces are unchanged.)
- **FR-012**: An override change (set or clear) MUST take effect from the affected user's next assistant turn, without requiring the user to re-login or the service to restart.
- **FR-013**: The override MUST affect only the user's main assistant chat model. Auxiliary model uses (conversation compaction, search-chunk contextualization, thinking summaries) are separately fixed and MUST remain unaffected.
- **FR-014**: Credit metering and quotas MUST be unchanged: an overridden user's shared-path turns are metered and priced exactly as any shared-path turn on the resolved model; BYOK turns continue to skip metering.
- **FR-015**: The admin MUST be able to set or clear an override for a user whose BYOK is currently active; the override is simply dormant (FR-003) until BYOK is inactive.

### Key Entities

- **User account — chat model override**: a new optional attribute on the user record (`users.chat_model_override`, nullable model key per the design doc). NULL means "follow the shared default dynamically". Deleted with the account.
- **Model registry entry**: an existing catalog entry (key, provider, label). The override stores only the key; eligibility is derived from the entry's provider having a shared server key — never duplicated per user.
- **Shared default setting**: the existing admin-selected app-wide default. Unchanged by this feature; the override slots immediately above it in precedence.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The admin can pin a model for a specific user in under 30 seconds from opening the admin area, with no tooling beyond the admin UI.
- **SC-002**: 100% of assistant turns by an overridden (non-BYOK) user run on the pinned model while it is eligible; 100% of turns by non-overridden users are unaffected.
- **SC-003**: After clearing an override, the user's very next turn follows the current shared default — including shared-default changes made while the override was in force.
- **SC-004**: Zero chats fail due to override state: with a stale/ineligible override stored, turns succeed on the shared default and each fallback is visible to the operator in logs.
- **SC-005**: Zero disclosure to affected users: no non-admin surface reveals the existence or value of an override.
- **SC-006**: BYOK invariants hold under override: 100% of active-BYOK turns bill the user's own key, and BYOK-misconfiguration errors surface identically with or without a stored override.

## Assumptions

- The single runtime consumer of chat-model resolution is the main assistant turn path; auxiliary models (compaction, contextualization, thinking summaries) are resolved by separate fixed mechanisms and are out of scope (verified against the current codebase, 2026-07-26).
- The per-user override is stored on the user record itself (per the design doc) and read per turn alongside the user's existing per-turn settings, which is what makes FR-012 (next-turn effect) hold without new caching machinery.
- The admin UI reuses the eligible-model enumeration (models + provider grouping) that the shared-default picker already receives, so the two pickers can never drift apart.
- The new database migration must carry a timestamp greater than 1799400000000 (the latest applied migration); this is the only migration-bearing feature currently in flight.
- No audit/history of override changes is kept (explicitly out of scope); the stored value plus server logs of fallbacks are the only records.
- Standard test coverage per constitution Principle II: resolution precedence (BYOK-wins, override-beats-default, dynamic-default-follow), eligibility fallback, admin API validation and authorization, and admin UI rendering of the picker states.

## Out of Scope

- Per-user overrides for compaction, contextualizer, thinking-summary, or any auxiliary model.
- Any user-visible surfacing of the override (badges, settings entries, chat UI hints).
- An audit trail of override changes (who set what, when).
- Any BYOK interaction beyond the existing BYOK-wins/misconfiguration invariants — no per-user override of BYOK model choices, no admin editing of BYOK settings.
- Bulk operations (setting overrides for many users at once) and override expiry/scheduling.
- Changes to credit metering, pricing, or quotas.
