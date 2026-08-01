# Merge notes — 038-attribution-integrity

For the merge queue. Everything here is something the queue has to *do* or
*know*; the design rationale lives in [plan.md](plan.md) / [research.md](research.md).

## 1. Migration to run

| | |
|---|---|
| File | `migrations/1799700000000_add-via-sync-to-yjs-updates.js` |
| Change | `yjs_updates` gains nullable boolean `via_sync` |
| Reversible | **Yes** — `down` drops the column; tested down-then-up against the per-agent DB |
| Backfill | **None** (D1). Every pre-feature row reads `null` = "channel unknown" |
| Index | None |

This feature owned the single in-flight migration slot. Timestamp
`1799700000000` is strictly greater than the pre-feature head
(`1799600000000_add-yjs-updates-user-activity-index`) and above the
`1795000000000` floor that `script/migrate.js`'s rolled-back-008 phantom-row
cleanup requires.

**Rolling-deploy safety**: old pods INSERT without the column and get `NULL`,
which is a legal "unknown" — same pattern `meaningful` used in 023 (D-8). The
migration can therefore go out before or with the image.

## 2. New observability event: `WS_STEP2_BLOCKED`

Emitted when a viewer-role connection's `SYNC_STEP2` frame is dropped:

```
logPerf('WS_STEP2_BLOCKED', { connId, userId, docId, role })
```

Same channel, shape and call site as the pre-existing `WS_EDIT_BLOCKED`.

### ⚠ Honest finding: neither blocked-frame event is actually *counted* today

The tasks asked for this event to get "identical treatment" to `WS_EDIT_BLOCKED`
in the 013/014 telemetry path, including any event-catalog or alert-config
registration. Investigated; the finding is that **there is no such path to
register with**:

- `logPerf` (`server/index.js:101`) is a bare `console.log` of
  `[PERF <ts>] <LABEL> <json>`. Nothing more.
- `WS_EDIT_BLOCKED` appears in **exactly one** non-spec file in the repo:
  `server/index.js`. There is no event catalog.
- The OTel metrics module (`server/telemetry/metrics.js`) has explicit counters
  (`http.server.request.count`, `ratelimit.rejections`,
  `collab.render_skip.reports`). No WS blocked-frame counter exists.
- Nothing in `k8s/o11y/collector-config.yaml` parses `[PERF …]` lines, and none
  of the six alert definitions in `k8s/o11y-dashboards/alerts/` reference `WS_`.
- `infra/terraform/alarms.tf` covers only CloudFront 5xx and the Route 53 health
  check.

So `WS_STEP2_BLOCKED` has been given genuinely identical treatment to
`WS_EDIT_BLOCKED` — which means both are **log-grep-only**. SC-002's "separately
countable" holds at the log level (the names are distinct, which was the point),
not as a metric or an alert. Per instruction, no mechanism was invented. If
counting is wanted, the natural home is a counter in
`server/telemetry/metrics.js` alongside `ratelimit.rejections` — that is
follow-on work, and it should cover both events at once.

### ⚠ Operational note: viewers will emit this routinely, not just attackers

Worth knowing before anyone builds an alert on it. In the normal y-websocket
handshake the server sends step1 and the client answers with step2. A viewer's
ordinary, well-behaved client therefore produces a `WS_STEP2_BLOCKED` on **every
connect and every reconnect**. That is correct and harmless — the server never
awaits the client's step2 reply, so the viewer's read experience is unaffected
(covered by the "step1 from a viewer is answered normally" e2e case) — but it
means the event is a *frequency* signal, not an *incident* signal. Any future
alerting should threshold on viewer-connect-rate-normalised volume, or
distinguish empty from content-bearing step2 payloads.

(quickstart.md's manual smoke says "no `WS_STEP2_BLOCKED` from well-behaved
clients during normal reconnects **by editors**" — that is accurate as written;
this note is about viewers.)

## 3. Docs to reconcile

**Expected: none.** README.md / docs/dev.md describe collaboration a level above
these mechanics (they do not document the sync frame types, the origin parsing
contract, or the update-capture internals), so no drift is introduced. Per the
parallel-agent protocol, this worktree edited none of `CLAUDE.md`, `README.md`,
`docs/dev.md`, or anything under `design/`.

The in-code contract documentation that FR-015/FR-011/FR-018 mandate ships with
the code, at these three sites:

| Contract | Site |
|---|---|
| FR-015 `via_sync` semantics | `server/postgres-persistence.js`, on the `_mapUpdateRow` column mapping |
| FR-011 synchronicity assumption | `server/ws-edit-gate.js`, at the flag window in `installGate` |
| FR-018 publish-before-commit window | `server/index.js`, at the bindState `storeUpdate` call site |

## 4. Conflict risk with 039-diff-cache-integrity

Kept to the documented minimum. In `server/postgres-persistence.js` this feature
touched only the write path (`storeUpdate` / `_runStoreSlot` /
`_storeUpdateCritical`) plus two lines of metadata surfacing.

