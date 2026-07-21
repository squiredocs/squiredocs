# Feature Specification: Clean Hard-Break Rendering in Transcript Diffs

**Feature Branch**: `028-clean-diff-hard-breaks`

**Created**: 2026-07-21

**Status**: Draft

**Input**: User description: "028-clean-diff-hard-breaks: remove hard-break markers (trailing backslash) from chat transcript inline diffs at generation time"

**Design ground truth**:

- `design/in-app-ai-assistant.md` → **Amendment (Sam, 2026-07-21) — hard-break markers never render in transcript diffs (feature 028)** (commit 19887fa). The amendment pins: the transcript diff is built from canonical markdown, where a hard line break serializes as a trailing backslash — serialization syntax, not content; diff lines rendered in the transcript (modify and undo/redo cards alike) present a hard break as the line break it already is; the marker is removed where the diff payload is generated (server post-processing, keyed on block context — never by client substring stripping); a genuine backslash in content or code blocks is preserved exactly; legacy persisted tool-part payloads predate the fix and may retain the marker — accepted, consistent with the additive-payload convention (022); the version-history diff is unaffected by construction (it rebuilds an annotated document where hardBreak renders as a real break).

## Overview

Observed by Sam on 2026-07-21: a poem edited by the assistant rendered in the chat transcript's inline diff with a literal `\` at the end of every hard-broken line (e.g. `That is the whole job.\`). The diff payload is computed from the canonical markdown serialization of the document, in which a hard line break (a ProseMirror `hardBreak`) is emitted as the markdown hard-break marker — a backslash immediately before the newline. The transcript diff renderer shows the serialized lines verbatim, so the marker leaks into the UI as if it were document text.

This feature removes the marker at diff-payload **generation time**, on the server, keyed on block context derived from the canonical serialization's own grammar:

- Inside paragraph-like blocks (paragraphs, list items, task items, blockquote paragraphs), every internal line break comes from a hard break and always carries the marker — those trailing backslashes are serialization syntax and are removed.
- Inside fenced blocks (code blocks and diagram fences), a trailing backslash is document content and is preserved exactly.
- A backslash that the grammar says is literal content — including one at the very end of a paragraph — is preserved exactly.

Because both diff-producing card types (modify, and the shared undo/redo handler from 020) build their payload through one shared generation path, fixing that single point covers both by construction. Word-level inline segments (022) are computed from the same line text after cleanup, so segments can never contain the phantom marker and old/new pairing stays consistent. No client change is required; legacy persisted payloads keep their markers and render exactly as they do today. The version-history diff pipeline is a separate code path and is untouched.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hard-broken prose renders clean in modify-card diffs (Priority: P1)

Sam asks the assistant to edit a poem whose stanza lines are separated by hard breaks. The modify card's "Changes" diff shows each stanza line as its own diff row — with no trailing `\` on any removed, added, or context row. The diff reads exactly like the document does in the editor.

