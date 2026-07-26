# Implementation Plan: Per-User Chat Model Override

**Branch**: `035-per-user-model-override` (feature id only — work stays on `main` per the parallel-agent overrides) | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/035-per-user-model-override/spec.md`

**Design ground truth**: `design/in-app-ai-assistant.md` — the amended "Model resolution" sentence (`active BYOK choice → admin-set per-user override (users.chat_model_override) → admin-set shared default (app_settings) → env → built-in default`) and the "Per-user model override (035)" paragraph; plus the Admin area capabilities list in `design/authentication-and-sharing.md` (which already names "pinning a per-user chat model override"). Constitution Principle VI: where this plan and those documents disagree, the documents win. Open decisions are RATIFIED-BY-DEFAULT in [clarifications-needed.md](./clarifications-needed.md) (Sam pre-authorized, 2026-07-25); design gaps stay flagged there, never silently resolved.

## Summary

Give the admin one nullable column on `users`, one slot in the model-resolution chain, one admin endpoint, and one picker in the admin user list's expanded row. Everything else — eligibility, metering, BYOK behavior, the shared default — is reused verbatim.

The whole feature is five small, additive edits plus one migration:

1. **One migration** (`migrations/1799500000000_add-chat-model-override-to-users.js`): a single nullable `users.chat_model_override text` column. No default, no backfill, no CHECK constraint (the legal values are a *code-side* registry — see research R2). NULL is the universal, dynamic "follow the shared default" state (FR-001/FR-004).
2. **One resolution helper** (`server/api/chat-models.js`): `resolveUserChatModelKey(overrideKey, sharedDefaultKey)` — returns the override when `isSharedEligible(overrideKey)`, otherwise warns once and delegates to the existing `resolveSharedDefaultKey(sharedDefaultKey)`. `resolveChatModel` gains one optional `userOverrideKey` parameter and its **non-BYOK branch only** swaps `resolveSharedDefaultKey(...)` for `resolveUserChatModelKey(...)`. The BYOK branch — including the `byok_misconfigured` early return — is not touched, by construction (FR-003). `isSharedEligible` is added to the module exports so write-time validation and resolution-time fallback are literally the same predicate (FR-005).
3. **One column added to the per-turn user-row read** (`server/api/byok-settings.js`): `loadByokSettings` already `SELECT`s the user's per-turn settings row on every chat turn; `chat_model_override` joins that column list. This is what makes "next turn, no cache, no re-login" (FR-012) true without any new machinery. `buildResponse` — the client-facing BYOK payload — builds an explicit key set and therefore cannot leak the new column (FR-011); a test pins that.
4. **One line at the single call site** (`server/api/chat.js:~860`): `userOverrideKey: byokSettings?.chat_model_override || null`.
5. **Admin surface** (`server/api/admin.js` + `client/src/pages/AdminPage.jsx`): `GET /users` carries `chatModelOverride`; a new `PATCH /users/:userId/chat-model` sets (validated) or clears (`null`) it; the admin page's existing expanded detail row gains an "Assistant model" `<select>` built from the **same** `GET /settings/shared-model` payload (`models` + `providers`) the shared-default picker already fetches on mount, so the two pickers cannot drift (RBD-3). A stored-but-ineligible value renders as the same disabled `"<key> (unavailable — using <label>)"` option the shared-default picker already uses (RBD-4/FR-010).

Load-bearing invariants, each with its own test: **BYOK wins** over an override; **`byok_misconfigured` never falls back** to the override or the shared key; a stale override **never fails a chat** and is **never auto-cleared** (RBD-2); the override is **never visible to the user it applies to** (FR-011); non-admins **cannot reach** the management endpoint (tested behind the *real* `requireAdmin`, mounted as `server/index.js` mounts it — a bare-router 403 test would be vacuous).

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server), React 18 (client). No new language or runtime.

**Primary Dependencies**: Existing only — `express`, `pg` (parameterized queries on the shared pool), `node-pg-migrate` (schema). **No new production dependency**, no new module: every edit lands in a file that already exists.

**Storage**: PostgreSQL — one nullable `text` column on `users`. No new table, no index (the column is only ever read by primary-key lookup on the row the chat turn already loads). No Redis, no S3, no pgvector involvement.

**Testing**: Backend Jest, run **serially** against the shared `collab_test_db` (Constitution Principle II; `npm run test:server` → `jest --runInBand`). Test DB access via `server/__tests__/helpers/db.js`. Client: Vitest (`client/src/pages/__tests__/`). New suites: `server/api/__tests__/chat-model-override.test.js` (pure unit — precedence + eligibility, no DB), `server/__tests__/chat-model-override-wiring.test.js` (the chat.js → resolveChatModel argument seam, mock harness copied from `chat-reservation-release.test.js`), `server/__tests__/admin-chat-model-override.test.js` (DB + the real `requireAdmin`). Extended: `server/__tests__/byok-settings.test.js` (non-disclosure), `client/src/pages/__tests__/AdminPage.test.jsx` (picker states).

**Target Platform**: Linux server (Minikube `app-dev` pod for dev; hardened k3s cluster in prod).

**Project Type**: Web application — Express backend (`server/`) + React frontend (`client/`), schema in `migrations/`.

**Performance Goals**: Zero added latency on the chat path. The override rides an *already-executing* per-turn `SELECT` (one more column, no extra round trip) and resolution stays a synchronous in-memory registry lookup. The admin picker adds no new fetch — it reuses the `sharedModel` payload the page already loads and the `chatModelOverride` field on the `GET /users` row it already renders.

**Constraints**:

- New migration timestamp MUST exceed `1799400000000` (`add-auth-ip-capture`, the current latest) and trivially clears the stale `>1795000000000` rolled-back-008 floor. 035 is the only migration-bearing feature in flight, so `1799500000000` is uncontested.
- **No refactor of `resolveChatModel` beyond the added parameter/slot** (assignment constraint). The BYOK branch keeps byte-for-byte behavior; the new helper is additive.
- Eligibility MUST be the single derived predicate `isSharedEligible` (registry entry + `hasServerKey(provider)`); no second list, no DB-side enum.
- The override MUST NOT be auto-cleared at resolution time (RBD-2) and MUST NOT fail a turn (FR-006).
- Auxiliary models (`getCompactionModel`, `getContextualizerModel`, `getThinkingSummaryModels`) are separately fixed and MUST remain untouched (FR-013) — verified: none of them consults the shared default or any user row.
- `README.md`, `docs/dev.md`, and `CLAUDE.md` are off-limits to this feature's agents (assignment override); any owed doc touch is flagged for the merge-queue docs pass, not resolved here.

**Scale/Scope**: Beta-scale (low hundreds of accounts), of which a handful will ever carry an override. Footprint: 1 new migration, 4 edited server files, 1 edited client file, 3 new + 2 edited test files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

- **I. Documentation Reflects Reality** — the design docs are already amended and correct for 035 (the "Model resolution" sentence names `users.chat_model_override`; the Admin area list names the capability), so no design-doc *divergence* is created. `README.md` **does** enumerate both the resolution chain (lines ~273/~557) and the Admin Area capability list (line ~33), and both go stale the moment this feature lands; `README.md` is off-limits to this agent, so that edit is **merge-blocking work owed to the merge-queue docs pass**, named line-by-line in T021 rather than left implicit. `docs/dev.md` was checked and owes nothing. Three non-blocking design-paragraph amendments remain flagged in the ledger (write-time validation, stale-override retention, UI placement). **PASS (with flagged owed doc pass).**
- **II. Test-Backed Changes** — every behavioral change is test-backed: precedence (BYOK > override > shared default > env > built-in), dynamic default-follow, eligibility fallback with warning, no auto-clear, write-time validation (accept/reject agreeing with `isSharedEligible` across the *whole* registry), admin-only enforcement behind the real gate, non-disclosure on the user-facing BYOK payload, and the chat.js wiring seam. Backend suites run serially. No format-registry / serialization surface is touched, so `format-roundtrip.test.js` is untouched by construction. **PASS.**
- **III. Trunk-Based Solo Workflow** — stay on `main`, never branch, never commit (assignment override). No new module, no new script, no new ceremony; the feature deliberately adds a parameter rather than a resolution "strategy" abstraction. YAGNI honored (research R4 rejects the per-user eligibility list and the audit table). **PASS.**
- **IV. Collaboration-Safe Document Operations** — not applicable: no Yjs, no document mutation, no format registry, no attribution surface. **PASS (N/A).**
- **V. Secure by Default for Agent & User Content** — the override is an **admin-only** write with **server-side** validation against a fixed registry; the stored value is never interpolated into SQL (parameterized), never rendered as HTML (React escapes; the stale-option label is a text child), and never echoed to the user it applies to. The new endpoint lands under the already-`requireAdmin`-gated `/api/admin` mount and its 403/401 behavior is asserted with the real middleware mounted (`app.use('/api/admin', requireAdmin, admin.router)`), not a bare router. No new ingestion surface, no new trust boundary, no new credential path. The one genuinely security-shaped risk — an override silently routing a BYOK user onto the operator's shared key — is forbidden by FR-003 and pinned by two explicit tests. **PASS.**
- **VI. Design Docs Are Ground Truth** — the plan implements the design paragraph verbatim: column name, nullability, NULL-means-dynamic-default, precedence slot, derived eligibility, log-and-fall-back on ineligible, clear-returns-to-default, admin-only, invisible to the user. The points the design leaves under-specified (write-time validation, stale-value retention, UI placement, BYOK-dormancy hinting) keep the spec's RATIFIED-BY-DEFAULT answers and stay flagged; this plan adds no new divergence and records its own plan-level defaults as RBD-9..RBD-12 in the ledger. **PASS (with flagged design amendments owed).**

**Initial gate: PASS.** No violations requiring Complexity Tracking.

**Post-Phase-1 re-check: PASS.** Phase 1 introduced no new dependency, no new module, no new endpoint beyond the single admin PATCH, and no constitutional exception. The four plan-level decisions taken during design (helper placement in `chat-models.js`; riding `loadByokSettings`' column list; `PATCH /users/:userId/chat-model` shape; no per-user `effectiveModelKey` on the list payload) are all inside existing conventions and are recorded as RBD-9..RBD-12. Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/035-per-user-model-override/
├── plan.md                     # This file
├── research.md                 # Phase 0 — the six decisions that shaped the design
├── data-model.md               # Phase 1 — the users column, its states and lifecycle
├── contracts/
│   ├── model-resolution.md         # resolveUserChatModelKey / resolveChatModel / loadByokSettings deltas
│   └── admin-chat-model-api.md     # PATCH /users/:userId/chat-model + GET /users delta + exposure boundary
├── quickstart.md               # Phase 1 — runnable validation walk
├── clarifications-needed.md    # RBD ledger (exists; extended with RBD-9..RBD-12)
├── checklists/requirements.md  # (exists)
├── spec.md                     # (exists)
└── tasks.md                    # /speckit-tasks output
```

