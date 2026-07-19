# Clarifications Ledger — 022-inline-diff-highlighting

Decisions the design amendments did not answer were taken with the best default and
recorded here as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)**.

Decisions already made are Sam-ratified 2026-07-19 and are cited in the spec, not
re-decided:

- **By the design amendments** (`design/document-model-format-pipeline.md` "Version
  diffs" + schema marks list; `design/in-app-ai-assistant.md`): word-level granularity
  via `diffWordsWithSpace` (whitespace-preserving); two-tier GitHub-style visual (keep
  the subtle line/row tint, layer a stronger highlight on changed words); both surfaces
  in one feature; one shared segmentation helper; replace-region refinement as
  post-processing over the frozen strict parser's output (parser untouched, CN-2);
  graceful degradation to line-level when a region doesn't align; strong marks
  `diffInsertWord`/`diffDeleteWord` produced only by the diff service, never by user
  editing; diff cache version v7→v8; chat payload field `inlineSegments` is additive
  with pre-feature persisted tool parts rendering exactly as before; unpaired
  wholly-added/removed chat lines carry no word emphasis.
- **By the approved implementation plan**
  (`/root/.claude/plans/i-d-like-to-add-warm-feigenbaum.md`): helper shape
  (`computeWordSegments(before, after)` → per-side `{ text, changed }` segments,
  unchanged runs emitted to both sides, adjacent same-flag coalescing); chat pairing by
  index up to `min(delCount, addCount)` inside the existing non-format-only paired
  block; `inlineSegments` keyed by output line index and filtered on the
  `truncatedByServer` branch; DiffView renders changed segments as `.ai-diff-word`
  spans with a plain-string fallback; history refinement parses both sides unmarked,
  word-diffs the concatenated plain text, splits text nodes preserving existing
  formatting marks; new marks registered in `shared/prosemirror-schema.js` and
  `client/src/extensions/editorExtensions.js`, rendered as `ins.diff-word`/
  `del.diff-word`; strong tokens `--canvas-diff-add-bg-strong`/
  `--canvas-diff-del-bg-strong` in light + every dark block, chat styling off the
  existing `--success`/`--danger` families; `CACHE_VERSION` assertion update in the
  characterization test; legacy ychange path out of scope.

---

## RBD-1: Whitespace-only changed segments get the strong highlight, unspecial-cased

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: `diffWordsWithSpace` reports whitespace runs as segments, so a
  whitespace-only edit (double space → single space, trailing-space removal within a
  line) yields changed segments containing only whitespace. Should those render with
  the strong highlight, or be suppressed as visual noise?
- **Decision**: Render them exactly like any other changed segment — strong background
  highlight on the whitespace run, both surfaces. No suppression, no minimum-content
  filter.
- **Why this default**: Sam explicitly chose the whitespace-preserving variant because
  this is a prose app where whitespace edits are real edits. A background highlight is
  the only way an invisible character change becomes visible at all — suppressing it
  would reintroduce exactly the "scan both lines and guess" problem the feature exists
  to fix. It is also the zero-special-case option: any filter would need its own rules
  (leading? trailing? tabs?) and would make the two surfaces' honesty depend on
  heuristics. Spec: Edge Cases + FR-001.

## RBD-2: No similarity threshold — refinement always applies to paired/replace content

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: When a paired line (chat) or replace region (history) is almost
  completely rewritten, word refinement marks nearly everything as changed, so the
  strong highlight covers essentially the whole line. GitHub-class tools sometimes
  suppress intra-line refinement below a similarity threshold. Should v1 include such
  a threshold?
- **Decision**: No threshold in v1. Segmentation output is rendered as computed: a
  fully rewritten line renders all-strong over its row tint.
- **Why this default**: An all-strong line is honest ("everything here changed") and
  visually near-equivalent to today's whole-line treatment — mildly redundant, never
  misleading. A threshold is a tuning knob with no ratified value, would create
  same-diff inconsistency (some pairs refined, some not, for reasons invisible to the
  reader), and both amendments describe refinement as unconditional for paired/replace
  content. The graceful-degradation clause in the pipeline amendment covers
  *structural* misalignment, not "too many words changed". Easy to add later behind
  the shared helper if real diffs prove noisy. Spec: Edge Cases + FR-002/FR-007.

## RBD-3: Refinement is best-effort and fail-open on both surfaces

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: The amendments pin graceful degradation for non-aligning history
  regions but do not state the general failure posture: what happens if segmentation,
  node splitting, or offset walking throws — on either surface?
- **Decision**: Strictly best-effort, fail-open, per pair/region: any refinement error
  degrades that pair (chat) or region (history) to today's line-level presentation —
  segments omitted, subtle marks only — with at most a server log line. A refinement
  failure never fails the version-diff request, the tool call, the chat message, or
  the underlying edit, and never poisons the cache with an error result.
- **Why this default**: Word emphasis is presentation on top of an already-correct
  diff; the never-worse-than-today floor is exactly the degradation posture the
  pipeline amendment establishes for misalignment, extended to faults. It matches the
  project's precedent that diff decoration must never block the durable operation
  (020's RBD-3 for undo diffs). Fail-closed alternatives (500s, broken cards) would
  trade a cosmetic loss for a functional outage. Spec: FR-012, SC-008.

## RBD-4: No block-type carve-outs — refinement applies uniformly in v1

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: A history replace region can contain non-prose blocks (headings, list
  items, code blocks, table cells); chat paired lines can be markdown of any block
  kind. Should any block type (most plausibly code blocks, where word-diff semantics
  are debatable) be excluded from word refinement in v1?
- **Decision**: No carve-outs. Every text node in a replace region and every
  non-format-only paired chat line is refined the same way, regardless of block type.
- **Why this default**: The amendments state the mechanism generically with no
  exclusion list, and `diffWordsWithSpace` behaves acceptably on code-ish text (it is
  whitespace-preserving, so indentation changes surface honestly). A carve-out would
  add a block-type dispatch to both paths and make identical text diff differently
  depending on its container — more machinery for a speculative aesthetic concern in a
  prose-first product. If code-block refinement proves noisy in practice, excluding it
  later is a small, additive change at the refinement layer. Spec: Edge Cases.

## RBD-5: Word-diff perf guardrails — 20,000 chars/side cap + 250ms jsdiff timeout

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19) — values await
  Sam's ratification
- **Question**: What ceiling should bound the synchronous word-diff so a huge
  replace region (whole-doc rewrite, giant single-line paragraph) cannot block
  the Node event loop? (Raised as the HIGH finding in the 2026-07-19 post-merge
  review; the ratified decisions set no perf ceiling — a spec gap, not a
  contradiction.)
- **Why it matters**: Myers word-diff is O(N·D) and synchronous; two ~300KB
  mostly-dissimilar sides could stall every request for seconds to minutes. The
  pre-022 line-level diff was orders of magnitude cheaper on the same input.
- **Decision**: `computeWordSegments` returns `null` when either side exceeds
  `MAX_SIDE_CHARS = 20000` or jsdiff's `timeout: 250` (ms) fires; both callers
  degrade to the line-level presentation silently (expected degradation under
  RBD-3, not an error). Rationale: beyond ~20k chars a side, word emphasis has
  no skim value (a rewrite reads as all-strong anyway), so nothing of value is
  lost; 250ms bounds the worst case per region/pair while never firing on
  realistic prose. Constants exported from `shared/diff/word-diff.js` for
  test pinning and easy tuning.
