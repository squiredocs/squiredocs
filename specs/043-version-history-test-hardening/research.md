# Phase 0 Research: 043-version-history-test-hardening

**Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md) | **Ledger**: [clarifications-needed.md](./clarifications-needed.md)

All findings below were established by reading the working tree on 2026-08-02 (main at
`f0273b68`). Because this feature merges **after** 041, 042 and 044, every line reference here
is a *locator*, not a contract — task T001 re-verifies all of them against merged `main` before
any code is written (D5).

---

## R1 — What "the production WebSocket upgrade and document-binding path" actually is

**Question**: FR-001 requires the attribution E2E to drive the production path. Which code is
that, and how much of it is importable today?

**Finding**: it is three inline blocks in `server/index.js`, none importable:

| Block | Location (pre-041) | What it decides |
|---|---|---|
| `setPersistence({ bindState })` — the update listener | `server/index.js:276-480` (listener at `:287-440`) | classification, `parseOrigin`, malformed-origin notify, `viaSyncFromOrigin`, `storeUpdate(docGuid, update, userId, agentName, …, {meaningful, viaSync})`, pendingWrites registration, the FR-018 publish-before-commit comment, the CRITICAL persist-failure catch |
| `server.on('upgrade')` | `server/index.js:1942-2019` | drain refusal, `/s/` path check, cookie-then-query token, `permissions.extractUser`, `permissions.can.view`, `request.tokenMayWrite` scope binding |
| `wss.on('connection')` | `server/index.js:2034-2140` | `ws.userId = req.user?.userId`, `ws.agentName = req.user?.isAgent ? req.user.agentName : null`, `installGate`, ping/pong, 60s role re-check, `setupWSConnection` |

The identity assignment at `:2054-2055` **is the fix for the historical misattribution bug**
(the deleted awareness-capture is eulogised in the comment at `:2021-2031`). US1's whole point
is to guard that line, so a test that re-declares it in-file guards nothing.

