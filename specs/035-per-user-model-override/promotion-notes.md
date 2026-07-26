# Promotion notes — 035-per-user-model-override

What this feature leaves owed to the merge queue, the design docs, and the
deploy. One item is **merge-blocking** (the README docs pass); the rest need an
owner but not a gate.

## MERGE-BLOCKING — `README.md` becomes factually wrong the moment this lands

This feature's agents may not edit `README.md`, so the merge queue owns the fix.
These are not hypothetical: each line was read and is contradicted by the code on
this branch.

- **`README.md:33` — the Admin Area capability list.** It enumerates the admin
  dashboard's powers and ends with "setting the shared assistant's default AI
  model". It must also name the per-user pin, e.g. "…setting the shared
  assistant's default AI model **and pinning a different assistant model for an
  individual user**…".

- **`README.md:557` — the "Model" precedence sentence** (in the AI assistant
  section). It currently reads:

  > Its precedence is: admin selection → `AI_CHAT_MODEL` env var →
  > `DEFAULT_MODEL_KEY` code constant (Claude Opus 4.8).

  The full chain is now:

  > BYOK → per-user override (`users.chat_model_override`) → admin shared
  > selection → `AI_CHAT_MODEL` env var → `DEFAULT_MODEL_KEY` code constant

  The same paragraph should note that a per-user pin degrades exactly like a
  stored shared selection: if its provider's server key is withdrawn the turn
  falls back to the shared-default chain with a logged warning, and the stored
  value is kept, not cleared.

- **`README.md:273` — the `AI_CHAT_MODEL` env-var entry** describes the same
  chain from the env var's point of view ("`AI_CHAT_MODEL` only applies when no
  admin selection has been made"). It needs the per-user slot inserted ahead of
  the admin selection so the two descriptions do not disagree with each other.

`docs/dev.md` was checked: it mentions neither the model chain nor the admin
model picker. **Nothing is owed there.** `CLAUDE.md` likewise.

## Owed to the Squire design docs (constitution Principle VI)

All three are **non-blocking** and were already flagged in
`clarifications-needed.md` → "Flagged design gaps". Amend the Squire doc and
re-run `node design/sync.mjs`; never hand-edit `design/`.

