# Tasks: OpenRouter-Backed Shared Default Models (Kimi, Qwen, MiniMax, GLM)

**Feature**: 026-openrouter-shared-models | **Input**: plan.md, spec.md, research.md, data-model.md,
contracts/admin-shared-model.md, quickstart.md

**Tests**: INCLUDED — the spec mandates tests (FR-006/007/008 and every SC name a verifying test).

**Fence (FR-010) — DO NOT EDIT**: `specs/025-durable-chat-errors/`, `server/api/chat.js`,
`server/api/chat-store.js`, and client chat contexts/components. If any task appears to require
editing a fenced file, STOP and surface it — never cross the fence.

**Environment**: Backend Jest is **serial-only on one shared DB** (Constitution II). Work in a
worktree with a per-agent DB. Run backend tests with `--runInBand`.

**Absolute paths** (touch set, per plan): `/local-dev/server/api/ai-providers.js`,
`/local-dev/server/api/chat-models.js`, `/local-dev/server/api/admin.js`,
`/local-dev/client/src/pages/AdminPage.jsx`, and tests under
`/local-dev/server/api/__tests__/` and `/local-dev/client/src/pages/__tests__/`.

---

## Phase 1: Setup

- [ ] T001 Create the worktree test DB and env: `createdb collab_test_db_026`, export
  `DATABASE_URL=postgres://…/collab_test_db_026`, run backend migrations per `docs/dev.md`. Confirm
  `npx jest server/api/__tests__ --runInBand` is green **before** any change (baseline).
- [ ] T002 [P] Fetch the live OpenRouter catalog **unauthenticated** —
  `curl -s https://openrouter.ai/api/v1/models` — and record into a scratch note (NOT a repo file),
  for each of `moonshotai/kimi-k3`, `qwen/qwen3.7-max`, `qwen/qwen3.7-plus`, `minimax/minimax-m3`
  AND the four existing `z-ai/glm-4.6|4.7|5|5.2`: exact `id`, `pricing.prompt`/`pricing.completion`
  (USD/token), `context_length`, and `architecture.input_modalities`. Re-verify the D1 ids still
  exist; if any id changed/retired, note it for T006 and flag to the caller (does NOT block other
  tasks). Conversion to record: cents-per-1M = USD/token × 10^8.

---

## Phase 2: Foundational (blocking prerequisite for ALL user stories)

