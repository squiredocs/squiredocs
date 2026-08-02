# Data Model: 043-version-history-test-hardening

This feature adds **no schema**, **no migration**, and **no new persisted entity**. The "data
model" here is the set of records the new tests observe and the invariants they assert about them.
Every field below already exists.

## 1. Attributed update row — `yjs_updates`

The unit whose honesty every backend test in this feature guards. Written in exactly one place:
the `bindState` update listener (X1 after extraction), via
`persistence.storeUpdate(docGuid, update, userId, agentName, onBehalfOf, externalClient, { meaningful, viaSync })`.

| Field | Source | Test-relevant meaning |
|---|---|---|
| `doc_guid` | connection path (`/s/{guid}`) | **The cleanup key.** FR-010: every suite deletes its rows by this. |
| `clock` | `MAX(clock)+1` under `pg_advisory_xact_lock` | Ordering; gap/tail-completeness reads key on it. |
| `user_id` | `ws.userId` ← `identityFromPrincipal(req.user).userId` | US1 asserts this on **every** row (SC-002). |
| `agent_name` | `ws.agentName` ← `user.isAgent ? user.agentName : null` | US1: an agent row carries the token's name; a human row carries `NULL`. |
| `via_sync` | `viaSyncFromOrigin(origin)` — true only while a SYNC_STEP2 frame is being applied | US2's subject. Records **how content arrived**, never **who wrote it**. |
| `meaningful` | `classifyByXml(prevXml, nextXml)`; `null` = unknown ⇒ meaningful (fail-visible, D-3) | Drill-down/timeline filtering; US5(a) asserts the classify decision through real code. |
| `on_behalf_of` | not exercised by this feature | — |

**Invariants asserted:**

- **I1 (US1)** Identity is derived from the authenticated principal at connection time, never from
  awareness. For every row produced by a connection: `user_id` equals that connection's principal
  and `agent_name` equals the principal's agent name (or `NULL` for a human) — **independent of
  connection order**.
- **I2 (US1)** No row is merely counted. Every row produced in the new E2E suites is asserted for
  identity (SC-002).
- **I3 (US2)** A row produced by applying a catch-up frame has `via_sync = true` **and** keeps the
  relaying connection's identity — relay marking and attribution are orthogonal.
- **I4 (US3)** When `storeUpdate` rejects through all retries, **no row exists** for that update
  (the pinned outcome; see §5).

## 2. Connection principal

Produced by `permissions.extractUser({ queryToken })`. Two shapes matter:

| Shape | Fields | How the harness makes one |
|---|---|---|
| **Human (browser session JWT)** | `{ userId }`, no `scopes` array | real user row (`createTestUser`) + a real access token |
| **Agent (`sk_sqd_` API token)** | `{ userId, agentId: 'api-token:<id>', agentName: <token name>, scopes: [...], isAgent: true, apiTokenId }` | real `api_tokens` row minted through the production mint path with `['documents:read','documents:write']` |

**Derived fields on the connection** (the two lines US1 exists to guard):

- `ws.userId = principal.userId`
- `ws.agentName = principal.isAgent ? principal.agentName : null`
- `request.tokenMayWrite = !Array.isArray(principal.scopes) || principal.scopes.includes('documents:write')`

**Invariant I5**: absence of a `scopes` array means unrestricted (a browser session), not denied.
Already pinned by `ws-edit-gate.test.js`; the harness must not contradict it.

## 3. Sync catch-up frame

A `SYNC_STEP2` wire frame carrying state the server lacks. Not a database entity — a protocol
event — but it is the *cause* of the `via_sync` rows in §1.

- **Encoding**: `varUint(MESSAGE_SYNC=0)`, `varUint(SYNC_STEP2=1)`, `varUint8Array(Y.encodeStateAsUpdate(clientDoc))`.
- **Gating**: `server/ws-edit-gate.js` classifies it as an edit frame; a viewer's is dropped
  (`WS_STEP2_BLOCKED`), an editor's passes and the gate scopes the `via_sync` flag around its
  application window.
