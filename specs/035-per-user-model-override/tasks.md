---
description: "Task list for feature 035 — Per-User Chat Model Override"
---

# Tasks: Per-User Chat Model Override (035)

**Input**: Design documents from `/specs/035-per-user-model-override/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: REQUIRED. Constitution Principle II makes the suite the only reviewer, and the spec's
Assumptions call out the coverage set explicitly. Every behavioral task below is paired with a test task.

**Organization**: grouped by user story. US1 (P1) carries the whole mechanism — storage, resolution
insertion, admin API, admin picker — per the spec's own scoping. US2 (P2) and US3 (P3) are almost
entirely *proofs*: the behaviors they describe fall out of the US1 code, and their phases pin them so a
later change cannot quietly break them. That is deliberate, not padding — the invariants (dynamic
default-follow, BYOK-wins, no-silent-fallback, stale-never-fails) are the expensive part of this feature.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3
- All paths are repository-relative from `/local-dev`

## Parallel-agent constraints (apply to every task)

- Stay on `main`; never branch, never commit. Never run `create-new-feature.sh`; never write
  `.specify/feature.json`.
- Never edit `CLAUDE.md`, `README.md`, `docs/dev.md` — owed doc touches get recorded for the merge queue (T021).
- Never hand-edit `design/` exports.
- Backend tests run **serially** (`npm run test:server …`) against the shared `collab_test_db`.

---

## Phase 1: Setup

**Purpose**: confirm the seams are where the plan says they are. `server/api/chat-models.js` is under
concurrent edit by a registry-update agent, so line numbers in the plan are indicative only.

- [ ] T001 Re-read the four serving-path seams before editing anything and confirm the plan's assumptions
      still hold: `isSharedEligible` / `resolveSharedDefaultKey` / `resolveChatModel` and the export list in
      `server/api/chat-models.js`; the column list in `loadByokSettings` and the explicit `buildResponse`
      literal in `server/api/byok-settings.js`; the single `resolveChatModel` call site in
      `server/api/chat.js`; the shared-default endpoints + `PATCH /users/:userId/*` precedents in
      `server/api/admin.js`. Also confirm `ls migrations | sort | tail -1` is still
      `1799400000000_add-auth-ip-capture.js` (if a newer migration landed, bump the new timestamp above it).
      Finally, confirm FR-013 still holds by construction: `getCompactionModel`, `getContextualizerModel`, and
      `getThinkingSummaryModels` take no user context and consult neither the shared default nor a user row —
      if any of them has since gained a user-scoped argument, stop and report it before writing code (an
      auxiliary model silently inheriting the override would be out-of-scope behavior).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the column must exist before any resolution or admin code can be tested.

**⚠️ CRITICAL**: no user story work can begin until T003 is green.

- [ ] T002 Create `migrations/1799500000000_add-chat-model-override-to-users.js` adding a single nullable
      `chat_model_override text` column to `users` (`pgm.addColumns` up / `pgm.dropColumns` down), with a
      header comment stating: NULL = follow the shared default dynamically; no default and no backfill; no
      CHECK/enum/FK because legal values are a code-side, deployment-dependent registry (research R2); and
      why the timestamp clears both `1799400000000` and the stale `>1795000000000` floor. Shape per
      [data-model.md](./data-model.md).
- [ ] T003 Apply the migration (`npm run migrate`) against the dev/test database and verify with
      `\d users` that the column is `text`, nullable, no default, and that
      `SELECT count(*) FROM users WHERE chat_model_override IS NOT NULL` is `0` (quickstart §2).

**Checkpoint**: schema ready — user story work can begin.

---

## Phase 3: User Story 1 — Admin pins a model for one user (Priority: P1) 🎯 MVP

**Goal**: an admin can pin a model for one account from the admin user list, and that account's next
assistant turn runs on it while everyone else is unaffected — with the management surface admin-only and
the pin invisible to the affected user.

**Independent Test**: pin a non-default model for user A; A's next turn runs on it (visible in
`ai_usage_log.model_key`), user B's turn still runs on the shared default, a non-admin call to the
management endpoint is rejected, and nothing in A's own API payloads names the pin.

### Tests for User Story 1

> Write these first; they must fail before the implementation tasks land.

- [ ] T004 [P] [US1] Create `server/api/__tests__/chat-model-override.test.js` (pure unit, no DB) covering the
      core precedence: an eligible override beats the shared default; no override (`null`/`undefined`) →
      `resolveSharedDefaultKey` result; an override equal to the current shared default still resolves to
      that key (pinned, per spec Edge Cases); and — as a regression guard — calling `resolveChatModel`
      **without** `userOverrideKey` reproduces today's behavior exactly. Follow the env save/restore +
      `console.warn` spy pattern already used in `server/api/__tests__/chat-models.test.js`.
- [ ] T005 [P] [US1] Create `server/__tests__/admin-chat-model-override.test.js` mounting the router the way
      `server/index.js` does — `app.use('/api/admin', requireAdmin, admin.router)` — exactly as
      `server/__tests__/admin-auth-capture.test.js` does (a bare-router mount would make the 403 assertion
      vacuous). Cover: set → `200` with stored + `effectiveModelKey`; unknown key → `400`, nothing stored;
      known-but-ineligible key → `400`, nothing stored; non-string non-null body → `400`; unknown user →
      `404`; signed-in non-admin → `403` with no override data in the body; unauthenticated → `401`;
      `GET /api/admin/users` carries `chatModelOverride` (and `null` for an untouched account); and a
      property test asserting the endpoint's accept/reject decision equals `isSharedEligible(key)` for
      **every** `MODEL_DEFS` entry (FR-005 anti-drift); and setting an override for a user whose BYOK is
      active succeeds (dormant, FR-015). Toggle provider env vars to create an ineligible case rather than
      assuming any particular key is unfunded. Create accounts under a suite-specific email suffix and delete
      them in `afterAll` (the shared `collab_test_db` is serial-only — leaked fixed-key rows break later runs).
- [ ] T006 [P] [US1] Create `server/__tests__/chat-model-override-wiring.test.js` proving `chat.js` passes the
      stored value into resolution: reuse the mock harness from
      `server/__tests__/chat-reservation-release.test.js` (mock `../auth`, `../ai-usage`, `../chat-store`,
      `../api/app-settings`, etc.), make `loadByokSettings` resolve a row containing
      `chat_model_override: 'claude-haiku'`, spy on `resolveChatModel`, POST one message, and assert the spy
      was called with `userOverrideKey: 'claude-haiku'`. Add a second case asserting a `null` column yields
      `userOverrideKey: null`.
- [ ] T007 [P] [US1] Extend `server/__tests__/byok-settings.test.js` with the FR-011/SC-005 non-disclosure
      assertion: with `chat_model_override` set directly in the DB for the test user, `GET /api/settings/byok`
      returns a key set that contains no `chatModelOverride` / `chat_model_override`, and the serialized body
      does not contain the pinned key anywhere (mirrors 034's `/auth/me` whitelist test).
- [ ] T008 [P] [US1] Extend `client/src/pages/__tests__/AdminPage.test.jsx` with the picker states: a user with
      no override renders the `Default (<shared effective label>)` option selected; the offered options are
      **exactly** the mocked shared-model payload's models grouped under their providers, plus `Default` — no
      extra or hand-listed model (US1 acceptance 3 / FR-009); a user whose stored override is absent from the
      eligible list renders the disabled `"<key> (unavailable — using <label>)"` option as selected and never
      `Default` (FR-010); choosing a model issues `PATCH /api/admin/users/<id>/chat-model` with
      `{ modelKey: '<key>' }`; choosing `Default` issues `{ modelKey: null }`. Mock
      `GET /api/admin/settings/shared-model` alongside the existing `GET /api/admin/users` mock (today's mock
      *rejects* that URL), add a `patch` spy to the mocked `useAuth().api` (it currently exposes only
      `get`/`put`/`post`), and click the row's Credits expander (`@testing-library/user-event` is available)
      before asserting — the existing 034 tests never expand a row.

### Implementation for User Story 1

- [ ] T009 [US1] In `server/api/chat-models.js`, add `resolveUserChatModelKey(overrideKey, sharedDefaultKey)`
      immediately after `resolveSharedDefaultKey` (so the file reads in precedence order): eligible override →
      return it; ineligible/unknown override → one `console.warn` naming the key and the reason, then delegate
      to `resolveSharedDefaultKey(sharedDefaultKey)`; falsy override → delegate silently. Document that the
      stored value is deliberately never cleared here (RBD-2). Exact contract in
      [contracts/model-resolution.md](./contracts/model-resolution.md) C1.
- [ ] T010 [US1] In `server/api/chat-models.js`, give `resolveChatModel` an optional `userOverrideKey`
      parameter and change **only** its non-BYOK branch to
      `const modelKey = resolveUserChatModelKey(userOverrideKey, sharedDefaultKey);`. The BYOK branch —
      including the `byok_misconfigured` early return — must be byte-for-byte unchanged. Add
      `resolveUserChatModelKey` and `isSharedEligible` to `module.exports` (contract C2). No other refactor of
      this function.
- [ ] T011 [P] [US1] In `server/api/byok-settings.js`, add `'chat_model_override'` to the `loadByokSettings`
      column list with the comment from contract C3 (this is the per-turn user-settings row; `buildResponse`
      must stay an explicit literal and must never carry the override). Leave `buildResponse` and
      `isByokActive` unchanged.
- [ ] T012 [US1] In `server/api/chat.js`, at the single `chatModels.resolveChatModel({...})` call site, pass
      `userOverrideKey: byokSettings?.chat_model_override || null` with a one-line comment (contract C4).
      Depends on T010, T011.
- [ ] T013 [P] [US1] In `server/api/admin.js`, add `u.chat_model_override` to the `GET /users` SELECT and
      `chatModelOverride: r.chat_model_override` to the row mapping (contract A2).
- [ ] T014 [US1] In `server/api/admin.js`, add `PATCH /users/:userId/chat-model` per contract A1: validate
      `modelKey` is a string or `null` (else `400`), then — for a string — reject an unknown key and a key
      whose provider has no shared server key with the two distinct `400` messages; `UPDATE users SET
      chat_model_override = $1 WHERE id = $2 RETURNING chat_model_override`; `404` when no row; respond
      `{ chatModelOverride, effectiveModelKey }` where the effective key comes from
      `resolveUserChatModelKey(stored, appSettings.getSharedDefaultModel())`. Place it beside the other
      `PATCH /users/:userId/*` handlers; import `resolveUserChatModelKey` from `./chat-models`. Depends on T009.
- [ ] T015 [US1] In `client/src/pages/AdminPage.jsx`, add the "Assistant model" section to the existing
      expanded detail row (after the Trusted toggle, before "Sign-in origin"): a `<select>` valued from
      `u.chatModelOverride ?? ''` with the `Default (<effective label>)` option, provider `<optgroup>`s built
      from the already-loaded `sharedModel.providers`/`.models`, the disabled
      `"<key> (unavailable — using <label>)"` option when the stored key is not in the eligible list, plus
      `savingModelUserId` state and a `handleChatModelChange` handler that PATCHes (`''` → `null`) and then
      calls `fetchUsers()`. Render a plain "Model list unavailable." note when `sharedModel` is null. Markup
      and handler in [contracts/admin-chat-model-api.md](./contracts/admin-chat-model-api.md) A3. Depends on T013, T014.

**Checkpoint**: US1 is complete and independently testable — T004–T008 green, and the quickstart §3/§4/§8
walks behave as described.

---

## Phase 4: User Story 2 — Everyone defaults to the default, dynamically (Priority: P2)

**Goal**: an un-pinned account follows the shared default as it changes, and clearing a pin returns the
account to whatever the shared default is *at that moment* — never a snapshot.

**Independent Test**: with no override, change the shared default and confirm the next turn follows it; pin,
change the shared default again, clear the pin — the next turn runs on the **new** shared default.

- [ ] T016 [US2] Extend `server/api/__tests__/chat-model-override.test.js` with the dynamic-default cases: with
      no override, changing the `sharedDefaultKey` argument changes the resolved key on the next call (no
      snapshot anywhere); with an override set, changing `sharedDefaultKey` does **not** affect the resolved
      key; after clearing (override `null`), the resolved key is the *current* shared default, including a
      value that changed while the override was in force (FR-004, US2-1/2/3, SC-003). Same file as T004 — run
      after it.
- [ ] T017 [US2] Extend `server/__tests__/admin-chat-model-override.test.js` with the clear round-trip: set an
      override, change the shared default via `appSettings.setSharedDefaultModel(...)`, clear the override,
      and assert the response's `effectiveModelKey` equals the **new** shared default (not the one in force
      when the pin was set). Same file as T005 — run after it. This test mutates the **global** `app_settings`
      shared-default row: capture `appSettings.getSharedDefaultModel()` first and restore it in `afterAll`, or
      the next suite in the serial run inherits a changed default.
- [ ] T018 [US2] Verify the deploy-time state (US2 acceptance 4) as part of the quickstart §2 check: after the
      migration every existing account has `chat_model_override IS NULL` and therefore behaves exactly as
      before. Record the observed count in the run notes.

**Checkpoint**: US1 + US2 both hold — pinning is reversible and the default is genuinely dynamic.

---

## Phase 5: User Story 3 — The override never breaks a chat and never touches BYOK (Priority: P3)

**Goal**: the override is a routing preference, not a failure mode — BYOK still wins, misconfigured BYOK
still fails loudly, and a stale pin degrades quietly to the shared default.

**Independent Test**: a BYOK-active user with a stored pin still runs on their own key/model; breaking their
BYOK config still surfaces the misconfiguration error with no shared fallback; a stored pin whose provider
key was withdrawn resolves to the shared default with a warning, and the stored value survives.

- [ ] T019 [US3] Extend `server/api/__tests__/chat-model-override.test.js` with the stale-override cases: a
      known override whose provider lost its shared server key resolves to the shared-default chain and emits
      exactly one warning naming the key; an unknown override key does the same; and the fallback is
      re-evaluated per call, so restoring the provider key makes the very next call return the override again
      (FR-006, US3-3, spec Edge Cases). Assert the turn always resolves to a usable model — never `null`,
      never a throw (SC-004).
- [ ] T020 [US3] Extend `server/api/__tests__/chat-model-override.test.js` with the two BYOK invariants as
      **separate, explicitly named** tests (FR-003, SC-006): (a) an active-BYOK user with a stored override
      resolves the BYOK model via the user's key — the override has no effect; (b) BYOK enabled but
      unresolvable (unknown BYOK model, missing key, or a key that fails to decrypt) returns
      `{ error: 'byok_misconfigured' }` **even when a valid override and a valid shared default exist** — it
      never falls back to either. Same file as T004/T016/T019 — run after them.

**Checkpoint**: all three stories hold; the guardrails are pinned by tests that fail loudly if the BYOK
branch is ever touched.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T021 Record the owed follow-ups for the merge queue in `specs/035-per-user-model-override/promotion-notes.md`
      (034 precedent). **Verified, not hypothetical (Principle I): `README.md` will be factually wrong the
      moment this lands** — line ~33 lists the Admin Area capabilities without the per-user pin, and line ~557
      states the precedence as "admin selection → `AI_CHAT_MODEL` → `DEFAULT_MODEL_KEY`" with no per-user slot
      (line ~273 describes the same chain for `AI_CHAT_MODEL`). `README.md` is off-limits to this feature's
      agents, so the note must name those exact lines and the replacement chain (BYOK → per-user override →
      admin shared default → `AI_CHAT_MODEL` → `DEFAULT_MODEL_KEY`) as a **merge-blocking** docs task.
      `docs/dev.md` was checked and mentions none of this — nothing owed there. Also record: the three
      non-blocking Squire-doc
      amendments already flagged in `clarifications-needed.md` (write-time validation, stale-override
      retention, UI placement); and the `loadByokSettings` naming smell (research R3) as a deliberate,
      documented MEDIUM.
- [ ] T022 Run the full suites serially and green: `npm run test:server` then `npm run test:client`. Pay
      particular attention to the untouched-by-design suites that exercise the same seam —
      `chat-models-byok.test.js`, `chat-models.test.js`, `chat.durable-failures.test.js`,
      `chat-reservation-release.test.js`, `admin-auth-capture.test.js` — which must pass **unmodified**.
- [ ] T023 Walk [quickstart.md](./quickstart.md) §3–§8 against the dev pod: admin API walk, serving-path
      matrix (pinned vs un-pinned vs shared-default change vs clear), stale-override degradation **including
      the RBD-2 retention check** (`SELECT chat_model_override` still returns the stale key after a
      fallback turn), the BYOK matrix, the non-disclosure check on `/api/settings/byok` and `/auth/me`, and
      the admin UI states (Default / pinned / unavailable). Note any deviation in the run notes rather than
      fixing it silently.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (T001)** — no dependencies.
- **Foundational (T002–T003)** — depends on T001; **blocks everything else**.
- **US1 (T004–T015)** — depends on Foundational. MVP.
- **US2 (T016–T018)** — depends on US1 implementation (the behavior it proves lives in T009/T010).
- **US3 (T019–T020)** — depends on US1 implementation; independent of US2.
- **Polish (T021–T023)** — depends on all desired stories.

### Within User Story 1

- Tests T004–T008 are written first and must fail.
- T009 → T010 (same file, ordered) → T012 (needs both T010 and T011).
- T013 → T014 (same file, ordered) → T015 (the UI consumes both).
- T011 is independent of the `chat-models.js` and `admin.js` chains.

### File-conflict notes (why some tasks are not `[P]`)

- T009, T010 — same file (`server/api/chat-models.js`).
- T013, T014 — same file (`server/api/admin.js`).
- T004, T016, T019, T020 — same file (`server/api/__tests__/chat-model-override.test.js`); sequential.
- T005, T017 — same file (`server/__tests__/admin-chat-model-override.test.js`); sequential.

### Parallel opportunities

```bash
# US1 test authoring — four different files, all independent:
Task: "T004 core precedence unit tests in server/api/__tests__/chat-model-override.test.js"
Task: "T005 admin API + authorization tests in server/__tests__/admin-chat-model-override.test.js"
Task: "T006 chat.js wiring test in server/__tests__/chat-model-override-wiring.test.js"
Task: "T007 non-disclosure assertion in server/__tests__/byok-settings.test.js"
Task: "T008 picker render/PATCH tests in client/src/pages/__tests__/AdminPage.test.jsx"

# US1 implementation — the two independent chains plus the standalone column edit:
Task: "T011 chat_model_override joins loadByokSettings' column list in server/api/byok-settings.js"
Task: "T013 chatModelOverride on GET /users in server/api/admin.js"   # then T014 in the same file
```

---

## Implementation Strategy

**MVP = Phases 1–3 (through T015).** That is the entire admin-visible feature: pin, clear, resolve, and a
picker that cannot drift from the shared-default picker. Stop there and validate quickstart §3/§4/§8 before
moving on.

**Then** Phase 4 (reversibility + dynamic default) and Phase 5 (the guardrails). Neither adds product
surface; both exist so a future edit to the resolution chain fails a test instead of silently billing the
operator's key or freezing a user on a snapshot.

**Finally** Phase 6: full suites, the quickstart walk, and the owed-items note for the merge queue.

## Notes

- `server/api/chat-models.js` is under concurrent edit (registry entries). Re-read before every edit; never
  rely on the line numbers in the plan.
- Do **not** widen the diff: no rename of `loadByokSettings`, no refactor of `resolveChatModel`'s BYOK
  branch, no changes to metering, quotas, auxiliary models, or the shared-default endpoints.
- Never commit; never touch `CLAUDE.md`, `README.md`, `docs/dev.md`, or `design/` exports.