### Source Code (repository root)

```text
migrations/
└── 1799500000000_add-chat-model-override-to-users.js   # NEW — users.chat_model_override text NULL

server/
├── api/
│   ├── chat-models.js             # EDIT — resolveUserChatModelKey(); resolveChatModel gains userOverrideKey; export isSharedEligible
│   ├── byok-settings.js           # EDIT — chat_model_override joins loadByokSettings' column list
│   ├── chat.js                    # EDIT — one line: userOverrideKey passed at the single call site (~:860)
│   ├── admin.js                   # EDIT — GET /users carries chatModelOverride; NEW PATCH /users/:userId/chat-model
│   └── __tests__/
│       └── chat-model-override.test.js       # NEW — precedence + eligibility (pure unit, no DB)
└── __tests__/
    ├── chat-model-override-wiring.test.js    # NEW — chat.js passes the stored override into resolveChatModel
    ├── admin-chat-model-override.test.js     # NEW — admin API: set/clear/validate/403/401/404 (real requireAdmin)
    └── byok-settings.test.js                 # EDIT — FR-011: the user-facing BYOK payload never discloses the override

client/src/pages/
├── AdminPage.jsx                             # EDIT — "Assistant model" picker in the existing expanded detail row
└── __tests__/AdminPage.test.jsx              # EDIT — Default / stale-value / PATCH-on-change render tests
```

