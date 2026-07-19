# Worklog — 021-collab-binding-hardening (implementation)

**Implementer run**: 2026-07-19, pipeline worktree, branch `021-collab-binding-hardening`
(branched from main @ 8355107). Backend tests ran serially against a dedicated
`collab_test_db_021` (fresh migrate; no new migrations added by this feature).

## Quickstart validation (T021)

### §1 Client — binding patch (US1)

- `npm ci` in `client/`: green end-to-end; postinstall `patch-package
  --error-on-fail` applies `patches/@tiptap+y-tiptap+3.0.7.patch`
  (`@tiptap/y-tiptap@3.0.7 ✔`). Verified twice from `rm -rf node_modules`.
- Named suites all green:
  `binding-patch-guard` 5/5, `binding-render-failure` 6/6,
  `binding-selection-writeback` 7/7, `binding-killswitch` 4/4,
  `skip-reporter` 6/6, `editor-quarantine` 5/5.
- Red-first evidence is in the branch history: 35cdf8c committed the repros
  RED against stock 3.0.7 (13 failed — every failure the stock
  delete-on-catch / ungated-diff behavior); b835f6e turned them green with the
  patch. The drift-guard test was committed RED in 1cb23f6.

### Drift-guard install-failure drill (SC-007) — with a finding

- `npm install @tiptap/y-tiptap@3.0.6 --no-save` does **not** fail postinstall,
  contrary to the quickstart's phrasing: patch-package applies the 3.0.7 patch
  cleanly onto 3.0.6 (the patched functions are near-identical) and downgrades
  the version mismatch to a **warning** (exit 0). `--error-on-fail` fires only
  when the patch fails to apply (i.e. genuinely drifted code) — that case does
  kill the install loudly.
- The guard **test** is the enforcing layer for clean-apply drift, exactly as
  FR-008 designed (belt + braces): with 3.0.6 installed the guard suite goes
  RED (`installed version === '3.0.7'` fails) — verified live during the
  drill. Restored with `npm ci` (3.0.7 + 5 sentinels back).
- Consequence for reviewers: SC-007 holds — a bump can never *silently*
  revert (either the patch fails the install, or the guard test fails) — but
  the loud failure is not always at install time. Recorded here rather than
  silently editing the quickstart.

### §2 Server — guardrail (US2)

- `collab-guardrail` 8/8 green (committed RED first — module absent).
  Signature alert carries docGuid/humanUserId/agentName/agentUserId/
  agentClockRange (DB clock space)/overlappedItemRanges (Yjs item-ID space)/
  suppressedSinceLastAlert. Silence controls, storm suppression (page once,
  carry count, independent docs), malformed-bytes swallow, and
  persistence-unaffected-under-throw all verified with real Y.Doc updates.

### §3 Server — gap read (US3)

- `postgres-gap-read` 6/6 green (committed RED first — (a)/(b)/(e) failed
  against the gap-blind read). Heal-within-window returns the complete doc;
  still-gapped serves as-is within the configured budget with the
  `served with clock gap (retries=…, rows=…, firstGapAfterClock=…)` line;
  gap-free/head-of-history/empty/single-row paths add no retries or waits
  (timing driven via `COLLAB_READ_GAP_RETRIES` / `COLLAB_READ_GAP_RETRY_DELAYS_MS`).

### §4 Regression + manual checks

- SC-006 sweep, zero test-file edits: `attribution-bug` + `origin` +
  `__tests__/integration/collaboration.test.js` = 20/20 green (serial).
- Full client vitest suite: 57 files / 680 tests green (includes all new 021
  suites).
- Full backend jest suite on `collab_test_db_021` (serial, `--runInBand`):
  **3137 passed / 3139** (185/187 suites). The 2 failures are in
  `server/__tests__/search.test.js` ("hybrid mode falls back to fulltext…" —
  `await embed(...)` returns undefined in this sandbox), **proven
  pre-existing**: the same failure reproduces with every 021-touched server
  file checked out from the base commit (8355107). Search files are owned by
  the in-flight 018 track and were not touched by 021 (verified:
  `git diff 8355107..HEAD --name-only` has zero overlap with the 018/019
  ownership lists).
- Client production build green (`vite build` + documentation build, 12
  pages); the patched binding is in the shipped bundle (verified
  `__SQUIRE_COLLAB_HARDENING__` present in `dist/assets/index-*.js`).
- **Manual checks NOT performed here** (no browser in the implementer
  environment) — owed to Sam / the merge phase, per quickstart §4:
  1. two-tab normal typing + agent edit (sync/presence/undo/attribution),
  2. kill-switch drill against a running server
     (`PUT /api/admin/settings/collab-binding-hardening {"enabled":false}` →
     refresh → stock mode → flip back ON),
  3. quarantine on a doc with an unknown node type (read-only + refresh
     banner, doc unmodified server-side).

## Deviations / notes for review

- **Skip-reporter call shape**: the patch calls
  `globalThis.__SQUIRE_SKIP_REPORTER__({ docId, nodeType, errorName })` — the
  binding-patch contract's site-1 text says `{ nodeType, errorName }`, but the
  beacon payload requires `docId` for per-doc batching
  (runtime-config-and-skip-report contract), and the patch is the only place
  that knows the doc. Superset judged intentional; flagging for the reviewer.
- **Oversize skip report** returns **413** (body-parser `entity.too.large`
  via the existing error branch), not 400; malformed *shape* returns 400 per
  contract. Both tested.
- **Editing inside a createAndFill stand-in** is an accepted degraded-view
  edge (documented in the patch): identity-tracked pair exclusion means a
  user edit inside a stand-in creates a new PM node that no longer matches
  the tracked identity; the diff may then add content to Y but can never
  delete shared content (FR-001's invariant is structural). Not covered by a
  spec scenario; noted for a possible follow-up.
- **docs/dev.md**: verified no change needed — the patch applies through the
  existing `npm ci` / `npm install` flows documented there (T020).
- README gained a "Collaboration Binding Hardening (feature 021)" section +
  the five new env vars (T020).

## Owed follow-ups (promotion notes — NOT closed by this feature)

- Upstream filing: y-tiptap issue + comments on y-prosemirror #39/#258
  (design Addition refinement 5).
- Post-deploy kill-switch flip drill (quickstart §4 item 2) in prod.
- The three manual browser checks listed above.