**Why this priority**: This is the reported bug (Sam's 2026-07-21 screenshot) and the most common surface — every assistant edit of hard-broken content renders one of these diffs. Fixing the shared generation path is the whole feature; everything else is protection.

**Independent Test**: In the chat, ask the assistant to modify a document containing a multi-line hard-broken paragraph (a poem stanza). The modify card's diff shows the affected lines with no trailing backslash on any row, while line tints, gutter numbers, hunk separators, and word-level highlights all behave as today.

**Acceptance Scenarios**:

1. **Given** a document with a paragraph containing hard breaks (poem stanza), **When** the assistant modifies one stanza line and the tool card renders its diff, **Then** no removed, added, or context row ends with a backslash that was a hard-break marker, and the diff otherwise renders as today (row tint, prefix, gutter numbering, hunk separators).
2. **Given** a hard-broken paragraph inside a list item or blockquote (continuation lines carry the list indent or `> ` prefix in the serialization), **When** a diff touching those lines renders, **Then** their hard-break markers are removed the same way.
3. **Given** a changed pair of hard-broken lines, **When** word-level highlighting (022) renders, **Then** no word segment on either side contains the marker, segments rejoin exactly to the row's rendered text, and the trailing marker never appears as a phantom changed word.
4. **Given** a formatting-only change on a hard-broken line, **When** the diff renders its annotated pair, **Then** format-only detection and its annotation behave exactly as today, on the cleaned line text.

---

### User Story 2 - Undo and redo cards get the identical treatment (Priority: P2)

Sam undoes the poem edit. The undo card's diff — computed from the pre/post states of the applied inverse (020) — shows the same clean, marker-free lines as the modify card did.

**Why this priority**: The amendment pins "modify and undo/redo cards alike". Both card types build their payload through one shared diff-generation path, so this story is delivered by construction — but it must be verified, not assumed.

**Independent Test**: After a modify touching hard-broken content, press Undo (or invoke the undo tool). The undo card's diff shows the reverted lines with no trailing hard-break backslashes.

**Acceptance Scenarios**:

1. **Given** a successful undo (or redo) of an edit to hard-broken content whose card carries a diff, **When** the card renders, **Then** its diff lines are free of hard-break markers exactly as modify cards are.
2. **Given** the undo/redo diff generation path, **When** the payload is produced, **Then** it flows through the same generation-time cleanup as modify — there is no second, divergent implementation.

---

### User Story 3 - Genuine backslashes and everything else are untouched (Priority: P3)

Nothing that is not a hard-break marker changes: backslashes that are document content (in code blocks, diagram fences, or literally at the end of a paragraph) still render exactly; chats persisted before the feature render exactly as they always did; the version-history diff is byte-identical to today.

**Why this priority**: Pure protection — the amendment's "preserved exactly" clause is what separates a correct grammar-keyed fix from a lossy substring hack. It converts the fix from "works on the screenshot" to "shippable".

**Independent Test**: Modify a code block whose content includes a line ending in `\`; the diff shows that backslash. Open a pre-feature chat with a hard-broken diff; it renders with its markers, unchanged. Open Version History on a hard-broken document; the diff preview is unchanged.

**Acceptance Scenarios**:

1. **Given** a fenced code block (or mermaid/svg diagram fence) containing a line that ends in a backslash, **When** a diff touching that block renders, **Then** the trailing backslash is preserved exactly — fence content is never treated as hard-break syntax.
2. **Given** a paragraph whose text legitimately ends with a literal backslash (the serialized block's final line ends in `\` with no continuation line), **When** a diff touching it renders, **Then** the backslash is preserved (per the serializer's grammar, a hard break requires a following line in the same block — a block-final trailing backslash is content).
3. **Given** a persisted tool part created before this feature (its diff lines contain markers), **When** its chat re-renders, **Then** it renders exactly as before the feature — markers and all, no client-side stripping, no errors.
4. **Given** a document with hard breaks viewed in Version History with highlighting on, **When** the diff preview renders, **Then** its output is identical to today — the version-history pipeline shares no changed code.

### Edge Cases

- **Line ending in a double backslash with a continuation line** (a literal content backslash immediately followed by a hard break): exactly one trailing backslash — the marker, which the serializer always emits last — is removed; the literal backslash stays.
- **Hard break as the last child of a paragraph / literal backslash at paragraph end**: both serialize to a block-final line ending in `\` with no continuation — indistinguishable in the serialized form. Resolved by the grammar: a hard break requires a following line in the same block, so a block-final trailing backslash is preserved as content (RBD-1; matches how the markdown re-parses).
- **Headings and table cells**: the canonical serializer never emits the trailing-backslash form there (hard breaks become `<br>` to keep the block one line); the cleanup must not touch `<br>` or otherwise alter those lines.
- **Blockquote and list continuation lines**: in the serialization, hard-break continuation lines carry their container prefix (`> `, or the list content-column indent). Same-block continuation detection must account for those prefixes so markers inside quoted/listed paragraphs are removed.
- **Fence state across the whole document**: whether a line is inside a fenced block is determined from the full serialized document, never guessed from a windowed hunk — a diff hunk that starts mid-code-block must still know it is inside the fence (RBD-2).
- **Context lines**: unchanged context rows around a change render in the transcript too; they must be cleaned the same as `-`/`+` rows (the amendment covers "diff lines rendered in the transcript", not only changed ones).
- **Format-only pair detection and truncation**: format-only comparison, annotations, size caps, and truncation filtering all operate on the cleaned lines consistently — no behavior change beyond marker removal.
- **Gutter line numbers**: cleanup removes characters, never lines, so line counts and hunk start numbers still match the document's serialized line structure.
- **A diff whose only visible change involves hard-break structure** (e.g. a hard break replaced by a paragraph split): still shows as a line-structure change on the cleaned text — cleanup cannot make a real change invisible, because the marker's newline itself survives.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Hard-break markers MUST be removed from transcript diff payloads at generation time, on the server. No rendered diff row — removed, added, or context — may end with a backslash that the canonical serialization emitted as a hard-break marker. The client MUST NOT perform any marker stripping.
- **FR-002**: Marker identification MUST follow the canonical serializer's grammar, not substring heuristics. A trailing backslash on a serialized line is a hard-break marker if and only if (a) the line lies outside every fenced block (code blocks and diagram fences), and (b) the line has a continuation line within the same paragraph-like block — because inline text in the canonical serialization contains no literal newlines, every internal line break of a paragraph-like block is a hard break and always carries the marker. Exactly one trailing backslash is removed from a qualifying line; no other character of any line is altered.
- **FR-003**: A trailing backslash that fails the FR-002 test MUST be preserved exactly: content inside fenced code and diagram blocks, a block-final trailing backslash (literal content or trailing hard break — grammar-ambiguous, preserved per RBD-1), and any backslash not at end of line. Lines where the serializer already renders hard breaks as `<br>` (headings, table cells) MUST pass through unchanged.
- **FR-004**: Cleanup MUST be applied to both full serialized documents (before and after) prior to line comparison and word segmentation (RBD-2), so that: fence state is derived from complete documents, context lines are clean, a line pair differing only by markers never shows as a change, word-level segments (022) are computed from the cleaned text and rejoin byte-identically to the rendered row, and format-only detection compares cleaned text on both sides.
- **FR-005**: Both diff-producing card types — modify, and the shared undo/redo handler (020) — MUST emit cleaned payloads. The cleanup lives at their single shared generation point so no producer can bypass it.
- **FR-006**: All other diff payload semantics MUST be unchanged: line prefixes, hunk starts and gutter numbering, hunk separators, formatting-only annotations, word-level inline segments' additive contract, size caps, and truncation filtering keep their exact existing meanings. Cleanup changes characters within lines only, never the number of lines.
- **FR-007**: Legacy persisted tool-part payloads MUST render exactly as they do today, markers included — no migration, no client-side compensation (additive-payload convention, 022). No client rendering change is required by this feature.
- **FR-008**: The canonical markdown serializer MUST NOT change — its hard-break emission is load-bearing for export, round-trip, and sync source maps. The version-history diff pipeline and the shared word-segmentation helper MUST NOT change; version-history diff output remains byte-identical.

### Key Entities

- **Hard-break marker**: the backslash the canonical serializer emits immediately before a newline to represent a `hardBreak` inside paragraph-like inline content — serialization syntax, never document text.
- **Paragraph-like block**: a serialized block whose internal line breaks can only be hard breaks (paragraphs, list/task-item paragraphs, blockquote paragraphs) — the only context where the marker form appears.
- **Fenced block**: a code block or diagram fence in the serialization; its lines are verbatim content and exempt from marker removal.
- **Cleaned diff input**: a full canonical serialization with all and only its hard-break markers removed; the text both the line diff and the word segmentation consume.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The screenshot scenario renders clean: a modify diff over a hard-broken poem stanza shows zero trailing backslashes on its removed, added, and context rows, while the same edit's line tints, gutter numbers, and word highlights are unchanged from today.
- **SC-002**: The regression matrix passes — for each of: (a) hard-broken paragraphs, (b) hard breaks inside list items and blockquotes, (c) a code block containing a line that ends in a backslash, (d) a diagram fence containing a trailing-backslash line, (e) a paragraph whose text ends in a literal backslash, (f) a line ending in double backslash followed by a hard-break continuation, (g) mixed hunks combining several of the above — the diff removes exactly the markers and preserves every content backslash exactly.
- **SC-003**: Undo and redo cards over hard-broken content render marker-free identically to modify cards (single generation point, verified by test).
- **SC-004**: No word-level segment produced for any diff contains a hard-break marker, and each row's segments concatenate exactly to that row's rendered text.
- **SC-005**: A chat persisted before the feature renders its diffs byte-identically to today (markers present), with no errors and no client code change.
- **SC-006**: The version-history diff for a hard-broken document is byte-identical before and after the feature.
- **SC-007**: All existing diff-generation test suites pass unchanged in meaning, and the new coverage extends the existing diff post-processing suites following their established patterns.

## Dependencies & Sequencing

- **Design ground truth first**: the 2026-07-21 amendment is exported to `design/` (commit 19887fa, RATIFIED); this spec converges to it and cites it rather than re-deciding.
- **Feature 020 (undo/redo diffs)** is merged substrate: undo/redo cards share modify's diff generation path, which is why one fix point covers both card types.
- **Feature 022 (word-level highlighting)** is merged substrate: its segments are computed inside the same generation pass from the same line text, which is why cleanup ordered before segmentation keeps segments consistent by construction; its additive-payload convention is the precedent for leaving legacy payloads untouched.
- **No migrations, no new dependencies, no client changes, no payload shape changes** — the fix alters the text content of generated payloads only.
- **Concurrent work**: feature 027 (read-only highlights) is being implemented in parallel and owns unrelated files; this feature touches only the chat diff generation pipeline and its tests, which are disjoint from 027's surface.

## Assumptions

- The canonical serializer does not escape literal backslashes in inline text (verified in the current serializer) — the FR-002 grammar rule depends on this; if backslash escaping is ever introduced there, the rule must be revisited in the same change.
- Inline text in the document model contains no literal newlines (a schema invariant): within a paragraph-like block, the only source of an internal serialized newline is a hard break. This is what makes FR-002's continuation test exact rather than heuristic.
- Headings and table cells never emit the trailing-backslash form (verified: the serializer substitutes `<br>` in both), so no special handling beyond leaving those lines alone is needed.
- Both diff inputs are always full canonical serializations of the document (verified for both the modify path and the inverse-application path), so full-document fence tracking at generation time is always possible.
- The transcript renderer is the only consumer that displays these lines; external MCP clients reading modify/undo/redo results receive the same cleaned lines and are expected to treat them as the display text they already are (same posture as 020/022 payload evolutions).
