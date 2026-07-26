# Implementation Plan: Admin Per-User Agent Connection & Onboarding Detail

**Branch**: `036-admin-adoption-reporting` (feature id only — work stays on `main` per the parallel-agent overrides) | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/036-admin-adoption-reporting/spec.md`

**Design ground truth**: `design/agent-surface-mcp.md` — section "Admin visibility: adoption and connection state (036)", including its four invariants (read-only; never exposes secret material; request-time computation with no new write path; the activity-coverage paragraph) and the **DEFERRED** marker on the deployment-wide rollups; plus the Admin area capabilities sentence in `design/authentication-and-sharing.md`. Constitution Principle VI: where this plan and those documents disagree, the documents win. Open decisions are RATIFIED-BY-DEFAULT in [clarifications-needed.md](./clarifications-needed.md) (Sam pre-authorized, 2026-07-26); this plan adds RBD-8..RBD-12 there.

**Note on the design ledger**: the spec-phase ledger flagged the design doc as not yet amended. Re-checked at plan time — **the amendment has landed**: the export now marks the rollups deferred, itemises the onboarding fields, and carries the activity-coverage paragraph. Two of the four spec-phase design gaps are therefore closed; the addendum in the ledger records this so the closure is not mistaken for drift.

## Summary

One read-only admin endpoint and one panel in an expanded row that already exists. No schema, no migration, no new module, no new dependency, no write path of any kind.

The whole feature is two edited source files plus one additive CSS rule:

1. **`server/api/admin.js`** — a new `GET /users/:userId/adoption` handler beside the existing `GET /users/:userId/sharing`, whose shape it copies: one endpoint, several parameterised queries inside, one composed JSON payload, one `try/catch` logging `[Admin] …`. Four reads: delegations `LEFT JOIN registered_agents` (explicit columns), tokens (explicit columns), the user's onboarding row with an `EXISTS` for non-welcome document ownership, and a `COUNT(*)/MAX(created_at)` aggregate over `agent_activity_log`. State (`active`/`revoked`/`expired`) and mint path (`agent`/`interactive`) are derived in the handler; the response is built from explicit object literals.
2. **`client/src/pages/AdminPage.jsx`** — a third lazy fetch inside the existing `toggleExpand`, with its own loading flag and its own `.catch()`, and two new `.admin-detail-section` blocks rendering: connected agents, API tokens, onboarding state, and the activity summary under a heading that says what it actually measures.
3. **`client/src/pages/AdminPage.css`** — exactly one additive rule, `.admin-status-revoked`. Everything else reuses classes that already exist: `.admin-credits-table`, `.admin-status-badge`, `.admin-origin-list`, `.admin-detail-empty`, and `.admin-detail-note` (which **035 adds** — verified in its working diff on 2026-07-26, so 036 must reuse it, not redeclare it).

Load-bearing invariants, each with its own test: **no secret material** anywhere in the payload (explicit column lists — `SELECT *` is banned here because these tables carry `token_hash`, `refresh_token_hash` and `client_secret_hash`); **no writes at all** (row counts and `last_used_at` unchanged across repeated views); **non-admins cannot reach it** (asserted behind the *real* `requireAdmin`, mounted the way `server/index.js` mounts it — a bare-router 403 test would be vacuous); **lifetime listing** (revoked and expired rows present and labelled, not filtered out); and **the activity count is labelled for what it covers**, never presented as total agent usage.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server), React 18 (client). No new language or runtime.

**Primary Dependencies**: Existing only — `express`, `pg` (parameterised queries on the shared pool). **No new production dependency and no new module**: every edit lands in a file that already exists.

**Storage**: PostgreSQL, read-only. Tables touched: `agent_delegations`, `registered_agents` (join target), `mcp_api_tokens`, `agent_activity_log` (aggregate), `users`, `document_shares` (`EXISTS`). **No migration** — schema verified against `migrations/` and the dev database on 2026-07-26; every column this feature needs already exists and is indexed for the access pattern (`idx_agent_delegations_user`, `idx_mcp_api_tokens_user_id`, `idx_agent_activity_user_time`). No Redis, no S3, no pgvector.

**Testing**: Backend Jest, run **serially** against the shared `collab_test_db` (Constitution Principle II; `npm run test:server` → `jest --runInBand`), DB access via `server/__tests__/helpers/db.js`, seeded rows cleaned up by email suffix in `afterAll` as the existing admin suites do. Client: Vitest (`client/src/pages/__tests__/`). New suite: `server/__tests__/admin-agent-adoption.test.js` (DB + the real `requireAdmin`, modelled on `admin-auth-capture.test.js`). Extended: `client/src/pages/__tests__/AdminPage.test.jsx`.

**Target Platform**: Linux server (Minikube `app-dev` pod for dev; hardened k3s cluster in prod).

**Project Type**: Web application — Express backend (`server/`) + React frontend (`client/`).

**Performance Goals**: SC-005 — under 1 s from expand to rendered detail at beta scale. Four index-served queries per expand, one round trip, no work on the list load (the `GET /users` query is not touched at all, so the list cannot get slower). Volume is bounded by the existing per-user token cap (250) and a handful of delegations; the activity read returns exactly one aggregate row regardless of log size.

**Constraints**:

- **READ-ONLY, absolutely**: no revoke, no mint, no edit, no counter, no view log, no `last_viewed_at`. `SELECT` only.
- **No `SELECT *`** in any query this feature adds, and no spreading of a database row into a response object.
- `agent_activity_log.metadata` and `agent_delegations.agent_metadata` are never selected — exclusion at the SQL level, not at serialisation.
- The existing helpers `delegation.listUserDelegations()` and `apiTokens.listUserTokens()` **must not** be reused (research R2: the first is `SELECT *` and so carries `refresh_token_hash`; both filter revoked/expired rows out, the opposite of FR-003) and **must not** be widened for this feature — that would change behaviour on user-facing MCP routes.
- **Diff stays tight and additive**: no restructuring of the admin page, the user table, `toggleExpand`'s existing two fetches, or any existing endpoint. `GET /users` is not modified.
- `README.md`, `docs/dev.md`, `CLAUDE.md` and `design/` are off-limits to this feature's agents (assignment override); owed doc touches are named for the merge-queue docs pass, not resolved here.
- **Queued behind 035** — see the sequencing section below.

**Scale/Scope**: Beta-scale (tens of accounts). Footprint: 1 new endpoint, 2 edited source files, 1 additive CSS rule, 1 new test file, 1 extended test file. Zero migrations.

## Sequencing: this feature is QUEUED behind 035

Feature 035 (per-user chat model override) edits **the same** files 036 edits — `server/api/admin.js`, `client/src/pages/AdminPage.jsx`, `client/src/pages/AdminPage.css`, `client/src/pages/__tests__/AdminPage.test.jsx` — and merges first.

**Status at the end of planning (2026-07-26): 035 has landed on `main`** (commit `03188de`, "Surface pinned models in the admin list and land the 035 review fixes") — verified: `PATCH /users/:userId/chat-model` and `chatModelOverride` are in `admin.js`, the assistant-model picker is in the expanded row, and `.admin-detail-note` is in the CSS. The queue precondition is therefore satisfied; the re-read requirements below still stand, because more may have landed between planning and implementation. The implementer MUST:

1. **Start from a `main` that contains `03188de` or later.** Do not start from the pre-035 tree.
2. **Re-read both files from disk at start.** Nothing in this plan cites line numbers, and nothing should: both files were under concurrent edit while it was written. The plan cites *behaviour and patterns* (`GET /users/:userId/sharing`'s shape, `toggleExpand`'s two independent fetches, the `.admin-detail-section` blocks, the `[Admin] …` catch style) — locate those, then match them.
3. Expect, post-035: a `chatModelOverride` field on the `GET /users` row, a `PATCH /users/:userId/chat-model` handler in `admin.js`, and an "Assistant model" `<select>` inside the expanded detail row. **Place the 036 sections after those; change none of them.**
4. Expect `client/src/pages/__tests__/AdminPage.test.jsx` to contain 035's picker tests and a `mockGet` implementation keyed by URL — **extend** that mock with the new URL and **add** a describe block; do not rewrite the file or replace the fixtures.
5. If 035 has *not* merged when implementation starts, stop and report rather than working around it — two agents editing the same two files concurrently is exactly the conflict the queue exists to prevent.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

- **I. Documentation Reflects Reality** — `README.md` line 33 enumerates Admin Area capabilities ("viewing user stats …, reviewing a user's sharing activity …, setting the shared assistant's default AI model, pinning a per-user model override …") and goes stale the moment this lands: the per-user agent-connection/onboarding detail is a new admin capability and belongs in that sentence. `README.md` is off-limits to this agent, so the edit is **work owed to the merge-queue docs pass**, named explicitly in T018 rather than left implicit. `docs/dev.md` was checked — it documents the dev loop, not admin capabilities, and owes nothing. `design/` is already correct and amended for 036 (see the note above). **PASS (with flagged owed doc pass).**
- **II. Test-Backed Changes** — every behavioural change is test-backed: credential listing with lifetime semantics and correct state labels, mint-path derivation, registry-name fallback, onboarding fields, the authored-doc predicate both ways, the activity summary including the zero case, empty states, the non-vacuous 403/401, `404` for unknown/malformed ids, secret-material absence across the whole payload, and zero writes. Backend suites run serially against the shared DB. No format-registry or serialization surface is touched, so `format-roundtrip.test.js` is untouched by construction. **PASS.**
- **III. Trunk-Based Solo Workflow** — stay on `main`, never branch, never commit (assignment override). No new module, no new script, no abstraction layer: one handler beside its siblings and one panel beside its siblings. The rollup surface that would have justified a service layer is explicitly deferred; YAGNI honoured (research R1 rejects four endpoints, data-model rejects pagination). **PASS.**
- **IV. Collaboration-Safe Document Operations** — not applicable: no Yjs, no document mutation, no format registry, no attribution surface. The only document-adjacent read is an `EXISTS` over `document_shares`. **PASS (N/A).**
- **V. Secure by Default for Agent & User Content** — this is the principle the feature lives or dies on, and it cuts three ways. (a) **Exposure**: the endpoint sits under the already-`requireAdmin`-gated `/api/admin` mount and its 403/401 are asserted with the real middleware mounted, not a bare router. (b) **Secret material**: three of the tables read carry hashes (`token_hash`, `refresh_token_hash`, `client_secret_hash`); the defence is structural — explicit column lists, explicit response literals, no reuse of the `SELECT *` helper, plus a test that scans the serialised body for hash-shaped fields and for the seeded hash values themselves. `metadata` (raw tool arguments — user content) is excluded in SQL. (c) **Untrusted strings**: `agent_delegations.agent_name`/`agent_id` are **self-reported by the OAuth client** (dynamic registration is open) and token `name` is user-supplied — attacker-controlled text on an admin page, exactly like the user-agents feature 034 surfaced here. They are bound parameters in SQL and React text children in the DOM; never `dangerouslySetInnerHTML`. No new ingestion surface, no new trust boundary, no new credential path, and — by FR-010 — no new privileged mutation over other people's credentials. **PASS.**
- **VI. Design Docs Are Ground Truth** — the plan implements the design section verbatim: per-user detail in the expanded row; delegations with name/scopes/created/last-used/revoked-expired; tokens with name/prefix/scopes/timestamps/mint path; onboarding as `onboarded_at` + authored-a-doc + `signup_source` + welcome-email; read-only; never secret material; request-time computation with no new write path; rollups **not** built (deferred). The activity-coverage paragraph is implemented as an explicit labelling requirement rather than quietly followed. No new divergence is introduced; plan-level defaults are recorded as RBD-8..RBD-12. **PASS.**

**Initial gate: PASS.** No violations requiring Complexity Tracking.

**Post-Phase-1 re-check: PASS.** Phase 1 added no dependency, no module, no endpoint beyond the single GET, and no constitutional exception. The five plan-level decisions taken during design (one endpoint and its name; server-side `state` derivation; mint-path ids alongside the label; the ownership predicate and its stated divergence from `isEngaged()`; `404` on a malformed id) are all inside existing conventions and are recorded as RBD-8..RBD-12. Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/036-admin-adoption-reporting/
├── plan.md                     # This file
├── research.md                 # Phase 0 — the eight decisions that shaped the design
├── data-model.md               # Phase 1 — every column read, every column deliberately not read
├── contracts/
│   └── admin-adoption-api.md   # GET /api/admin/users/:userId/adoption + client contract + forbidden fields
├── quickstart.md               # Phase 1 — runnable validation walk
├── clarifications-needed.md    # RBD ledger (exists; extended with RBD-8..RBD-12 + design-amendment addendum)
├── checklists/requirements.md  # (exists)
├── spec.md                     # (exists)
└── tasks.md                    # /speckit-tasks output
```

