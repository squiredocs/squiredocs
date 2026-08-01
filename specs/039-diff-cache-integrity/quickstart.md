# Quickstart — Validating 039-diff-cache-integrity

A runnable validation guide. Details live in [contracts/](./contracts/) and
[data-model.md](./data-model.md); this file is how you *prove* the feature works.

---

## 0. Parallel-agent ground rules (read first)

- Stay on the current branch. **Do not create a branch, do not commit** unless the pipeline
  instructs it.
- **Do not** run `create-new-feature.sh`; **do not** write `.specify/feature.json` (shared and racy
  — it currently points at 038).
- Prefix every `.specify` script invocation with
  `SPECIFY_FEATURE=039-diff-cache-integrity SPECIFY_FEATURE_DIRECTORY=/local-dev/specs/039-diff-cache-integrity`.
- **Do not** edit `CLAUDE.md`, `README.md`, or `docs/dev.md` — reconciled in the merge queue.
- **Do not** touch 038's territory: `server/index.js`, `server/origin.js`,
  `server/document-service.js`, the WRITE path of `server/postgres-persistence.js` (`storeUpdate`),
  and **no migration of any kind**.

---

## 1. Environment setup (worktree)

Worktrees do not inherit `node_modules`.

```bash
cd <worktree-root>
npm ci
(cd client && npm ci)
cp /local-dev/.env .env 2>/dev/null || true    # if present in the main tree
```

Redis is shared across agents and that is fine — the `CACHE_VERSION` bump to `v10` namespaces
039's entries away from anything else.

### Per-agent test database (required)

Backend tests are serial-only **within one database**, and concurrent runs against the shared
`collab_test_db` corrupt it. Create your own:

```bash
createdb collab_test_db_039
export TEST_DATABASE_URL='postgres://<user>:<pass>@<host>:5432/collab_test_db_039'
```

Pass it on **every** backend test command (`server/__tests__/helpers/db.js` respects
`DATABASE_URL`):

```bash
DATABASE_URL="$TEST_DATABASE_URL" npx jest server/__tests__/diff-service.test.js --runInBand
```

`--runInBand` is already wired — **do not defeat it**.

---

## 2. Test commands

| Scope | Command |
|---|---|
| Shared segmentation | `npx jest shared/diff --runInBand` |
| Version-history word marks | `DATABASE_URL="$TEST_DATABASE_URL" npx jest server/diff --runInBand` |
| Diff service (cache rules, reconstruction, metadata) | `DATABASE_URL="$TEST_DATABASE_URL" npx jest server/__tests__/diff-service.test.js --runInBand` |
| Read completeness | `DATABASE_URL="$TEST_DATABASE_URL" npx jest server/__tests__/postgres-gap-read.test.js --runInBand` |
| Chat diff surface + 028 regression | `DATABASE_URL="$TEST_DATABASE_URL" npx jest server/mcp/__tests__/diff-postprocess.test.js --runInBand` |
| Model-bound strip | `DATABASE_URL="$TEST_DATABASE_URL" npx jest server/api/__tests__ server/mcp/__tests__ --runInBand` |
| Undo (shares the diff shape) | `DATABASE_URL="$TEST_DATABASE_URL" npx jest server/undo --runInBand` |
| Full backend | `DATABASE_URL="$TEST_DATABASE_URL" npx jest --runInBand` |
| Client (worktree-safe as-is) | `cd client && npx vitest run` |
| Build | `npm run build` |

---

## 3. Validation scenarios

Each maps to a success criterion. Prerequisites: setup above complete.

### V1 — SC-001: an incomplete read is never cached (US1, FR-001…005a)

1. Mock the persistence provider so the first fetch omits the newest row and a later fetch
   includes it (a delayed-commit harness; the existing `diff-service.test.js` mock at line 57
   already returns `{ rows, gapped }`).
2. Request a diff up to version N.
3. **Expect**: the read is retried within the existing budget; still short after the budget ⇒ the
   result is returned to the caller **and** `redis.setex` was **not** called.
4. Heal the log, request again. **Expect**: the diff includes version N **and** `setex` **is**
   called with a `diffv10:` key.
5. Negative control: `getUpdateRowsUpTo(guid, 2147483647)` with **no** `expectedTailClock` performs
   exactly one query (backfill regression guard, RC-7).

### V2 — SC-002: a transient failure recovers on the next request (US2, FR-005b)

1. Force `computeMarkdownDiff` to throw once.
2. **Expect**: the plain current document + `meta.diffFailed === true` is served, `setex` **not**
   called.
3. Remove the failure, request the same pair. **Expect**: full highlighted diff **and** cached.

### V3 — SC-004: determinism, size vs. timeout (US3, FR-005c/FR-006)

1. Region exceeding `MAX_SIDE_CHARS` ⇒ line-level presentation, `report.reason === 'size'`, result
   **IS** cached.
