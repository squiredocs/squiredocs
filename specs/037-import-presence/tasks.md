# Tasks: Imports Announce Presence (037-import-presence)

**Input**: Design documents from `/specs/037-import-presence/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [clarifications-needed.md](./clarifications-needed.md)

**Tests**: REQUIRED — Constitution Principle II ("every behavioral change MUST be covered by tests").
Backend Jest suites share one database and MUST run serially (`npm run test:server` uses `--runInBand`).

**Organization**: grouped by user story so each can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task
- **[Story]**: US1–US5 from spec.md
- Every task names exact file paths

## Implementer brief

Read this before starting. These are the MEDIUM findings from the cross-artifact analysis, folded in
as working guidance. (No CRITICAL or HIGH findings were raised.)

1. **US1 and US2 both edit `server/api/docs-import.js`** (T007/T010 vs T016), so the "Phase 3 and
   Phase 4 in parallel" guidance is only true for *authoring*. Serialize the route edits — land the
   US1 wiring first, then T016 — or expect to reconcile one file by hand. Everything else in the two
   phases is genuinely disjoint.
2. **`settle` consumes the sync range from `observeSyncRange`.** T008 describes the append/replace
   arithmetic and T009 builds the observer, but the handoff is only implicit: `settle` takes the
   observer's accumulated indices as its `observed` argument and uses `min`/`max` as the sync range
   (contracts/import-presence.md §`settle`). Implement that in T008, not as an afterthought in T010.
3. **SC-001's "100%" is a healthy-path measure, not a hard invariant.** FR-009's ~2 s cap explicitly
   allows the import to proceed with the session still attaching (US3 scenario 2), so on a cold
   document the agent can become visible *after* the apply. Measure SC-001 with presence healthy;
   the degraded case is governed by US3, which outranks it (best-effort is ratified). Do not add
   waiting or retries to close this gap — that would violate FR-009.
4. **FR-007's ~60 s linger and the apply-time refresh have no automated coverage.** The task list
   asserts the refresh *call* (T008) but nothing asserts that the session TTL is actually re-armed and
   that the session then expires unattended. Add a targeted case in `server/__tests__/import-presence.test.js`
   (fake timers: refresh at apply ⇒ session alive at T+55 s from open, gone by T+65 s from apply) or
   accept it as manual-only coverage via quickstart scenario A and say so in the commit message.
5. **FR-014 (no modify-style highlight sweep in v1) is an exclusion with no guard.** The presence
   machinery exposes `queueHighlightSequence`; nothing in this feature may call it. Worth one negative
   assertion in the US1 suite.
6. **Terminology**: the spec says "replica", the code and existing tests say "instance"
   (`INSTANCE_ID`, `presence-multi-instance.test.js`). They mean the same thing. Prefer the code's
   word in code and test names so the new suites read like their neighbours.

---

## Phase 1: Setup

**Purpose**: confirm the ground this feature stands on. No new dependencies, no scaffolding, no config.

- [ ] T001 Re-verify the surface map in [research.md](./research.md) §R1 against current `main` — in particular `server/api/docs-import.js` (editor gate ~:344, mode resolution ~:352), `server/document-service.js:50` `updateDocument`, `server/markdown-sync.js` `applySyncPush` (~:1061, the `Y.applyUpdate(sharedDoc, pushUpdate, ORIGIN_SYNC_PUSH)` line ~:1148), `server/mcp/agent-presence.js` `getOrCreateSession` (:739) and `setTemporarySelection` (:974), `server/index.js:2129-2236` (lazy `_redisUpdateHandler` attach + skip-list), `server/live-apply.js`. Correct any drifted line reference in research.md before writing code.

**Checkpoint**: surface map trusted; implementation can proceed.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: shared test scaffolding used by US1, US2 and US3. There is no production-code foundational
work — this feature adds callers, not capabilities.

**⚠️ CRITICAL**: T002 blocks the test tasks in Phases 3–6.

- [ ] T002 Add shared test doubles in `server/__tests__/helpers/import-presence-doubles.js` (the `server/__tests__/helpers/` directory already exists — `db.js`, `baseline-doc.js`, …): (a) a `redisPubSub` double recording `publishUpdate(docGuid, update)` calls with `isEnabled()` toggleable; (b) an `agentPresence` double whose `getOrCreateSession` can resolve, reject, or hang on demand and which records `setTemporarySelection(sessionId, anchor, head)` calls. Reuse the existing real-awareness harness patterns from `server/mcp/__tests__/presence-real-awareness.test.js` rather than inventing a new one.

**Checkpoint**: user-story phases can now start in parallel.

---

## Phase 3: User Story 1 — Watching user sees the importing agent (P1) 🎯 MVP

**Goal**: every agent-authenticated update-mode import opens the shared agent-presence session before
any content changes, shows a temporary selection over the changed range at apply, and expires by itself.

**Independent Test**: open a document in a browser, run a token-authenticated import from a shell for
each mode, observe (1) the agent appears before content changes, (2) a temporary selection covers the
changed content, (3) presence disappears on its own. Assertions C1–C13 in
[contracts/import-presence.md](./contracts/import-presence.md).

### Tests for User Story 1

- [ ] T003 [P] [US1] New suite `server/__tests__/import-presence.test.js` covering C1–C3 (session opened once, with the mode's identity, before parsing; zero sessions for a browser-session principal; zero for `POST /api/docs/import`) and C11/C13 (two imports on one token ⇒ one session; failed import ⇒ no teardown call), using the T002 doubles.
- [ ] T004 [P] [US1] Extend `__tests__/integration/docs-import-api.test.js` and `__tests__/integration/sync-push.route.test.js` with end-to-end presence assertions per mode: an agent-authenticated import produces exactly one presence session for the expected identity and leaves the HTTP response byte-identical to the pre-feature baseline.
- [ ] T005 [P] [US1] Add selection assertions C6–C9 to `server/__tests__/import-presence.test.js`: append ⇒ range covers exactly the appended blocks; replace ⇒ range covers the whole post-apply document; a sync push touching blocks 3 and 7 ⇒ `first=3, last=7`; a no-op sync push ⇒ session opened but **no** `setTemporarySelection` (FR-012).

### Implementation for User Story 1

- [ ] T006 [US1] Create `server/import-presence.js` with `open(opts)` and `awaitAttach(presence, capMs)` per [contracts/import-presence.md](./contracts/import-presence.md): mint the per-mode synthetic token via `createAgentTokenPair` (`server/mcp/auth/agent-token-factory.js`) — append/replace use `agentId = req.user.agentId` + `agentName = req.user.agentName`; sync uses `agentId = 'repo-sync'` + `agentName = SYNC_AGENT_NAME`; scopes pass through `req.user.scopes` — then call `agentPresence.getOrCreateSession(docId, token, 60, { requiredRole: 'editor' })`. `open` returns synchronously, never throws, attaches `.catch` at creation, and resolves `null` on any failure. `PRESENCE_ATTACH_CAP_MS = 2000` is a module constant, not config (ledger RBD-3).
- [ ] T007 [US1] Wire `open` + `awaitAttach` into `PUT /api/docs/:docId/import` in `server/api/docs-import.js`, placed immediately after the editor-role gate and mode resolution and **before** receipt-option validation, the empty-body check, `waitForDocLoaded`, sync baseline validation, parsing and the image pass (FR-006, ledger RBD-9). Guard on `req.user.isAgent === true` (FR-003). Leave `POST /api/docs/import` untouched (FR-004).
- [ ] T008 [US1] Add `settle(presence, { fragment, mode, imported, observed })` to `server/import-presence.js`: compute the changed range **synchronously** post-apply — append: `first = len - report.blocks.imported`, `last = len - 1`; replace: `0..len-1`; **sync: `min`/`max` of `observed.indices` from `observeSyncRange` (T009), no range when empty** — convert with `cursorOps.createBlockRangeSelection` (returns `null` ⇒ no selection), then chain on `presence.promise` to refresh the TTL (a second `getOrCreateSession` with the same token — FR-007) and call `agentPresence.setTemporarySelection`. Every step logged-and-swallowed; **never awaited** by the caller.
- [ ] T009 [US1] Add `observeSyncRange(docId)` to `server/import-presence.js`: `fragment.observeDeep` on the live shared doc's `'default'` fragment, filtered to `transaction.origin === ORIGIN_SYNC_PUSH`, accumulating touched top-level indices (`event.path[0]`; for the fragment's own event walk the `retain`/`insert`/`delete` delta). Read-only. `stop()` idempotent.
- [ ] T010 [US1] Wire `settle` into the append/replace path and `observeSyncRange` + `settle` around `handleSyncPush` in `server/api/docs-import.js`, with `observed.stop()` in a `finally` (research R8.3). Error paths (400/403/409/410/413/500) never call `settle`.

**Checkpoint**: US1 fully functional — an agent import is visible live in all three modes.

---

## Phase 4: User Story 2 — Import content reaches viewers on every replica (P1)

**Goal**: an import's content change always fans out cross-replica, whether or not the handling replica
holds a live connection for the document — with no double-apply and no single-replica change.

**Independent Test**: connect a viewer through replica A, route each of the three modes' imports at
replica B (which holds no connection for the doc), verify the viewer updates without a reload.
Assertions F1–F9 in [contracts/live-fanout.md](./contracts/live-fanout.md).

**Independence note**: US2 is implementable and testable without US1 — it touches different functions
and needs no presence session.

### Tests for User Story 2

- [ ] T011 [P] [US2] New suite `server/__tests__/live-fanout.test.js` covering F1–F8 with the T002 `redisPubSub` double: no attached handler ⇒ exactly one `publishUpdate` for append/replace/sync; handler attached ⇒ zero explicit publishes; Redis disabled ⇒ zero publishes and unchanged content; `publishUpdate` throwing ⇒ import still succeeds, one error logged.
- [ ] T012 [P] [US2] Extend `__tests__/integration/redis-sync.test.js` with F9: a second in-process instance holding the doc receives and applies the import's update for all three modes, exactly once, with no second `yjs_updates` row on the receiving side (F7).

### Implementation for User Story 2

- [ ] T013 [US2] Give `documentService.updateDocument` in `server/document-service.js` the additive return value `{ update, hadRedisHandler }`, captured **inside the existing `ydoc.once('update', handler)`** — `hadRedisHandler = !!ydoc._redisUpdateHandler` sampled at emit time, never after the await (research R3). The no-change 50 ms timeout path resolves `{ update: null, hadRedisHandler: false }`. Do not change any existing timing semantics; all current callers ignore the value.
- [ ] T014 [P] [US2] Add `publishIfUnhandled({ redisPubSub }, docGuid, update, hadRedisHandler, label)` to `server/live-apply.js` per [contracts/live-fanout.md](./contracts/live-fanout.md) §3: publish-only (never applies), no-ops when `!update`, when `hadRedisHandler`, or when Redis is disabled; logs and swallows publish failures (ledger RBD-6).
- [ ] T015 [US2] Thread the capture out of `importMarkdown` in `server/markdown-import.js` as `report.live = { update, hadRedisHandler }` (internal module contract — **not** the HTTP receipt).
- [ ] T016 [US2] Call `publishIfUnhandled` from the append/replace path in `server/api/docs-import.js` after a successful apply, using `report.live`.
- [ ] T017 [US2] In `server/markdown-sync.js` `applySyncPush`, replace the inline `const sharedDoc = getSharedDoc(docGuid); if (sharedDoc) Y.applyUpdate(sharedDoc, pushUpdate, ORIGIN_SYNC_PUSH);` with `applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, pushUpdate, ORIGIN_SYNC_PUSH, 'sync')`, taking `redisPubSub` from `opts` with `require('./redis-pubsub')` as the default (the `server/undo/undo-service.js:39` `defaultRedisPubSub` pattern). Leave `searchIndexer.markDirty` and the receipt shape untouched.
- [ ] T018 [P] [US2] *(test — listed here because it must run after T017)* Extend `server/__tests__/markdown-sync.replay.test.js` (or the closest existing sync suite) to assert the fan-out call for a push, and that a no-op / already-applied short-circuit publishes nothing.

**Checkpoint**: US1 and US2 both work; imports are visible AND delivered on every replica.

---

## Phase 5: User Story 3 — Presence never breaks or slows an import (P2)

**Goal**: with presence degraded (backend down, dial failing, position math erroring) the import's
behavior, response contract and latency are indistinguishable from the pre-feature baseline.

**Independent Test**: force session creation to fail and to hang; verify the import succeeds with an
unchanged response and that a hang adds no more than ~2 s. Assertions C4, C5, C10 / SC-004, SC-005.

### Tests for User Story 3

- [ ] T019 [P] [US3] Add C4/C5 to `server/__tests__/import-presence.test.js`: `getOrCreateSession` rejecting ⇒ import response identical to baseline plus one warn; `getOrCreateSession` hanging ⇒ response returns within baseline + ~2 s (assert against a fake timer or a measured bound, not a wall-clock sleep).
- [ ] T020 [P] [US3] Add C10/SC-005 to `server/__tests__/import-presence.test.js`: for each mode, `Y.encodeStateAsUpdate` of the final document is byte-identical between an import run with presence enabled and the same import with presence disabled — the reads-never-write proof obligation (FR-013).
- [ ] T021 [P] [US3] Add a case for a post-apply selection computation that throws (stub `createBlockRangeSelection` to throw): the HTTP response is unaffected and the error is only logged (US3 scenario 3).

### Implementation for User Story 3

- [ ] T022 [US3] Audit every presence call site added in Phases 3–4 (`server/import-presence.js`, `server/api/docs-import.js`) and confirm: exactly ONE `await` on presence work in the whole request path (the `awaitAttach` race); every other call is `.then(...).catch(...)`; every promise has a `.catch` attached at creation; no presence error can reach the route's `try/catch` or `notifyException`. Fix anything that fails the audit.
- [ ] T023 [US3] Confirm the timer in `awaitAttach` **resolves** rather than rejects and does not keep the event loop alive (`unref` or cleared on settle) so the suite exits cleanly under `--forceExit`-free conditions.

**Checkpoint**: presence is provably decorative — degradation cannot touch the byte channel.

---

## Phase 6: User Story 4 — Presence identity matches version-history attribution (P2)

**Goal**: the label a viewer sees is exactly the author version history records for the same change.

**Independent Test**: run an append/replace import and a sync push with a named token; compare the
observed presence label against the author on the resulting version entry. Assertion C12 / SC-006.

### Tests for User Story 4

- [ ] T024 [P] [US4] Add an identity-parity suite section to `server/__tests__/import-presence.test.js` walking the mode × identity matrix: for append/replace the presence label is `"<token name> (<user name>)"` and the stored update row's `agent_name` is the same token name; for sync the label is `"Repo Sync (<user name>)"` and the row's `agent_name` is `SYNC_AGENT_NAME`. Assert against the real `_buildAgentInfo` output shape (`{ name, isAgent: true, ... }`), not a hand-rolled string.
- [ ] T025 [P] [US4] Assert there is no per-request presence-label affordance (FR-016): a request carrying plausible label-ish query params/headers (e.g. `?agentName=`, `X-Squire-Agent-Name`) produces the identity-derived label unchanged.

### Implementation for User Story 4

- [ ] T026 [US4] Verify (and fix if needed) the per-mode identity table implemented in T006 against [plan.md](./plan.md) §"Identity table" and ledger RBD-7: sync must use the fixed `agentId = 'repo-sync'` so repeated pushes dedup per user+document rather than per token, and must never inherit the token's display name.

**Checkpoint**: presence and provenance tell one story (Constitution Principle IV).

---

## Phase 7: User Story 5 — Newly minted tokens are named for the agent (P3)

**Goal**: tokens minted through either surface get concise, agent-descriptive default names, and the
tool contract tells agents to name tokens after themselves.

**Independent Test**: mint via `import_markdown_file` and via `create_access_token` with no name;
inspect the stored names and the tool descriptions. Assertions N1–N7 in
[contracts/token-naming.md](./contracts/token-naming.md).

**Independence note**: fully independent of US1–US4 — presence works with any token name.

### Tests for User Story 5

- [ ] T027 [P] [US5] Extend `server/mcp/__tests__/tools/create-access-token.test.js` with N2–N5: default name is the derived agent name (no `"Minted by … via …"` string, no operation name); an explicit `name` is stored verbatim in both the claim and `inline: true` paths; empty/non-string/over-255 `name` is an invalid-parameter error that mints nothing; a principal with no `agentName` yields `"AI Agent"` and never `"api-token:<id>"`.
- [ ] T028 [P] [US5] Extend `server/mcp/__tests__/tools/import-markdown-file.test.js` (and `__tests__/integration/import-recipe-e2e.test.js` where it asserts the minted name) with N1: a client registered as "Claude Code" yields the token name `"Claude Code"`.
- [ ] T029 [P] [US5] Add N7: both tool `description` strings instruct the agent to name the token after itself; assert on the description text so the contract cannot silently regress.

### Implementation for User Story 5

- [ ] T030 [P] [US5] Create `server/mcp/auth/token-naming.js` exporting `deriveMintedTokenName(agentToken)`: trimmed `agentToken.agentName` if non-empty, else `'AI Agent'`, truncated to 255. `agentToken.agentId` is never a fallback (contracts/token-naming.md §1).
- [ ] T031 [US5] Replace the `` `Minted by … via import_markdown_file` `` default at `server/mcp/tools/import-markdown-file.js` (~:176-177) with `deriveMintedTokenName(agentToken)`. No name parameter is added to this recipe tool.
- [ ] T032 [US5] In `server/mcp/tools/create-access-token.js`: add the optional `name` property to `inputSchema` with the contract wording from [contracts/token-naming.md](./contracts/token-naming.md) §2; add a `resolveName(requested, agentToken)` validator in the existing `resolveScopes`/`resolveTtlSeconds` style (string, trimmed, 1–255, else invalid-parameter error); use the resolved name in **both** the claim path (`prepareClaimDelivery`) and the `inline: true` path (`apiTokens.createToken`), replacing the `"Minted by … via MCP"` default. Nothing else about scopes, caps, TTL, provenance or claim mechanics changes.
- [ ] T033 [P] [US5] Add one sentence to each tool's `description` (`create_access_token`, `import_markdown_file`) stating that the token name is the agent's public identity — the live presence label while it works in a document and the version-history author — and to name the token after itself, never after the operation (FR-017a). Keep it to one sentence per tool: these strings are in every agent's context on every connection.

**Checkpoint**: all five stories independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T034 [P] Update `README.md` in the same commit as the behavior change (Constitution Principle I): imports now announce agent presence (the agent-presence / MCP sections around the presence-claim description ~:630-639 and the import surface bullets ~:689), an import's content now fans out cross-replica regardless of which replica handles it, and minted-token naming + the new `create_access_token` `name` parameter (~:678, ~:748). Do **not** hand-edit anything under `design/`.
- [ ] T035 Confirm **no migration** was introduced anywhere in the change set (`git diff --stat migrations/`). This feature needs none; if one appears, stop and flag it — migration slots are serialized across features and new migrations must be numbered above `1795000000000`.
- [ ] T036 Run the full backend suite serially: `npm run test:server` (never concurrently with another backend run — Principle II), then `npm run test:client` to confirm the untouched client is still green.
- [ ] T037 Walk the manual scenarios A–E in [quickstart.md](./quickstart.md) — especially scenario C (two replicas) and scenario A (the 2026-07-30 reproduction, SC-002), which no automated test can fully stand in for.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)** — no dependencies.
- **Phase 2 (Foundational)** — after Phase 1. T002 blocks the test tasks in Phases 3–5.
- **Phase 3 (US1)** / **Phase 4 (US2)** / **Phase 7 (US5)** — independent of each other; can run in parallel after Phase 2.
- **Phase 5 (US3)** — depends on Phase 3 (it hardens and proves the US1 code paths).
- **Phase 6 (US4)** — depends on Phase 3 (it verifies the identity implemented in T006).
- **Phase 8 (Polish)** — after every story phase that will ship.

### Task-level dependencies

- T006 → T007 → T008 → T009 → T010 (same module and same route; strictly sequential).
- T013 → T015 → T016 (the capture must exist before it is threaded and consumed).
- T014 is independent of T013 and can land in parallel; T016 needs both.
- T017 and T018 are independent of the T013/T015/T016 chain (different file, different apply style).
- T022, T023 depend on Phases 3–4 being complete.
- T024, T025 depend on T002 (they extend the T003 suite) and on T006.
- T026 depends on T006.
- **File conflict**: T007/T010 (US1) and T016 (US2) all edit `server/api/docs-import.js` — land the US1 route wiring before T016 rather than editing in parallel (implementer brief §1).
- T030 → T031, T032; T033 is independent of T030.
- T034–T037 depend on all shipping story phases.

### Parallel opportunities

- T003, T004, T005 (US1 tests) — different files/sections, all after T002.
- T011, T012, T018 (US2 tests) — different suites.
- T019, T020, T021 (US3 tests) — different cases in one new suite; parallel only if authored as separate blocks, otherwise sequential in one file.
- T027, T028, T029, T030, T033 (US5) — different files.
- US1, US2 and US5 phases can be worked simultaneously by different implementers.

### Parallel example: after Phase 2

```text
Track A (US1): T003 → T005 → T006 → T007 → T008 → T009 → T010
Track B (US2): T011 → T014 → T013 → T015 → T016 (and T017 → T018 alongside)
Track C (US5): T030 → T031 → T032 → T033 (with T027–T029 written first)
```

---

## Implementation Strategy

### MVP scope

**US1 + US2 together are the MVP.** Both are P1 and the spec is explicit that US2 is co-equal: without
cross-replica delivery, US1's promise ("watch the import happen") is false on the production topology
of record (2 replicas). Shipping US1 alone would make the feature *look* correct in single-replica
development and fail in production.

### Incremental delivery

1. Phase 1 + Phase 2 → foundation ready.
2. Phase 3 (US1) + Phase 4 (US2) → **MVP**; validate with quickstart scenarios A and C.
3. Phase 5 (US3) → prove degradation safety; scenario D.
4. Phase 6 (US4) → provenance parity; scenario B.
5. Phase 7 (US5) → naming contract; scenario E.
6. Phase 8 → README, full serial test run, manual matrix.

US3 and US4 are verification-heavy phases over code already written in US1 — they are cheap to run and
should not be deferred past the merge.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task.
- Backend tests share one database and **must** run serially; never launch two backend runs at once.
- No migration is expected. No client-side change is expected. No new configuration or tunables
  (ledger RBD-3).
- The HTTP contract of both import routes — request shape, status codes, response body, receipt — is
  byte-identical before and after this feature. The only externally visible contract change is the MCP
  `create_access_token` `name` parameter.
- Commit after each task or logical group; stay on `main` (Constitution Principle III).