**The one shared-neighbourhood edit**: `_queryUpdatesWithUsers` *calls* the
039-owned `_fetchRowsWithGapRetry`. The call site itself is **not in this
feature's diff** — only the `sql` template literal a few lines above it gained
`u.via_sync` to its SELECT list. If git still reports a conflict there, the
resolution is mechanical: keep 039's version of the
`_fetchRowsWithGapRetry(...)` call and keep `u.via_sync` in the SELECT column
list. Nothing about the two changes is semantically entangled.

Verified untouched by this feature: `getUpdateRowsUpTo`, `_fetchRowsWithGapRetry`,
`_findFirstGap`, everything under `server/diff/`, `server/diff-service.js`, and
`specs/039-*`.

## 5. Behavior changes a reviewer should not mistake for regressions

- **`parseOrigin('user-123')` no longer attributes.** Bare string origins must
  now be valid UUIDs. The pre-existing assertion in `server/__tests__/origin.test.js`
  that a non-UUID string attributes was pinning the lax behavior US3 removes; it
  now uses a real UUID. Any caller passing a non-UUID string will start
  persisting unattributed **and paging** (`source: 'origin-parsing'`) — that is
  the intent, and it replaces a path that previously *dropped the row entirely*.
- **`permissions.test.js` asserts the opposite of what it used to** for step2.
  Updating it was the work (FR-007), not collateral damage.
- **Viewer step2 frames are now dropped.** See the operational note in §2.
- **Task order deviation**: T027 (delete the `connectionClientId` machinery) was
  executed together with T010 rather than after T022. Both rewrite the same
  `ws.emit` interceptor region, and the C1 drift guard asserts that region is
  final in `server/index.js`. Doing them in one pass was less churn, not more.
  All of T027/T028's verification ran and passed.

## 6. Deferred / follow-on

- **Publish-after-commit reorder (FR-018).** Documented at the call site, not
  implemented. Today the Redis publish and WS broadcast are initiated
  synchronously from the doc `update` event while the durable commit is async,
  so an instance dying in between leaves content live elsewhere and absent from
  durable history. Closing it means putting a DB round-trip in front of every
  keystroke's fan-out — a latency and failure-mode change on the hottest path in
  the product, deliberately deferred.
- **Escalation policy for repeat step2 offenders.** D4 keeps the connection open
  with no throttling, notification or escalation, matching existing
  `WS_EDIT_BLOCKED` policy. A real policy (rate-limit, disconnect, flag the
  account) belongs with the 034 auth-anomaly detector follow-on, and needs the
  viewer-handshake noise in §2 accounted for first.
- **Counting the blocked-frame events.** See §2.
- **Diff-side consumption of `via_sync`.** 039 / follow-on scope. The column is
  written and surfaced through `_mapUpdateRow`; nothing in the diff subsystem
  reads it yet.
- **Version-history author display for flagged rows.** Feature 040 scope. Rows
  carry the field; the timeline's behavior is unchanged in this feature.

## 7. Verification performed in this worktree

| Gate | Result |
|---|---|
| Full backend suite (`npm run test:server`, serial, per-agent DB `collab_test_db_038`) | **230 suites, 3971 tests passed, 0 failed** |
| Client suite (`npx vitest run`) | **65 suites, 805 passed** |
| `npm run build` | green (incl. documentation + blog builds) |
| Migration `down` then re-`up` | clean both ways |

Each story's tests were additionally confirmed to FAIL against the pre-feature
behavior, not merely to pass against the new: reverting step2 classification
fails 9 tests across the three US1 files; removing the `viaSync` check in
`isIdentityRow` fails 5 undo tests; restoring the old `document-service.js`
fails 6 capture tests including the F4 repro.

**One caveat on a discarded run.** A second full-suite run was started while the
first was still finishing, against the same database, and produced 18 failures —
all `documents_creator_id_fkey` violations and "never persisted" errors in MCP
suites, i.e. the two runs' `cleanupTestUser` calls deleting each other's rows.
That is the known backend-tests-are-serial-only hazard, self-inflicted, not a
regression: those same suites pass in isolation (30/30). The authoritative
result is the clean run in the table above.

## 8. Manual validation still owed (Sam, post-deploy)

Per quickstart.md — none of this is automatable here:

1. Two-participant disconnect walk (US5): open a doc as A and B where B connects
   *after* A's awareness broadcast; disconnect B; A's avatar must survive for
   other participants and B's must disappear. This is the case the deleted
   `connectionClientId` capture got wrong.
2. Viewer read experience in a browser: content and live edits still arrive
   normally while `WS_STEP2_BLOCKED` lines appear in the server log.
3. Editor offline-edit reconnect: rows persist and
   `SELECT clock, user_id, via_sync FROM yjs_updates WHERE doc_guid='…' ORDER BY clock DESC LIMIT 5`
   shows `via_sync = t` only on catch-up rows.
