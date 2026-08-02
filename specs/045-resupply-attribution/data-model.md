# Phase 1 Data Model — 045-resupply-attribution

**No schema change. No migration. No backfill.** Every field this feature reads already
exists in `yjs_updates` (`via_sync` from migration `1799700000000`, `update_data`, `user_id`,
`agent_name`, `meaningful`, `clock`, `created_at`). The entities below are all in-memory,
derived, and display-scoped.

---

## 1. Sync-relayed row (existing, unchanged on disk)

`yjs_updates` row with `via_sync = true`. Meaning is fixed by the 038 contract, restated at
`server/postgres-persistence.js` `_mapUpdateRow`: the content reached the server THROUGH that
client, never that the client wrote it. `via_sync` `NULL`/`false` are identical and are never
suspicious.

| Field | Source | Role in this feature |
|---|---|---|
| `clock` | existing | memo key, evidence ordering |
| `via_sync` | existing | selects rows needing resolution (`=== true` only) |
| `update_data` | existing | decoded once for origin extraction |
| `user_id` / `agent_name` | existing | the STAMPED identity — never displayed as authorship of this row's content |
| `meaningful` | existing | 041's filter applies BEFORE resolution; unchanged |

**This feature never writes to `yjs_updates`.** The stamped row is never rewritten (FR-010).

---

## 2. Origin client identity (derived, transient)

The set of Yjs client identities embedded in a row's payload:
`[...Y.parseUpdateMeta(updateData).to.keys()]`.

- Empty set ⇒ the payload inserts nothing (deletion-only) ⇒ UNRESOLVABLE (FR-005).
- Delete-set client identities are structurally excluded (verified: `parseUpdateMeta` reports
  struct clients only) — they name the DELETED content's author, never the deleter.
- Never conflated with `yjs_updates.clock`, which is a per-document DB coordinate.

---

## 3. Evidence map (derived, per document, memoized)

`byClient: Map<clientID, { userId, agentName } | AMBIGUOUS>`

Built by folding, in ascending clock order, the origin client identities of **evidence rows**:

```
evidence row  ≡  same doc_guid
              ∧  clock < target clock          (prior only — R2)
              ∧  via_sync IS NOT TRUE          (a relayed row is never evidence — FR-006)
              ∧  user_id IS NOT NULL           (an unattributed row proves nothing)
```

Fold rules:

| Situation | Result |
|---|---|
| identity unseen | bind to this row's `(userId, agentName)` |
| identity re-seen with the SAME `(userId, agentName)` | unchanged |
| identity re-seen with a DIFFERENT `(userId, agentName)` | `AMBIGUOUS` (sticky, never un-set) |

Identity is the PAIR: the same user acting as themselves and as an agent are different
display identities, and a client identity that carries both is ambiguous.

Companion state per document: `scannedThroughClock` (how far the ascending fold has run) —
lets later targets extend the scan instead of restarting (R4).

---

## 4. Resolution outcome (derived, per row, memoized permanently)

```js
{ origins: [ { userId, agentName } ],   // deduped, sorted by (userId, agentName) for stable order
  unresolved: boolean }                 // true if ANY content-bearing origin failed to resolve
```

Produced only for rows with `via_sync === true`. Derivation from the row's origin identities:

| Origin identities | Outcome |
|---|---|
| empty (deletion-only) | `{ origins: [], unresolved: true }` |
| all bind to identities | `{ origins: [...], unresolved: false }` |
| some bind, some unknown/`AMBIGUOUS` | `{ origins: [bound ones], unresolved: true }` — FR-005: credit every resolvable origin, add exactly ONE unresolved marker |
| none bind | `{ origins: [], unresolved: true }` |
| evidence cap exceeded (R5) | `{ origins: [], unresolved: true }` |

**Immutability**: evidence is prior-only over an append-only log, so an outcome cannot change.
The memo key is `${docGuid}:${clock}` and entries never need invalidation.

**Self-relay**: nothing special. If the resolved origin equals the stamped identity, the row
displays exactly as a direct edit (FR-003, 038's promise preserved).

**Chained relay**: structurally impossible to launder — a `via_sync` row is excluded from the
evidence query, so it can never supply an identity binding for another row.

---

## 5. Display directory (derived, per request, not memoized)

`Map<userId, { userName, userEmail, userPicture }>` assembled from the caller's already-fetched
rows, plus one batched `users` lookup for resolved ids absent from them (R6). Keeping display
fields OUT of the memo is what prevents stale names and avatars.

A resolved `userId` with no `users` record ⇒ the deleted-account rule: `UNKNOWN_AUTHOR`, not
the synced contribution (RBD-045-11).

---

## 6. Synced contribution (display entity, new)

```js
SYNCED_CONTRIBUTION = Object.freeze({
  id: null, name: 'Synced content', email: null, picture: null,
  color: '#888888', isAgent: false, isSynced: true,
})
SYNCED_CONTRIBUTION_KEY = 'synced'
```

- Exported from `server/version-history.js` beside `UNKNOWN_AUTHOR` (040 FR-008 pattern).
- The fixed key collapses any number of unresolvable origins across any number of rows into
  exactly ONE entry per version/sub-version, and lets it coexist with real authors.
- Distinct from `UNKNOWN_AUTHOR` by `name` and by the additive `isSynced` marker the client
  styles on (RBD-045-2). The two may appear together in one version and remain distinguishable.

---

## 7. Guardrail candidate (existing entity, widened)

A fresh `yjs_updates` row the guardrail treats as agent content when checking a human
deletion. Membership after this feature:

| Row | Candidate? | Path |
|---|---|---|
| `agent_name IS NOT NULL` | yes | existing path, byte-for-byte unchanged |
| `via_sync = true`, resolved origin includes an agent | yes | new |
| `via_sync = true`, unresolved | yes (conservative — RBD-045-4) | new |
| `via_sync = true`, all origins resolve to humans | no | new |
| everything else | no | unchanged |

Item-ID intersection, suppression keying, alert payload shape, and the never-block posture are
unchanged (FR-012).

---

## 8. Accepted-residual record (documentation entity)

RBD-045-5 in `specs/045-resupply-attribution/clarifications-needed.md`, cross-referenced from
`design/collaboration-core.md`'s 2026-08-02 amendment and from the 038 FR-018 window comment
at the persistence listener in `server/index.js`. No runtime representation; FR-014 forbids any
change to the write/broadcast ordering, retry policy, or drain behavior that produced it.
