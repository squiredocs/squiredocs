# Promotion Notes — 022-inline-diff-highlighting

Implemented by the parallel implementer agent on branch
`022-inline-diff-highlighting` (off main at f147295), 2026-07-19. All 28 tasks
executed except the deploy-time manual checks (T024/T025/T028), which are owed
to Sam. Automated verification: full backend + full client suites green, client
build OK (see the implementation report).

## Owed at promotion (Sam / deploy-time)

- **T024 — pre-feature chat regression (manual):** open a chat authored before
  this feature and confirm its modify/undo/redo diff cards render unchanged with
  no console errors. (Covered automatically by the backward-compat client test,
  but a real-app pass is owed per quickstart.md — SC-004.)
- **T025 — theme legibility (manual):** on BOTH surfaces (chat diff card and
  version-history preview), in light mode and every dark variant, confirm the
  strong word highlight is clearly distinguishable from the subtle line/row tint
  and the highlighted text stays readable (SC-007).
- **T028 — quickstart end-to-end (manual):** chat one-word edit, undo/redo card,
  version-history one-word edit, plus the format-only + pure-add sanity checks
  (SC-001/SC-002/SC-006).
- **Deploy coupling (FR-011):** `CACHE_VERSION` was bumped `v7 → v8`. The bump
  and the app code MUST ship together — deploying the new marks without the bump
  would serve stale v7 line-level diffs from Redis; bumping without the code
  would recompute but is harmless. No manual cache flush needed (immutable
  historical diffs age out at the existing 3600s TTL, and the new key namespace
  simply misses).
- **D3/D5 design ratification** (per the pipeline): the two design amendments
  are already exported to `design/`; this implementation converges to them. Any
  post-merge ratification checkboxes in the decisions ledger are Sam's to tick.

## Post-merge review dispositions (2026-07-19, reviewer: Fable — MERGE STANDS)

- **HIGH — unbounded synchronous word-diff (FIXED same-day, orchestrator):**
  Myers word-diff over two large mostly-dissimilar sides (whole-doc rewrite via
  the history path; giant single-line paragraph via the chat path) ran with no
  ceiling and could block the Node event loop for seconds-to-minutes. Fix:
  `computeWordSegments` now returns `null` when either side exceeds
  `MAX_SIDE_CHARS` (20,000) or jsdiff's `timeout` (250ms) fires; both callers
  degrade to the line-level presentation with no error logged (expected
  degradation per RBD-3). Constants are RBD-5 in the clarifications ledger —
  Sam to ratify the values.
- **LOW — paste re-introduces diff marks (ACCEPTED, pre-existing class):**
  copying from the version preview and pasting into a live editor parses
  `ins.diff-word` into a real `diffInsertWord` mark. The same is true of the
  pre-022 `diffInsert`/`diffDelete` via bare `ins`/`del` parse rules, so this is
  a pre-existing class made slightly more visible, not a new hole. Markdown
  export drops the marks. Owed at promotion: strip all four diff marks in the
  editor's paste transform (one transformPasted hook) — small, do with the next
  editor-surface feature.
- **LOW — fail-open catch can rethrow when the parser itself throws (ACCEPTED):**
  if `markdownToPm` throws on the same input in the catch path, the error
  escapes `applyWordMarks` — but it is absorbed by `computeDiff`'s outer try
  (diffFailed=true, no 500, no cache poison), and pre-022 threw identically on
  the same input. No behavioral regression; letter-of-FR-012 gap noted.
- **LOW — log-once observability (ACCEPTED):** refinement failures log once per
  process lifetime. With the 013/014 observability stack, a rate-limited log or
  metric would be more diagnosable — fold into the next observability pass.
- **Docs (DONE same-day):** README diff sections updated for the two-tier
  behavior; `docs/version-diff-status-update.md` stamped SUPERSEDED (it
  described the abandoned y-prosemirror snapshot approach).

## Implementation notes (not decisions — for the reviewer's awareness)

- **Chat segment text is span-stripped, not merely prefix-stripped.** The
  contract (`contracts/chat-diff-payload.md`) says "prefix-stripped text
  (`line.slice(1)`)". The rendered diff row is ALSO `<span style>`-stripped by
  `stripSpanTags`, so to keep the client's segment render byte-identical to the
  plain-`{entry.line}` fallback, `postProcessDiffLines` segments the
  span-stripped text (`stripSpanTags(line.slice(1))`), not the raw slice. This
  is a faithful reading of the contract's intent ("segments rejoin to the row"),
  just more specific than its literal wording. A test asserts the rejoin equals
  the rendered row.
- **Chat strong highlight uses CSS `color-mix()`** off the theme-aware
  `--success`/`--danger` families (`AiPanel.css`). `color-mix` was not
  previously used in this codebase; it is supported in all current evergreen
  browsers (2023+). If a hard floor on an older engine is ever required, swap to
  precomputed rgba tokens like the version-history side uses.
- **`inlineSegments` is always a KEY on the in-memory diff object** (value
  `undefined` when empty), exactly like `formatAnnotations`. `JSON.stringify`
  drops it from persisted payloads when undefined, so persisted pre-feature parts
  are unaffected. Two diff-shape allowlists in tests (`DIFF_KEYS` in
  `undo-service.test.js` and `undo-redo-workflow.test.js`) were extended to
  include the additive field — this is the additive-shape update, not a behavior
  change.
- **Fault-injection testability:** `apply-word-marks.js` calls
  `wordDiff.computeWordSegments` via the module namespace (not a destructured
  binding) so a `jest.spyOn` fault-injection test works without `isolateModules`
  (which would load a second `yjs` copy and clash Y.Doc constructors). Same
  pattern the undo-service uses for `diffUtils.computeChatDiff`.

## Worktree/CI note (environmental — merge queue re-verifies in main tree)

- The repo `jest` config ignores `/.claude/worktrees/`, so running the backend
  suite FROM this worktree requires overriding the ignore patterns:
  `--testPathIgnorePatterns /node_modules/ /client/ --modulePathIgnorePatterns
  /nonexistent/`. In the main tree this is a non-issue.
- Backend jest leaves open handles (pre-existing, not introduced here); runs
  must use `--forceExit` (the repo's `test:server` script already does) or they
  hang after the last test with buffered output.
- Per-agent DB used for verification: `collab_test_db_022` on the shared
  Postgres (`collab-postgres`, user `postgres`). Not the shared `collab_test_db`.
