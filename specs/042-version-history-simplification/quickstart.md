# Quickstart — Validating 042 Version History Simplification

The acceptance bar for this feature is unusual: **nothing should happen.** Validation is
therefore mostly negative — proving the suites still pass unmodified, the references are
gone, and the UI is indistinguishable.

Details of *what* must stay identical live in
[`contracts/behavior-preservation.md`](./contracts/behavior-preservation.md); entity shapes
in [`data-model.md`](./data-model.md); verified code anchors in [`research.md`](./research.md).

---

## Prerequisites

Work happens inside the Minikube `app-dev` pod (`docs/dev.md`).

```bash
# 1. Branch off post-041 main (042 merges AFTER 041 — FR-017)
git log --oneline -5          # confirm 041 has merged

# 2. Worktrees do not inherit node_modules
npm ci && (cd client && npm ci)

# 3. Per-worktree database — backend tests are serial-only against one DB.
#    globalSetup only auto-creates the DB named by the TEST_DB_NAME constant,
#    so create the per-worktree one yourself first.
createdb collab_test_db_042
export DATABASE_URL=postgresql://$USER@localhost:5432/collab_test_db_042
```

Every backend command below assumes that `DATABASE_URL` is exported. **Never point a
worktree at the shared `collab_test_db`.**

---

## Step 0 — Baseline (run BEFORE changing anything)

This is the whole safety net. Capture it first or you cannot prove FR-001.

```bash
npm run test:server 2>&1 | tee /tmp/042-baseline-server.txt
npm run test:client 2>&1 | tee /tmp/042-baseline-client.txt
npm run build
git rev-parse HEAD > /tmp/042-merge-base.txt
```

Both suites must be green **before** you start. A pre-existing failure that you inherit
will otherwise be misread as one you caused.

---

## Step 1 — Rebase re-verification gate (FR-017)

Before touching any file, re-run the reference greps for every deletion and consolidation
target against post-041 `main`. 041 may have wired up something this spec lists as dead.

```bash
# The known cases:
grep -rn "version-history-error" client/src/          # 041 wires this CSS up — must now have JSX hits
grep -rn "isMeaningful"          server/              # DEC-5: if 041 introduced it, 042 does NOT

# The full sweep — every symbol must still have the reference count research.md claims:
grep -rn "redis-persistence"     --include=*.js --include=*.json .
grep -rn "getDiff("              server/ script/ migrations/ __tests__/
grep -rn "baselineClock"         server/undo/
grep -rn "clearSelection\|loadVersionContent\|loadContentAtClock\|previousVersionContent" client/src/
grep -rn "claimUndo\|claimRedo\|insertLegacyUndone\|EDIT_ORIGIN\|HISTORY_ORIGIN\|LEGACY_GAP_MS" server/
```

**Expected**: counts match `research.md` R1-R15, except `.version-history-error`, which
should now be referenced by 041's error rendering. Any other change updates
`clarifications-needed.md` before implementation proceeds (FR-017).

**Exclude** `.claude/worktrees/` from every grep — it holds ~45 stale full-repo copies that
otherwise dominate results.

---

## Step 2 — Per-story validation

Run the relevant suites after each story; run everything before merge.

### US1 — Pure deletions

```bash
npm run test:server && npm run test:client && npm run build

# SC-003: zero references to anything deleted
grep -rn "redis-persistence\|getDiff(" server/ client/src/ shared/ script/ migrations/ __tests__/
grep -rn "loadVersionContent\|loadContentAtClock\|loadPreviousContentAtClock" client/src/
grep -rn "baselineClock" server/undo/
```

Expected: no hits (the feature-004 `baselineClock` hits in `server/api/docs-import.js`,
`server/mcp/`, and the 004 specs are a **different concept** and must remain — see R5).

Dead-CSS check — every class removed must have zero JSX references, and
`.version-history-error` must still be present:

```bash
grep -n "version-history-error" client/src/components/VersionHistoryPanel.css   # must still match
```

**⚠️ FR-002 gate**: do not delete `server/redis-persistence.js` until DEC-7 is resolved.
`design/authentication-and-sharing.md:19` and `design/collaboration-core.md:23` describe it
as live; `design/` exports must not be hand-edited (Constitution VI).

### US4 — Cache fingerprint (SC-006)