2. Forced jsdiff timeout ⇒ line-level presentation, `report.reason === 'timeout'`, result served,
   **NOT** cached.
3. Recompute without the timeout ⇒ word-level result returned **and** cached.
4. Assert `DIFF_TIMEOUT_MS === 250` is unchanged.

### V4 — SC-003: two-surface parity (US4, FR-008…010)

1. Build a before/after pair where a new sentence is inserted at the **top** of an otherwise
   unchanged multi-line block.
2. Drive **both** pipelines from the same input: `postProcessDiffLines` (chat) and `applyWordMarks`
   (version history).
3. **Expect**: identical ordered (row-relative start, end) changed-range lists per side, row for
   row. Unchanged rows carry **no** strong emphasis on either surface.
4. Unequal row counts ⇒ **every** row (including surplus) receives segments.
5. **Byte assertion**: `perRow.before[k].map(s => s.text).join('') === beforeLines[k]` for every
   `k` — bytes, not visual plausibility.
6. Oversized region ⇒ both surfaces fall back for the **whole** region.
7. Run the 028 hard-break regression suite unmodified — it must pass untouched.

### V5 — SC-005: no UI-only data reaches the model (US5, FR-012…014)

1. **MCP seam**: serialize a `modify` result via `server/mcp/index.js` ⇒ no `inlineSegments`;
   `hunkStarts` and `formatAnnotations` present; indentation unchanged.
2. **Live-turn seam**: the bridged tool's `toModelOutput` strips, while the value returned by
   `execute` still carries the segments.
3. **History seam**: `stripUiOnlyDiffParts` over a stored conversation strips replayed outputs;
   the input array and its parts are not mutated.
4. **FR-014 regression guard**: assert `convertToModelMessages` is called with **exactly one
   argument**, and that an image tool part in history survives the strip pass without image bytes
   being re-inlined.
5. **Storage guard**: the existing `AiChatMessages` rendering test still passes — the browser
   renders emphasis from the stored output.

### V6 — SC-006: single replay (US6, FR-015)

1. Deep-equal `computeDiff` output before/after the change for ≥3 representative version pairs,
   including `previousClock = -1`.
2. Application counter: no log row applied more than once per reconstruction.

### V7 — SC-007: the "Formatting changes only" banner tells the truth (US7, FR-016/017)

1. Two versions differing **only** inside literal angle-bracket prose (`use <div> tags for layout`).
2. **Expect**: `meta.textIdentical === false`, `meta.formattingOnly === false`.
3. Repeat with the literal `<` inside a **bold** run (the `Y.XmlText` `toDelta` subtlety).
4. Confirm the `textIdentical` parameter is gone from `computeMarkdownDiff` and no behavior moved.

### V8 — SC-008 + FR-018: badge color and the full suite

1. Render `HierarchicalVersionList` with an author lacking `color` on two different mocked dates
   ⇒ `#888888` both times.
2. Confirm `client/src/utils/colorUtils.js` is unchanged (presence rotation is deliberate).
3. Run the full backend suite and client suite. **Expect**: green, with the only intended visible
   changes being the four approved ones (surplus-row emphasis, less false emphasis on shifted
   rewrites, slightly more frequent chat row-tint fallback on very large regions, stable badge
   color).

---

## 4. Manual smoke (owed to the maintainer, not automatable here)

- Open version history on a real document, compare two mid-history versions, confirm word emphasis
  renders in both light and dark themes.
- Ask the in-app agent to modify a document; confirm the chat diff still shows word emphasis and
  that surplus rows in a multi-line rewrite are now emphasized.
- Confirm no `diffv9:` key is ever read after deploy (namespace cut-over).

---

## 5. Pre-handoff checklist

- [ ] No new migration file exists anywhere in the change.
- [ ] `git diff --stat` touches **none** of: `server/index.js`, `server/origin.js`,
      `server/document-service.js`, `CLAUDE.md`, `README.md`, `docs/dev.md`,
      `.specify/feature.json`.
- [ ] `server/postgres-persistence.js` changes are confined to `_findFirstGap`,
      `_fetchRowsWithGapRetry`, `getUpdateRowsUpTo` and their JSDoc.
- [ ] `CACHE_VERSION === 'v10'` — bumped exactly once.
- [ ] `stripHardBreakMarkers` is byte-identical to `main`.
- [ ] `convertToModelMessages` still takes exactly one argument.
- [ ] `server/scripts/backfill-meaningful-classification.js` is unmodified.
- [ ] `DIFF_TIMEOUT_MS === 250`, `MAX_SIDE_CHARS === 20000`, cache TTL `3600`.
- [ ] Full backend suite green under `--runInBand` against `collab_test_db_039`; client suite green;
      `npm run build` succeeds.
