---
description: "Task list for feature 036 — Admin Per-User Agent Connection & Onboarding Detail"
---

# Tasks: Admin Per-User Agent Connection & Onboarding Detail (036)

**Input**: Design documents from `/specs/036-admin-adoption-reporting/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: REQUIRED. Constitution Principle II makes the suite the only reviewer, and the spec's
Assumptions name the coverage set explicitly. Two of the three user stories are mostly *proofs*
(leak-free, read-only, gated) — that is the point of them, not padding: this feature's whole risk
is that a reporting surface over credential tables quietly reports too much.

**Organization**: grouped by user story. US1 (P1) delivers the endpoint and the credentials
panel; US2 (P2) extends the same endpoint and panel with onboarding + activity; US3 (P3) is the
invariant suite. Each story is independently testable and independently shippable in that order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3
- All paths are repository-relative from `/local-dev`

## Parallel-agent constraints (apply to every task)

- Stay on `main`; never branch, never commit. Never run `create-new-feature.sh`; never write
  `.specify/feature.json`.
- Never edit `CLAUDE.md`, `README.md`, `docs/dev.md`, or anything under `design/` — owed doc
  touches get recorded for the merge queue (T018).
- Backend tests run **serially** (`npm run test:server …`) against the shared `collab_test_db`.
- **Nothing in these tasks cites a line number**, by design: `server/api/admin.js` and
  `client/src/pages/AdminPage.jsx` were under concurrent edit while this was written. Locate the
  named *pattern*, then match it.

---

## Phase 1: Setup

**Purpose**: this feature is queued behind 035, which edits the same four files. 035 landed on
`main` at commit `03188de` during planning, so the precondition is expected to pass — confirm it
anyway, and re-read the files regardless of what this plan says about them.

- [ ] T001 Confirm the queue precondition and re-read the seams in `server/api/admin.js` and
      `client/src/pages/AdminPage.jsx`. (a) `main` must already contain feature 035 — verify a
      `PATCH /users/:userId/chat-model` handler exists in `server/api/admin.js` and an "Assistant
      model" `<select>` exists in the expanded detail row of `client/src/pages/AdminPage.jsx`; if
      either is missing, **stop and report** rather than working around it. (b) Re-read the three
      patterns this feature copies: the `GET /users/:userId/sharing` handler shape (several
      parameterised queries → explicit `.map()` serialisation → one `try/catch` logging
      `[Admin] …`), `toggleExpand`'s two independent lazy fetches each with their own loading flag
      and `.catch()`, and the `.admin-detail-section` blocks inside `.admin-detail`. Also read
      `client/src/pages/AdminPage.css` (which classes 035 left behind — `.admin-detail-note` in
      particular) and `client/src/pages/__tests__/AdminPage.test.jsx` (035's URL-keyed `mockGet`).
      (c) Confirm
      no migration is needed: `agent_delegations`, `registered_agents`, `mcp_api_tokens`,
      `agent_activity_log` and the `users` onboarding columns all exist as
      [data-model.md](./data-model.md) describes.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: none. Deliberately empty — 036 adds no schema, no shared module, and no
infrastructure. There is nothing that must exist before US1 can start beyond T001's check. Stated
explicitly so its absence reads as a decision, not an omission.

---

## Phase 3: User Story 1 — Admin inspects one user's agent connections and keys (Priority: P1) 🎯 MVP

**Goal**: expanding a user's row shows every delegation and every `sk_sqd_` token that account has
ever held — with agent name, scopes, timestamps, state, and mint path — without a psql session.

**Independent test**: seed one user with an active delegation, a revoked delegation with no
catalog link, an active interactive token, an agent-minted token and an expired token; expand
their row and see all five with correct names, scopes, timestamps, state labels and mint paths.
Expand a user with no agent history and see a clear empty state.

- [ ] T002 [US1] Add `GET /users/:userId/adoption` to `server/api/admin.js`, beside the existing
      `GET /users/:userId/sharing` and matching its shape. This task delivers the credentials half:
      a UUID-shape guard on `:userId` returning `404 { error: 'User not found' }` (RBD-11); an
      existence check on `users` returning the same `404`; a delegations query
      (`agent_delegations d LEFT JOIN registered_agents ra ON ra.id = d.agent_client_id`,
      `WHERE d.user_id = $1`, `ORDER BY d.created_at DESC`) and a tokens query (`mcp_api_tokens`,
      `WHERE user_id = $1`, `ORDER BY created_at DESC`), both with the **explicit column lists**
      from [data-model.md](./data-model.md); a `try/catch` logging
      `[Admin] Error fetching agent adoption detail:` and returning `500`. **Do not** call
      `delegation.listUserDelegations()` or `apiTokens.listUserTokens()` and **do not** widen them
      — research R2 explains why (the first is `SELECT *` and carries `refresh_token_hash`; both
      filter out the revoked/expired rows FR-003 requires). **No `SELECT *` anywhere.** Add a
      comment at each query naming the forbidden columns so a future editor sees the rule at the
      point of temptation.
- [ ] T003 [US1] In the same handler, derive and serialise the credential fields per
      [contracts/admin-adoption-api.md](./contracts/admin-adoption-api.md): `state`
      (`revoked_at` → `revoked`, else `expires_at <= now()` → `expired`, else `active`),
      `agentName` (`registered_agents.name` when joined, else the delegation's self-reported
      `agent_name` — FR-004), `mintedBy` (`agent` when either `minted_by_*` is non-null, else
      `interactive`) plus both nullable parent ids, and camelCase timestamps. Build the response
      from **explicit object literals** — never spread a database row.
- [ ] T004 [US1] Create `server/__tests__/admin-agent-adoption.test.js` covering the credentials
      payload against seeded state: the delegations present with the registry name and the
      self-reported fallback respectively (FR-004) — seed **three**: an active catalog-linked one,
      a revoked unlinked one, and one with `expires_at` in the past and `revoked_at NULL`, so the
      `expired` state is exercised on delegations and not only on tokens — all three tokens
      present with correct
      `state`/`mintedBy`/`tokenPrefix`, revoked and expired rows **included** and labelled
      (FR-003), newest-first ordering, and a second user returning `{ delegations: [], tokens: [] }`
      rather than an error (FR-012). Model the harness on
      `server/__tests__/admin-auth-capture.test.js`: real `pool` from
      `server/__tests__/helpers/db.js`, `admin.init(pool)`, and cleanup by email suffix in
      `afterAll`. Seed `mcp_api_tokens.token_hash` and `agent_delegations.refresh_token_hash` with
      recognisable literal values — T012 asserts they never appear in a response.
- [ ] T005 [US1] Wire the lazy fetch in `client/src/pages/AdminPage.jsx`: `adoption` +
      `adoptionLoading` + `adoptionError` state, a third `api.get('/api/admin/users/${userId}/adoption')`
      inside the existing `toggleExpand` alongside the extra-credits and sharing fetches (its own
      loading flag, its own `.catch()` setting the error sentinel — **not** an empty fallback,
      RBD-12), and clearing all three on collapse. Do not touch the two existing fetches, and do
      not add anything to the list load (FR-007).
- [ ] T006 [US1] Render the **Agent access** section in `client/src/pages/AdminPage.jsx` as a new
      `.admin-detail-section` placed after the existing sections (and after 035's assistant-model
      control): sub-heading `Connected agents` (table: agent, scopes, created, last used, state
      badge; the `agentClientId` as sub-text so a self-reported name is visibly unbacked) and
      sub-heading `API tokens` (table: name, prefix, scopes, created, last used, expires, state
      badge, minted-by). Reuse `.admin-credits-table`, `.admin-status-badge`,
      `.admin-detail-empty`, `.admin-detail-loading`. Copy is contractual — empty states
      `No agent connections.` / `No API tokens.`, failure state `Couldn't load agent detail.`
      **All name fields are attacker- or user-supplied**: render as React text children only,
      never `dangerouslySetInnerHTML` — carry a comment saying so, as the 034 user-agent cells do.
