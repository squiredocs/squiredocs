# Phase 0 Research — 045-resupply-attribution

**Planned against**: `main` @ 62bccbc7 (includes merged 041 and 042). Every anchor below
was re-located BY SYMBOL in the working tree on 2026-08-02; the pre-041 line numbers in
`tmp/045-resupply-attribution-investigation.md` are stale and were not trusted.

Each decision is stated as Decision / Rationale / Alternatives, and is referenced by
`plan.md`, the contracts, and `tasks.md`.

---

## R1 — Where the forensic resolution runs: READ TIME, memoized. **No migration.**

**Decision**: Resolution is computed at READ time, in one new server module
(`server/resupply-resolution.js`), and memoized per `(docGuid, clock)` in a bounded
per-process cache. **045 does NOT take the migration slot. No `node-pg-migrate` file is
added, no column, no backfill.**

**Rationale**:

1. **The persisted-resolution option cannot satisfy FR-008 on its own.** FR-008 requires
   every historical `via_sync` row — including rows already in production logs — to resolve
   at display time with no backfill. A write-time column only ever covers rows written
   AFTER the migration, so shipping it means shipping the read-time path anyway (for the
   historical population) and then maintaining two mechanisms that must agree. Two
   mechanisms that must agree is exactly the divergence FR-007 forbids.
2. **The expensive half of resolution is EVIDENCE, and evidence cannot be cheaply
   persisted retroactively.** Mapping a `via_sync` row's embedded client identity to a user
   needs the client identities of *prior directly-attributed rows*. Persisting those at
   write time (a `yjs_client_ids` column) would make evidence a single indexed query — but
   backfilling it means decoding **every** `yjs_updates` row in **every** document, not just
   the small `via_sync` population. That is a corpus-wide decode job, i.e. the heaviest
   possible deploy story, to buy an optimization the memo already buys.
3. **The `via_sync` population is small and recent** (the flag shipped with 038 on
   2026-08-01; only SyncStep2-applied writes set it), so there is very little to resolve and
   the memo warms in one request per document per process.
4. **Deploy story stays trivial**: code-only, no migration, no backfill, roll back by
   reverting the commit. Against a migration's cost (ordering floor > 1795000000000, a
   backfill pass, an irreversible-ish deploy step, and the in-flight migration slot spent),
   the memo wins outright.

**Alternatives considered**:

- *Write-time resolution stored in a new column*: rejected per (1)/(2). It is the cleanest
  design ON PAPER and would make SC-005 trivially true, but it fails FR-008 without a
  backfill and needs the read path regardless.
- *Redis-backed resolution cache*: rejected. Redis is optional in this deployment, and 042
  just DELETED a dormant Redis doc cache; reintroducing a Redis cache for a rare-row lookup
  is ceremony (Constitution III) with a second consistency story.
- *Resolve on every request with no memo*: rejected — violates FR-009 and SC-005.

---

## R2 — Evidence is PRIOR-ONLY, which is what makes an outcome immutable and cacheable

**Decision**: The evidence set for a `via_sync` row at clock `C` is the document's rows with
`clock < C` that are directly attributed: `via_sync IS NOT TRUE` **and** `user_id IS NOT
NULL`. Evidence never crosses documents. A resolved outcome is therefore **immutable** (the
log is append-only and clocks are assigned max+1), so the memo needs no invalidation and can
be keyed `(docGuid, clock)` for the process lifetime.

**Rationale**: FR-006 and the spec's Key Entities both state evidence precedes the row in
clock order. Beyond spec compliance it is load-bearing: if later-arriving rows could become
evidence, the same row would resolve differently on different requests, breaking FR-007
determinism and forcing cache invalidation on every write.

**Alternatives considered**: *Any directly-attributed row in the document (including later
ones)*: slightly higher resolution rate (a returning author re-editing later would supply
evidence), rejected because it makes outcomes mutable and non-deterministic across requests.

---

## R3 — Origin extraction uses `Y.parseUpdateMeta`, which gives FR-005's deletion rule for free

**Decision**: A row's embedded origin client identities are
`[...Y.parseUpdateMeta(updateData).to.keys()]`. An empty set means the payload carries no
inserted structs (a deletion-only payload) and the row is UNRESOLVABLE by construction.

**Rationale**: Verified empirically against the installed `yjs@13.6.30` on 2026-08-02:

```
deletion-only update  → parseUpdateMeta(u).to = []   (decodeUpdate(u).ds.clients = [author of deleted content])
insert update         → parseUpdateMeta(u).to = [the inserting client]
```

