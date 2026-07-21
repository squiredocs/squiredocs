# Clarifications Ledger — 028-clean-diff-hard-breaks

Decisions the design amendment did not answer were taken with the best default and
recorded here as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-21)**.

Decisions already made are Sam-ratified 2026-07-21 (design amendment, commit 19887fa)
and are cited in the spec, not re-decided:

- **By the design amendment** (`design/in-app-ai-assistant.md`, "Amendment (Sam,
  2026-07-21) — hard-break markers never render in transcript diffs (feature 028)"):
  the marker is removed where the diff payload is generated — server post-processing,
  keyed on block context, never client substring stripping; applies to modify and
  undo/redo cards alike; a genuine backslash in content or code blocks is preserved
  exactly; legacy persisted tool-part payloads keep their markers (accepted,
  additive-payload convention per 022); the version-history diff is unaffected by
  construction.
- **By the current code shape (verified, not decided)**: both card types produce their
  payload through one shared diff-generation function (modify and the 020 undo/redo
  handler), so a single fix point covers both; the canonical serializer emits a hard
  break as a backslash immediately before the newline inside paragraph-like inline
  content, substitutes `<br>` in headings and table cells, and never escapes literal
  backslashes in inline text; the version-history pipeline shares only the word-
  segmentation helper with the chat pipeline, and that helper needs no change.

---

## RBD-1: A block-final trailing backslash is preserved as content

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-21)
- **Question**: In the canonical serialization, a paragraph whose text literally ends
  with a backslash and a paragraph whose last child is a hard break both serialize to
  a block-final line ending in `\` with no continuation line — the two are
  indistinguishable in the serialized form. Should that trailing backslash be removed
  (assume trailing hard break) or preserved (assume literal content)?
- **Decision**: Preserved, always. A trailing backslash is removed only when the line
  has a continuation line within the same paragraph-like block.
- **Why this default**: It is the grammar's own answer — in markdown (and in the
  strict re-parse of the canonical serialization) a backslash before a blank line or
  end of input is a literal backslash; a hard break requires a following line in the
  same paragraph. Preserving therefore matches what the document re-parses and
  renders as, and errs on the side the amendment weights: "a genuine backslash in
  content ... is preserved exactly". The lost case (a trailing hard break at the very
  end of a paragraph) is visually inert — a line break before the paragraph ends
  renders the same as none — so preserving costs nothing visible, while removing
  would silently delete real content backslashes from the diff. Spec: FR-002/FR-003,
  Edge Cases, SC-002(e).

## RBD-2: Cleanup normalizes both full serialized documents before the line diff

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-21)
- **Question**: The amendment pins generation-time server post-processing keyed on
  block context, but not the exact stage: strip markers from the two full markdown
  inputs before the line diff runs, or walk the already-computed hunk lines
  afterward?
- **Decision**: Normalize both full serialized documents (before-text and after-text)
  first; the line diff, format-only detection, and word segmentation all consume the
  cleaned text.
- **Why this default**: It is the only stage where the block-context requirement can
  be met exactly — fence state is a whole-document property, and a hunk windowed to a
  few context lines can begin mid-code-block with no way to know it (hunks also omit
  the lines between them, so fence state cannot be reconstructed from diff output
  alone). It additionally makes every downstream consumer consistent for free:
  context lines render clean, a pair differing only by markers is never reported as a
  change, word segments (022) can never contain the phantom marker, and format-only
  comparison sees the same text on both sides. Line counts are unchanged, so hunk
  numbering is unaffected. Post-hoc line walking would need fence heuristics —
  exactly what the amendment forbids. Spec: FR-004, Edge Cases, SC-004.

## RBD-3: Diagram fences are treated as fenced content, same as code blocks

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-21)
- **Question**: The amendment exempts "code blocks" from marker removal. The
  canonical serialization also emits diagram fences (mermaid, svg) with the same
  fence syntax and verbatim content. Are they exempt too?
- **Decision**: Yes — every fenced block in the canonical serialization (code
  fences and diagram fences alike) is exempt; its trailing backslashes are content.
- **Why this default**: The serializer emits diagram bodies through the same
  verbatim fence mechanism as code blocks; their content grammar is not markdown, so
  a trailing backslash there can only be content. Reading "code blocks" as "fenced
  verbatim blocks" is the amendment's evident intent (content preserved exactly);
  carving diagram fences out would require the cleanup to distinguish fence flavors
  for no benefit and would corrupt diagram source in diffs. Spec: FR-002/FR-003,
  SC-002(d).
