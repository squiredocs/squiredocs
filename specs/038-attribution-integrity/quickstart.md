# Quickstart — validating 038-attribution-integrity

Runnable scenarios proving each user story end-to-end. Implementation details live in
[plan.md](plan.md) / [contracts/](contracts/); this is the validation guide.

## Prerequisites

- Worktree deps installed: `npm ci && (cd client && npm ci)` (worktrees do not inherit
  `node_modules`).
- **Per-agent test DB** (NEVER the shared `collab_test_db` from a worktree):
  `createdb collab_test_db_038`, then run every backend test command with
  `DATABASE_URL=postgres://<user>:<pass>@<host>:5432/collab_test_db_038`
  (the helpers in `server/__tests__/helpers/db.js` respect it). Backend tests are
  serial-only within one DB — `--runInBand` is already wired; do not defeat it.
- Migration applied to the test DB: `DATABASE_URL=... npm run migrate` (expects
  `1799700000000_add-via-sync-to-yjs-updates.js` to run last).

## Automated validation (the authoritative gate — SC-009)

```bash
# Unit: the gate module + the updated (formerly bug-pinning) permissions test
DATABASE_URL=... npx jest server/__tests__/ws-edit-gate.test.js server/__tests__/permissions.test.js

# US1/FR-008: protocol-level e2e — viewer step2 blocked, editor step2 applied + via_sync row
DATABASE_URL=... npx jest __tests__/integration/step2-viewer-block.test.js

# US2: flag scoping + undo exclusion + guardrail annotation
DATABASE_URL=... npx jest server/undo/__tests__/legacy.test.js server/__tests__/collab-guardrail.test.js

# US3: origin hardening
DATABASE_URL=... npx jest server/__tests__/origin.test.js

# US4: capture race + 037 regression guards
DATABASE_URL=... npx jest server/__tests__/live-fanout.test.js server/__tests__/import-presence.test.js

# US5: presence removal regression guard (015 fan-out must stay green)
DATABASE_URL=... npx jest server/__tests__/awareness-removal-propagation.test.js

# Full backend + client suites before merge
DATABASE_URL=... npm test
cd client && npx vitest run && cd .. && npm run build
```

Expected: all green; the permissions test now asserts `step2 IS edit-classified`
(SC-009) — if it still asserts the old contract, the work is incomplete.

## Scenario walkthroughs (what each key test proves)

### US1 — viewer cannot write through step2 (SC-001/SC-002)

`step2-viewer-block.test.js`: a viewer-role connection sends a hand-crafted
`[MESSAGE_SYNC, SYNC_STEP2, <update the server lacks>]` frame as its very first frame.
Verify: document XML unchanged, zero new `yjs_updates` rows, exactly one
`WS_STEP2_BLOCKED` event `{connId, userId, docId, role}`, connection still open and still
receiving live edits. Same frame from an editor: content applied, one row persisted with
`via_sync = true`.

### US2 — re-supply marked as sync; live edits never flagged (SC-003/SC-004/SC-005)

- Flag scoping: an editor step2 followed immediately by a live update frame on the same
  connection ⇒ only the step2-originated row has `via_sync = true`.
- Undo: `legacy.test.js` — a candidate window whose tail row is `viaSync: true` breaks
  the run (foreign semantics); an all-flagged window derives `null` (honest refusal);
  rows with `viaSync: null` behave exactly as before.
- Guardrail: `collab-guardrail.test.js` — a matching evaluation with `viaSync: true`
  pages with `syncSourced: true` in the extra and in the warn line; paging decisions
  otherwise identical.

### US3 — malformed origin degrades loudly, never drops (SC-006)

`origin.test.js`: `parseOrigin('not-a-uuid')` ⇒ `{ userId: null, agentName: null,
malformedOrigin: 'non-uuid-string' }` (+ error log); a valid UUID string is attributed
unchanged; an unrecognized object shape ⇒ degraded parse + warning; all five sentinels
still return `null`. Integration-level: an update applied with a junk string origin still
persists (unattributed) and the CRITICAL persistence-failure path is not reached.

### US4 — capture is origin-scoped (SC-007)

`live-fanout` / dedicated test: a no-change `updateDocument` overlapping a concurrent
foreign-origin update on the same doc returns `{ update: null, hadRedisHandler: false }`
immediately (nothing captured, no 50 ms window); a change-producing call still returns
its own transaction's bytes with emit-time `hadRedisHandler`; a throwing `updateFn`
leaves no armed listener on the doc.

### US5 — presence eviction (SC-008)

Automated: `awareness-removal-propagation.test.js` stays green;
`grep -rn "parseAwarenessClientIds\|connectionClientId" server/` returns only
comments/history (machinery deleted). Manual (post-deploy, Sam's browser walk): open a
doc as A and B where B connects after A's awareness broadcast; disconnect B; A's avatar
survives for other participants, B's disappears.

## Manual smoke (dev pod, optional pre-merge)

1. Start the dev server; open a doc in two browsers (owner + a viewer-role share).
2. Viewer devtools: confirm normal read experience (content + live edits arrive).
3. Server logs: no `WS_STEP2_BLOCKED` from well-behaved clients during normal
   reconnects by editors; reconnecting an editor after offline edits persists rows and
   `psql -c "SELECT clock, user_id, via_sync FROM yjs_updates WHERE doc_guid='...' ORDER BY clock DESC LIMIT 5"`
   shows `via_sync = t` only on catch-up rows.