`parseUpdateMeta` reads struct headers only and never exposes delete-set clients — which is
exactly FR-005's requirement that a deletion payload's identifiers (they name the DELETED
content's author, not the deleter) must never be used to attribute anyone. Using
`Y.decodeUpdate(...).structs` would work too but materializes every struct; `parseUpdateMeta`
is the cheaper read and makes the deletion rule structural rather than a filter someone can
later "optimize" away.

**Alternatives considered**: *`Y.decodeUpdate().structs` filtered to `Item`s with length > 0*:
equivalent result, more allocation, and the deletion-set trap sits one careless edit away.

---

## R4 — Evidence-map construction: one ascending pass, targets snapshotted in clock order

**Decision**: For the set of unresolved target clocks in a request, sort ascending, scan the
document's direct rows ascending in batches (default 500), fold each row's client identities
into `byClient: Map<clientID, {userId, agentName} | AMBIGUOUS>`, and snapshot each target's
outcome when the scan crosses that target's clock. One pass resolves all targets while
honoring "evidence strictly before this row" per target. A per-document
`{byClient, scannedThroughClock}` is retained so later (higher-clock) targets extend the scan
forward instead of restarting; a target BELOW `scannedThroughClock` that is not already
memoized (only reachable after cache eviction) restarts the scan from the beginning.

**Rationale**: Naively rebuilding evidence per target is O(targets × rows). The single
ascending pass is O(rows) once per document per process, and the retained map makes the
steady state O(new rows).

**Alternatives considered**: *A bounded evidence window (last K direct rows before the
target)*: cheaper worst case, rejected because a conflicting association OUTSIDE the window
would go unseen and turn an FR-006 "ambiguous, refuse" into a confident answer — precisely
the failure mode this feature exists to end. A cost ceiling is enforced instead (R5).

---

## R5 — Cost ceiling: refuse honestly rather than burn CPU

**Decision**: `RESUPPLY_EVIDENCE_MAX_ROWS` (default 20000) caps the evidence rows decoded for
one document. Beyond the cap the scan stops and every unresolved target for that document
resolves to UNRESOLVABLE (synced contribution) with a single `console.warn`. Documents above
the cap are rare; the outcome is honest, never a guess.

**Rationale**: An unbounded first-render scan on a pathological document would put an
unbounded decode on a timeline request. The cap is a fail-honest degradation, consistent with
the feature's whole posture (an honest label beats a fabricated author). Because the cap is
config-fixed, outcomes stay deterministic for a given deployment (FR-007).

**Alternatives considered**: *No cap* (unbounded worst case); *cap → resolve from partial
evidence* (reintroduces the R4 ambiguity hole).

---

## R6 — Two-layer output: identity-only outcome (cached) + per-request display directory

**Decision**: A cached outcome holds IDENTIFIERS only:
`{ origins: [{ userId, agentName }], unresolved: boolean }`. Display fields
(`userName`, `userEmail`, `userPicture`) are materialized per request from a **directory**
built out of (a) the rows the caller already fetched (they carry the `users` join) and, only
for resolved user ids absent from those rows, (b) one batched
`SELECT id, name, email, picture FROM users WHERE id = ANY($1)`.

**Rationale**: Caching display fields would serve stale names/avatars after a rename and would
force a TTL (which re-triggers evidence scans). Caching identifiers only keeps outcomes
permanently valid. The timeline (which fetches ALL rows) needs no extra query at all, because
resolution SUCCEEDS only when a prior direct row of that user exists in the same document —
so that row, with its join, is always in the timeline's own row set. Only windowed callers
(drill-down range, recent-100) can miss it, and they pay one small indexed lookup.

**Alternatives considered**: *Materialize authors inside the resolver and cache them*
(stale display data); *re-query users per resolved origin* (N+1).

---

## R7 — One resolution, one author-collection helper, four (plus one) renderers

**Decision**: `server/version-history.js` gains ONE private helper,
`collectAuthorsForUpdate(update, authorsMap, ctx)`, that both `groupUpdatesIntoVersions` and
`computeRangeMeta` call in place of their currently-duplicated author-accumulation blocks.
The helper is the ONLY place that knows about `via_sync`. Surfaces receive a resolution
context (`{ outcomes, directory }`) threaded from the caller; with no context, behavior is
byte-identical to today.

Consumers wired:

| Surface | Entry point | Wiring |
|---|---|---|
| Timeline (auto, named, fragments) | `getVersionTimeline` → `groupUpdatesIntoVersions`, `mergeNamedVersions` → `computeRangeMeta`/`computeFragmentMeta` | resolve once on the full row set, thread ctx |
| Drill-down | `getUpdatesForVersion` → `groupUpdatesIntoVersions` | resolve on the range rows; the projection at the call site must stop dropping `viaSync` |
| Per-clock author | `getContentAtClock` | resolve the single row; single-slot rule (R8) |
| Recent authors / MCP | `getCurrentSessionAuthors` (sync) ← `server/mcp/tools/read-document.js` | caller awaits the resolver and passes ctx; function stays synchronous |
| `lastModifiedBy` (MCP) | `read-document.js` `createAuthor(lastUpdate)` | same ctx, single-slot rule — see RBD-045-12 |

**Rationale**: FR-007 forbids divergeable per-surface logic. The two author-accumulation
blocks in `version-history.js` are already near-duplicates (041 documented that they MUST
stay identical); collapsing them into one helper is the only change that makes "one
resolution, many renderers" structurally true instead of a comment.

**Alternatives considered**: *Rewrite each `via_sync` row's `userId` before it reaches the
renderers*: attractive (zero renderer changes) but cannot express FR-005's multi-origin case
(one row → several authors) without fabricating pseudo-rows, which would corrupt the
drill-down's `updateCount`.

---

## R8 — Single-slot surfaces (per-clock author, `lastModifiedBy`) use a defined collapse

**Decision**: Where a surface displays exactly ONE author for a row: exactly one resolved
origin and nothing unresolved ⇒ that author; anything else (multi-origin, any unresolved,
deletion-only) ⇒ the synced contribution. Recorded as RBD-045-9.

**Rationale**: The RESOLUTION is identical across surfaces (FR-007 satisfied); only the
rendering arity differs. Picking "the first resolved origin" for a multi-origin row would
display a true-but-incomplete author as if it were the whole story, and would let the
timeline and the per-clock view disagree about who is credited.

---

## R9 — The synced contribution is a server-side synthetic author, mirroring 040's UNKNOWN_AUTHOR

**Decision**: `SYNCED_CONTRIBUTION`, a frozen author object exported from
`server/version-history.js` beside `UNKNOWN_AUTHOR`, collapsed under a fixed map key
(`SYNCED_CONTRIBUTION_KEY = 'synced'`) so any number of unresolvable origins in a version
render as exactly one entry:

```js
{ id: null, name: 'Synced content', email: null, picture: null,
  color: '#888888', isAgent: false, isSynced: true }
```

**Rationale**: This is exactly the shipped 040 FR-008 pattern (fixed key, neutral color,
computed entirely server-side), which the client already renders with zero changes —
`HierarchicalVersionList`'s `AuthorList` and `VersionPreview` read `name`/`color` only, and
key on `author.id || i`. The additive `isSynced` marker is what lets the client style it
DISTINCTLY from `UNKNOWN_AUTHOR` (RBD-045-2) without string-matching a display name.

**Alternatives considered**: *Reuse `UNKNOWN_AUTHOR`*: forbidden by RBD-045-2 (the two state
different facts). *A separate top-level API field (e.g. `version.syncedContribution: true`)*:
rejected — it would make every renderer implement its own merge of two lists.

---

## R10 — Client work is one styling touch, not a rendering rework

**Decision**: Client changes are limited to: distinct rendering for `author.isSynced` in
`HierarchicalVersionList` (dot style + `title` explaining the state) and the matching CSS,
plus Vitest coverage. `VersionPreview` inherits the name-based rendering unchanged.

**Rationale**: Verified — the client has zero `via_sync` references and computes no authorship;
all four surfaces are server-computed. Honesty therefore lands server-side, and the client's
only job is to not make "Synced content" look like a person.

---

## R11 — Guardrail candidate widening is a WHERE-clause widening plus a resolution filter

**Decision**: `server/collab-guardrail.js` fresh-row query becomes

```sql
AND (agent_name IS NOT NULL OR via_sync IS TRUE)
```

(selecting `via_sync` as well). Rows with `agent_name IS NOT NULL` follow the existing path
byte-for-byte. Rows that are `via_sync` without an agent name are resolved through the shared
resolver: origins containing an agent identity ⇒ candidate; unresolved ⇒ candidate
(conservative, RBD-045-4); all origins resolve to humans ⇒ NOT a candidate (it is human
content, and the guardrail's signature is a human deleting AGENT content). Alert extras gain
an additive `syncSourcedCandidates: true` when a matched candidate was sync-relayed; the
existing trigger-level `syncSourced` annotation is untouched, so existing pages stay
byte-identical. An unresolved candidate contributes the agent-name placeholder
`unknown (sync-relayed)` to the alert's `agentName` join rather than an empty string.

**Rationale**: FR-011/FR-012: the candidate set only ever widens, never narrows, and posture
(alert-only, all failures swallowed) is unchanged. Cost is bounded because the query is
already recency-bounded to the freshness window (default 10 s), so the widened predicate can
only add rows in the exact window a resupply just happened — and only when the triggering
human update carries a non-empty delete set (the existing cheap-first guard).

**Alternatives considered**: *Include ALL fresh `via_sync` rows without resolving*: simpler
and never blind, but pages on human-content resupply deletions that the guardrail was never
meant to watch; RBD-045-4 asks for conservative treatment of the UNRESOLVED case only.
*`cachedOnly` resolution in the guardrail* (never wait for a scan): rejected — it would make
alerting depend on cache state.

---

## R12 — Agent content resolves cleanly; server-shared-doc content honestly refuses

**Decision**: No special-casing for agents. Verified: MCP `modify` edits are applied through
`session.provider.doc` (`server/mcp/tools/modify.js` — the per-agent-session Y.Doc opened by
`server/mcp/agent-presence.js`), so an agent session has its OWN Yjs client identity and its
rows carry a consistent `(userId, agentName)` pair — clean, unambiguous evidence. That is what
makes US1 scenario 4 (an agent's lost edit relayed by a human) resolve to the agent.

Content produced ON the server's shared Y.Doc (restore's clone, undo/redo inverses applied via
`server/live-apply.js`, import writes) shares one client identity across whichever users acted
on that pod, so that identity typically maps to several users and is AMBIGUOUS. Resupplied
server-origin content therefore renders as the synced contribution. This is correct behavior,
not a defect: the identity genuinely does not determine an author.

**Alternatives considered**: none — special-casing the shared-doc identity would mean guessing.

---

## R13 — Known evidence-quality limits, documented rather than engineered around

**Decision**: Three limits are accepted and documented (ledger N-045-1, RBD-045-10,
RBD-045-11) rather than mitigated in this feature:

1. **Pre-038 unmarked resupplies are evidence-eligible.** Rows written before the `via_sync`
   marker existed carry `NULL`, and the 038 contract forbids treating `NULL` as suspicious, so
   a pre-038 resupply row can associate a client identity with the RELAYER. Where that is the
   only association for that identity, a later resupply can resolve to the wrong user. Bounded
   (it needs the true author to have no correctly-attributed row for that session in the same
   document) and strictly no worse than today's unconditional lie.
2. **A first-session offline edit re-supplied by its own author has no evidence** (nothing from
   that session ever committed directly), so it renders as the synced contribution instead of
   its author — an honest hedge, but a narrow softening of the 038 credit promise. Recorded as
   RBD-045-10; the SC-002 test matrix stages prior attributed rows, matching US1 scenario 3's
   "A has prior attributed edits" framing.
3. **Account deletion erases evidence** (`yjs_updates.user_id` is `ON DELETE SET NULL`), so the
   spec's "resupply whose author's account was since deleted → Unknown author" edge case is
   reachable only while a resolved outcome is still memoized; the steady state after deletion
   is the synced contribution. Both renderings are honest. Recorded as RBD-045-11.

---

## R14 — Scope guard (FR-010) is enforced by a test, not only by intent

**Decision**: A test asserts that `server/undo/`, `server/diff-service.js`, and the restore
path do not import `server/resupply-resolution.js`, and that undo's existing `viaSync`
run-breaking guard (`server/undo/legacy.js:62`) is unchanged. `restoreVersion`,
`getVersionContent`, replay, and permissions never receive a resolution context.

**Rationale**: FR-010 is the safety rail that keeps a display-only inference out of paths that
mutate documents. A grep-style import test is cheap and survives refactors better than a
comment.

---

## R15 — Tests: 045 fabricates its own resupply rows; the real reconnect E2E stays 043's job

**Decision**: 045 ships (a) unit tests over the resolver with fabricated Yjs updates (build two
Y.Docs, take their update bytes, insert rows with `via_sync=true` stamped to the wrong user),
(b) integration tests over the four display surfaces + the guardrail against a real database,
(c) client Vitest coverage for the synced-contribution rendering. It does NOT build a
reconnect/WebSocket harness. 043's US2 supplies the end-to-end reconnect assertion once it
merges (after 045).

**Rationale**: The interlock is explicit in the spec (045 merges BEFORE 043) and in RBD-045-7.
043's extraction-contract harness may land useful infrastructure LATER; depending on it would
invert the merge order. Fabricated rows exercise every branch of the resolution matrix
(resolvable, ambiguous, deletion-only, multi-origin, self-relay, chained relay) far more
precisely than a staged incident could.

---

## R16 — Instrumentation seam for SC-005

**Decision**: The resolver exports `_stats()` (`{ evidenceRowsDecoded, targetRowsDecoded,
evidenceQueries }`) and `_resetForTest()`. SC-005's assertion is a second identical timeline
request over the same rows performing zero additional decodes.

**Rationale**: SC-005 explicitly calls for instrumentation/spies; a counter on the module is
simpler and more stable than spying on `yjs` internals.
