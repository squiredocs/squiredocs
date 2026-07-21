# 028-clean-diff-hard-breaks — promotion notes

## Post-merge review dispositions (2026-07-21)

Review of 8ee003c + f31c4a4 (Fable): diff integrity, blast radius,
guardrails, README all CLEAN (verified by executing the merged function
against adversarial serializer emissions). Findings:

- MEDIUM-1 (FIXED same day): fence toggling treated any ```-prefixed line
  as a boundary, so fence-lookalike content (code quoting fence syntax)
  inverted the state and could strip genuine code backslashes downstream.
  Fixed: closing is now asymmetric — inside a fence only a bare ``` line
  closes (the serializer's sole closing form) — with an M1 regression test.
  Residual string-level ambiguities (bare ``` as code BODY; paragraph
  STARTING with ```) are accepted, fail preserve-side only (cosmetic marker
  leak, never content-stripping), and are pinned by explicit tests.
- LOW-2 (ACCEPTED, documented): a continuation line consisting entirely of
  >/whitespace reads as block-final → genuine marker leaks. String-level
  indistinguishable from a blockquote separator; preserve-side only.
- LOW-3 (FIXED): tautological duplicate-call assertion in the US2 test
  replaced with an honest comment; the single-generation-point property is
  architectural (both call sites use diffUtils.computeChatDiff, pinned by
  the namespace-import convention).
- LOW-4 (FIXED): the serializer's indent-only continuation emission for a
  trailing list-item hard break is now pinned by a unit case (preserved per
  RBD-1).
- Note-5 (no action): codeBlock inside a plain listItem serializes unfenced
  (pre-existing serializer limitation); those lines classify as prose. Not
  a 028 defect; inherits the serializer's existing round-trip gap.

## Owed at promotion
- Manual checks: SC-001 modify card over hard-broken prose renders clean;
  SC-003 undo card clean; fence-backslash spot check; SC-005 legacy chat
  cards byte-identical; SC-006 version history unaffected.
- Sam ratifications: RBD-1..3.
