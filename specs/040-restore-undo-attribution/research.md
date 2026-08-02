# Phase 0 Research — 040-restore-undo-attribution

All findings re-verified against `main` on **2026-08-01, after 038 and 039 merged**
(HEAD `e448a579`). Every line number in this document was read on that tree.

---

## R1 — Where the shared identity module lives, and why it is not `edit-records.js`

**Decision**: a new zero-dependency leaf module `server/agent-identity.js` exporting both
`CHAT_AGENT_NAME` and `isSameIdentity(a, b)`.

**Rationale**:

- FR-005 requires the constant to be "consumable by the version-history layer without creating
  a circular dependency with the chat surface". `server/api/chat.js` requires 20+ modules
  (`documents`, `chat-store`, `ai-usage`, `email`, `crypto`, express, …) and is an Express
  router factory; having `server/version-history.js` require it to read one string would drag
  the entire chat stack into every history request and put a fragile edge into the graph.
- The spec calls `server/undo/edit-records.js` the "natural home" for the predicate. Verified
  on `main`: `server/mcp/yjs/edit-range.js` requires **only `yjs`** — it is a pure leaf. Making
  it require the `agent_edits` DB-access layer to obtain a pure comparison function inverts the
  layering (transport-level durability polling depending on a persistence module) for no gain.
  `edit-records.js` still receives the FR-007 sentinel rule and the FR-012 FK rationale, which
  is where a developer actually looks for identity *semantics*.
- A module with zero `require`s cannot participate in a cycle, which makes FR-005's
  no-circular-dependency requirement a structural property rather than a review promise.

**Alternatives considered**: (a) predicate in `edit-records.js`, constant in a separate new
module — two new seams instead of one, and the layering inversion above; (b) both in
`shared/` — rejected, the client never compares undo identities and the constitution reserves
`shared/` for genuinely shared client/server logic; (c) constant stays in `chat.js` and
`version-history.js` requires it lazily inside the function — rejected, hides the dependency
and defers the failure to request time.

Recorded as **D8**.

---

## R2 — How the restore identity is threaded

**Decision**: `server/index.js`'s restore route passes `agentName: CHAT_AGENT_NAME`;
`restoreVersion` drops its `agentName ?? ''` fallback and passes the value it was given,
unchanged, to **both** `persistence.storeUpdate(...)` and `editRecords.recordEdit(...)`.
The `agentName = null` default parameter **stays**, and a null now reaches the loud guard.

