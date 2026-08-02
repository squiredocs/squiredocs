# 045-resupply-attribution — promotion notes

Seeded by the implementer for the merge queue and the post-merge adversarial
review. Branch `045-resupply-attribution`, off `main` @ `e1af5061` (044 merged;
the plan was written against `62bccbc7`, which is the same substrate plus 044's
docs commit — every symbol the plan assumed was verified present, no drift).

**What shipped**: no author-displaying surface presents a sync relayer as the
author of content they only carried. A new read-time module recovers the true
author from a `via_sync` row's own embedded Yjs client identities, bound to
users by the document's PRIOR directly-attributed rows; anything unresolvable
renders as a new **"Synced content"** contributor, never the relayer and never a
guess. The timeline (auto, named, both fragment shapes), the drill-down, the
per-clock author, and the MCP recent-authors feed (including `lastModifiedBy`)
consume ONE resolution. The collaboration guardrail stops going blind on agent
content that arrived through a human's reconnect. The durability window itself
is untouched and now recorded as a ratifiable accepted residual.

**No migration, no backfill, no schema change, no new env var required** (the
four knobs all have defaults). Deploy is a plain image roll; rollback is a
revert.

---

## Files

| File | Change |
|---|---|
| `server/resupply-resolution.js` | NEW — origin extraction, evidence fold, memo, `_stats()` seam |
| `server/postgres-persistence.js` | `getUpdatePayloads`, `getDirectAttributedRows`, `getUserDisplayFields`; `_mapUpdateRow` comment states the new display consumer |
| `server/version-history.js` | `SYNCED_CONTRIBUTION`, `collectAuthorsForUpdate`, `authorFromOrigin`, `authorForSingleSlot`; `{ resolution }` threaded through grouping/range/fragment/merge; timeline, drill-down and per-clock wired |
| `server/collab-guardrail.js` | widened fresh-row query, candidate classification, additive alert fields, `init(pool, persistence)` |
| `server/mcp/tools/read-document.js` | one resolution feeding `recentAuthors` and `lastModifiedBy` |
| `server/index.js` | guardrail init argument; 038 FR-018 window comment cross-references RBD-045-5 (comment only) |
| `client/src/components/HierarchicalVersionList.{jsx,css}` | outlined dot + explanatory title for `author.isSynced` |
| tests | `server/__tests__/resupply-resolution.test.js` (new, 28), `server/__tests__/resupply-attribution.test.js` (new, 7), `version-history.test.js` (+13), `collab-guardrail.test.js` (+7), `HierarchicalVersionList.test.jsx` (+3) |

---

## Decisions taken during implementation

Recorded in full in `clarifications-needed.md` as RBD-045-13..15
(RATIFIED-BY-DEFAULT):

- **RBD-045-13 — FIFO cache eviction**, not LRU (the plan left the policy open,
  F10). An evicted outcome costs a recompute, never correctness, so per-read
  recency bookkeeping on a display path would buy nothing.
- **RBD-045-14 — MCP `lastModifiedBy` gains 040's unknown-author fallback.**
  Adopting the shared single-slot helper changes that one field from `null` to
  `Unknown author` for a deleted-account row, matching what the per-clock view
  has done since 040. `null` now means only "there is no row".
- **RBD-045-15 — the guardrail's `agentUserId` is computed from DIRECT matched
  rows only**, with a sync candidate's stamped user reported as the additive
  `relayedByUserId`. Existing alerts stay byte-identical and no relayer is
  presented as an agent's user.

## The analyze gate's MEDIUMs