- **Write-time validation is not in the design doc.** `design/in-app-ai-assistant.md`'s
  "Per-user model override (035)" paragraph specifies only the resolution-time
  fallback. The implemented endpoint *also* rejects unknown and currently
  ineligible keys up front (RBD-1, from Sam's scope guidance). One clause in the
  design paragraph would close the gap.
- **Stale-override retention is not stated.** The doc specifies the fallback but
  not whether the stored value survives it. Implemented as keep-and-fall-back,
  re-evaluated per turn, so a briefly-withdrawn provider key resumes the pin by
  itself (RBD-2). Worth a sentence.
- **UI placement was under-specified.** The doc says "from the admin user list";
  the implementation put the picker in the existing expanded per-user detail row
  (RBD-3), next to the other per-user controls. If Sam wants it as a visible
  table column instead, that is a design amendment, not a bug.

The Admin-area capability list in `design/authentication-and-sharing.md` should
pick up the per-user pin in the same pass that fixes `README.md:33`.

## Known MEDIUM carried deliberately

**`loadByokSettings` no longer returns only BYOK state.** `chat_model_override`
rides its `SELECT` because that function *is* the chat path's per-turn
user-settings read — which is precisely what makes "the next turn, no cache, no
re-login" true (RBD-6/RBD-10, research R3). The name is now a mild lie. It was
**not** renamed: that is a cross-file refactor and the assignment forbids
widening the diff. Mitigations in place:

- a comment at the column list saying what the function actually is, and that
  `buildResponse` must never grow the field;
- `buildResponse` stays an explicit literal rather than a spread, so a new column
  cannot leak into the user-facing payload by accident;
- `server/__tests__/byok-settings.test.js` pins the non-disclosure: the
  serialized `GET`/`PUT /api/settings/byok` body contains neither the field name
  nor the pinned key anywhere (FR-011/SC-005).

A future rename to something like `loadUserChatSettings` is a clean, mechanical
follow-on.

## Deploy notes

- One migration: `1799500000000_add-chat-model-override-to-users.js`. Additive,
  nullable, no default, no backfill, no index. `down` drops the column cleanly;
  up/down/up was verified. Nothing else in the deploy depends on it, and the
  pre-035 code ignores the column, so the migration can ship ahead of the app
  image if that is convenient.
- **No config, no env var, no feature flag.** The feature is dormant until an
  admin pins someone: every account is `NULL` after the migration and `NULL`
  resolves through the pre-existing chain unchanged.
- Post-deploy sanity: `SELECT count(*) FROM users WHERE chat_model_override IS
  NOT NULL;` should be `0` immediately after the migration.

## Owed by a human (not automatable here)

- **Browser walk of the admin picker — quickstart §8.** The only unexecuted
  section. Its three states (`Default (<label>)`, a pinned model, and a
  stored-but-unavailable key rendering as "unavailable — using X") are asserted
  in jsdom, but nobody has seen the control in a real browser, and it sits inside
  a detail row that must stay open across the refetch a PATCH triggers.
  §3–§7 *were* executed live — see "Live quickstart walk" below.
- **RBD ratifications.** Twelve RATIFIED-BY-DEFAULT decisions in
  `clarifications-needed.md` are still awaiting Sam's explicit confirmation. The
  ones with real product consequences: RBD-3 (picker placement), RBD-5 (an
  override may be set on a BYOK-active user and lies dormant), RBD-8 (the admin
  may pin a model for their own account).

## Live quickstart walk (§3–§7, executed)

Run against a real server booted from this branch (`node server/index.js`, port
3099, its own `collab_test_db_035walk`, real provider keys, `ENABLE_DEV_ENDPOINTS=1`
for account creation). Real assistant turns, real `ai_usage_log` rows. Every
section below was observed, not inferred. The walk database and the server were
torn down afterwards; `.env` was restored byte-identical.

- **§3 admin API** — set → `200 {"chatModelOverride":"claude-haiku","effectiveModelKey":"claude-haiku"}`;
  unknown key → `400 Unknown model: ghost-model`; ineligible key → `400 Model
  "gpt-5.5" has no shared server key…`; non-string → `400`; unknown user →
  `404`; non-admin → `403 Admin access required`; unauthenticated → `401`. The
  stored value survived all three rejected writes. `GET /users` carried
  `chatModelOverride` (the pin for the pinned account, `null` for the other
  three). Admin pinned a model for **their own** account → `200` (RBD-8).
- **§4 serving path** — pinned user's turn logged `model_key=claude-haiku,
  is_byok=false` while an un-pinned user's logged the shared default. Shared
  default changed `claude-sonnet` → `gemini-2.5-flash` **with no restart and no
  re-login**: the un-pinned user's next turn followed it, the pinned user's did
  not. Clearing the pin put that user on `gemini-2.5-flash` — the *new* default,
  not the `claude-sonnet` in force when the pin was set (SC-003).
- **§5 stale override** — with `OPENROUTER_API_KEY` withdrawn and the server
  restarted, the picker offered 0 OpenRouter models, a fresh write of
  `or-glm-4.7` was rejected `400`, and the user's **existing** `or-glm-4.7` pin
  served a normal turn on `gemini-2.5-flash` with exactly one warning naming the
  key. `SELECT chat_model_override` still returned `or-glm-4.7` afterwards
  (RBD-2). Restoring the key and restarting: the very next turn ran on
  `or-glm-4.7` again, no warning, no admin action.
- **§6 BYOK** — with the `or-glm-4.7` pin stored throughout: BYOK on with a valid
  key ran `claude-haiku | is_byok=true`, the user's own model, not the pin
  (US3-1). Clearing the key column with `byok_enabled` still true produced
  `{"code":"byok_misconfigured","provider":"anthropic"}` and the
  `ai_usage_log` row count was **unchanged across the request** — no fallback to
  the pin, no fallback to the shared default, no shared-key spend (US3-2/SC-006).
  Disabling BYOK put the next turn on `or-glm-4.7 | is_byok=false` (US3-4).
- **§7 non-disclosure** — as the pinned user, `GET`/`PUT /api/settings/byok` and
  `GET /auth/me` carried no field whose name contains "override" at any depth,
  and the pinned key appeared nowhere outside the `models` catalog that every
  user sees regardless of any pin (`paths(scalars)` located the single hit at
  `models.0.key`, and `del(.models)` left no match).

## Deviations and judgment calls made during implementation

1. **Quickstart §8 (the browser walk) was not executed** — no browser in this
   environment. Listed above as owed. §3–§7 were.

2. **Two test-harness defects were fixed (commit `03ab687`), neither changing
   what any test asserts.**
   - `chat-model-override-wiring.test.js` inherited its mock harness from
     `chat-reservation-release.test.js`, which never gives `chat.js` a pool.
     `chat.js` guards its settings read with `pool ? await loadByokSettings(...)
     : null`, so the mocked row could never be reached and the suite's central
     assertion was unreachable. Fixed by initialising a stub persistence provider
     in `beforeAll`.
   - `client/src/pages/__tests__/AdminPage.test.jsx`'s mocked `useAuth()` rebuilt
     its `api` object on every call. `AdminPage`'s boot effect is keyed on that
     object (`useEffect(..., [api])`), so every fetch-driven state update looked
     like a new `api` and re-fired the effect — an unbounded re-fetch loop. The
     034 tests asserted and exited before it mattered; the 035 test that
     deliberately waits on a picker which never appears rode the loop into a
     worker OOM (the run died after 9 of 11 tests). Fixed by building `api` once
     inside the mock factory. **This was a latent defect in the 034 harness, not
     something 035 introduced** — worth knowing if another AdminPage test is ever
     added that waits on an absent element.

3. **Backend suites ran against a per-agent database (`collab_test_db_035`), not
   the shared `collab_test_db`.** Per the orchestrator's environment brief, to
   keep a parallel worktree from corrupting the shared serial-only DB. Serial
   execution (`--runInBand`) was preserved.

4. **Jest needed a config override to run inside the worktree at all.** The
   `jest` block in `package.json` lists `/.claude/worktrees/` in both
   `modulePathIgnorePatterns` and `testPathIgnorePatterns`, so `npm run
   test:server` from a worktree finds zero tests. Runs used a generated config
   identical to `package.json`'s minus those two entries, with `rootDir` pinned
   to the worktree. **No repo file was changed for this** — but the same wall
   will hit every future worktree agent, so it may be worth teaching
   `script/`-level tooling about it.

5. **The `Default (…)` option names `sharedModel.effectiveModelKey`, not
   `deploymentDefaultKey`.** The shared-default picker's own first option uses
   `deploymentDefaultKey ?? effectiveModelKey` because it means "what you get with
   *no admin selection*". The per-user option means "what you get with *no pin*",
   which is the effective shared default — a different quantity that happens to
   coincide when no admin selection exists. Matches `contracts/admin-chat-model-api.md` A3.

6. **`dotenv` defeats a shell-level `unset` — worth knowing for any future
   provider-key walk.** `server/index.js` calls `require('dotenv').config()`, so
   unsetting `OPENROUTER_API_KEY` in the launching shell is silently undone by
   the repo `.env` (and `/proc/<pid>/environ` still shows it absent, which makes
   the failure look like a code bug rather than a harness one). The §5 step above
   only became a real test once the key was absent from **both** the shell
   environment and `.env`. The first two attempts looked like "the override was
   honored when it should have degraded"; they were not.

7. **FR-013 re-verified rather than assumed.** `getCompactionModel`,
   `getContextualizerModel`, and `getThinkingSummaryModels` still take no user
   context and consult neither the shared default nor a user row, so no auxiliary
   model can inherit the pin. This holds by construction, not by a test — if any
   of them ever gains a user-scoped argument, that is the moment to add one.