- [ ] T003 FR-001: In `/local-dev/server/api/ai-providers.js` (openrouter block ~500–524) change
  `serverKeyEnv: null` → `serverKeyEnv: 'OPENROUTER_API_KEY'` and rewrite the three stale comments
  (~506–511: "No shared server key… never the shared default", "The default (no-BYOK) client is
  never used to serve a shared default") to describe the shared-gateway reality. Leave `defaultClient`,
  `createClient`, `validateKey`, `buildWebSearch`, `classifyOpenRouterError`, `capabilities`
  UNCHANGED. Verify z.ai block still has `serverKeyEnv: null` (untouched).

**Checkpoint**: `hasServerKey('openrouter')` now tracks `OPENROUTER_API_KEY`. All stories can proceed.

---

## Phase 3: User Story 1 — Admin selects a gateway model as the shared default (P1) 🎯 MVP

**Goal**: With `OPENROUTER_API_KEY` set, the curated Kimi/Qwen/MiniMax/GLM entries appear in the
admin shared-default picker (grouped by provider), are selectable and validation-accepted, and a
non-BYOK turn is served by and metered from the selected gateway model.

**Independent test**: Set the key in test env → GET lists the entries + `providers`; PUT a gateway
key → 200 stored+effective; a non-BYOK shared turn writes one usage row at the entry's pricing.

### Tests (write first)

- [ ] T004 [P] [US1] In `/local-dev/server/api/__tests__/admin.test.js`: with `OPENROUTER_API_KEY`
  set, GET `/settings/shared-model` `models` includes the four curated entries + `or-glm-*` and
  `providers` includes `{ id:'openrouter', label:'OpenRouter' }`; every `models[i].provider` ∈
  `providers`. With the key UNSET, `models`/`providers` contain no openrouter entries (SC-007).
- [ ] T005 [P] [US1] In `/local-dev/server/api/__tests__/admin.test.js`: PUT a gateway `modelKey`
  with the key set → 200, `modelKey` and `effectiveModelKey` echo the gateway key; PUT a gateway
  `modelKey` with the key UNSET → 400 "no shared server key" (US1 acceptance 2 & 4).
- [ ] T006 [P] [US1] FR-007 metering: in `/local-dev/server/api/__tests__/chat-models*.test.js` (or
  the existing chat test harness helper that does NOT require editing `chat.js`/`chat-store.js`),
  assert a non-BYOK shared turn on a gateway entry produces exactly one `ai_usage_log` row priced
  from the entry's registry pricing; a BYOK turn produces none. If this cannot be asserted without
  editing a fenced file, STOP and surface it.
- [ ] T007 [P] [US1] FR-006 shared-key exhaustion: in
  `/local-dev/server/api/__tests__/ai-providers.classify.test.js` assert `classifyOpenRouterError`
  maps a 402 / credit shape → `insufficient_credits`; and (at the orchestration seam, no fenced-file
  edit) that a shared (non-BYOK) `insufficient_credits` on `openrouter` surfaces to the user as
  `provider_overloaded` and notifies the operator (SC-005). No taxonomy/classifier code change.

### Implementation

- [ ] T008 [US1] FR-002/D1: Add the four curated entries to `MODEL_DEFS` in
  `/local-dev/server/api/chat-models.js` using the T002 values — `provider:'openrouter'`, verbatim
  namespaced `modelId`, family `label`, `pricing` in cents-per-1M (×10^8 conversion), `contextWindow`
  from `context_length`. Ship **text-only** (no `supportsImages`) unless a flag is earned in T015.
  Update the block's authoring-date comment. Do NOT duplicate GLM.
- [ ] T009 [US1] FR-009/D3: In the same block of `/local-dev/server/api/chat-models.js`, refresh the
  four `or-glm-4.6|4.7|5|5.2` `pricing` and `contextWindow` to the T002 live values; update the
  authoring-date comment so one snapshot date covers all gateway entries. (Same file as T008 →
  sequential, not [P].)
- [ ] T010 [US1] FR-004/D2 (server): In `/local-dev/server/api/admin.js` add an additive `providers`
  array (`{ id, label }` from `listProviders()` filtered by `hasServerKey`) to BOTH the GET and PUT
  `/settings/shared-model` responses. Keep `modelKey`/`effectiveModelKey`/`models` and the derived
  save-time validation UNCHANGED. (Per contracts/admin-shared-model.md.)
- [ ] T011 [US1] FR-004/D2 (client): In `/local-dev/client/src/pages/AdminPage.jsx` (~258–270)
  replace the flat `<select>` of bare labels with provider `<optgroup>`s driven by
  `sharedModel.providers`, grouping `sharedModel.models` by `provider === p.id` — mirroring
  `/local-dev/client/src/pages/SettingsPage.jsx` (~273–283). Keep the "Deployment default" option and
  the `modelLabel` effective-line label-only.
- [ ] T012 [P] [US1] If a frontend harness for AdminPage exists under
  `/local-dev/client/src/pages/__tests__/`, add a test asserting the picker renders provider
  optgroups (OpenRouter group present when `providers` includes it). Otherwise note it as covered by
  the T004 contract test + manual check and skip (do not scaffold a new harness).

**Checkpoint**: MVP complete — gateway models are admin-selectable, grouped, validated, served, and
metered. US1 is independently shippable.

---

## Phase 4: User Story 2 — Graceful degradation when the shared key is absent or removed (P2)

**Goal**: A stored gateway default degrades to the deployment fallback (env → built-in) when the key
is removed, with a logged warning and the admin UI showing the true effective model — no crash, no
unauthenticated client, no BYOK key drafted.

**Independent test**: Store a gateway key, unset `OPENROUTER_API_KEY` → GET `effectiveModelKey` is the
fallback (not the stored key); a non-BYOK resolution returns the fallback model.

### Tests (write first)

- [ ] T013 [US2] In `/local-dev/server/api/__tests__/chat-models*.test.js`: with a stored gateway
  `sharedDefaultKey` and `OPENROUTER_API_KEY` UNSET, `resolveSharedDefaultKey` returns the fallback
  (`AI_CHAT_MODEL` if set, else `DEFAULT_MODEL_KEY`) and logs a warning; `resolveChatModel` (non-BYOK)
  returns the fallback model and instantiates NO unauthenticated client. Assert the BYOK path is
  untouched (BYOK-unresolvable still → `byok_misconfigured`, never this fallback).
- [ ] T014 [P] [US2] In `/local-dev/server/api/__tests__/admin.test.js` (contract test 5): stored
  `modelKey` is a gateway key but `OPENROUTER_API_KEY` absent → GET `effectiveModelKey` is the
  fallback, NOT the stored gateway key (FR-005 visibility / SC-003).

### Implementation

- [ ] T015 [US2] FR-005/D4: In `/local-dev/server/api/chat-models.js` add `hasServerKey` to the
  `require('./ai-providers')` import and update `resolveSharedDefaultKey(storedKey)` (~288): if
  `storedKey` is set but its `MODEL_DEFS` provider fails `hasServerKey` (or the key is unknown), log a
  warning and fall through to `process.env.AI_CHAT_MODEL || DEFAULT_MODEL_KEY`; otherwise return
  `storedKey`. This single point fixes both the serving path (`resolveChatModel` ~334) and the admin
  effective-model display (`admin.js` GET/PUT). Do NOT touch the BYOK branch.

**Checkpoint**: Rollback-by-deleting-the-secret is now safe; degradation is visible in the admin UI.

---

## Phase 5: User Story 3 — BYOK users are untouched (P2)

**Goal**: A BYOK OpenRouter user always routes through their own key (never the shared key), and
`byok_misconfigured` never silently falls back — re-asserted now that a shared key exists.

**Independent test**: With both keys configured, a BYOK turn uses the user's key + skips metering;
breaking the BYOK ref yields `byok_misconfigured` with no fallback.

### Tests

- [ ] T016 [US3] FR-008: in `/local-dev/server/api/__tests__/chat-models*.test.js` (or an existing
  chat harness helper, NO fenced-file edit) with both `OPENROUTER_API_KEY` and a user BYOK openrouter
  key set: assert a BYOK turn resolves via the user's key (the shared key is never used) and skips
  metering; assert a broken BYOK key/model ref returns `byok_misconfigured` with NO fallback to the
  shared key. If unassertable without a fenced-file edit, STOP and surface it.

**Note**: No production code change expected — this story is an invariant re-assertion. If T016 fails,
that is a bug to surface, not a silent fix outside the touch set.

---

## Phase 6: User Story 4 — Image attachments behave honestly per model (P3)

**Goal**: Vision-flagged gateway entries accept images (only where earned by live verification);
text-only entries ride the existing honest-failure path without crashing on historical image parts.

**Independent test**: text-only entry → `model_no_image_support` gate + placeholder replacement;
vision-flagged entry (if any earned) → image succeeds.

### Tests

- [ ] T017 [US4] FR-003: in `/local-dev/server/api/__tests__/chat-models*.test.js` assert a text-only
  gateway entry has `supportsImages === false` (derives from `VISION_PROVIDERS` excluding openrouter)
  and rides the honest path: the `model_no_image_support` pre-flight rejects an attachment and a
  transcript with historical image parts is handled by `replaceUnsupportedImageParts` without crashing
  (assert at the helper seam, not by editing `chat.js`).

### Implementation

- [ ] T018 [US4] FR-003/D5: In `/local-dev/server/api/chat-models.js` set `supportsImages: true` on a
  new entry ONLY where the T002 catalog declares `image` input AND a live image round-trip through the
  gateway was verified. **Default at plan time (no funded key): ship all new entries text-only**, add a
  per-candidate `// TODO(go-live): verify live image round-trip before enabling vision` comment on
  `kimi-k3`/`qwen3.7-plus`/`minimax-m3`, and record "flip vision flags after live round-trip" in the
  promotion notes. `qwen3.7-max` and all `or-glm-*` stay text-only.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T019 Run the full backend suite serially: `npx jest server/api/__tests__ --runInBand` (green),
  plus `npx vitest run client/src/pages/__tests__/AdminPage` if a test was added in T012. Re-verify
  no fenced file (`chat.js`, `chat-store.js`, `specs/025-…`, client chat contexts/components) was
  modified: `git diff --name-only` must show only the four touch-set files + tests.
- [ ] T020 [P] Update this feature's promotion/deploy notes (in `spec.md` "Dependencies & Deployment
  Notes" is already present — add a line to the deploy checklist artifact the pipeline uses, NOT
  README/docs/dev.md which are off-limits to this agent): operator must seed `OPENROUTER_API_KEY`
  (SOPS in prod, `.env` local), fund the account, and perform the live vision round-trip before
  flipping any `supportsImages` flag (T018 deferral). Confirm `checklists/requirements.md` items all
  still hold.

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → before everything. T002 [P] can run alongside T003.
- **Foundational (T003)** → BLOCKS all user stories (eligibility flip).
- **US1 (T004–T012)** depends on T003 + T002 (values). MVP. Tests T004–T007 [P] together; impl
  T008→T009 sequential (same file), T010→T011 (server before client), T012 [P].