| ID | Disposition |
|---|---|
| **F1** | Implemented as directed: a self-relay with NO prior evidence renders "Synced content" (FR-004 over US1-3's literal text). Covered by the resolver's no-evidence case; the self-relay tests stage prior attributed rows, matching US1 scenario 3's own framing. Still flagged for Sam as RBD-045-10. |
| **F3** | The guardrail EXCLUDES a `via_sync` row whose origins all resolve to humans, asserted explicitly: `a resupplied row whose origins ALL resolve to humans does NOT page (F3)` in `collab-guardrail.test.js`. |
| **F4** | `RESUPPLY_EVIDENCE_MAX_ROWS` (default 20000) trips one `console.warn` and resolves every remaining target as unresolvable — an honest refusal, never a partial-evidence guess. Tested with the cap lowered to 2. |
| **F5** | Deleted-account steady state is the synced contribution; the unreachable branch was not built. The reachable half (a resolved id absent from the `users` lookup ⇒ `UNKNOWN_AUTHOR`) is implemented and tested. |
| **F7** | Direct-path alert payloads are byte-identical: `syncSourcedCandidates` and `relayedByUserId` are omitted entirely unless a MATCHED row was sync-relayed. Pinned by the `DIRECT agent_name path is byte-identical` test. |
| **F9** | The resolver fetches its own payloads through `getUpdatePayloads`. `getContentAtClock` and the drill-down still read `includeData: false`; nothing reintroduced payload transfer into a metadata read. |
| **F10** | The eviction rule is stated in the module header of `server/resupply-resolution.js` (RBD-045-13). |

## FR-014 (loss path untouched) — verified by diff

`git diff e1af5061 -- server/index.js server/postgres-persistence.js server/retry.js server/shutdown.js`:
`retry.js` and `shutdown.js` are unchanged; `postgres-persistence.js` adds three
READ-ONLY methods and one comment (`storeUpdate`, `_runStoreSlot`,
`_storeUpdateCritical` untouched); `index.js` changes are one comment block at
the bindState listener and the guardrail's init argument (post-persist,
fire-and-forget, detection-only). Write/broadcast ordering, retry policy and
drain behavior are byte-identical, so 043's US3 characterization will observe
exactly pre-045 behavior.

## Verification

| Suite | Result |
|---|---|
| `server/__tests__` (full, `--runInBand`) | 130 suites / 2195 tests green |
| `__tests__/integration` (full, `--runInBand`) | 20 suites / 214 tests green |
| `client` Vitest (full) | 71 files / 878 tests green |
| `client` production build | green (`vite build` + documentation + blog) |

Baseline before any edit (`version-history` + `collab-guardrail`): 112 green, so
nothing here is masking a pre-existing failure. Backend runs used a per-worktree
database (`collab_test_db_045`), serially.

Note for anyone running targeted suites: jest runs that touch `y-protocols`
Awareness need `--forceExit` (a staleness-prune interval keeps the process alive
after green). Unrelated to this feature.

---

## Note for the merge queue

1. **README (Constitution I) — owed at merge.** This agent may not edit
   `README.md`. Two places now understate what the product does:
   - the **version-history section** (~L446-475): relayed content is credited to
     its recovered author, or shown as a distinct "Synced content" contributor —
     never the relaying client.
   - the **`via_sync` paragraph** (~L1128): the flag now also drives display
     resolution, which never rewrites the row and never treats the stamp as
     authorship.
2. **043's sequencing line** still says "after 041 and 042" and must be extended
   to "after 041, 042, and 045" (RBD-045-7, orchestrator-owned). 043's US2/FR-003
   assertion ("the timeline does not credit the relaying client") goes GREEN only
   once this is on `main`.
3. **No migration, no backfill, no deploy ordering.** The migration slot stays
   free.
4. **Do not duplicate 043's harness.** 045 stages resupplies as fabricated rows;
   the real reconnect end-to-end test is 043's (R15).
5. **Design docs need no edit.** `design/collaboration-core.md`'s 2026-08-02
   amendment already states the ratified direction and the residual, and `design/`
   is a Squire export that agents must not hand-edit.

## Owed to Sam (not gating merge)

1. **Ratify RBD-045-5** — the publish-before-commit durability window as an
   accepted residual (confirm / overturn). Overturning promotes
   durable-before-broadcast into its own feature.
2. **Look at RBD-045-10** — the narrow softening of 038's credit promise: a
   genuine offline edit whose session never committed a direct row in that
   document has no evidence, so it renders "Synced content" rather than its
   author. The mitigation (capturing the connection's own Yjs client identity at
   write time) is deliberately a separate feature.
3. **The manual UI walk** in `quickstart.md`: a version showing the recovered
   author, a version showing the outlined "Synced content" dot with its tooltip,
   the two synthetic entries side by side, and both themes.