```bash
# Namespace is stable across restarts on unchanged source
node -e "console.log(require('./server/diff-service.js').CACHE_VERSION)"
node -e "console.log(require('./server/diff-service.js').CACHE_VERSION)"   # identical

# A scratch edit to any pipeline source changes it, with no human action
echo "// scratch" >> shared/diff/word-diff.js
node -e "console.log(require('./server/diff-service.js').CACHE_VERSION)"   # differs
git checkout shared/diff/word-diff.js
node -e "console.log(require('./server/diff-service.js').CACHE_VERSION)"   # back to the original
```

The pin test must pass **unmodified**:

```bash
npx jest server/__tests__/diff-service.test.js --runInBand --forceExit
git diff --stat server/__tests__/diff-service.test.js    # must be empty
```

### US2 — Backend structure

```bash
npx jest server/undo server/__tests__/diff-service.test.js \
         server/__tests__/diff-two-surface-parity.test.js \
         server/__tests__/version-history.test.js --runInBand --forceExit
git diff --stat server/undo/__tests__/ server/__tests__/    # only legacy.test.js (baselineClock blocks)
```

The traversal-agreement pin tests are the FR-011 safety net and must pass byte-for-byte.

### US3 — Frontend structure

Characterization tests for `VersionHistoryPanel` and `VersionPreview` are written
**first** — neither has any test today (R17), so the refactor is otherwise unguarded.

```bash
npm run test:client
git diff --stat client/src/components/__tests__/HierarchicalVersionList.test.jsx  # must be empty
```

### US5 — Long tail (SC-007)

```bash
# Exactly one definition per consolidated concept
grep -rn "function retryWithBackoff\|retryWithBackoff =" server/ shared/
grep -rn "function isSentinelOrigin" server/
grep -rn "function clockRangeLabel\|clockRangeLabel =" client/src/
grep -rn "formatDateTime" client/src/    # definitions only in utils/datetime.js
```

Note `origin.js`'s five-member check consolidates, but the two **deliberate subsets** at
`index.js:2209` and `:2242` stay different (contract C9).

---

## Step 3 — Manual walk (SC-005)

No automated coverage exists for the panel or preview, so this is load-bearing. With the
dev server running, on a document with several versions including at least one named
version and one drill-down with sub-versions:

1. Open version history — timeline renders; contributors and timestamps look right.
2. Drill into a version — individual edits appear; counts match the timeline.
3. Select versions — preview renders; toggle diff highlights **on and off** (this is the
   `VersionPreview` path whose comment FR-016 corrects; behavior must be unchanged).
4. Restore from the **header** button — dialog copy, confirm, cancel, and post-restore
   navigation.
5. Restore from a **row menu** — same dialog, same messages, same navigation.
6. Undo/redo after a restore.
7. Filter to named versions and back; confirm empty states read identically.
8. Repeat 1-3 in dark mode and at mobile width.

Anything that differs from pre-change behavior is a defect.

---

## Step 4 — Cross-instance fan-out (SC-004)

With two server instances and Redis pub/sub active, edit on instance A and observe
instance B:

- Document state converges exactly as before.
- **No** `[RedisPubSub:ROOT_CAUSE]` lines are emitted.
- An induced apply error still logs
  `[RedisPubSub] Error applying doc update for <docId>: <message>`.

---

## Step 5 — Merge-queue verification

Run in the **main** tree, serially, per the pipeline:

```bash
npm run migrate        # proves the title migration still resolves getDocumentMeta (C8)
npm test               # backend then client; never overlap another backend run
npm run build
```

Then the SC-002 measurement (basis defined in contract C11):

```bash
git diff --shortstat $(cat /tmp/042-merge-base.txt) HEAD -- . ':(exclude)specs'
```

Expected: net reduction ≥ 600 lines. **If DEC-7 resolved against deleting
`redis-persistence.js`, 470 of the ~865 available deletion lines are gone and this target
is unreachable — renegotiate SC-002 rather than padding other deletions.**

---

## Definition of done

- [ ] Both suites green, and `git diff` shows **no** test modifications except: `legacy.test.js` (`baselineClock` blocks), `useVersionHistory.test.js` (deleted-symbol blocks), the two `EditorView.*.test.jsx` mock entries, and the deleted `redis-persistence.test.js`.
- [ ] `npm run build` clean; `npm run migrate` clean.
- [ ] Every SC-003 reference grep returns zero hits in production code.
- [ ] SC-006 scratch-edit test demonstrated both directions.
- [ ] Manual walk (Step 3) shows no observable difference.
- [ ] No `[RedisPubSub:ROOT_CAUSE]` output remains; error logging intact.
- [ ] No new migrations added.
- [ ] DEC-7 resolved one way or the other, and `clarifications-needed.md` reflects the outcome.
