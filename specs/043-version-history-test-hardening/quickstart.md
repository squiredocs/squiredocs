# Quickstart: validating 043-version-history-test-hardening

This feature ships tests, so "validation" means: the new suites exist, they fail for the right
reasons when production breaks, and nothing else changed.

## Prerequisites

- Work happens in the Minikube `app-dev` pod (`docs/dev.md`). Redis reachable; PostgreSQL reachable.
- **041, 042 and 044 are merged into `main`.** This feature is last in the queue; running it earlier
  produces tests written against code that does not exist yet.
- In a worktree, a per-agent database (backend tests are serial-only against a shared DB):

```bash
createdb collab_test_db_043
export DATABASE_URL="postgresql://<user>@<DB_HOST:-localhost>:5432/collab_test_db_043"
npm ci && (cd client && npm ci)
cp ../../.env . 2>/dev/null || true   # from the main tree, if present
```

`server/__tests__/globalSetup.js` creates the DB if absent and runs `npm run migrate` with that URL.

## Step 0 — the blocking re-verification (T001)

Before writing anything, confirm the targets still exist on merged `main`:

```bash
# X1 target: the bindState update listener still inline in index.js?
grep -n "setPersistence({" -A 6 server/index.js
grep -n "ydoc.on('update'" server/index.js

# X2/X3/X4 targets
grep -n "ws.agentName = " server/index.js
grep -n "origin === ORIGIN_REDIS" server/index.js
grep -n "'/api/docs/:docId/undo-status'" server/index.js

# The extraction CEILING — these two must still be greppable in index.js after our work
grep -c "installGate(" server/index.js          # expect 1
grep -n "request.tokenMayWrite = " server/index.js

# Has 042 already moved something we planned to move?
grep -rn "retryWithBackoff\|isMeaningful\|isSentinelOrigin" server/ --include=*.js | grep -v __tests__

# 041's error states (US7 depends on them)
grep -rn "version-history-error\|error" client/src/hooks/useVersionHistory.js | head

# 042's prop collapse (US7's biggest risk)
grep -n "VersionHistoryContext\|function VersionHistoryPanel" client/src/components/VersionHistoryPanel.jsx

# The wall-clock count (spec says nine; verify)
grep -c "toBeLessThan(300)" server/__tests__/postgres-gap-read.test.js
```

Record every divergence in `clarifications-needed.md`; 041/042 win (D5).

## Step 1 — run the suites

```bash
npm run test:server     # jest --runInBand (serial, required)
npm run test:client     # vitest
npm run build
```

Targeted runs while iterating:

```bash
npx jest --runInBand __tests__/integration/attribution-e2e.test.js
npx jest --runInBand __tests__/integration/sync-catchup-e2e.test.js
npx jest --runInBand __tests__/integration/persistence-failure-e2e.test.js
npx jest --runInBand __tests__/integration/restore-concurrency.test.js
npx jest --runInBand server/__tests__/collab-extraction-guard.test.js
npx jest --runInBand server/__tests__/diff-two-surface-parity.test.js
(cd client && npx vitest run src/components/__tests__/VersionHistoryPanel.test.jsx src/components/__tests__/VersionPreview.test.jsx)
```

> A bare `npx jest` without `--forceExit` can hang: a live Redis client keeps the process alive.
> Prefer `npm run test:server` for full runs.

## Step 2 — prove the tests actually guard (SC-001, SC-003)

The point of this feature is tests that fail when production breaks. Verify by deliberate local
breakage, then **revert every one**:

| Break (locally, then revert) | Expected failure |
|---|---|
| In `server/agent-identity.js`, make `identityFromPrincipal` always return `agentName: null` | `attribution-e2e.test.js` fails: agent rows lose their name |
| In `server/collab-bind-state.js`, hardcode `viaSync = false` | `sync-catchup-e2e.test.js` fails |
| In `server/origin.js`, flip `shouldPublishToRedis` to always return `true` | `origin.test.js` fails (SC-003b) |
| In `server/collab-bind-state.js`, skip the `classificationDisabled` guard | `update-classifier.test.js` fails (SC-003a) |
| In `server/api/undo-status.js`, drop the viewer gate | `undo-status-api.test.js` fails (SC-003c) |
| Re-inline any extracted unit into `server/index.js` | `collab-extraction-guard.test.js` fails |

If a break does **not** fail a test, that test is still a mirror. Fix it before claiming the story.

## Step 3 — the honesty greps (SC-001, SC-007, SC-008)

```bash
# SC-001: no tautologies left in the attribution area
grep -rn "expect(true).toBe(true)" server/__tests__/ __tests__/ && echo "FAIL" || echo "OK"

# SC-007: no bare wall-clock assertion left
grep -n "toBeLessThan(300)" server/__tests__/postgres-gap-read.test.js && echo "FAIL" || echo "OK"

# SC-003: the three mirrors are gone
grep -n "runListener" server/__tests__/update-classifier.test.js && echo "FAIL" || echo "OK"
grep -n "function shouldPublishToRedis" server/__tests__/origin.test.js && echo "FAIL" || echo "OK"
grep -n "Mirror of the server/index.js endpoint handler" server/__tests__/undo-status-api.test.js && echo "FAIL" || echo "OK"

# SC-008: production diff is move-only — review it by eye, it should be small
git diff --stat main -- server/ ':!server/__tests__'
```

## Step 4 — flake hygiene (SC-007)

Three consecutive serial runs, zero failures:

```bash
for i in 1 2 3; do npm run test:server || { echo "RUN $i FAILED"; break; }; done
```

Then confirm no orphaned rows survive (I10):

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM yjs_updates u LEFT JOIN documents d ON d.guid = u.doc_guid WHERE d.guid IS NULL;"
# expect 0 after a full run
```

## Step 5 — characterization headers (FR-014)

Every pin must name its decision, so a future change fails loudly and points somewhere useful:

```bash
grep -n "038" __tests__/integration/persistence-failure-e2e.test.js   # FR-018 / D1
grep -n "039" server/__tests__/diff-two-surface-parity.test.js        # A1
```

## What "done" looks like

- 8 stories' suites exist and pass; stretch S1-S3 present or explicitly dropped (D6).
- Every break in Step 2 fails a test; every grep in Step 3 prints `OK`.
- `npm run test:server` green three times running; `npm run test:client` and `npm run build` green.
- Production diff outside `__tests__` is four extractions and their call sites — nothing else.

## Explicitly not validated here

- **Browser E2E** (D7/FR-013): deferred, Sam owns browser walks.
- **The publish-before-commit window** (D1): pinned by US3, not fixed.
- **Presence/awareness spoofing**: 044's coverage; 043 asserts nothing about it.
