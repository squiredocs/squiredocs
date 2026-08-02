# Contract — `server/agent-identity.js` (NEW internal module)

This module is **server-internal**: no MCP tool schema and no client bundle changes come from it.
Every existing external contract (`POST /api/docs/:docId/restore`,
`POST /api/docs/:docId/undo|redo`, the `restore_document_version` / `undo` / `redo` MCP tools,
and the version-history JSON shape) keeps its request and response shape exactly — only the
*values* inside the version-history `authors` array change (see data-model.md).

**One external contract does change, additively**: `GET /api/docs/:docId/undo-status` gains two
optional fields per Sam's F1 decision (D13). That change is specified in
[the second half of this document](#contract--get-apidocsdocidundo-status-additive-fr-016).

---

## Module invariant

**`server/agent-identity.js` MUST have zero `require`s.** That is what makes FR-005's
"no circular dependency with the chat surface" a structural property rather than a convention.
Any future addition that needs a dependency belongs in a different module.

---

## `CHAT_AGENT_NAME: string`

```js
const CHAT_AGENT_NAME = 'Squire Docs Assistant';
```

The single authoritative display name of the in-app chat assistant. The literal moves here from
`server/api/chat.js:91`.

**Required consumers** (all must read it from this module, directly or via a re-export):

| Consumer | Use |
|---|---|
| `server/api/chat.js` | imports it; **keeps exporting `CHAT_AGENT_NAME`** from its own `module.exports` (`:1423`) so existing readers such as `server/index.js:1632` do not change |
| `server/index.js` restore route (`:1525`) | the identity a web-UI restore is recorded under (FR-001) |
| `server/index.js` undo-status route (`:1632`) | unchanged — continues to read `chat.CHAT_AGENT_NAME`, now transitively the same constant |
| `server/onboarding.js` (`:18`) | replaces its local `AGENT_NAME` literal (FR-005, D10) |

**Invariant (FR-005/SC-001):** the identity a restore is *recorded* under and the identity the
undo surface *queries* are the same string by construction. A test must assert that the value
`server/index.js`'s restore route passes and the value the undo-status route queries are
identical, so the two can never drift.

**Not consolidated**: `client/src/components/AiPanel.jsx:35-36` and
`client/src/pages/SettingsPage.jsx:173` — display copy in an ESM client bundle that must not
import a CommonJS server module, and neither participates in undo identity.

---

## `isSameIdentity(a, b): boolean`

```js
/**
 * The one definition of "is this row mine?" for undo/attribution identity.
 * @param {{userId: string|null|undefined, agentName: string|null|undefined}} a
 * @param {{userId: string|null|undefined, agentName: string|null|undefined}} b
 * @returns {boolean}
 */
function isSameIdentity(a, b) {
  if (!a || !b) return false;
  return a.userId === b.userId
    && (a.agentName ?? null) === (b.agentName ?? null);
}
```

### Semantics

1. **Symmetric**: `isSameIdentity(x, y) === isSameIdentity(y, x)`.
2. **Null/undefined equivalence**: an absent agent name is the same identity whether it arrives
   as `null` (from a DB row) or `undefined` (from an in-process identity object that omitted the
   field). This is the FR-015 bug fix.
3. **Never coerces `userId`**: `userId` is compared with strict `===`. A `null` user id equals
   only another `null` user id; the caller decides whether that is meaningful.
4. **`''` is not `null`**: an empty-string agent name is a *distinct* identity, not an absent
   one. It is never written by this feature (FR-007) but legacy rows carry it, and the predicate
   must not silently fold them into the human identity.
5. **Pure**: no I/O, no logging, no throwing.

### Required call sites (FR-015, SC-009)

| Site | Current form | After |
|---|---|---|
| `server/mcp/yjs/edit-range.js:185` | `r.userId === identity.userId && r.agentName === identity.agentName` | `isSameIdentity(r, identity)` — **behavior change (bug fix)** for the `null`/`undefined` case |
| `server/undo/inverse.js:80` | normalized inline | `isSameIdentity(r, identity)` — behavior-preserving |
| `server/undo/legacy.js:56-62` | normalized inline, **after** an `if (row.viaSync === true) return false` guard (038) | `isSameIdentity(row, identity)` **inside** the existing function, below the untouched `viaSync` guard — behavior-preserving |
| `server/mcp/tools/modify.js:308` | raw `===`, negated (foreign-edit filter) | `!isSameIdentity(u, agentToken)` — behavior-identical (D11) |
| `server/mcp/tools/modify.js:327` | raw `===` (`isSelf`) | `isSameIdentity(u, agentToken)` — behavior-identical (D11) |
| `server/api/chat-staleness.js:111` | raw `===` (`isOwnAgent`) | `isSameIdentity(u, agent)` — behavior-identical (D11) |

**Explicitly out of scope**: `server/origin.js:182` (`agentName: origin.agentName ?? null`) is
*normalization*, not comparison, and stays as it is. Parameterized SQL identity predicates
(`WHERE user_id = $2 AND agent_name = $3` in `edit-records.js`) are Postgres-side equality on a
`NOT NULL` column and are not replaced.

### Required test (SC-009)

One test file asserts that the three **undo** surfaces agree on the `null`-vs-`undefined`
agent-name case: given a DB-shaped row `{ userId: U, agentName: null }` and an in-process
identity `{ userId: U }` (no `agentName` key), the `edit-range` durability filter, the
`inverse` identity filter, and the `legacy` run detector all classify the row as the identity's
own. Before this feature the first disagreed with the other two.

---

## `recordEdit` boundary contract (FR-006, unchanged signature)

`server/undo/edit-records.js`'s `recordEdit(persistence, { docGuid, userId, agentName, clockStart, clockEnd, clocks })`
gains a precondition **evaluated before any SQL**:

- **Rejects** when `agentName` is `null`, `undefined`, not a `string`, or empty/whitespace-only.
- **Throws** an `Error` whose message names the missing identity, the document, and the user —
  never a raw Postgres `null value in column "agent_name" violates not-null constraint`.
- **Return shape on success is unchanged**: the inserted row, or `null` when the
  identity-unique constraint absorbed a duplicate.
- **Callers' non-fatal handling is unchanged (D6)**: `restoreVersion` (`version-history.js:663`)
  and `modify.js` (`:584`, and the background recorder at `:595`) keep logging and continuing —
  the user's content change is never lost to a recording failure.
- **`insertLegacyUndone` is deliberately not guarded** (research R7): it runs inside the
  `finalizeClaim` transaction, so throwing would roll back a legitimate undo. The sentinel-rule
  comment states this so a reader does not extend the guard unsafely.

---

# Contract — `GET /api/docs/:docId/undo-status` (additive, FR-016)

Sam's F1 decision (D13) adds the offer-honesty guard. The endpoint that already answers "can
this identity undo?" now also answers "**which record** would it act on?", so a client control
can refuse to offer an action it would misreport.

## Response shape

**Today** (unchanged meaning, unchanged for any client that ignores the additions):

```json
{ "canUndo": true, "canRedo": false }
```

**After FR-016**:

```json
{
  "canUndo": true,
  "canRedo": false,
  "nextUndo": { "editClockStart": 42 }
}
```

### Rules

1. **`canUndo` / `canRedo` are untouched** — same semantics, same type, same conditions. A client
   that never reads the new fields observes byte-identical behavior (SC-011).
2. **`nextUndo` / `nextRedo` are present only when an `agent_edits` row backs the answer.** They
   are **omitted**, never `null`-guessed and never zero-filled, when:
   - the corresponding `can*` is `false`; or
   - the answer came from the **legacy-derivation fallback**
     (`server/undo/undo-service.js:326-336`), which derives a range from the update log and has
     no record — so there is no stable identity to report.
3. **`editClockStart` is the record's immutable identity** (D14): `agent_edits.edit_clock_start`,
   part of the unique key `(doc_guid, user_id, agent_name, edit_clock_start)`. It is deliberately
   **not** `undo_target_start`/`redo_target_start`, which `finalizeClaim` **rewrites** on every
   transition — a client matching on those would stop matching after an undo↔redo cycle and the
   control would vanish from a perfectly valid card (US6 scenario 4).
4. **No new query and no schema change**: `getUndoStatus` already awaits
   `nextUndoTarget` / `nextRedoTarget`, both of which return the mapped row including
   `editClockStart`. The change is a response projection.
5. **Viewer role and error paths are unchanged**: both still answer
   `{canUndo: false, canRedo: false}` with no target fields.

## Client consumption (FR-017/FR-018)

`UndoEditButton` (`client/src/components/AiChatMessages.jsx:599`) currently gates on
`isLatest && (canAct || busy)`. It gains one condition — **the record must be this part's own
edit**:

```
targetClock  = reverted ? status?.nextRedo?.editClockStart
                        : status?.nextUndo?.editClockStart
partClock    = part.output?.editRange?.clockStart      // set by modify.js:574
isMyTarget   = targetClock === undefined || partClock === undefined
                 ? true                                 // fail-open (D15)
                 : targetClock === partClock
```

- **Fail-open is mandatory** (D15, US6 scenario 5). Either value can legitimately be missing —
  an older server, the legacy fallback, or a `modify` whose durability wait timed out and
  returned `editRangePending` with no `editRange`. In those cases the control behaves exactly as
  it does today. A fail-closed guard would silently strip a working Undo button from every
  pre-existing chat card: an honesty fix turned into a capability regression.
- **On mismatch the control is hidden**, matching the component's existing idiom (it already
  returns `null` when there is nothing to show). FR-017 permits a short honest reason instead;
  adding user-facing wording stays outside the revised D7 boundary (D16).
- **The `Reverted` label is unaffected** — an already-undone card keeps showing it. The guard
  governs the *action button*, not the historical marker. What FR-018 forbids is *setting* that
  flag on an edit that was not the one inverted, which the guard prevents by never letting the
  click happen.
- **`isLatest` stays.** It is a cheaper necessary condition and preserves today's
  latest-edit-only chat semantics; the new check is an additional gate, not a replacement.

## Required tests (SC-010, SC-011, SC-012)

| # | Scenario | Expected |
|---|---|---|
| a | modify card present; a restore is the identity's next undo target | no Undo control offered; no click path can stamp "Reverted" on that modify |
| b | modify card present; that modify IS the next undo target | Undo offered exactly as today |
| c | both of the above | the undo endpoint still inverts the identity's true next target correctly — the guard changes what is offered, never what the endpoint does |
| d | undone card whose record is the next **redo** target | Redo offered — the same rule governs both directions, and `editClockStart` still matches after the undo (proves D14's choice of field) |
| e | `nextUndo` absent (legacy fallback / older response), or `editRange` absent (`editRangePending`) | control offered — fail-open, never fail-blank |