- **Origin**: y-websocket passes the `ws` object as the transaction origin — the same object
  `ws.userId` rides on, which is why marking and attribution cannot cross connections.

**Invariant I6 (US2)**: the version timeline must not credit the relayer as an *author* of relayed
content; `via_sync` rows are provenance-marked, and undo derivation refuses to invert across them
(041 FR-016) even though the pending-recording guard now ignores them (041 FR-014).

## 4. Edit record — `agent_edits`

Undo bookkeeping. Relevant to this feature only as an **absence assertion**:

**Invariant I7 (US4, US7 — D8 / `design/collaboration-core.md:58`)**: a human web-UI restore
creates **no** `agent_edits` row and is not an undo target. An agent/MCP restore **does** create one
under the acting agent and is undoable by that agent's own undo tool. Tests must assert the absence,
not resurrect the pre-040-cut behavior.

## 5. Characterization records (pinned, not desired)

These are outcomes the feature **records** rather than changes. Each carries an FR-014 header
naming the accepted behavior and the decision it traces to.

| Pin | Expected observed shape | Traces to |
|---|---|---|
| **P1 — persistence-failed live edit** (US3/FR-004) | No `yjs_updates` row; the edit remains in the in-memory `Y.Doc` and in every connected browser; one `CRITICAL: Failed to persist update …` log; one `notifyException({source:'persistence'})`. I.e. **silent loss from the durable log.** | 038 FR-018 (publish-before-commit window, documentation-only closure); D1 |
| **P2 — chat vs. history diff divergence** (US6/FR-008) | The two surfaces' changed-word ranges differ for bold syntax, backslash escapes, and hard breaks (≥3 pinned cases, SC-005). Chat emphasises markdown syntax (`**word**`); history emphasises post-parse text (`word`). | 039 A1 |

**Invariant I8**: if production behavior changes, a characterization test **fails loudly** and its
header points at the decision to revisit. Silently updating a pin is forbidden.

## 6. Shared diff fixture

A pair of `Y.Doc`s (`before`, `after`) constituting one real collaborative document state pair.

- Version-history pipeline consumes them directly:
  `new DiffService(stubPersistence).computeMarkdownDiff(before, after, report)` → PM JSON with
  `diffInsert`/`diffDelete` + `diffInsertWord`/`diffDeleteWord` marks.
- Chat pipeline consumes their markdown:
  `computeChatDiff(toMarkdown(beforeFragment), toMarkdown(afterFragment))` → rows with
  `inlineSegments`.
- **Comparison currency**: per row, the ordered list of row-relative `[start, end)` changed
  character ranges — the existing `rangesFromSegments` / `rangesFromBlock` helpers in
  `diff-two-surface-parity.test.js`.

**Invariant I9 (US6)**: on plain-prose regions (no inline markdown syntax, no hard breaks) the two
range lists are **equal**. Outside that corpus, equality is *not* asserted — the divergence is
pinned instead (P2).

## 7. Suite cleanup convention

Not a record but a rule this feature makes into shared infrastructure.

- **Rule**: every suite that causes `yjs_updates` rows to exist deletes them **by `doc_guid`** in
  `finally`/`afterAll`, including rows created indirectly (through a WS connection, a restore, or
  `storeUpdate`), so the global `reindexStale` scan can never find this suite's orphans.
- **Home**: a documented helper `cleanupDocRows(pool, docGuid)` exported from
  `server/__tests__/helpers/db.js`, so future suites inherit the rule by import rather than by
  copy-paste. `server/__tests__/collab-guardrail.test.js:81` is the in-repo shape it generalises.
- **Why not a per-suite `search_index` heal**: it papers over orphans rather than removing them,
  and it must cover the `si.doc_id IS NULL` branch to work at all. D3.

**Invariant I10 (US8)**: after any suite in this feature runs, `SELECT count(*) FROM yjs_updates
WHERE doc_guid = ANY(<the suite's guids>)` is `0`.