- **US2 (T013–T015)** depends on T003. Independent of US1 impl (touches a different function), though
  T014 reuses admin.test.js. Can start after Foundational.
- **US3 (T016)** depends on T003. Independent (invariant re-assertion).
- **US4 (T017–T018)** depends on T008 (entries must exist). Independent of US2/US3.
- **Polish (T019–T020)** last.

**Story independence**: US1 (surface+select+meter), US2 (degradation), US3 (BYOK), US4 (vision) each
have their own tests and can be implemented/verified independently once T003 lands. US1 alone is a
shippable MVP.

## Parallel Opportunities

- T002 ∥ T003 (different files).
- Within US1: T004 ∥ T005 ∥ T006 ∥ T007 (distinct test files/harness helpers, all read-only re: impl).
- Across stories after T003: US2 tests (T013/T014) ∥ US3 test (T016) — different concerns; note
  T005/T014 both touch admin.test.js so serialize those two if edited concurrently.

## MVP Scope

**Phase 1 + Phase 2 + Phase 3 (US1)** = the feature's full core value: gateway models selectable,
grouped, validated, served, and metered. US2 (safe rollback), US3 (BYOK re-assertion), and US4
(vision honesty) are incremental hardening layers on top.

## Format validation

All tasks use `- [ ] Txxx [P?] [US?] description + absolute file path`; Setup/Foundational/Polish
carry no story label; user-story tasks carry [US1]–[US4]. 20 tasks total.
