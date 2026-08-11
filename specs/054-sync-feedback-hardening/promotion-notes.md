# 054-sync-feedback-hardening — promotion notes

## Post-merge review dispositions (Fable review of d2d38482, 2026-08-11)

Verdict: no HIGH findings. One MEDIUM, three LOW, two ratification items.

- **MEDIUM — stale sandbox bundle: FIXED same-day.** The committed
  `server/mcp/sandbox/isolate-bundle.js` still carried the pre-054 parsers, so
  agent `fromMarkdown` scripts could write `orderedList start: 0` while every
  export/diff/sync surface clamps to 1. Rebuilt via `npm run
  build:sandbox-bundle` (picks up the 054 clamp and the LOW-3 cap below).
- **LOW-3 — unbounded ordered-list `start`: FIXED same-day.** Both parsers and
  the serializer helper now cap `start` at nine digits (999999999, the
  CommonMark marker limit); an oversized value used to serialize as `1e+24.`
  and re-parse as a paragraph, silently changing the block type on round trip.
- **LOW-1 — strict-gate TOCTOU window: ACCEPTED, promotion item.** The strict
  clock check runs before image staging (potentially seconds); a live edit
  landing in that window yields a 200 strict receipt with
  `docChangedSinceBaseline: false` yet non-empty `overlaps`. Fix direction if
  promoted: re-read the clock immediately before `storeUpdate` under strict
  and 409 there. Not fixed now: the window predates 054 for all non-strict
  semantics, and strict is opt-in.
- **LOW-2 — strict breaks at-least-once retry idempotency: ACCEPTED,
  promotion item.** A strict push whose response is lost gets 409
  `sync_baseline_stale` on identical retry (the "unseen change" is its own
  landed edit); converges via the standard re-export remedy. Fix direction if
  promoted: self-application detection before rejecting, or document the
  strict-mode exception at README:~523.

## Awaiting Sam ratification

- **RBD-054-5** — `operations` hunk counts retained alongside `blocksChanged`
  (loose reading of the amendment's "replace"; one-line deletion if literal
  reading is wanted).
- **RBD-054-11** — dryRun still runs the staged image pass (may rehost
  external images to S3 with no document-visible trace). Kept so previews
  predict the real plan; reviewer notes no test asserts the rehost occurs
  under dryRun and the no-audit-trail nuance deserves explicit sign-off.
- **RBD-054-1 / -3** (from spec stage) — staleness defined as clock
  inequality incl. the ahead-baseline/restore edge; dry run opens no 037
  presence session (a carve-out from 037's "presence spans the whole
  request").

## Owed at/after deploy

- **T076 manual browser walk** — dry run shows no avatar/no temporary
  selection; version history renders `11.` numbering after the diff-cache
  bump (v10→v11).
