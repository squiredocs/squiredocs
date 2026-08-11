# Quickstart — Validating 054 Sync Feedback Hardening

Runnable validation for the repo-sync trust pack. Run everything **inside the Minikube
`app-dev` pod** (`docs/dev.md`); Claude already runs there, so commands execute directly.

> `server/markdown-sync.js` contains NUL bytes — `grep` reports it as binary and appears to
> find nothing. Use `grep -a` or read the file.

## Prerequisites

- Backend suites run with per-worker DB/Redis isolation (Constitution II) — no serial flag,
  no shared-database assumptions. One whole invocation at a time.
- An `sk_sqd_` API token with `documents:write` and editor role on the test document, for the
  manual walk.

## 1. Automated suites (the gate)

```bash
# Sync engine + route: staleness, strict, dryRun, change report
npx jest server/__tests__/markdown-sync --forceExit
npx jest __tests__/integration/sync-push.route.test.js --forceExit

# Ordered-list numbering: serializer both copies, both parser modes, round trip
npx jest server/__tests__/format-roundtrip.test.js server/__tests__/serialization.sourcemap.test.js --forceExit

# Strict parser is frozen — these must stay green (start preservation is the one
# sanctioned exception; the 70-case characterization snapshot is unaffected)
npx jest server/__tests__/markdown-strict-characterization.test.js server/__tests__/markdown-tolerant.test.js --forceExit

# Diff engine consumes the strict parser — cache version bump must land with it
npx jest server/__tests__/diff-service.test.js --forceExit

# Guidance surfaces: byte budgets and pinned trigger phrases
npx jest server/mcp/__tests__/tools/ --forceExit

# Distribution regeneration (dry-run by default; validates, no network)
node distribution/publish.mjs
```

Full backend suite before commit (SC-008): `npx jest --forceExit`.

## 2. Manual walk — staleness and strict (US1)

```bash
DOC=<doc-guid>; TOKEN=sk_sqd_...; BASE=http://localhost:3000

# Pull a baseline
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/docs/$DOC/export?flavor=squire&frontmatter=true" > doc.md

# Push it back unchanged -> noop, and staleness fields are present anyway
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: text/markdown' \
  --data-binary @doc.md "$BASE/api/docs/$DOC/import?mode=sync" | jq '{noop, clockGap, docChangedSinceBaseline, blocksChanged}'
```

**Expected**: `noop: true`, `clockGap: 0`, `docChangedSinceBaseline: false`,
`blocksChanged: []`.

Now edit the document **in the browser** (type a sentence into a different paragraph), then:

```bash
# Edit doc.md locally too, then push the STALE baseline
curl -s -X PUT ... "$BASE/api/docs/$DOC/import?mode=sync" | jq '{clockGap, docChangedSinceBaseline}'
```

**Expected**: applies as today, `clockGap > 0`, `docChangedSinceBaseline: true`.

```bash
# Same push, strict
curl -s -o resp.json -w '%{http_code}\n' -X PUT ... "$BASE/api/docs/$DOC/import?mode=sync&strict=true"
jq . resp.json
```

**Expected**: `409`, `error: "sync_baseline_stale"`, a re-export remedy, staleness fields.
Confirm in the UI that **nothing changed** and version history gained no entry.

```bash
# Malformed boolean must be rejected, not silently ignored
curl -s -o /dev/null -w '%{http_code}\n' -X PUT ... "...&strict=yes"    # expect 400
```

## 3. Manual walk — dry run leaves no trace (US3, SC-003)

```bash
before=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/docs/$DOC/export?flavor=squire&frontmatter=true")

curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: text/markdown' \
  --data-binary @edited.md "$BASE/api/docs/$DOC/import?mode=sync&dryRun=true" | jq '{dryRun, markdown, blocksChanged, operations}'

after=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/docs/$DOC/export?flavor=squire&frontmatter=true")
[ "$before" = "$after" ] && echo "NO TRACE" || echo "MUTATED — FAIL"
```

**Expected**: `dryRun: true`, `markdown: null` (omitted — a dry run is never a baseline),
a populated `blocksChanged`, byte-identical export before and after.

**Watch the document open in a browser while the dry run runs**: no agent avatar appears, no
content changes, no selection highlight (RBD-054-3). Version history gains no entry.

Then push the same file for real and confirm the applied `blocksChanged` **matches** what the
dry run predicted (SC-003).

```bash
# Dry run on a non-sync mode is rejected
curl -s -o /dev/null -w '%{http_code}\n' -X PUT ... "...?mode=append&dryRun=true"   # expect 400

# strict under dryRun predicts the real call
curl -s -o /dev/null -w '%{http_code}\n' -X PUT ... "...?mode=sync&dryRun=true&strict=true"  # expect 409 when stale
```

## 4. Manual walk — ordered-list numbering (US4, SC-005)

Create a document containing an ordered list starting at 11 (via the editor, or import
markdown whose first item is `11.`), then:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/docs/$DOC/export?frontmatter=true" | grep -n '^1[0-9]\.'
```

**Expected**: items numbered `11.`, `12.`, `13.` — not flattened to `1.`.

```bash
# Push the unchanged export straight back
curl -s -X PUT ... --data-binary @exported.md "$BASE/api/docs/$DOC/import?mode=sync" | jq '{noop, blocksChanged}'
```

**Expected**: `noop: true`, `blocksChanged: []` — zero spurious numbering diffs. This is the
whole point of US4: before the fix, this round trip reported a change the agent never made.

Then open **version history** and diff two versions of that document: the numbering must read
`11.` in the diff too (this is the strict parser + the bumped diff cache version).

## 5. Guidance split (US5, SC-007)

```bash
npx jest server/mcp/__tests__/tools/ --forceExit    # budgets + pinned phrases
node distribution/publish.mjs                        # regenerate + drift guard
git status --short distribution/                     # regenerated files should be committed
```

Then grep each write site in `contracts/guidance-split.md`'s table for both halves of the
split. Remember: the Kiro steering files and the Cursor `.mdc` are **generated from inline
text in `distribution/publish.mjs`** — editing the checked-in copies is reverted on the next
regenerate.

## Success criteria mapping

| SC | Validated by |
|---|---|
| SC-001 | §2 first push — gap visible in one response |
| SC-002 | §2 strict 409 + untouched history |
| SC-003 | §3 byte-identical export, no version entry, no avatar, plan matches real push |
| SC-004 | §3 `blocksChanged` identifies every changed block, no unchanged ones |
| SC-005 | §4 export numbers from 11; unchanged push is a noop |
| SC-006 | §1 `format-roundtrip.test.js:764` + `serialization.sourcemap.test.js` |
| SC-007 | §5 |
| SC-008 | §1 full backend suite; previously written baselines still validate |
