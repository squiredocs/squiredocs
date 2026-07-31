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

## Deferred (flagged for Sam, not decided)

- **Undo-on-import**: REST imports record no agent_edits rows, so log-derived
  undo cannot revert them; presence will make imports visible and likely
  create demand. Separate design if wanted.
