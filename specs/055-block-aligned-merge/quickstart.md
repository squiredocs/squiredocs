# Quickstart: Validating the Block-Aligned Merge Pre-Pass (055)

## Prerequisites

- App-dev pod environment (docs/dev.md) or the local backend test stack
  (pg + pgvector + redis + env). The planner suites themselves are pure and
  need no DB; the end-to-end sync suites use the standard per-worker isolated
  DBs (Constitution II).
- Feature 054 merged (the `blocksChanged` report the parity assertions read).

## Fast signal (pure planner, no DB)

```bash
cd /local-dev
REDIS_HOST=${REDIS_HOST:-localhost} npx jest --forceExit server/__tests__/markdown-sync.alignment.test.js
```

Expected: alignment, Dice-threshold boundary (I5), duplicate-block (I10),
split/merge, cap-degradation (I7), and FR-002 invariant (I1/I2) tests green.

## Full sync engine validation

```bash
REDIS_HOST=${REDIS_HOST:-localhost} npx jest --forceExit \
         server/__tests__/markdown-sync.replay.test.js \
         server/__tests__/markdown-sync.convergence.test.js \
         server/__tests__/markdown-sync.order-independence.test.js \
         server/__tests__/markdown-sync.overlap.test.js \
         server/__tests__/markdown-sync.rejection.test.js \
         server/__tests__/import-roundtrip.test.js \
         server/__tests__/format-roundtrip.test.js
```

Expected: all green with assertions unchanged (FR-009/FR-012 — only
`computeHunks`/`planPush` call-site signatures were updated).

## Scenario walk-throughs (what proves what)

1. **Decoy heading (I8, SC-001)** — baseline has `# Deployment` and
   `# Deployment Notes`; push renames only the first to `# Rollout`. Assert:
   plan touches exactly one block; `Deployment Notes` block byte-identical in
   the receipt re-export and absent from `blocksChanged`.
2. **Atomic rewrite (I2, SC-006)** — push replaces one paragraph's text
   wholesale (sim < 0.5). Assert: one `structural` entry covering exactly that
   block, zero text hunks, neighbors untouched; with a concurrent live edit in
   that block, an overlap flag with `pushSide: 'structural'`.
3. **Size parity (I6, SC-004)** — the same one-word edit in a ~1KB doc and in
   the same doc inflated past 64KB (padding blocks). Assert: identical op-kind
   classification in both plans/reports.
4. **Round trip (I3, SC-003)** — push an unmodified export. Assert:
   `noop: true`, zero operations, no new version entry.
5. **Bound degradation (I7)** — a single >16KB block edited among normal
   blocks. Assert: that pair alone is `structural`; every other edit in the
   push still character-diffs.

## Performance check (SC-005)

The replay suite's performance-guard describe (extended for the unified path)
must pass: single-block edit in a >64KB document plans within the existing
time bound and without a whole-document character diff (asserted structurally:
the coarse/whole-doc code path no longer exists; guard asserts wall-time).

## Manual end-to-end (optional, post-merge)

```bash
# Export a doc with frontmatter, edit one heading + one distant paragraph, push:
curl -s -H "Authorization: Bearer $SK" "$BASE/api/docs/$DOC/export?format=md&frontmatter=true" > /tmp/doc.md
$EDITOR /tmp/doc.md
curl -s -X PUT -H "Authorization: Bearer $SK" -H 'Content-Type: text/markdown' \
  --data-binary @/tmp/doc.md "$BASE/api/docs/$DOC/import?mode=sync&dryRun=true" | jq '.blocksChanged'
```

Expected: exactly the two edited blocks listed, op kinds `text`/`reconcile`,
no structural entries, decoy blocks absent. (dryRun is 054 surface.)
