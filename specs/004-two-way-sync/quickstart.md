# Quickstart: Validating Two-Way Sync

**Feature**: 004-two-way-sync. Runnable end-to-end validation scenarios. Contract details:
[contracts/sync-push.md](./contracts/sync-push.md); entities: [data-model.md](./data-model.md).

## Prerequisites

- Dev environment per `docs/dev.md` (commands run in the Minikube `app-dev` pod; server on
  `$APP_URL`, e.g. `http://localhost:3001`).
- Features 001–003 merged (parser, `PUT /api/docs/:docId/import`, export with
  `frontmatter=true` + flavors).
- An `sk_sqd_` token with `documents:write` (mint via the `create_access_token` MCP tool), a test
  document with some content, and its id: `DOC=<uuid>`, `TOK=sk_sqd_...`.

## Scenario 1 — Round trip with a text edit (US1)

```bash
# Pull: export with frontmatter (baseline)
curl -s -H "Authorization: Bearer $TOK" \
  "$APP_URL/api/docs/$DOC/export?format=markdown&frontmatter=true" > /tmp/doc.md
grep -E "docGuid|clock" /tmp/doc.md    # note the baseline clock N

# Edit one sentence inside one paragraph (text-only change)
sed -i 's/exponential backoff/fixed 5s intervals/' /tmp/doc.md

# Push
curl -s -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: text/markdown" \
  --data-binary @/tmp/doc.md "$APP_URL/api/docs/$DOC/import?mode=sync" | tee /tmp/receipt.json
```

**Expected**: `noop:false`; `clock` > N; `operations.textHunks` ≥ 1, `structuralHunks` = 0;
`overlaps` empty; the live document (open in a browser) shows the edit in real time; version
history shows a new entry attributed "Repo Sync (<token owner>)"; all other content byte-identical
in the receipt's `markdown` except the edited sentence and refreshed frontmatter. Rewrite the local
file from `.markdown` — it is the next baseline.

## Scenario 2 — Concurrent edits converge, overlap flagged (US2)

1. Pull as above (baseline N). In the browser, edit block A (live side).
2. In `/tmp/doc.md`, edit block B; push. **Expected**: both edits in the final doc, `overlaps: []`.
3. Pull again; in the browser edit a sentence in block C; in the file edit a *different span of the
   same block C*; push. **Expected**: both edits present in block C (no whole-block clobber);
   `overlaps` lists block C with `docSide:"edited"`.

## Scenario 3 — Formatting-only push is a true no-op (US3)

```bash
curl -s -H "Authorization: Bearer $TOK" \
  "$APP_URL/api/docs/$DOC/export?format=markdown&frontmatter=true" > /tmp/doc.md
sed -i 's/\*\*\([^*]*\)\*\*/\*\1\*/g' /tmp/doc.md  # bold delimiter style only: **x** → *x*
                                                   # (001's emphasis-variant equivalence; spec US3
                                                   #  names "*bold* → **bold**" as formatting-only)
curl -s -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: text/markdown" \
  --data-binary @/tmp/doc.md "$APP_URL/api/docs/$DOC/import?mode=sync"
```

**Expected**: `noop:true`, `clock` unchanged, zero operations; version history gains **no** entry;
pushing the exported file back completely unedited gives the identical result (SC-001/SC-009:
repeat pull→push cycles stay no-ops).

## Scenario 4 — Attribution with on-behalf-of (US4)

```bash
curl -s -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: text/markdown" \
  -H "X-Squire-On-Behalf-Of-Name: Liz Lemon" \
  -H "X-Squire-On-Behalf-Of-Email: liz@example.com" \
  -H "X-Squire-On-Behalf-Of-Commit: a1b2c3d" \
  --data-binary @/tmp/doc-edited.md "$APP_URL/api/docs/$DOC/import?mode=sync"
```

**Expected**: version history entry authored by the token identity (agent-style), showing the
on-behalf-of details as plain text (never rendered as markup/links).

## Scenario 5 — Stale/invalid baselines rejected (US5)

```bash
# Clock beyond current
curl -s -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: text/markdown" \
  --data-binary @/tmp/doc.md "$APP_URL/api/docs/$DOC/import?mode=sync&baselineClock=999999"
# → 400 sync_baseline_invalid, guidance to re-pull, currentClock included

# No baseline at all (frontmatter stripped, no param)
sed '/^---$/,/^---$/d' /tmp/doc.md | curl -s -X PUT -H "Authorization: Bearer $TOK" \
  -H "Content-Type: text/markdown" --data-binary @- "$APP_URL/api/docs/$DOC/import?mode=sync"
# → 400 sync_baseline_missing

# Frontmatter docGuid pointing at a different document
# (edit squire.docGuid in the file, push at $DOC) → 409 sync_doc_mismatch
```

**Expected in all cases**: no document change (verify clock unchanged), no version entry.

## Automated validation

```bash
# In the app-dev pod, serial backend suites (Constitution II — never concurrent):
npx jest server/__tests__/serialization.sourcemap.test.js \
         server/__tests__/markdown-sync.replay.test.js \
         server/__tests__/markdown-sync.convergence.test.js \
         server/__tests__/markdown-sync.overlap.test.js \
         server/__tests__/markdown-sync.order-independence.test.js \
         server/__tests__/markdown-sync.rejection.test.js \
         server/__tests__/format-roundtrip.test.js \
         __tests__/integration/sync-push.route.test.js --runInBand
```

**Expected**: all green. The round-trip suite enforces SC-001 (import(export(doc)) is a no-op for
every registry construct) and the convergence suite enforces SC-002 (push ≡ real offline Yjs
client) — these two are the feature's standing CI invariants.