**Existing precedent — and its explicit self-admission**: `__tests__/integration/step2-viewer-block.test.js`
(feature 038) already stands up a mini express+`ws` server, installs the **real** gate via
`installGate`, and speaks raw frames. But its `bindState` is a hand-written
"production-shaped" copy (file header says so), and its connection handler reads `role` and
`userId` from query params — no auth, no identity derivation. `server/__tests__/ws-edit-gate.test.js:448-487`
records exactly why that is not enough ("a passing e2e still would not prove that PRODUCTION
uses it") and compensates with a **structural drift guard** (C1) that greps `server/index.js`.

**Decision**: adopt both halves of the 038 pattern — real modules in the harness *plus* a C1-style
structural guard — and extract only what is needed to make the decision-bearing code importable.
See R2.

**Alternatives considered**:
- *Boot `server/index.js` in-process.* Rejected: the module starts Redis, cron, the MCP server,
  the search indexer and a listening HTTP server at require time; it is not designed for
  in-process teardown and would make every suite in this feature order-dependent.
- *Playwright / browser E2E.* Out of scope by D7.
- *Keep mirroring bindState (038's approach).* Rejected: it is the exact failure mode FR-002/FR-006
  exist to kill, and US1 would be a third mirror.

---

## R2 — Extraction budget: what production code moves, and what deliberately does not

**Question**: FR-007 limits production changes to "minimal, behavior-preserving extractions
required by FR-006" (the three US5 mirrors). FR-001 requires driving the production binding
path, which needs an extraction FR-006 does not name. How is that reconciled?

**Finding**: the tension is smaller than it looks, because **US5's first mirror and US1/US2/US3's
subject are the same code**: `update-classifier.test.js:116-140`'s in-test `runListener` is a
copy of the bindState update listener, which is also the unit that records `user_id`/`agent_name`/
`via_sync` on every row. One extraction discharges FR-006(a) *and* unblocks FR-001/FR-003/FR-004.

Four extractions, all move-only:

| # | Extraction | Serves | Size |
|---|---|---|---|
| **X1** | `server/collab-bind-state.js` — `createBindState(deps)` returning the y-websocket `bindState`, with the update listener as its own exported `createUpdateListener(deps)`. `server/index.js` calls `setPersistence({ bindState: createBindState({...}), writeState, provider })`. | US1, US2, US3, US5(a) | medium (~160 moved lines) |
| **X2** | `identityFromPrincipal(user)` → `{ userId, agentName }` added to the existing zero-dependency leaf `server/agent-identity.js` (created by 040). `server/index.js:2054-2055` calls it. | US1 | 3 lines |
| **X3** | `shouldPublishToRedis(origin)` exported from `server/origin.js`; the `redisUpdateHandler` skip-list in `server/index.js` consults it. | US5(b) | 4 lines |
| **X4** | `server/api/undo-status.js` — the `GET /api/docs/:docId/undo-status` handler (live at `server/index.js:1630-1646`) as an exported express `Router` factory; `server/index.js` mounts it. Repo precedent for exactly this shape already exists: `createExportRouter` / `createImportRouter` / `createTokenClaimRouter` are mounted at `server/index.js:1470-1479`, and `server/api/*.js` is the established home. | US5(c) | ~15 moved lines |

The production Redis predicate for X3 is `server/index.js:2242` (`if (origin === ORIGIN_REDIS || origin === ORIGIN_DB_LOAD) return;`), inside the `redisUpdateHandler` closure created per-connection at `:2235-2249`. Because the handler is a closure over `docId`, only the *predicate* is extractable — which is exactly the unit `origin.test.js:22-25` mirrors (9 call sites: lines 182, 183, 186, 192, 221, 236, 241, 256, 261).

**Deliberately NOT extracted** (and this is load-bearing, not laziness):

- The `server.on('upgrade')` handler and the `installGate(...)` call site stay in
  `server/index.js`. `server/__tests__/ws-edit-gate.test.js` (feature 038, C1 guard) asserts by
  source-grep that `index.js` matches `/installGate\s*\(/` **exactly once** and contains the
  literal `request.tokenMayWrite = !Array.isArray(user.scopes) || …`. Moving either would break
  a pre-existing test — a direct violation of FR-007(4)/SC-008. The harness instead composes the
  *real decision modules* (`permissions.extractUser`, `permissions.can.view`,
  `identityFromPrincipal`, `installGate`, `createUpdateListener`) behind its own express/`ws`
  plumbing, and a new C1-style guard pins that `index.js` uses the same modules.
- The ping/pong keepalive, the 60s role re-check, the Redis subscribe/close handling. None carry
  attribution decisions; leaving them keeps the diff small.

**Decision**: recorded as **D9** in `clarifications-needed.md` (RATIFIED-BY-DEFAULT). FR-007's
"required by FR-006" is read as "required by the tests this feature specifies", with the C1-guard
constraint above as the hard ceiling.

---

## R3 — The US1/US2/US3 harness

**Decision**: one shared helper, `__tests__/integration/helpers/collab-harness.js`, extending the
038 pattern with real auth and the real listener:

- boots `express()` + `new WebSocket.Server({ noServer: true })` on port 0;
- `server.on('upgrade')` in the harness performs the *production sequence* using production
  modules: `permissions.extractUser({ queryToken })` → `permissions.can.view(userId, docId)` →
  `request.tokenMayWrite = !Array.isArray(user.scopes) || user.scopes.includes('documents:write')`;
- `wss.on('connection')` calls `identityFromPrincipal(req.user)` (X2), `installGate` (real), then
  `setupWSConnection`;
- `setPersistence({ bindState: createBindState({...}) })` (X1) with the real persistence provider
  from `server/__tests__/helpers/db.js`.

**Identities**: the human is a real user row (`createTestUser`) with a real session JWT; the agent
is the same-or-different user holding a real `sk_sqd_` API token row minted through the production
`server/api-tokens.js` path with `['documents:read','documents:write']` scopes —
`extractUser` returns `{ userId, agentName: record.name, isAgent: true, scopes }` for it
(`server/permissions.js:46-58`). This is the production MCP-agent shape, so US1 exercises the real
token→identity derivation rather than a fabricated `ws.agentName`.

**Frame crafting**: reuse `step2-viewer-block.test.js`'s raw-frame helpers (`encodeSyncFrame`,
`step2FrameFrom`, `updateFrame`) — these are already the real wire protocol via
`server/ws-edit-gate.js`'s exported constants. Promote them into the shared helper so three
suites stop re-deriving them.

**Waiting**: `waitFor(fn, {timeout,label})` polling — already proven in
`step2-viewer-block.test.js:40-49`. This is also the substitute US8(c) prescribes for
`collaboration.test.js`'s `tick(50)` sleeps.

**Alternatives considered**: using `y-websocket`'s client provider instead of raw frames. Rejected:
US2 needs to force a *specific* SYNC_STEP2 catch-up frame carrying content the server lacks, which
the provider will not do on demand.

---

## R4 — US2: how to make a real catch-up frame

**Finding**: a `SYNC_STEP2` frame carrying state the server does not have is exactly what
`step2-viewer-block.test.js` already forges (`step2FrameFrom(docWithParagraph('…'))`). For an
*editor* connection the gate passes it, `y-websocket` applies it with the connection as the
transaction origin, and `viaSyncFromOrigin(origin)` (`server/ws-edit-gate.js`) returns `true`
because the gate scopes a flag around the step2 application window
(`server/index.js:335-344` explains the scoping). The resulting `storeUpdate` therefore lands
`via_sync = true` under the *relaying* connection's identity.

So US2 needs no new mechanism: connect as editor, evict/restart the server-side doc so it is
behind, send `step2FrameFrom(clientDoc)`, assert the row's `via_sync`/`user_id`, then run the real
`version-history.groupUpdatesIntoVersions` and the real `undo` derivation over those rows.

**Undo refusal across sync rows** is existing designed behavior; note the **041 interaction**: 041
FR-014 makes the *pending-recording guard* ignore `via_sync` rows, while the *inverse-computation*
exclusion (041 FR-016) stays. US2 acceptance scenario 3 must assert the post-041 shape: undo is
**not blocked** by a sync row being newest (041 FR-014), but derivation still **refuses to invert
across** one. Writing the pre-041 expectation would make this suite fail on merge.

---

## R5 — US3: what actually happens to a persistence-failed live edit

**Finding** (from `server/index.js:380-439` + `server/postgres-persistence.js` `_runStoreSlot`):
the update has *already been applied to the in-memory Y.Doc*, already fanned out to other browsers
by `y-websocket`, and already published to Redis by the peer `redisUpdateHandler` listener, all
synchronously, before `storeUpdate` is even called. On terminal failure the `.catch` at `:435-439`
logs `CRITICAL: Failed to persist update …` and calls `notifyException(err, { source: 'persistence' })`.
Nothing retries further; nothing removes the edit from the live doc.

**Predicted pinned outcome**: *silent loss from the durable log* — no `yjs_updates` row, edit still
present in the live document and in every connected editor, one CRITICAL log line, one exception
notification. This is the 038 FR-018 window, documented at `server/index.js:386-400`.

The test must **assert the observed outcome, not this prediction** (FR-004 says "pins the exact
observed outcome"). If reality differs, the test records reality and the header note is adjusted;
D1 forbids fixing it either way.

**Failure injection**: rig the *persistence provider instance the harness passes to X1*, not a
global — e.g. wrap `storeUpdate` so that a specific update payload (matched by byte content)
rejects on every attempt, and restore the original in `finally`. This satisfies the spec's edge
case "failure injection must be scoped to the specific update and torn down deterministically"
without touching production retry constants.

---

## R6 — US4: restore concurrency against post-041 semantics

**041 FR-011** changes restore to build its delta *from the live in-memory document inside a
transaction on that document* when the doc is loaded on the serving instance, and records
cross-pod serialization as an accepted residual. **041 FR-013** makes the is-loaded probe honest
(no side-effect creation).

**Consequence for US4**: both tests must run with the document **loaded** in the harness (a live
connection open) so the FR-011 path is the one under test, and must assert 041's semantics:

1. *restore vs. concurrent live edit* — invariants (D2): the concurrent edit's row exists with its
   own `user_id`/`agent_name`; the restore row exists attributed to the restorer; the final
   document contains the restored content *and* the concurrent edit is not silently absent from the
   durable log. No assertion on which landed first.
2. *two concurrent restores* — final document equals the output of restore-to-V1 **or** restore-to-V2
   (serializable), both restore rows present and individually attributed, and
   `getVersionHistory`/`groupUpdatesIntoVersions` returns without error over the resulting log.

**Label semantics (D8)**: a human web-UI restore records **no** `agent_edits` row (040 D19 /
`design/collaboration-core.md:58`). Tests must assert that absence, not a restore-undo record.

**Provoking overlap**: barriers are permitted (D2) — e.g. resolve a deferred promise inside the
rigged persistence layer to hold the restore mid-flight while the live edit is sent — but no
assertion may depend on the barrier's ordering.

---

## R7 — US6: both diff pipelines are already importable; no extraction needed

**Finding**: the two *complete* pipelines have clean pure entry points that take the same kind of
input:

- **Chat**: `computeChatDiff(mdBefore, mdAfter)` — `server/mcp/diff-utils.js:95` (does
  `stripHardBreakMarkers` → `structuredPatch` → `postProcessDiffLines`). Exported.
- **Version history**: `DiffService.prototype.computeMarkdownDiff(prevDoc, currDoc, report)` —
  `server/diff-service.js:269` (does `toMarkdown` → `diffLines` → `applyWordMarks`/`markdownToPm`).
  `new DiffService(mockPersistence)` needs no DB and no Redis for this method
  (`server/__tests__/diff-service.test.js:1-30` already constructs it that way).

**Shared fixture** = a pair of `Y.Doc`s. The version-history side consumes them directly; the chat
side consumes `toMarkdown(doc.get('default', Y.XmlFragment))` of each — which is precisely what
`computeMarkdownDiff` does internally, so both surfaces provably start from the same bytes.

The existing `diff-two-surface-parity.test.js` range-extraction helpers (`rangesFromSegments`,
`rangesFromBlock`) are the comparison currency and are reused verbatim (FR-008 explicitly permits).

**Divergence pins (≥3, SC-005)**: bold syntax (`**word**`), backslash escapes, hard breaks — the
three regions named in FR-008. Each gets an exact-output characterization assertion with the
FR-014 header naming **039 A1**.

**042 interaction**: 042 FR-011 merges the twin traversals inside `apply-word-marks.js` and FR-014
changes the cache namespace. Neither changes `computeMarkdownDiff`'s signature or output; the
existing traversal-agreement pin tests are 042's own safety net. Re-verify at T001.

---

## R8 — US7: component test surface, and the 042 collision

**Finding**: `client/src/components/VersionHistoryPanel.jsx` takes **21 props** (docGuid, isOpen,
onClose, onSelectVersion, selection, hierarchicalVersions, totalEdits, isLoading,
onCreateNamedVersion, onRenameVersion, onDeleteVersion, onRestoreVersion, userRole, onSelectUpdate,
onLoadUpdates, versionUpdates, versionUpdatesMeta, loadingVersionUpdates, showDiffHighlights,
onToggleDiffHighlights, onNavigateToDoc) and forwards most to `HierarchicalVersionList`.
`client/src/components/VersionPreview.jsx` takes 4 (`diffData`, `selection`, `isLoading`,
`showDiff`) and renders a read-only TipTap editor over `diffData.document`.

**Two hard dependencies on features merging first:**

- **042 FR-012** explicitly collapses that prop drill, default mechanism a `VersionHistoryContext`.
  If it lands as a context, every US7 panel test must render inside the provider. **This is the
  single largest re-verification item in T001.**
- **041 FR-005/FR-006** introduce the error states US7 acceptance scenario 4 asserts, and
  041 FR-007 introduces selection reconciliation. Neither exists on today's `main` — writing those
  assertions against today's code would produce four failing tests.

**Harness**: `client/src/components/__tests__/VersionConfirmDialog.test.jsx` is the sibling
pattern; runner is Vitest with `environment: 'jsdom'` and `setupFiles: ['./src/test/setup.js']`
(`client/vitest.config.js`). `VersionPreview` mounts `@tiptap/react`'s `useEditor` — the existing
`Editor.test.jsx` shows the established mocking approach for that; prefer asserting on the rendered
`EditorContent` output where jsdom supports it, and mock `useEditor` only if the real editor proves
unstable under jsdom.

Two setup facts that will bite otherwise: `client/src/test/setup.js` **stubs `console.error` and
`console.warn` with `vi.fn()`**, so a component test cannot assert on console output; and it fixes
`crypto.randomUUID`, so generated ids are stable across renders.

**Today's render branches** (the "before" these tests are written against, all subject to 041/042
re-verification): `VersionHistoryPanel` returns `null` when `!isOpen`, shows `"Loading versions..."`
while `isLoading`, and otherwise falls through to `"No version history yet."` / `"No named versions
yet."` — **there is no error branch at all**, which is precisely deep-dive B4 and 041 FR-005.
`VersionPreview` shows `"Loading version..."`, then `"Select a version to preview"` when
`!diffData`, plus the `diffFailed` / `formattingOnly` / `textIdentical` notices — **no error prop
today**, which is 041 FR-006.

---

## R9 — US8: the three flake shapes, precisely

**(a) Orphaned update-log rows.** Confirmed: the version/undo DB suites insert `yjs_updates` rows
and never write `search_index` rows, which is the shape behind the known CI `reindexStale` flake
(auto-memory `ci-reindexstale-shared-db-flakiness`). D3 chooses **cleanup by `doc_guid` in
`finally`/`afterAll`**, recorded once. Recording home: a documented convention block in
`server/__tests__/helpers/db.js` plus a small exported helper (`cleanupDocRows(pool, docGuid)`) so
suites inherit it by import rather than by copy-paste. `server/__tests__/collab-guardrail.test.js:81`
(`DELETE FROM yjs_updates WHERE doc_guid = $1`) is the in-repo counter-example that already does it
right and is the shape to generalise. Note that `cleanupTestUser` in the shared helper deletes
`ai_extra_credits`, `agent_activity_log`, `agent_delegations`, `document_shares`, `documents` and
`users` — it **never** touches `yjs_updates` or `search_index`, which is why the orphans survive
suite end.

**Offending suites (verified: raw `yjs_updates` inserts, zero `search_index` writes, no
`yjs_updates` cleanup)** — the retroactive-application worklist for FR-010:

| Suite | Evidence |
|---|---|
| `server/__tests__/undo-status-api.test.js` | inserts in `createDoc()`; `afterAll` deletes `agent_edits` + `cleanupTestUser` only |
| `server/undo/__tests__/undo-service.test.js` | raw inserts at 68, 208, 259, 345, 372, 398 + `storeUpdate` at 580; `afterAll` deletes `agent_edits` only |
| `server/undo/__tests__/edit-records.test.js` | `storeUpdate` at 153, 166; `afterAll` deletes `agent_edits` only |
| `server/undo/__tests__/legacy.test.js` | `afterAll` deletes `agent_edits` only |
| `server/__tests__/version-history.test.js` | DB-backed describe already deletes by `doc_guid` (:1800-1801) — **compliant**, convert to the shared helper only |

Out-of-area suites with the same shape (`backfill-meaningful`, `documents`, `onboarding`,
`postgres-gap-read`, `integration/faucet-wipe`, `integration/prod-reset`) are **not** in scope:
FR-010 scopes the retroactive pass to "the existing version/undo suites". They are recorded here so
the omission is a decision, not an oversight, and belong in `promotion-notes.md`.

**(b) Wall-clock assertions.** `server/__tests__/postgres-gap-read.test.js` contains **8**
`toBeLessThan(300)` assertions (lines 155, 173, 201, 210, 291, 324, 555, 605) — the spec's
Verification Notes say "nine"; the recount is a spec correction, not a scope change (see analyze).
Every one of them is a proxy for *"no retry wait happened"*, and D4's preferred replacement is
directly available: `_fetchRowsWithGapRetry` already **returns `retries`**
(`server/postgres-persistence.js:387,404,442`), and the retry delay is the single
`await new Promise(r => setTimeout(r, delay))` at `:421`, configurable via
`COLLAB_READ_GAP_RETRY_DELAYS_MS`. So the behavioral replacement is `expect(retries).toBe(0)` where
the call returns it, and a `setTimeout` spy / zeroed delay env otherwise. No production change is
needed for any of the eight.

**(c) Sleep-based propagation waits.** `__tests__/integration/collaboration.test.js` uses `tick(50)`.
Replace with the `waitFor` condition helper from R3 where the awaited condition is observable
(row present, doc text contains X); leave and *comment* the ones that wait for an absence
(you cannot condition-wait on "nothing happened") — FR-011's "documented at minimum" clause.

---

## R10 — Sequencing and the merge-order contract

043 is last in the queue: **041 → 042 → 044 → 043** (044 is independent of 041/042 but adds its own
awareness-guard tests, which 043 must not duplicate — 043 touches no awareness code and asserts
nothing about presence).

`T001` is a **blocking re-verification gate** covering, at minimum:
1. the four extraction targets (X1-X4) — has 042 already moved any? (042 FR-006/FR-008/FR-015 are
   the candidates; none currently names X1-X4, but FR-015 consolidates `retryWithBackoff`, which
   lives *inside* X1's block);
2. 041's merged restore semantics (FR-011/FR-013) and error-state render shape (FR-005/FR-006);
3. 042's `VersionHistoryPanel` prop/context shape (FR-012) and `useRestoreFlow` (FR-013);
4. the 8-vs-9 wall-clock count and the exact line numbers in `postgres-gap-read.test.js`;
5. that `server/__tests__/ws-edit-gate.test.js`'s C1 guard still greps for `installGate` and
   `request.tokenMayWrite` in `server/index.js` (the ceiling on R2's extraction budget).

Any divergence resolves **in 041/042's favor** (D5) and is noted in the ledger.

---

## R11 — Test-database constraint

Backend Jest is serial-only against a shared database (Constitution II). In the pipeline the
implementer runs in a worktree and MUST create a per-agent database
(`createdb collab_test_db_043`) and pass `DATABASE_URL` — `server/__tests__/helpers/db.js`
(`getTestDatabaseUrl`) respects it. `--runInBand` is already wired; do not defeat it. FR-012 is
satisfied by construction: no new suite may use `test.concurrent` or spawn a second runner, and
US4's "concurrency" is concurrency of requests *inside one suite*.