- [ ] T007 [P] [US1] Add the single additive `.admin-status-revoked` rule to
      `client/src/pages/AdminPage.css` (neutral treatment — `var(--surface-sunken)` /
      `var(--text-secondary)`, matching the existing badge rules), placed beside
      `.admin-status-active` / `.admin-status-expired` / `.admin-status-depleted`. **Do not add a
      `.admin-detail-note` rule** — 035 introduces one (verified in its working diff, 2026-07-26)
      and US2's activity note reuses it. Check first; if 035's rule is absent after the rebase, add
      it then. Additive only; change no existing rule.
- [ ] T008 [US1] Extend `client/src/pages/__tests__/AdminPage.test.jsx` with an "agent access"
      describe block: **extend** the existing URL-keyed `mockGet` with the adoption URL (do not
      rewrite the file or replace 035's fixtures), then assert the two tables render from a mocked
      payload with the right state badges and mint labels, the empty payload renders the empty
      states, and a delegation named `<img src=x onerror=alert(1)>` renders as literal text.
      **Also assert the negative half of FR-007**: after the page loads and before any row is
      expanded, `mockGet` has been called for `/api/admin/users` but **never** for an
      `.../adoption` URL — the requirement is "not bulk-loaded", and only a negative assertion
      can prove that.

**Checkpoint**: US1 is independently shippable — the connection/keys question is answered.

---

## Phase 4: User Story 2 — Admin sees onboarding state and activity at a glance (Priority: P2)

**Goal**: the same expanded row also says how the account signed up, whether it got onboarded,
whether it authored anything beyond the welcome doc, whether the welcome email went out, and how
much OAuth-delegated agent activity is on record.

**Independent test**: seed users at assorted stages (fresh signup, onboarded, authored a real doc,
`agent_oauth` signup, welcome-email sent/unsent, with and without activity rows) and verify each
expanded row reports the correct fields — including the zero-activity case.

- [ ] T009 [US2] Extend the `GET /users/:userId/adoption` handler in `server/api/admin.js` with
      the `onboarding` block: one query on `users` selecting `created_at`, `signup_source`,
      `onboarded_at`, `welcome_email_sent_at`, plus an `EXISTS` over `document_shares`
      (`user_id = $1 AND role = 'owner'`, excluding `welcome_doc_id` when it is non-null) as
      `authored_non_welcome_doc` — one row, no second round trip. This query doubles as the
      existence check from T002. Comment the deliberate divergence from `onboarding.js`
      `isEngaged()` (which additionally requires persisted content) per RBD-10.
- [ ] T010 [US2] Extend the same handler with the `activity` block:
      `SELECT COUNT(*)::int AS count, MAX(created_at) AS last_activity_at FROM agent_activity_log
      WHERE user_id = $1` → `{ count, lastActivityAt }`. **`metadata` must not appear in the
      SELECT list** — it stores raw tool arguments (user content). Comment that this table covers
      delegation-authenticated MCP calls only, so the number is not total agent usage.
- [ ] T011 [US2] Extend `server/__tests__/admin-agent-adoption.test.js` with the onboarding and
      activity assertions: `signupSource` / `createdAt` / `onboardedAt` / `welcomeEmailSentAt`
      pass through exactly (null where unset, no fabrication); `authoredNonWelcomeDoc` is `false`
      for a user whose only owned doc is the welcome doc and `true` once they own another (assert
      **both** directions — FR-005/US2 scenario 2); `activity` returns the seeded count and the
      newest timestamp; a user with no log rows returns `{ count: 0, lastActivityAt: null }`
      rather than an error (US2 scenario 4).
- [ ] T012 [US2] Render the **Onboarding** section in `client/src/pages/AdminPage.jsx`: a `<dl>`
      reusing `.admin-origin-list` with Signup source / Signed up / Onboarded (`Not yet` when
      null) / `Owns a doc besides the welcome doc` (Yes/No — this exact label, **not**
      "engaged"/"activated", per RBD-10) / Welcome email (`Not sent` when null); then the activity
      line under the heading `Agent sessions (OAuth-delegated MCP calls)` with the note
      `API-token and REST traffic are not logged — see each token's Last used.` The heading and
      note wording is contractual (FR-006) — it is what keeps a zero from reading as "this user
      does nothing".
- [ ] T013 [US2] Extend `client/src/pages/__tests__/AdminPage.test.jsx` with onboarding/activity
      render assertions, including the `Not yet` / `Not sent` null renderings, the Yes/No
      predicate, and an explicit assertion that the honest activity label and its note are present
      in the DOM (a regression here is silent and misleading, which is exactly why it is pinned).

**Checkpoint**: US1 + US2 — the full "did this account get anywhere?" picture.

---

## Phase 5: User Story 3 — The detail surface is read-only and leaks nothing (Priority: P3)

**Goal**: prove the invariants rather than assert them. Each task below prevents a specific,
plausible regression.

**Independent test**: exercise the endpoint and find no secret material anywhere in the payload,
no mutation operation on the surface, and no database write attributable to viewing it.

- [ ] T014 [P] [US3] Add the secret-material scan to `server/__tests__/admin-agent-adoption.test.js`:
      stringify the whole `200` body for a user seeded with every credential shape and assert it
      contains none of `token_hash` / `tokenHash` / `refresh_token_hash` / `refreshTokenHash` /
      `client_secret_hash` / `clientSecretHash` / `metadata`, none of the literal hash values
      seeded in T004, no `sk_sqd_`-shaped full token, and — as the catch-all for a column added
      later — **no 64-character hex string** (`/[0-9a-f]{64}/i`). FR-009, SC-003.
- [ ] T015 [P] [US3] Add the gate tests to the same suite, mounting the router the way
      `server/index.js` does — `app.use('/api/admin', requireAdmin, admin.router)` — per the
      exemplar `server/__tests__/admin-auth-capture.test.js`: a signed-in **non-admin** gets `403`
      with no adoption data in the body, and an **unauthenticated** caller gets `401`. A
      bare-router mount would answer `200` here and make both assertions vacuous; carry a comment
      saying so. Also assert `404` for an unknown UUID and `404` (not `500`) for a malformed
      `:userId` (RBD-11). FR-008.
- [ ] T016 [P] [US3] Add the zero-writes test to the same suite: snapshot `count(*)` for
      `agent_delegations`, `mcp_api_tokens`, `agent_activity_log`, plus the seeded user's
      delegation `last_used_at` and token `last_used_at`; issue the request several times; assert
      every value is byte-identical afterwards. FR-011, SC-004. Additionally assert the module
      exports no new mutation route by checking that a `POST`/`PATCH`/`PUT`/`DELETE` to
      `/api/admin/users/:userId/adoption` returns `404` from the router. FR-010.
- [ ] T017 [US3] Verify failure isolation (FR-012) in
      `client/src/pages/__tests__/AdminPage.test.jsx`: with the adoption fetch rejecting and the
      other two resolving, the expanded row still renders the sharing tables, the extra-credits
      table and the sign-in-origin block, and shows `Couldn't load agent detail.` in the agent
      section only — distinct from the loaded-but-empty rendering (RBD-12).

**Checkpoint**: all three stories complete; invariants pinned.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T018 Record the owed documentation pass for the merge queue (do **not** edit the files):
      `README.md` line 33 enumerates Admin Area capabilities and must gain the per-user agent
      connection / onboarding detail alongside "reviewing a user's sharing activity". `docs/dev.md`
      was checked and owes nothing; `design/agent-surface-mcp.md` is already amended for 036 and
      needs no change. Constitution Principle I is not satisfied until the README edit lands.
- [ ] T019 Run the suites and report results: `npm run test:server -- admin-agent-adoption`, then
      the neighbouring admin suites (`admin-auth-capture`, `admin-sharing`, `admin-welcome-email`)
      to prove no regression, then
      `npm run test:client -- src/pages/__tests__/AdminPage.test.jsx` (use the npm script, not a
      bare `vitest` invocation — the constitution requires the LLM reporters stay wired). Backend runs are
      **serial** — never launch a second backend run concurrently against `collab_test_db`.
- [ ] T020 Walk [quickstart.md](./quickstart.md) §3–§6 against the dev app: both user stories in
      the browser, the `curl` + `grep` leak check, the repeated-request write check, the untrusted
      `agent_name` render, and the SC-005 expand latency. Record anything the automated suites
      could not cover (visual density of the two tables in the expanded row; dark-mode legibility
      of the new `.admin-status-revoked` badge) as owed manual checks for Sam.

---

## Dependencies

- **T001 blocks everything** (queue precondition + seam re-read).
- **US1 (T002–T008)**: T002 → T003 → T004; T002 → T005 → T006 → T008; T007 is independent of the
  JSX work and can land any time after T001.
- **US2 (T009–T013)**: T009/T010 extend the T002/T003 handler, so they follow US1's server tasks;
  T012 follows T006 (same section container); T011 and T013 follow their respective code tasks.
- **US3 (T014–T017)**: T014/T015/T016 need the full payload (US1 + US2 complete) to be meaningful;
  T017 needs T005/T006.
- **Polish (T018–T020)**: after all stories.

Story order is strictly US1 → US2 → US3, because US2 extends the same endpoint and section US1
creates and US3 asserts over the finished payload. Within a story, `[P]`-marked tasks touch
different files and may run concurrently.

## Implementation Strategy

**MVP = US1** (T001–T008): the endpoint plus the connected-agents/API-tokens tables. That alone
retires the psql session for the question the feature was asked for.

**Increment 2 = US2** (T009–T013): onboarding and the activity summary in the same panel.

**Increment 3 = US3** (T014–T017): the invariant suite. It is listed last because it asserts over
the finished payload — **not** because it is optional. Landing US1/US2 without T014–T016 would
ship a reporting surface over three hash-bearing tables with no structural proof that it stays
leak-free, which is the one outcome this feature cannot afford.

**Total: 20 tasks** — US1: 7 (T002–T008), US2: 5 (T009–T013), US3: 4 (T014–T017), setup 1,
polish 3.
