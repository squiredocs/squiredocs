# Quickstart: Validating 056 (sync apply correctness + honest receipts)

Everything here runs inside the Minikube `app-dev` pod (see `docs/dev.md`),
or against the local backend test stack. No DB is needed for the replay
layer; the route tests use the standard per-worker isolated test DBs
(Constitution II).

> Repo hazard: `server/markdown-sync.js` contains NUL bytes. `grep` reads it
> as binary — use `grep -a` or open the file directly.

## 1. Reproduce the defects (before the fix)

The committed repro seeds run against the live engine with plain `node`:

```bash
node specs/056-sync-apply-correctness/repro/repro1.js   # Bug A: link/bold boundary insertions
node specs/056-sync-apply-correctness/repro/repro2.js   # Bug B: mixed-lane drops + repair loops
node specs/056-sync-apply-correctness/repro/repro3.js   # Bug A repair loops + S1 stale-noop lie
node specs/056-sync-apply-correctness/repro/repro4.js   # Bug C: bracket fuzz + ]( leaks
```

Pre-056 expected output: failing scenarios in every family (repro1 prints a
non-zero fail count; repro3 prints `*** STUCK`/`*** REPRODUCED`; repro4
prints non-converging cases). Post-056: zero failures, no STUCK, no leaks —
the same scripts double as a smoke check.

## 2. Run the committed regression corpus (the FR-015 suite)

```bash
cd /local-dev
npx jest server/__tests__/markdown-sync.apply-correctness.test.js
```

Asserts per scenario (see `research.md` R7): first-push convergence
(SC-001), one-push repair convergence from corrupted states (SC-002),
receipt honesty from apply results (SC-003), zero raw-syntax leaks (SC-004).

## 3. Run the engine + receipt gates (SC-006 non-regression)

```bash
# DB-free engine suites
npx jest server/__tests__/markdown-sync.replay.test.js \
         server/__tests__/markdown-sync.convergence.test.js \
         server/__tests__/markdown-sync.alignment.test.js \
         server/__tests__/markdown-sync.order-independence.test.js \
         server/__tests__/format-roundtrip.test.js

# Overlap/rejection + route-level receipts (need the test DB stack)
npx jest server/__tests__/markdown-sync.overlap.test.js \
         server/__tests__/markdown-sync.rejection.test.js \
         __tests__/integration/sync-push.route.test.js \
         __tests__/integration/sync-push.cross-doc-images.route.test.js
```

All 054/055 assertions must pass unchanged except the two reviewed
expectation classes named in `research.md` R8 (bracket-hunk lane counts;
plan-side replacement marks).

## 4. Receipt spot-checks (route level)

With a dev doc and an `sk_sqd_` token (see `export_api` tool docs):

```bash
# Healthy push → converged:true, skipped:0
curl -s -X PUT "$BASE/api/docs/$DOC/import?mode=sync" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: text/markdown' \
  --data-binary @edited.md | jq '{noop, converged, operations, blocksChanged}'

# Byte-identical re-push (already-applied noop): doc matches file → converged:true
# Dry run → same converged a real push would produce, no markdown field
curl -s -X PUT "$BASE/api/docs/$DOC/import?mode=sync&dryRun=true" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: text/markdown' \
  --data-binary @edited.md | jq '{dryRun, noop, converged, operations}'
```

Expected shapes are pinned in `contracts/sync-receipt-v3.md` (incl. the
`noop:true, converged:false` repair signal for a diverged doc).

## 5. Acceptance walk (the field scenario, US1)

1. Export a doc containing `Check the [runbook](url) before deploying.`
2. Edit the file: add a comma after the link. Push with `mode=sync`.
3. Verify: receipt `converged: true`; re-export byte-equals the file; in the
   editor the comma is plain text (not part of the link).
4. Re-push the identical file: `noop: true, converged: true`.

This walk previously required destructive `mode=replace` to exit; it is the
core promise (FR-014) restored.