### Source Code (repository root)

```text
server/
├── api/
│   └── admin.js                              # EDIT — NEW GET /users/:userId/adoption (read-only)
└── __tests__/
    └── admin-agent-adoption.test.js          # NEW — payload correctness, 403/401 behind real requireAdmin,
                                              #       secret-material absence, zero-writes

client/src/pages/
├── AdminPage.jsx                             # EDIT — third lazy fetch on expand + "Agent access" and
│                                              #        "Onboarding" sections in the existing detail row
├── AdminPage.css                             # EDIT — one additive rule: .admin-status-revoked
                                              #        (.admin-detail-note comes from 035 — reuse it)
└── __tests__/AdminPage.test.jsx              # EDIT — new describe block: sections, empty state,
                                              #        honest activity label, failure isolation
```

**Structure Decision**: the existing web-app layout is used as-is and **no new source module is created**. The endpoint belongs in `admin.js` because that file already owns every `/api/admin/users/:userId/*` read and its two siblings define the exact pattern this one follows; extracting an "adoption service" would split one handler across two files for no second consumer. The panel belongs in the expanded detail row in `AdminPage.jsx` — the established home for per-user admin detail (trusted flag, 034's sign-in origin, sharing, extra credits, and post-035 the assistant model) — which is also what the design document specifies. The migrations directory is untouched by design.

## Phase Overview

- **Phase 0 — Research** (`research.md`): eight decisions — one endpoint vs four and its name; why the existing list helpers are unusable and `SELECT *` is banned; server-side state derivation; mint-path representation; the registry-name fallback and the untrusted-string consequence; the activity aggregate and its honest label; the authored-a-doc predicate and its deliberate divergence from `isEngaged()`; failure isolation and the not-found path.
- **Phase 1 — Design & Contracts** (`data-model.md`, `contracts/`, `quickstart.md`): every column read and every column deliberately not read, the derived values and lifecycle gotchas, the full request/response contract with its forbidden-fields list and required UI copy, and a runnable validation walk covering all three user stories.

## Risks & Owed Follow-ups

| Risk / owed item | Handling |
|---|---|
| **`README.md` line 33 goes stale** — the Admin Area capability sentence will not mention per-user agent connection/onboarding detail | `README.md` is off-limits to this agent (assignment override) → **merge-blocking work owed to the merge-queue docs pass**, named in T018. Constitution Principle I is not satisfied until it lands. `docs/dev.md` checked, owes nothing. |
| **All four target files are under concurrent edit by 035** — `server/api/admin.js`, `client/src/pages/AdminPage.jsx`, `client/src/pages/__tests__/AdminPage.test.jsx` **and** `client/src/pages/AdminPage.css` (035's working diff adds `.admin-badge-model`, `.admin-detail-error`, `.admin-detail-note`) | Handled by the queue: rebase onto post-035 `main`, re-read all four, place new code after 035's, extend (never replace) the client test fixtures, and **reuse** 035's `.admin-detail-note` rather than redeclaring it (T007). T001 is that check and is blocking. |
| **A `SELECT *` creeps in during implementation or a later edit**, leaking `refresh_token_hash`/`token_hash` | Three layers: the ban is stated in the plan, the contract and the data model; the response is built from explicit literals; and a test scans the whole serialised body for hash-shaped names, for the literal seeded hash values, and for any 64-char hex string. |
| **Pre-existing (out of scope)**: `GET /mcp/auth/delegations/:userId` returns `SELECT *` rows, so a user can read their own `refresh_token_hash` | Self-only exposure, predates 036, and fixing it means editing user-facing MCP routes — outside this feature's tight-diff constraint. **Recorded as a follow-on ticket in the ledger**, deliberately not fixed here, and explicitly *not* copied into the admin payload. |
| **The activity count reads as zero for token-only users** | Not a defect — a coverage boundary of the log (design-documented). Mitigated by required copy: the heading names OAuth-delegated MCP calls and the note points at each token's `Last used`. The wording is part of the contract precisely so a later UI tidy-up cannot quietly drop it. |
| **`authoredNonWelcomeDoc` can disagree with `onboardedAt`** (owns an empty doc) | Deliberate (RBD-10): spec-pinned ownership notion, consistent with the `Docs` column on the same row. Both fields are displayed and the label says "Owns a doc besides the welcome doc", not "engaged". Listed as a MEDIUM in the analysis report. |
| **Deployment-wide rollups will be asked for eventually** | Deferred by Sam, marked DEFERRED in the design doc. The per-user path (`/users/:userId/adoption`) leaves `/api/admin/adoption` free for them; the "ever connected" definition (RBD-6) is written to carry forward unchanged. Nothing is built for it now. |