**Structure Decision**: The existing web-app layout is used as-is and **no new source module is created**. The resolution helper belongs in `chat-models.js` because that file already owns every model-key resolution rule (`isSharedEligible`, `resolveSharedDefaultKey`, `resolveChatModel`) and is where a future reader will look for the precedence chain; putting it anywhere else would split one decision across two files. The admin endpoint joins `admin.js` beside the shared-default endpoints and the other `PATCH /users/:userId/*` handlers it mirrors. The picker joins the expanded detail row in `AdminPage.jsx` — the established home for per-user admin controls (credits, trusted flag, 034's sign-in origin) — per RBD-3.

## Phase Overview

- **Phase 0 — Research** (`research.md`): six decisions — where the override slots into resolution, why no DB-side constraint, where the per-turn read comes from, the admin endpoint shape, how the stale state is displayed, and how the "no user-visible disclosure" invariant is *proven* rather than asserted.
- **Phase 1 — Design & Contracts** (`data-model.md`, `contracts/`, `quickstart.md`): the column and its states, the two module/API contracts with their exact request/response shapes and failure modes, and a runnable validation walk that exercises every acceptance scenario.

## Risks & Owed Follow-ups

| Risk / owed item | Handling |
|---|---|
| **`README.md` will be factually wrong once this lands** (verified): line ~33 lists Admin Area capabilities without the per-user pin; lines ~273/~557 state the resolution chain as "admin selection → `AI_CHAT_MODEL` → `DEFAULT_MODEL_KEY`" with no per-user slot | `README.md` is off-limits to this agent (assignment override), so this is **merge-blocking work owed to the merge-queue docs pass**, named line-by-line in T021. Constitution Principle I is not satisfied until it lands. `docs/dev.md` was checked — it mentions neither the chain nor the admin capability list, so nothing is owed there. |
| Design paragraph doesn't mention write-time validation or stale-value retention | Non-blocking; already flagged in `clarifications-needed.md` for the next Squire-doc amendment. |
| `chat-models.js` is being edited concurrently by a registry-update agent (new model entries) | The 035 diff touches only the function bodies at the *bottom* of the file (`isSharedEligible` onward) and the export list; registry churn is confined to `MODEL_DEFS`. Merge-queue conflict, if any, is mechanical. Implement agent MUST re-read the file rather than trusting line numbers. |
| `loadByokSettings` now returns a non-BYOK column | Documented in a comment at the SELECT and covered by the non-disclosure test; the alternative (a second per-turn query) was rejected in research R3. Naming stays as-is to keep the diff tight — noted as a MEDIUM in the analysis report, not a blocker. |
| An admin pins a model whose provider key is later withdrawn | By design: per-turn fallback + warning log, value retained (RBD-2), admin UI shows "unavailable — using X". |
