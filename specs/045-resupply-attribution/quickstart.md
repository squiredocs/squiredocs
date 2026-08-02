# Quickstart Validation — 045-resupply-attribution

Prerequisites: repo at `main` with 044 merged and 045 implemented; backend test stack per
`docs/dev.md` (in the `app-dev` pod) or the local pg+pgvector+redis stack. **Backend suites
run SERIALLY against one shared DB** — never launch concurrent backend runs. Client suites run
under Vitest.

**No migration to run.** This feature adds no schema change and needs no backfill; the
`via_sync` column it reads shipped with 038 (`migrations/1799700000000_add-via-sync-to-yjs-updates.js`).

## Run the affected suites

```bash
# Backend (serial; from repo root)
npx jest server/__tests__/resupply-resolution.test.js \
         server/__tests__/resupply-attribution.test.js \
         server/__tests__/version-history.test.js \
         server/__tests__/collab-guardrail.test.js \
         --runInBand

# Integration (serial)
npx jest __tests__/integration --runInBand

# Client
cd client && npx vitest run src/components/__tests__/HierarchicalVersionList.test.jsx
```

## Staging a resupply without a reconnect

The resolution matrix is exercised with FABRICATED rows — real Yjs updates, written straight to
`yjs_updates` with the wrong stamp. This is the whole test substrate for 045; the real
reconnect end-to-end assertion belongs to 043 (which merges AFTER 045, RBD-045-7). Do not build
a WebSocket harness here.

```
1. Y.Doc A (client id CA) inserts "alpha"      → row @clock1, user_id = A, via_sync NULL
   (this is the EVIDENCE that binds CA → A)
2. Y.Doc A inserts "bravo"                     → capture the update bytes, do NOT store yet
3. store those bytes                           → row @clock2, user_id = B, via_sync = true
   (the mis-stamped resupply: B's stamp, A's content)
4. GET the timeline / drill-down / clock view / MCP read
   ⇒ every surface credits A for clock2 and never B
```

Variants the matrix must cover: no prior evidence (⇒ synced contribution); the same client id
bound to two users in prior rows (⇒ ambiguous ⇒ synced contribution); a deletion-only payload
(⇒ synced contribution, and the deleted content's author is NOT credited); one row carrying two
clients where only one resolves (⇒ that author + exactly one synced entry); self-relay with
prior evidence (⇒ unchanged credit, no hedging); a `via_sync` row used as the only "evidence"
for another `via_sync` row (⇒ never resolves — chains cannot launder).

## Manual walk (owed to Sam, non-blocking)

1. Open a document with a fabricated resupply row in the web UI, open History: the version
   shows the true author, not the relayer, and a version whose rows are all unresolvable shows
   the "Synced content" entry with the outlined dot and its explanatory tooltip.
2. In the same version, confirm a deleted-account row's "Unknown author" and the synced
   contribution appear as two distinct entries.
3. Expand the drill-down: the same authors, no disagreement with the timeline.
4. Dark mode: the outlined dot and its label are legible in both themes.

## FR → test matrix

| FR | Assertion | Home |
|---|---|---|
| FR-001 | no surface displays a `via_sync` row's stamped identity as authorship | `version-history.test.js`, `resupply-attribution.test.js` |
| FR-002 | client id → user mapping from prior directly-attributed rows recovers the true author | `resupply-resolution.test.js` |
| FR-003 | a resolved origin renders identically to a direct author (human + agent); self-relay unchanged | `version-history.test.js` |
| FR-004 | unresolvable ⇒ `SYNCED_CONTRIBUTION`, distinct from `UNKNOWN_AUTHOR`, relayer never shown | `version-history.test.js`, `HierarchicalVersionList.test.jsx` |
| FR-005 | multi-origin credits all resolvable + exactly one synced entry; deletion-only attributes nobody | `resupply-resolution.test.js`, `version-history.test.js` |
| FR-006 | ambiguity refuses; evidence never crosses documents; a `via_sync` row is never evidence | `resupply-resolution.test.js` |
| FR-007 | timeline, drill-down, per-clock, recent-authors agree on one staged row | `resupply-attribution.test.js` (cross-surface case) |
| FR-008 | rows pre-dating the feature resolve with no backfill; `via_sync` NULL/false unaffected | `resupply-resolution.test.js`, `version-history.test.js` |
| FR-009 | second identical request ⇒ `_stats()` shows zero additional decodes; no-`via_sync` doc ⇒ zero queries | `resupply-resolution.test.js` |
| FR-010 | undo/diff/restore/permissions never import or receive a resolution; undo's `viaSync` guard unchanged | `resupply-resolution.test.js` (import guard) + existing undo suites stay green |
| FR-011 | human deletion of fresh resupplied agent content alerts (resolved-agent and unresolved cases) | `collab-guardrail.test.js` |
| FR-012 | never blocks; direct `agent_name` detection unchanged; existing alert payload byte-identical | `collab-guardrail.test.js` |
| FR-013 | ledger entry has all six elements + ratification flag; 038 FR-018 comment cross-references it | doc review (task) |
| FR-014 | write/broadcast ordering, retry policy, drain untouched | `git diff` review + existing persistence suites |

## SC → evidence

| SC | Evidence |
|---|---|
| SC-001 | matrix rows for human→human, agent→human, human→agent relays across all four surfaces |
| SC-002 | self-relay-with-evidence cases show no hedging and no visible difference from a live edit |
| SC-003 | no-evidence / ambiguous / deletion-only cases all render the synced contribution; it coexists distinguishably with `UNKNOWN_AUTHOR` |
| SC-004 | one staged row asserted through all four surfaces in a single test |
| SC-005 | `_stats()` decode counters, asserted zero on the repeat request |
| SC-006 | guardrail matrix: resolved-agent, unresolved, human-resolved (no page), plus the untouched direct path |
| SC-007 | RBD-045-5 content check; `git diff` on the persistence listener shows comment-only change |
