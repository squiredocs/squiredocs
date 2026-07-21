# Quickstart: Verify Clean Hard-Break Rendering in Transcript Diffs

Feature 028 removes hard-break markers (trailing `\`) from chat transcript inline
diffs at generation time. This is a server-only, single-file change with no client,
schema, or dependency changes.

## What changed

- `server/mcp/diff-utils.js`: new exported pure function
  `stripHardBreakMarkers(markdown)`; `computeChatDiff` cleans **both** inputs with it
  before `structuredPatch`.
- `server/mcp/__tests__/diff-postprocess.test.js`: new unit + integration coverage.

Nothing else is touched (serializer, `server/diff/*`, `shared/diff/word-diff`, and
all client code are unchanged — FR-008).

## Run the tests (backend, serial-only)

Backend Jest shares one database and MUST run serially. In this pipeline the
implementer runs inside a git worktree pointed at an isolated DB:

```bash
# inside the app-dev pod / worktree, with the worktree jest-config workaround
DATABASE_URL=postgres://.../collab_test_db_028 \
  npx jest server/mcp/__tests__/diff-postprocess.test.js --runInBand --forceExit
```

Expected: the existing `stripSpanTags` / `extractPlainText` / `describeMarks` /
`postProcessDiffLines` blocks pass unchanged (SC-007), plus the new
`stripHardBreakMarkers` and `computeChatDiff` hard-break blocks pass.

## Manual smoke test (the screenshot scenario, SC-001)

1. In the app chat, open (or create) a document with a poem stanza whose lines are
   separated by hard breaks (Shift+Enter in the editor).
2. Ask the assistant to modify one stanza line.
3. In the modify tool card's **Changes** diff: no removed / added / context row ends
   with a trailing `\`. Line tints, gutter numbers, hunk separators, and 022
   word-level highlights are unchanged from before the fix.
4. Press **Undo** (or invoke the undo tool). The undo card's diff is clean the same
   way (SC-003).

## Regression spot-checks (SC-002, SC-005, SC-006)

- **Code block content backslash**: modify a fenced code block containing a line that
  ends in `\`; the diff preserves that backslash (SC-002c). Same for a mermaid/svg
  diagram fence (SC-002d).
- **Literal backslash at paragraph end**: a paragraph whose text ends in `\` keeps it
  in the diff (RBD-1 / SC-002e).
- **Legacy chat**: open a pre-feature chat that already shows a hard-broken diff — it
  renders byte-identically, markers and all, with no client change and no errors
  (SC-005).
- **Version History**: open Version History with highlighting on for a hard-broken
  document — the diff preview is byte-identical to before the feature (SC-006).

## Rollback

Revert the two hunks in `server/mcp/diff-utils.js` (the helper + the two cleanup
call lines) and the new test block. No data migration, no deploy coordination beyond
shipping the reverted image — payloads are computed on the fly, and legacy payloads
were never touched.
