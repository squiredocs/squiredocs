# 037-import-presence — promotion notes

Relaxations, manual-only coverage, and process notes owed at promotion.
Review dispositions land here after the Fable post-merge review.

## Manual coverage owed

- **T037 — quickstart scenarios A–E** (browser + two instances): owed by Sam.
  Includes the FR-007 ~60s linger/auto-expiry, which is manual-only by design
  (RBD-13): the suite pins the refresh re-arm this feature owns; the expiry
  itself is agent-presence machinery gated on a live WS provider.
- **SC-001 measured healthy-path only** (analyze finding A1, ratified
  disposition): the ~2s best-effort cap outranks "presence before content
  changes" — on a cold doc the agent can appear after apply. Deliberate; no
  waiting/retries were added. Verify the healthy path feels right in the
  manual walk.

## Process notes

- **README edited on the implementer branch** (9aa16ae2), violating the
  parallel-agent override that reserves README/CLAUDE/docs edits for the
  merge queue. Kept at merge — the content was accurate and matched what the
  queue would have written — but future implement briefs should repeat the
  rule more prominently; this is the second artifact-discipline slip in two
  features (036: uncommitted plan artifacts).
- Implementer survived ~8 API-connection interruptions (2026-07-30/31
  instability) via resume-from-transcript with commit-per-green-step
  discipline; no work lost. The chunked-write + heredoc-for-large-files
  guidance is worth carrying into future briefs during API instability.

## Post-merge review dispositions (Fable, 2026-07-31)

One MEDIUM and three LOW findings; all four FIXED same-day on main, each with
a test that fails without its fix. No user interaction — best defaults taken
and recorded here.

- **MEDIUM-1 — a pure-deletion sync push fabricated a selection over unchanged
  content.** FIXED (`6a0e160d`). The observer recorded the delete index into the
  changed span, but post-apply that index is the surviving NEIGHBOUR; mixed
  insert+delete pushes additionally stretched the span back over every
  untouched block between them. Delete-derived indices now live in their own
  list and never widen or create a span, so a pure deletion settles with no
  selection — RBD-8 as ratified. Tests (`server/__tests__/import-presence.test.js`):
  *"RBD-8: a sync push that ONLY deletes a mid-document block shows no
  selection"* and *"RBD-8: a mixed insert+delete push spans only the inserted
  block"*. Note for future readers: the sync engine only emits a bare top-level
  delete when the surrounding blocks still align, so both tests use distinct
  paragraph texts — with near-identical lines the engine replans the region as
  an insert+delete and a selection over the INSERTED block is correct.
- **LOW-1 — token names accepted invisible/control characters.** FIXED
  (`58047740`). `String.trim()` strips neither zero-width nor bidi characters,
  so a visually empty or direction-reversed name became a presence label and a
  version-history author. `sanitizeTokenName` (server/mcp/auth/token-naming.js,
  shared by both minting surfaces) strips the Unicode Cc/Cf categories and
  trims. DEFAULT TAKEN: a name left with nothing printable falls back to the
  derived agent name rather than erroring — an all-invisible name is a mistake,
  not an attack to report, and it lands where an omitted name would. The
  existing empty/whitespace/over-length errors are unchanged, and the length
  limits still measure what the caller sent. Tests: the three `N6:` cases in
  `server/mcp/__tests__/tools/create-access-token.test.js`.
- **LOW-2 — the append range could bracket a concurrent human tail edit.**
  FIXED (`fed2d3e3`). `settle` runs after `updateDocument`'s setImmediate hop,
  so a browser edit relayed in that hop was already in `fragment.length` and
  the tail-relative range slid onto the human's block. DEFAULT TAKEN: rather
  than the pre-apply LENGTH the route captures a pre-apply RelativePosition
  bound to the last existing block (`captureAppendBaseline`) — being
  CRDT-item-based it survives concurrent edits on either side, so this keeps
  research R4's earlier-insert robustness instead of trading it away. Any
  failure to capture or resolve falls back to the old arithmetic. Test:
  *"LOW-2: a tail edit landing between apply and settle does not drag the
  range"*.
- **LOW-3 — concurrent sync pushes on one instance cross-polluted observed
  ranges.** FIXED (`2c1aab18`), judged safely contained: `ORIGIN_SYNC_PUSH`
  had exactly four consumers (parseOrigin, the import-presence observer,
  markdown-sync's broadcast, and the origin suite), and the index.js publish
  skip-list never mentions it. `createSyncPushOrigin()` mints a per-push origin
  object and `isSyncPushOrigin()` recognises the class including the legacy
  string sentinel. Every other consumer's semantics are unchanged and now
  pinned by test rather than by inspection: `parseOrigin` still returns null
  for a per-push origin (no unattributed second row) and it is still off the
  Redis publish skip-list (still fans out cross-instance) —
  `server/__tests__/origin.test.js` *"per-push sync origins (037 LOW-3)"*, plus
  *"LOW-3: an observer ignores a CONCURRENT sync push on the same document"*.

Also corrected, no behavior change: RBD-15's "two pre-existing assertions"
→ three (one in create-access-token.test.js, two in token-claim.test.js), and
the docs-import.js header, which claimed the routes are pure thin wrappers
after the PUT handler had taken on presence and fan-out orchestration.

## Deferred (flagged for Sam, not decided)

- **Undo-on-import**: REST imports record no agent_edits rows, so log-derived
  undo cannot revert them; presence will make imports visible and likely
  create demand. Separate design if wanted.
