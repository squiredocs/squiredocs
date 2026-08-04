# Quickstart — Verifying 050-test-timeout-defects

Runnable validation for every success criterion. Run from the repo root inside the
`app-dev` pod (or the implementer's worktree). Details of the change itself are in
[plan.md](./plan.md); this file is only how to prove it works.

## Prerequisites

```bash
npm ci && (cd client && npm ci)          # worktrees don't inherit node_modules

# Per-worktree database — NEVER the shared collab_test_db (concurrent runs corrupt it).
createdb collab_test_db_050
export DATABASE_URL=postgresql://$USER@localhost:5432/collab_test_db_050
npm run migrate
```

Every backend command below must carry that `DATABASE_URL`. `--runInBand` is already
wired into `npm run test:server` and must stay — within one database the backend suite
is serial-only.

**Single-file runs (`docs/dev.md`):** keep `--runInBand --forceExit` — without
`--forceExit` a lingering Redis client makes the run block forever, which reads as a
broken suite. Also set `REDIS_HOST` deliberately: `npm run test:server` defaults it to
`localhost` while the pod environment exports `collab-redis`, so a bare `npx jest` can
silently target a different Redis than the full run. Export the same value for both:

```bash
export REDIS_HOST=collab-redis      # or localhost, matching your full-suite run
```

Note that `npm run test:server -- <path>` does NOT work (the positional lands after
`--reporters=`); use `npx jest <path> --runInBand --forceExit`.

## Baseline (capture BEFORE changing anything)

```bash
npx jest server/mcp/__tests__/integration/document-editing-workflow.test.js --runInBand --forceExit
cd client && npx vitest run src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx; cd ..
```

Expected baseline: backend file ≈103s with per-test times clustered at 4.97-5.31s (≈10s
for the two two-modify tests); client file ≈14.8s.

## SC-001 / SC-002 — Backend durability wait resolves instead of timing out

```bash
npx jest server/mcp/__tests__/integration/document-editing-workflow.test.js \
  --runInBand --forceExit --verbose 2>&1 | tee /tmp/050-backend.log
```

Pass when:
- every test passes;
- file total ≤ ~13s (from ~103s), and no individual test carries ~5s or ~10s of
  durability wait (SC-001);
- `grep -c editRangePending /tmp/050-backend.log` is `0` (SC-002), and the added
  `expect(...editRangePending).toBeUndefined()` assertions pass in-suite.

## SC-004 — Client suite stops sleeping

```bash
cd client
npx vitest run src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx
npx vitest run --reporter=../script/vitest-llm-reporter.mjs        # full client suite
cd ..
```

Pass when: all 10 tests in the file pass, the file reports ≈1s or less (from 14.8s), and
the full Vitest wall time is under 10s on the reference machine.

## SC-005 / SC-003 — Everything green; record the backend total

```bash
time npm run test:server         # with DATABASE_URL exported; keeps --runInBand + LLM reporter
npm run test:client
npm run test:first-run
```

Pass when all three are green (SC-005). Record the backend total for the design doc's
trend table — ≈175s is the reference-machine expectation, **not** a gate (RBD-050-4).

## SC-006 — Assertion semantics preserved

```bash
git diff -- server/mcp/__tests__/integration/document-editing-workflow.test.js \
            client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx
```

Pass when a reviewer can confirm: every pre-existing `expect` survives with the same
meaning, order and trigger conditions; the only changes are `setPersistence` wiring,
teardown flush, WS identity stamping, the `settle(...)` substitution, fake-timer
install/restore, per-test timeout annotations, and **additive** `editRangePending`
assertions (FR-006 / RBD-050-2).

## SC-007 — Sweep recorded

```bash
test -f specs/050-test-timeout-defects/sweep-results.md && echo present
```

Pass when the file exists and contains the commands, their raw output, and a
per-file classification (per-update-attributed / snapshot-only / not-applicable)
covering **both** backend roots (`server` and the repo-root `__tests__`) — including
the explicit "no additional offenders" finding if that is the result.

## FR-007 — No product code touched (hard gate)

```bash
git diff --name-only | grep -v -E '(__tests__|specs/050-test-timeout-defects)' || echo "OK: test + spec files only"
```

Pass when nothing outside test files and this feature's spec directory appears. In
particular `client/src/contexts/AiChatContext.jsx`, `server/mcp/yjs/edit-range.js` and
everything under `server/mcp/` outside `__tests__/` must be unchanged.

## Cleanup

```bash
dropdb collab_test_db_050
```
