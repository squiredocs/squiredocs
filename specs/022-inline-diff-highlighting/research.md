# Phase 0 Research — Word-Level Two-Tier Inline Diff Highlighting

All "unknowns" for this feature were pre-resolved by two Sam-ratified design amendments
(2026-07-19) and an approved implementation plan whose mechanics were validated against
the working tree. This file records the decisions, rationale, and alternatives so the
plan carries no NEEDS CLARIFICATION markers. Each item cross-references the ledger
(`clarifications-needed.md`) where it is an RBD default.

## D1 — Word-segmentation library and granularity

- **Decision**: Use `diffWordsWithSpace(before, after)` from the already-installed
  `diff` (jsdiff) `^8.0.4`. Segmentation is word-level and whitespace-preserving.
- **Rationale**: This is a prose/document app; whitespace edits are real edits and must
  surface (RBD-1). jsdiff already powers both existing diffs (`diffLines`), so no new
  dependency and no new performance budget. Design ground truth pins this exact variant.
- **Alternatives considered**: `diffWords` (collapses whitespace — hides real edits);
  char-level `diffChars` (too noisy for prose); a bespoke tokenizer (reinvents jsdiff,
  and violates "single source of truth" if the two surfaces tokenize differently).

## D2 — One shared helper vs. per-surface tokenization

- **Decision**: A single `shared/diff/word-diff.js` exporting
  `computeWordSegments(before, after)` returns `{ before: [{text,changed}], after:
  [{text,changed}] }`; unchanged runs are emitted to both sides; adjacent same-`changed`
  segments are coalesced. Both surfaces consume it; neither implements its own tokenizer.
- **Rationale**: FR-001 / SC-003 parity — the two surfaces can never disagree about what
  "the changed words" are. Constitution: shared client/server logic belongs under
  `shared/`. The chat path consumes literal text segments; the history path consumes the
  same segments as character ranges over the parser's plain text.
- **Alternatives considered**: Two independent implementations (current codebase state) —
  rejected: guaranteed drift, doubles the test surface, defeats SC-003.

## D3 — History refinement: post-process PM JSON, not the parser

- **Decision**: Leave `shared/markdown/strict-parser.js` untouched (CN-2 freeze). Refine
  a replace region by: parse both sides UNMARKED (`markdownToPm(md, null)`), concatenate
  each side's text-node text (blocks joined by `'\n'`), `computeWordSegments` on the
  plain text, walk PM text nodes tracking a char offset, split nodes at segment
  boundaries, stamp `diffDeleteWord`/`diffInsertWord` on changed ranges and
  `diffDelete`/`diffInsert` elsewhere — preserving each node's existing formatting marks.
  New helper `server/diff/apply-word-marks.js`.
- **Rationale**: The parser is characterization-frozen (CN-2, pinned by the amendment).
  Because refinement word-diffs the exact plain text the parser emitted, char offsets
  between the segment stream and the text nodes align by construction; the inter-block
  `'\n'` belongs to no text node and is skipped by the offset walk (spec Assumptions).
- **Alternatives considered**: Teaching the parser word ranges (violates CN-2); mapping
  markdown source ↔ nodes (fragile, unnecessary — we own the emitted plain text).

## D4 — Chat refinement: hook the existing pairing pass

- **Decision**: In `postProcessDiffLines`' non-format-only paired `-`/`+` branch, pair
  del/add lines by index up to `min(delCount, addCount)`, `computeWordSegments` on each
  pair's prefix-stripped text, and record results in `inlineSegments` keyed by the OUTPUT
  line index (the `result` array index — same keying discipline as `formatAnnotations`).
  Thread through `computeChatDiff`, including filtering keys `< MAX_DIFF_LINES` on the
  `truncatedByServer` branch (mirroring `formatAnnotations`).
- **Rationale**: The pairing already exists for format-only detection — natural hook,
  minimal new machinery. Output-index keying matches `formatAnnotations` so the client
  and truncation filter treat both fields identically.
- **Alternatives considered**: Re-diffing on the client (introduces a client-side diff
  dependency, breaks server-side-only invariant, defeats SC-003).

## D5 — Two-tier visual without mark nesting

- **Decision**: In a refined region every text range carries EXACTLY ONE diff-tier mark —
  unchanged words keep subtle `diffInsert`/`diffDelete`, changed words get strong
  `diffInsertWord`/`diffDeleteWord`. Rendered `<ins class="diff-word">`/`<del
  class="diff-word">`. Strong colors come from NEW tokens
  `--canvas-diff-add-bg-strong`/`--canvas-diff-del-bg-strong` (history) and the existing
  `--success`/`--danger` families at moderate alpha (chat) — no new hue.
- **Rationale**: FR-010/FR-013 — tiers never nest, so the whole line still reads
  inserted/removed while changed words pop. Deriving from existing theme-aware families
  guarantees light + every dark variant work.
- **Alternatives considered**: Nesting strong mark inside subtle mark (double-tint,
  ambiguous CSS cascade); a brand-new hue (fails "no new hue", risks theme drift).

## D6 — Failure posture (RBD-3) and cache coherency

- **Decision**: Refinement is best-effort / fail-open per pair (chat) or region
  (history): any error degrades that unit to today's line-level presentation, at most a
  server log line, never fails the diff request / tool call / chat message / edit, never
  caches an error result. Bump `CACHE_VERSION` v7→v8 so no stale line-level diff is
  served post-ship; update the characterization assertion to `'v8'`.
- **Rationale**: Word emphasis is presentation over an already-correct diff — never
  regress below today's floor (RBD-3, matches 020's diff-decoration posture). The cache
  bump is part of the feature, not a deploy afterthought (FR-011).
- **Alternatives considered**: Fail-closed (500s / broken cards) — trades a cosmetic loss
  for a functional outage; leaving cache at v7 — serves stale line-level diffs.

## D7 — Deferred / not-in-scope (recorded to prevent scope creep)

- **No similarity threshold in v1** (RBD-2): fully-rewritten lines render all-strong;
  honest and near-equivalent to today's whole-line treatment. Easy to add later behind
  the shared helper.
- **No block-type carve-outs** (RBD-4): headings, list items, code blocks, table cells
  are all refined uniformly; `diffWordsWithSpace` is whitespace-preserving so indentation
  changes surface honestly.
- **Legacy `ychange` path** (`client/src/extensions/YChangeExtension.js`) is unused by
  `VersionPreview` — untouched.
- **No new limits**: the existing chat-diff size caps (50,000 chars / 200 lines) are
  reused; `inlineSegments` is filtered to survivors on truncation, not given its own cap.