**Rationale**: this is the minimum-surface change the Collision Contract describes ("small
touch to the restore route only — the `agentName` it passes"). It keeps `restoreVersion`
identity-agnostic, so the MCP path (`server/mcp/tools/restore-document-version.js:88-99`,
passes `agentToken.agentName`) is untouched and FR-004's zero-regression requirement is met by
construction. It also makes the two stores consistent for free: the same variable feeds the
`yjs_updates` row and the `agent_edits` row, so the NULL/`''` split FR-001 targets cannot
reappear.

**Consequence, verified**: `hasPendingRecording` (`edit-records.js:108-130`) probes
`yjs_updates` for `(docGuid, userId, agentName)` and compares against `agent_edits`. Before
this change the restore's log row was NULL and its record was `''` — the probe could never see
them as the same identity. After it, both carry `CHAT_AGENT_NAME` and the probe is coherent
(spec Edge Cases, "Pending-recording probe consistency"). There is a sub-second window between
`storeUpdate` committing and `recordEdit` committing in which the probe reports "pending" —
identical in shape to what `modify` already produces, and handled by the existing freshness
bound; no new mechanism needed.

**Alternatives considered**: defaulting `agentName` to `CHAT_AGENT_NAME` inside
`restoreVersion` — rejected: it would silently attribute *any* caller that omits the option
(including tests and future internal callers) to the chat assistant, and it would destroy the
FR-006 tripwire, since no call could ever reach the guard.

---

## R3 — F14 / FR-010 is already implemented (by 039)

**Finding**: `client/src/components/HierarchicalVersionList.jsx` no longer imports
`colorUtils` at all. Line 61 reads:

```jsx
style={{ backgroundColor: author.color || '#888888' }}
```

with a comment citing **"Feature 039 FR-018"**, and a passing Vitest case at
`client/src/components/__tests__/HierarchicalVersionList.test.jsx:487` ("renders the stable
neutral #888888 for a colorless author, on any date"). 039's spec FR-018 is verbatim the same
requirement as 040's FR-010. The spec's citation of `HierarchicalVersionList.jsx:56` and its
`colorUtils.js:58-70` import are **stale as of 039's merge**.

**Decision**: US5 / FR-010 becomes a **verification-only** phase — assert the current code and
the existing test, change nothing, and record the overlap. `client/src/utils/colorUtils.js`
keeps its date-salted presence palette untouched (FR-010's second half, and 039's).

Recorded as **D9**.

---

## R4 — Unknown-author synthesis: one site covers both required paths

**Finding**: `getUpdatesForVersion` (`version-history.js:690-730`) builds the sub-version
drill-down by calling **`groupUpdatesIntoVersions`** (`:699`) with the 10-second threshold.
The version list calls the same function with the 5-minute threshold. So FR-008's "both the
version-grouping path and the sub-version drill-down path" is satisfied by a single change
inside `groupUpdatesIntoVersions`, at the author-collection guard on `:203-206`:

```js
const authorKey = getAuthorKey(update.userId, update.agentName);
if (update.userId && !currentVersion.authors.has(authorKey)) { ... }
```

**Decision**: synthesize the collapsed unknown author **in `groupUpdatesIntoVersions`** (the
`else` of that `update.userId` guard, keyed by a fixed `unknown` key so repeated unattributed
rows collapse to one entry), and apply the same synthesis at the single-author metadata site
`version-history.js:794` (`author: update ? createAuthor(update) : null`).

**`createAuthor`'s `if (!userId) return null` contract is deliberately preserved.** It is also
called by `mergeNamedVersions` for `createdBy: createAuthor(nv)` (`:261`); making `createAuthor`
itself return a synthetic object would silently turn a named version with no creator from
`createdBy: null` into `createdBy: {Unknown author}`, changing an unrelated client contract.
The synthesis is therefore an explicit constant (`UNKNOWN_AUTHOR`) applied at the two sites the
spec names, not a change to the shared helper.

**Shape** (D4, already ratified): `{ id: null, name: 'Unknown author', email: null,
picture: null, color: '#888888', isAgent: false }`.

Recorded as **D10**.

---

## R5 — SC-009 grep: every `(userId, agentName)` comparison on `main`

`grep -rn "agentName ===\|agentName !==\|agentName ?? null" server/ client/src/ --include=*.js --include=*.jsx | grep -v __tests__`

| Site | Form | Verdict |
|---|---|---|
| `server/mcp/yjs/edit-range.js:185` | raw `===` | FR-015 site — **bug fix** (null vs undefined) |
| `server/undo/inverse.js:80` | normalized `?? null` | FR-015 site — behavior-preserving |
| `server/undo/legacy.js:61` (in `isIdentityRow`, `:56-62`) | normalized `?? null`, **guarded by 038's `row.viaSync === true` early-return** | FR-015 site — behavior-preserving; the predicate replaces only the two-field comparison, the `viaSync` guard stays above it |
| `server/mcp/tools/modify.js:308` | raw `===`, foreign-edit conflict guard | **not named in the spec** — converted (D11) |
| `server/mcp/tools/modify.js:327` | raw `===`, `isSelf` replay filter | **not named in the spec** — converted (D11) |
| `server/api/chat-staleness.js:111` | raw `===`, `isOwnAgent` staleness filter | **not named in the spec** — converted (D11) |
| `server/origin.js:182` | `origin.agentName ?? null` | **normalization, not a comparison** — out of scope, leave as is |

The three unnamed comparisons are **behavior-identical** under the normalized predicate: in all
three the right-hand identity is an agent token (`agentToken.agentName`) or the chat identity
(`agent.agentName` = `CHAT_AGENT_NAME`), both of which always carry a real non-empty string,
so the `undefined`-vs-`null` divergence the predicate fixes cannot occur there. Converting them
is free and is what SC-009's grep is asking for.

Recorded as **D11**.

---

## R6 — A fourth definition of the assistant name

`grep -rn "Squire Docs Assistant"` finds **four** server-side definitions/uses of the literal:

- `server/api/chat.js:91` — `CHAT_AGENT_NAME` (the authoritative one)
- `server/onboarding.js:18` — `const AGENT_NAME = 'Squire Docs Assistant'` with the comment
  "mirrors the chat assistant author", used to attribute the seeded welcome document
- `server/mcp/auth/agent-token-factory.js:16` — a JSDoc example only, not a definition
- `client/src/components/AiPanel.jsx:35-36`, `client/src/pages/SettingsPage.jsx:173` — UI copy

**Decision**: `server/onboarding.js` consumes `CHAT_AGENT_NAME` from the new module and drops
its local literal. FR-005 says "exactly one authoritative definition, shared by every
consumer"; a second server-side literal whose stated intent is to mirror the first is exactly
the drift FR-005 exists to prevent, and the welcome doc's attribution is genuinely the same
identity. The two client strings are **not** consolidated: they are display copy in an ESM
client bundle that must not import a CommonJS server module, and neither participates in undo
identity.

Recorded as **D10** (same entry as R4's ledger slot is D10 — see clarifications file for the
exact numbering).

---

## R7 — The loud `recordEdit` guard: what counts as invalid

**Decision**: `recordEdit` throws before any SQL when `agentName` is `null`, `undefined`, not a
string, or a string that is empty/whitespace-only. Message names the problem and the caller
context, e.g.:

```
recordEdit: agent_name is required and must be a non-empty string (got null) —
doc <guid>, user <id>. An edit recorded without an identity is unreachable by
every undo surface; see server/undo/edit-records.js (sentinel rule).
```

**Rationale**: FR-007 retires `''` for all new records, so the guard must reject it, not just
null — otherwise the exact defect being closed (a dead `''` row) stays reachable through a
future caller. Verified that no live caller can trip it after FR-001: `restoreVersion` gets
`CHAT_AGENT_NAME` or an agent token name; `modify.js:576,595` pass `editIdentity.agentName`
from an authenticated agent token.

**Non-fatality is preserved (D6)**: `restoreVersion`'s existing `try/catch` (`:663-665`) and
`modify.js`'s (`:584-586`) already log and continue; the guard changes *what is logged*, never
whether the content change survives. The existing test
`version-history.test.js:1755` ("a recordEdit failure logs but the restore still succeeds")
already pins that parity and must keep passing.

**`insertLegacyUndone` (`edit-records.js:167`) is deliberately NOT guarded.** It writes the same
`NOT NULL` column, but it runs *inside* the `finalizeClaim` transaction, so a throw there would
roll back a legitimate legacy undo rather than merely lose a record — trading a silent failure
for a louder, worse one. Its identity comes from the undo-service call chain, which is already
`(userId, agentName)` from an authenticated surface. The sentinel-rule comment states this
explicitly so a reader does not "finish the job" unsafely.

Recorded as **D12**.

---

## R8 — Downstream effects of putting `CHAT_AGENT_NAME` on the restore's log row

Beyond the intended, ratified attribution change (FR-003/SC-004), the restore's `yjs_updates`
row changing from `agent_name = NULL` to `'Squire Docs Assistant'` is visible to every consumer
that reasons about that column. All consumers were enumerated and assessed:

| Consumer | Effect | Assessment |
|---|---|---|
| `server/version-history.js` `createAuthor` | Restore renders as `Squire Docs Assistant (Sam Goldstein)`, `isAgent: true` | **Intended** (FR-003). Explicit test required. |
| `server/undo/*` (`undo-service`, `inverse`, `legacy`, `edit-records`) | The restore row now matches the chat identity — which is the entire point | **Intended** (FR-001/FR-002). |
| `server/api/chat-staleness.js` `foreignEditsSince` | A user's own UI restore is no longer reported to the assistant as a *foreign* edit (it is now the assistant's own identity) | **Accepted consequence.** Coherent with the ratified attribution: the restore *is* recorded as the assistant acting for the user. Flagged for the implement brief; no code change. |
| `server/mcp/tools/modify.js:304-330` conflict guard | For the **chat assistant's own** modify (same `userId` + `CHAT_AGENT_NAME`) a preceding human UI restore is now `isSelf` rather than foreign, so it is replayed into the expected doc instead of triggering the divergence check. **MCP agent tokens (different `agentName`) are unaffected** and still see the restore as foreign. | **Accepted consequence**, follows directly from the ratified identity. Flagged for the implement brief; no code change. |
| `server/collab-guardrail.js` | Only invoked from the websocket persist path (`index.js:411`), never from `restoreVersion`; its `if (!userId \|\| agentName) return null` gate would ignore the row anyway | **No effect.** |
| Presence / cursors | Restore never creates a presence session on the REST path | **No effect.** |

None of these require code changes; all are recorded here so a reviewer meets them as analysed
consequences rather than surprises.

---

## R9 — Test strategy and the environment that makes it runnable

- **Integration (US1/US2)**: a new `server/__tests__/restore-undo-roundtrip.test.js` against a
  real Postgres — seed a doc with two versions, restore via `restoreVersion` with
  `CHAT_AGENT_NAME`, assert `getUndoStatus` reports `canUndo`, run `performUndo` and compare
  the replayed markdown to the pre-restore state byte-for-byte, then `performRedo`. The same
  file carries the agent-token regression (US2) and the cross-identity isolation case.
- **Existing tests that must be updated, not merely re-run**:
  `server/__tests__/version-history.test.js:1712` ("human restore records … identity = `''`")
  asserts `edits.rows[0].agent_name).toBe('')` — that assertion **inverts** under FR-001. It is
  rewritten to assert the assistant identity on *both* tables. This is the deliberate,
  reviewable behavior change; it must not be silently deleted.
- **Backend runs**: always `npm run test:server` (or `npx jest --runInBand --forceExit`) — a
  live Redis client keeps the process alive and a bare `npx jest` hangs forever when piped.
  Serial-only within one database; this feature uses its own `collab_test_db_040`.
- **Client**: Vitest is worktree-safe and parallel-safe.

---

## R10 — F1: no client control can reach a restore's undo (verified; drives D13)

**Finding (verified on `main` @ `e448a579`)**, in three parts:

1. **The only client caller of `/undo` is chat-card-bound.** `UndoEditButton`
   (`client/src/components/AiChatMessages.jsx:599`) renders only under
   `isModify && isComplete && part.output?.changed && docGuid` (`:541-547`), and its `showButton`
   additionally requires `isLatest`, i.e. `part === lastModifyPart` (`:544`, `:658`). A
   version-history restore produces no chat tool part, so with no recent assistant `modify` in
   the current chat there is **no undo control anywhere in the product**.
2. **`MobileActionBar` is not a second path.** Its Undo/Redo (`MobileActionBar.jsx:12`, `:95`)
   drive the editor's local `yUndoPlugin` (`@tiptap/y-tiptap`) — an unrelated, client-local
   mechanism, not the server's log-derived undo.
3. **The endpoint ignores `toolCallId` for target selection.** `makeUndoRedoHandler`
   (`server/index.js`) calls `performUndo({docGuid, userId, agentName})` → `nextUndoTarget`
   (identity-LIFO), and uses `req.body.toolCallId` **only** to stamp the `reverted` flag via
   `setChatPartReverted`. So once FR-001 puts restores into that queue, pressing "Undo edit" on
   the assistant's card would invert the **restore** and mark the **modify** "Reverted".

**Consequence**: the original US1 ("the Undo control … is available and pressing it exactly
reverts the restore") was not deliverable by the server-only change, and shipping FR-001 without
a client guard would have put a false statement on screen.

**Decision (Sam, 2026-08-01 — option (c), D13)**: re-scope US1/SC-001 to the endpoint contract;
add the offer-honesty guard (FR-016/FR-017/FR-018, US6); file the document-level affordance as
follow-on work (`promotion-notes.md` OWED-1). The guard keys on the record's immutable
`edit_clock_start` (D14) and is fail-open (D15).

**Why `edit_clock_start` and not the target range**: `finalizeClaim`
(`server/undo/edit-records.js:200-255`) **rewrites** `undo_target_*`/`redo_target_*` on every
transition — the next step's input is the inverse's own clock. A client matching on those would
match before an undo and stop matching after a redo, making the control vanish from a valid
card. `edit_clock_start` is part of the row's unique key and never changes; it is also exactly
what `modify` already returns as `editRange.clockStart` (`server/mcp/tools/modify.js:574`), so
no new client plumbing is needed.

**Why fail-open**: both sides of the comparison can be legitimately absent — an older or legacy
`/undo-status` response (the log-derived fallback has no `agent_edits` row), or a `modify` whose
durability wait timed out and returned `editRangePending` with no `editRange`. A fail-closed
guard would silently strip a working Undo button from every such card, converting an honesty fix
into a capability regression. The fail-open failure mode is the status quo ante.
