---

description: "Task list for 044-presence-awareness-guard"
---

# Tasks: Presence Awareness Guard

**Input**: Design documents from `/specs/044-presence-awareness-guard/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/awareness-ownership-guard.md](./contracts/awareness-ownership-guard.md),
[quickstart.md](./quickstart.md)

**Tests**: **Required.** Constitution II makes the suite the only reviewer, and this is a
security property about bytes on a socket — the spec's Independent Tests and plan §Approach
step 5 both demand the three-layer rigor 038 established (unit against the real module,
protocol-level integration through the real wiring, structural drift guards on the wiring
itself).

**Organization**: Grouped by user story so each ships and validates independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 from spec.md
- Exact file paths in every description

## Path Conventions

Server-only change, existing flat layout: `server/` (modules), `server/__tests__/` (unit),
`__tests__/integration/` (protocol-level). No client, shared, or migration surface.

## ⚠️ Sequencing & merge-queue notes (read before starting)

- **044 implements THIRD.** Branch from `main` **after 041 and 042 have merged** — both
  touch `server/index.js`.
- **Anchor every `server/index.js` edit to a symbol, never a line number**: the
  `wss.on('connection', (ws, req) => {` handler, the single `installGate(` call, the
  `const doc = getYDoc(wsDocName, true);` line, and the presence-cleanup comment block that
  begins `// Presence cleanup note (feature 038 US5)`. The line numbers in the design
  artifacts are a 2026-08-02 snapshot and **will** have moved.
- **No migrations, no schema change, no env vars.** Nothing to deploy for tests to pass.
- Backend suites share one DB and run **serially**; use a per-worktree database. The new
  integration suite needs **no** DB at all.

---

## Phase 1: Setup

**Purpose**: Establish a green baseline and the module shell, so every later failure is
attributable to this feature.

- [ ] T001 Confirm the per-worktree test database is configured, then record a green baseline by running `npx jest server/__tests__/ws-edit-gate.test.js __tests__/integration/step2-viewer-block.test.js server/__tests__/awareness-removal-propagation.test.js server/__tests__/import-presence.test.js --runInBand` before changing any source

- [ ] T002 Create `server/ws-awareness-guard.js` with the module header and constants only: a header stating the trust boundary (an awareness frame on a client socket is untrusted input, Constitution V), the FR-003 varint lesson carried over from `server/ws-edit-gate.js`'s header (decode with the SAME `lib0/decoding` primitives the applier uses; non-minimal encodings must classify identically; never byte-index), and the D-044-1 non-atomic-applier note (`applyAwarenessUpdate` applies entries in a loop, so a decodable prefix lands before a throw — the guard's id set must never be narrower than the applier's). Export `AWARENESS_BLOCKED_EVENT = 'WS_AWARENESS_BLOCKED'` and `AWARENESS_BLOCK_LOG_WINDOW_MS = 60000`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The frame parser, the handler plumbing, and the test harness — every user story
needs all three.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T003 [P] Implement `parseAwarenessFrame(data)` in `server/ws-awareness-guard.js` per contract §2: `createDecoder` → `readVarUint` (message type; bail unless `MESSAGE_AWARENESS`) → `readVarUint8Array` (inner update) → `readVarUint` (entry count) → per entry `readVarUint` clientID / `readVarUint` clock / `readVarString` state. Collect clientIDs **incrementally** so a decode failure returns everything read so far with `truncated: true` (D-044-1). Do **not** `JSON.parse` the state string (D-044-2). Total and throw-free on `null`, `undefined`, empty, 1-byte, non-Buffer, garbage, truncated varints, and an overstated entry count. Reuse `MESSAGE_AWARENESS` from `server/ws-edit-gate.js` rather than redeclaring it

- [ ] T004 [P] Create `server/__tests__/ws-awareness-guard.test.js` with unit coverage for `parseAwarenessFrame` against the real exported module: canonical single-entry frame; multi-entry frame (order and duplicates preserved); **non-minimal varint** clientID (e.g. `0x81 0x00` for 1) parsing identically to its canonical form; zero-entry frame → `clientIds: []`, passes; decodable-prefix-then-garbage → prefix ids present with `truncated: true`; failure before any complete entry → `clientIds: []`; non-awareness frames (sync step1/step2/update) → `isAwareness: false`; and the total/throw-free matrix over hostile inputs

- [ ] T005 Extend `installGate` in `server/ws-edit-gate.js` to accept optional `getConns` and `principalOf` handlers per contract §3, resolving `getConns()` **per frame** (never at install time). Wire the call site into the interceptor after edit classification, but leave the disposition as pass-through for now — no drops until T012. Both handlers stay optional so every existing caller and test is unaffected. Add a pointer in the module header to `server/ws-awareness-guard.js` explaining that awareness payload parsing lives there, preserving this file's "nothing here parses frame payloads beyond the two header varints" invariant. Re-run `server/__tests__/ws-edit-gate.test.js` and `__tests__/integration/step2-viewer-block.test.js` — both must stay green with zero test edits

- [ ] T006 Wire the lazy doc handle in `server/index.js` per contract §4: inside the `wss.on('connection', (ws, req) => {` handler declare `let sharedDoc = null;` above the existing `installGate(` call, pass `getConns: () => (sharedDoc ? sharedDoc.conns : null)`, and assign `sharedDoc = doc;` immediately after the existing `const doc = getYDoc(wsDocName, true);`. Do not move the `installGate` call relative to `setupWSConnection` — the 038 wiring and its structural guards depend on that order

- [ ] T007 [P] Create `__tests__/integration/awareness-spoof-block.test.js` with the mini-server harness only (no assertions yet): follow the pattern of `__tests__/integration/step2-viewer-block.test.js` — express + `WebSocket.Server`, a connection handler that stamps `ws.userId` from a query param and installs the **real** `installGate` with the real `getConns` wiring, then `setupWSConnection`. **Omit `setPersistence` entirely** (awareness never persists, so this suite needs no database). Add raw awareness-frame crafting helpers built on `lib0/encoding` (`awarenessFrame(entries)` producing `[MESSAGE_AWARENESS][varUint8Array([count, ...(clientID, clock, JSON state))]]`), a `paddedVarint` variant for non-minimal encodings, and a helper reading `getYDoc('s/' + docGuid, true).awareness.getStates()`

**Checkpoint**: Parser proven in isolation; handlers plumbed with no behavior change; harness stands up and the 038 suites are still green.

---

## Phase 3: User Story 1 - A participant's presence cannot be hijacked (Priority: P1) 🎯 MVP

**Goal**: A connection asserting another participant's clientID can neither change nor remove
that participant's presence, locally or cross-instance (SC-001).

**Independent Test**: Two connections on one document; connection B sends awareness frames
carrying connection A's clientID (forged state, then null state, then mixed with its own).
A's presence is unchanged, nothing reaches a third connection, B stays open.

**Scope note**: This phase implements ownership rules 1 (own), 2 (unclaimed) and 4 (foreign ⇒
drop). The same-user tie-break (rule 3) is US2's, so US1 ships as a deliberately strict guard
and US2 removes its false positive.

### Tests for User Story 1

> Write these first; they must FAIL before T010/T011.

- [ ] T008 [P] [US1] Add the exploit-reproduction tests to `__tests__/integration/awareness-spoof-block.test.js` (quickstart Scenario 1): connection A (`alice`) announces `Ca`; connection B (`bob`, view-only) sends an awareness frame asserting `Ca` with a higher clock and a forged user state → `awareness.getStates().get(Ca)` unchanged; the same with a `null` state → `Ca` **not** evicted; a mixed frame asserting both `Cb` and `Ca` → whole frame dropped and **neither** id updated; and B's socket still `OPEN` with no error frame received

- [ ] T009 [US1] Add the encoding-bypass tests to the same integration file: the `Ca` spoof re-sent with `Ca` encoded as a **non-minimal varint**, and the truncated-tail smuggle from research R2 (`[well-formed spoof of Ca][garbage]`) — both dropped, `Ca` unchanged. The second is the D-044-1 regression and must fail against a naive all-or-nothing parser

- [ ] T010 [P] [US1] Add `evaluateAwarenessFrame` unit coverage to `server/__tests__/ws-awareness-guard.test.js` for rules 1/2/4: id in the sender's own set → allowed; id in no set → allowed; id in another connection's set → `allowed: false` with the id in `foreignIds`; mixed own+foreign → `allowed: false` (whole frame); empty `clientIds` → allowed; `conns` null or not a Map → allowed; `foreignIds` de-duplicated in first-seen order; and an assertion that the passed-in `conns` Map and its Sets are **never mutated**

### Implementation for User Story 1

- [ ] T011 [US1] Implement `evaluateAwarenessFrame({ conns, conn, clientIds, principalOf })` in `server/ws-awareness-guard.js` with rules 1, 2 and 4 from contract §2 (data-model §4). Read `conns` only — the guard must never write to `doc.conns`, which `y-websocket`'s `awarenessChangeHandler` and `closeConn` solely own (research R4). Leave a clearly marked hook where rule 3 lands in T015

- [ ] T012 [US1] Make `installGate` in `server/ws-edit-gate.js` actually drop: for a non-edit frame where `parseAwarenessFrame` reports an awareness frame and `getConns()` yields a Map, call `evaluateAwarenessFrame`; when `allowed` is false, return `false` from the wrapped `emit` (no listener runs, nothing applied, broadcast or relayed) and invoke `onBlocked('WS_AWARENESS_BLOCKED', { kind: 'awareness', foreignIds })`. The connection stays open and is not notified, matching the `WS_EDIT_BLOCKED` policy. Edit classification and the step2 flag window are untouched (FR-005)

- [ ] T013 [US1] Add the fan-out assertion to `__tests__/integration/awareness-spoof-block.test.js`: with a third connection C subscribed, assert C receives **no** frame containing `Ca` as a result of B's spoof. Because the Redis awareness publisher is driven by `doc.awareness.on('update')`, "never applied" is also what proves "never relayed cross-instance" — state that reasoning in a comment so a reviewer does not read the missing Redis harness as a coverage gap

**Checkpoint**: The reviewer's 038 exploit fails closed at protocol level. US1 is independently shippable.

---

## Phase 4: User Story 2 - Legitimate presence keeps working (Priority: P1)

**Goal**: Zero false-positive drops across every enumerated legitimate case (SC-002). A guard
that breaks reconnect, agent presence, import presence, or multi-instance display would be
worse than the gap it closes.

**Independent Test**: Exercise FR-006 (a)-(e) and assert presence appears, updates and clears
exactly as before, with **zero** `WS_AWARENESS_BLOCKED` events across the whole scenario.

### Tests for User Story 2

- [ ] T014 [P] [US2] Add same-user tie-break unit coverage to `server/__tests__/ws-awareness-guard.test.js`: id held by another connection with the **same** non-null principal → allowed; same conditions with a **different** principal → foreign; owner principal `null` → foreign; asserting connection's principal `null` → foreign; **both** `null` → foreign (the fail-closed case that stops `undefined === undefined` becoming a universal bypass, research R6); id held by two connections where only one matches the principal → foreign; and the default `principalOf` reading `conn.userId`

- [ ] T015 [P] [US2] Add the legitimate-path tests to `__tests__/integration/awareness-spoof-block.test.js` (quickstart Scenario 2): own announce then cursor update; own removal via a `null`-state frame (id leaves `getStates()`, propagated to the observer); reconnect — a second socket for the **same** user asserting `Ca` while the first is still registered is **allowed**; the paired negative — a **different** user asserting `Ca` under identical conditions is **dropped**; an agent-principal connection announcing its own fresh clientID; a first announcement of an unclaimed id; and a zero-entry frame and an undecodable frame both passing through. Assert **zero** `WS_AWARENESS_BLOCKED` events over the entire scenario

- [ ] T016 [US2] Add the FR-008 Redis-relay exemption test to the same file: call `awarenessProtocol.applyAwarenessUpdate(doc.awareness, update, ORIGIN_REDIS)` directly with a clientID owned by no local connection and assert it applies and fans out — the relay never traverses `ws.emit`, so it is exempt by construction (research R7). Comment that this test exists to pin the exemption against a future refactor that routes relay traffic through a connection

### Implementation for User Story 2

- [ ] T017 [US2] Implement ownership rule 3 in `evaluateAwarenessFrame` (`server/ws-awareness-guard.js`): an id is not foreign when **every** connection holding it has the same non-null principal as the asserting connection. Add the default `principalOf = (c) => (c && c.userId != null ? c.userId : null)`. Document at the rule why `null` never matches on either side

- [ ] T018 [US2] Run the presence regression set — `npx jest server/__tests__/awareness-removal-propagation.test.js server/__tests__/import-presence.test.js server/__tests__/live-fanout.test.js __tests__/integration/step2-viewer-block.test.js --runInBand` — and confirm all green with no test edits. Any failure here is a real false positive, not a test to adjust

**Checkpoint**: The guard is invisible to honest traffic; both P1 stories hold together.

---

## Phase 5: User Story 3 - Spoof attempts are observable without flooding logs (Priority: P2)

**Goal**: Every spoofing connection produces at least one countable event, and a sustained
flood produces a bounded number of log lines (SC-003).

**Independent Test**: Stream spoofed frames from one connection; confirm a distinct named
event is emitted with counts, and that the line count is bounded rather than one per frame.

### Tests for User Story 3

- [ ] T019 [P] [US3] Add `createDropSuppressor` unit coverage to `server/__tests__/ws-awareness-guard.test.js` using an **injected clock** (no `sleep`, no timing flake): the first `record()` always returns a payload; 500 records inside one window yield exactly one emission carrying `dropped: 500`; advancing the fake clock past `windowMs` lets the next record emit with the accumulated `sinceLastLog`; `dropped` is cumulative while `sinceLastLog` resets on emit; and two independent suppressor instances never affect each other (per-connection isolation — no attacker can silence another connection's alarm)

- [ ] T020 [P] [US3] Add the observability assertions to `__tests__/integration/awareness-spoof-block.test.js`: a burst of spoofed frames from one connection produces exactly one `WS_AWARENESS_BLOCKED` with `dropped` equal to the burst size, while a second spoofing connection in the same window produces its **own** first event

### Implementation for User Story 3

- [ ] T021 [US3] Implement `createDropSuppressor({ windowMs = AWARENESS_BLOCK_LOG_WINDOW_MS, now = Date.now })` in `server/ws-awareness-guard.js` per contract §2, returning `{ record() }` → `null` or `{ dropped, sinceLastLog, windowMs }`

- [ ] T022 [US3] Route drops through a per-connection suppressor in `installGate` (`server/ws-edit-gate.js`): create it lazily in the `installGate` closure on first drop so it is garbage collected with the socket (no global map, no cleanup handler), and call `onBlocked` **only** when `record()` returns a payload, passing `{ kind: 'awareness', foreignIds, dropped, sinceLastLog, windowMs }`. The existing edit-block call shape `onBlocked(event, { kind })` is unchanged

- [ ] T023 [US3] Extend the `onBlocked` handler in `server/index.js` (inside the `installGate(` call) to emit `logPerf('WS_AWARENESS_BLOCKED', { connId, userId, docId, role: userRole, foreignIds, dropped, sinceLastLog })` plus a console line distinct from the edit-block wording, without disturbing the existing `WS_EDIT_BLOCKED` / `WS_STEP2_BLOCKED` branches

**Checkpoint**: All three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T024 [P] Extend the `C1` structural drift block in `server/__tests__/ws-edit-gate.test.js` (quickstart Scenario 4): `server/index.js` still calls `installGate(` exactly once, now passes `getConns`, still contains no `ws.emit =`, and defines **no** awareness parser of its own — in particular assert `parseAwarenessClientIds` does not reappear in `server/index.js`. Add the same shape for the new module: `server/index.js` declares no awareness protocol constants of its own

- [ ] T025 Add the awareness-interceptor unit cases to `server/__tests__/ws-edit-gate.test.js` against a fake ws and a hand-built `conns` Map: foreign-id awareness frame → `emit` returns `false`, no listener ran, `onBlocked` fired with `WS_AWARENESS_BLOCKED`; own-id and unclaimed-id frames pass through; `getConns()` returning `null` → pass through (no doc bound yet); `getConns`/`principalOf` omitted entirely → 038 behavior byte-for-byte, awareness frames untouched

- [ ] T026 Update the presence-cleanup comment block in `server/index.js` (the one beginning `// Presence cleanup note (feature 038 US5)`) per contract §6: state that awareness frames are parsed again, in `server/ws-awareness-guard.js`, to answer the **different and correct** question "which ids does this frame assert?" — not the deleted `parseAwarenessClientIds` question "which id does the sender own?" — and that eviction still comes solely from `closeConn` plus y-websocket's controlled-ids set, which the guard reads and never writes

- [ ] T027 Run the full backend suite serially against the per-worktree database (`npx jest --runInBand`) and confirm green, including the frontend Vitest suite if any client file was touched (none is expected — this feature has no client surface)

- [ ] T028 Walk [quickstart.md](./quickstart.md) end to end: run each listed command, confirm every scenario's expectations hold, and correct the quickstart if any command or path drifted during implementation

- [ ] T029 Seed `specs/044-presence-awareness-guard/promotion-notes.md` for the merge queue and post-merge review: the two plan-time decisions (D-044-1 decodable-prefix asserts its ids; D-044-2 no `JSON.parse`, deliberate superset), the FR-008 no-code/test-only disposition, the pre-existing same-user-reconnect eviction flicker explicitly left out of scope (research R4), and the items owed to Sam — the `design/collaboration-core.md` amendment (Squire doc first, then `node design/sync.mjs`; never hand-edit the export) and the post-deploy manual presence walk

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup. **Blocks all user stories.**
- **US1 (Phase 3)**: depends on Phase 2.
- **US2 (Phase 4)**: depends on US1 — rule 3 is added to the `evaluateAwarenessFrame` that
  US1 creates, and US2's negative case ("different user, same conditions ⇒ dropped") only
  means anything once US1's drop path exists.
- **US3 (Phase 5)**: depends on US1 (needs a drop path to observe). Independent of US2.
- **Polish (Phase 6)**: depends on all three stories.

### Within Each User Story

- Tests are written before implementation and must fail first.
- Parser (T003) before ownership (T011) before interception (T012) before observability (T021/T022).
- `server/index.js` wiring (T006) before any test that exercises production wiring.

### Parallel Opportunities

- **Phase 2**: T003 (parser) ‖ T007 (harness) — different files. T004 follows T003.
- **Phase 3**: T008 ‖ T010 (different files); T009 follows T008 in the same integration file;
  T011 → T012 → T013 are serial.
- **Phase 4**: T014 ‖ T015 (different files); T016 follows T015 in the same integration file;
  T017 then T018 serial.
- **Phase 5**: T019 ‖ T020; T021 → T022 → T023 serial.
- **Phase 6**: T024 then T025 (same file); the rest serial.
- **Cross-story**: US2 and US3 could be staffed in parallel once US1 lands, but they touch
  the same two source files — for a solo implementer, run them in order.

### Parallel Example: User Story 1

```bash
# Two files, so two tracks:
Task: "T008 exploit-reproduction tests in __tests__/integration/awareness-spoof-block.test.js"
Task: "T010 evaluateAwarenessFrame rules 1/2/4 in server/__tests__/ws-awareness-guard.test.js"
# Then, in the integration file:
Task: "T009 encoding-bypass tests in __tests__/integration/awareness-spoof-block.test.js"

# Then implement serially:
Task: "T011 evaluateAwarenessFrame in server/ws-awareness-guard.js"
Task: "T012 drop path in installGate (server/ws-edit-gate.js)"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → Phase 2 Foundational.
2. Phase 3 US1.
3. **STOP and VALIDATE**: the reviewer's spoof/evict fails closed at protocol level; the 038
   suites are still green.
4. At this checkpoint the security property (SC-001) holds, but the reconnect race can drop
   a user's own re-announcement — **do not ship past this point without US2.**

### Incremental Delivery

1. Setup + Foundational → parser proven, wiring plumbed, nothing behaviourally changed.
2. US1 → the gap is closed (SC-001).
3. US2 → the guard becomes invisible to honest traffic (SC-002). **This is the real ship gate.**
4. US3 → the guard becomes operable (SC-003).
5. Polish → drift guards, comment reconciliation, full-suite and quickstart validation.

---

## Notes

- `[P]` = different files, no dependencies on incomplete tasks.
- The three source files this feature touches are `server/ws-awareness-guard.js` (new),
  `server/ws-edit-gate.js`, and `server/index.js`. Keep the `server/index.js` diff minimal —
  one `let`, one handler argument, one assignment, one `onBlocked` branch, one comment block
  — to survive the 041/042 merge ordering.
- Never write to `doc.conns`. `y-websocket` is its sole maintainer; a second writer is the
  "second model" failure this feature is explicitly designed not to repeat.
- No task in this list edits `CLAUDE.md`, `README.md`, `docs/dev.md`, or anything under
  `design/` — those are outside this pipeline stage's scope, and `design/` exports must be
  amended at the Squire source and re-synced.
