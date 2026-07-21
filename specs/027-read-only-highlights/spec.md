# Feature Specification: Read-Only Highlights — Position Math Never Writes

**Feature Branch**: `027-read-only-highlights`

**Created**: 2026-07-21

**Status**: Draft

**Input**: User description: "027-read-only-highlights: reads never write — position math for text-less blocks must not insert placeholder Y.XmlText nodes; anchor to element boundary instead"

**Design ground truth**: `design/agent-surface-mcp.md`, "Amendment (Sam, 2026-07-21) — reads never write" (commit 6bacaf7). Constitution Principles IV (Collaboration-Safe Document Operations) and VI (Design Docs Are Ground Truth) apply.

## The Problem

When an agent reads a document, Squire Docs animates a presence highlight over the content being read so human collaborators can see what the agent is looking at. Computing where that highlight goes requires a "position" into the document. Today, when the target block contains no text — an empty paragraph, an image, a horizontal rule — the position helpers **insert an empty placeholder text node into the document** to have something to anchor to.

That insertion is a real document edit: it is synced to all collaborators, **persisted to the update log, and attributed to the agent**. The observable damage from a purely read-only operation:

- Version history shows the agent as a recent author of a document it never edited.
- Per-update attribution and meaningful-change classification gain phantom agent rows.
- The no-privileged-write expectation is violated: a token/consent granting read access effectively produced a persisted write.

The same position helpers also serve the cursor sweeps that animate **mutation** operations. The design invariant this feature enforces is broader than the read path: **position math itself never writes, on any path.** Document mutation is exclusive to the actual editing operations.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reading a document leaves zero trace (Priority: P1)

An agent reads a document (whole document, or a section selected by query) that contains text-less blocks — empty paragraphs, images, horizontal rules — or is entirely empty. Afterward, the document is byte-for-byte unchanged: no new entries in the update log, no change to its version clock, and the agent does not appear anywhere in version history or attribution.

**Why this priority**: This is the bug and the invariant. Attribution and version history are product differentiators (Constitution Principle IV: "Provenance is a product invariant"); a read that writes poisons both and breaches the read/write permission boundary.

**Independent Test**: On a document containing an empty paragraph, an image, and a horizontal rule (and separately, on an empty document), record the update-log row count and version-history author set; perform a whole-document read and a query-scoped read targeting each text-less block; assert the update-log row count is unchanged, the document clock is unchanged, and the version-history author set gained no agent entry.

**Acceptance Scenarios**:

1. **Given** a document containing an empty paragraph, an image block, and a horizontal rule, **When** an agent performs a whole-document read, **Then** the document's update log gains zero rows and version history shows no agent author.
2. **Given** the same document, **When** an agent performs a query-scoped (xpath) read that targets the empty paragraph, the image, and the horizontal rule individually, **Then** the update log gains zero rows for each read.
3. **Given** a completely empty document (no blocks) or a document whose only block is text-less, **When** an agent reads it, **Then** the read succeeds, no error is surfaced to the agent, and zero updates are persisted.
4. **Given** a document a human is actively viewing in the editor, **When** an agent reads it, **Then** the human's document is not modified (no placeholder nodes appear in their editor, no "document edited" signals fire) — only the ephemeral presence highlight is visible.
5. **Given** any read of any document (with or without text-less blocks), **When** the read completes, **Then** the document clock reported by the read equals the clock before the read.

---

### User Story 2 - Text-less blocks still get a visible highlight (Priority: P2)

A human watching a document while an agent reads it still sees the reading highlight sweep over every block the agent reads — including images, horizontal rules, and empty paragraphs. The fix must not silently drop highlights for text-less blocks; instead of anchoring inside a (nonexistent) text run, the highlight anchors to the block element's own boundary and renders as a selection of that element.

**Why this priority**: The presence highlight is the product's "see what your agent is doing" feature. Regressing it to skip text-less blocks would trade one invisible bug for a visible one; the design amendment explicitly requires boundary anchoring, not omission.

**Independent Test**: On a live replica of a document containing text-less blocks, compute read-highlight positions for each block and verify every emitted position resolves to a valid absolute location under the same resolution semantics the client viewer uses (resolution returns a non-null position; none are dropped). Visually confirm in the editor that an agent read of an image/horizontal-rule/empty-paragraph block produces a visible highlight.

**Acceptance Scenarios**:

1. **Given** a document with an image block, **When** an agent reads it with a query targeting the image, **Then** viewers see a highlight covering the image block, and the emitted anchor/head positions resolve non-null on a live replica using the client's resolution semantics.
2. **Given** a whole-document read over a document mixing text blocks and text-less blocks, **When** the expanding block-highlight sweep runs, **Then** every block in the sweep — including the text-less ones — is covered by the highlight sequence with no gaps and no dropped steps.
3. **Given** an empty paragraph, **When** a highlight position is computed for it, **Then** the position anchors to the paragraph element's boundary (a collapsed or element-spanning selection at that block), not to any newly created content.

---

### User Story 3 - Mutation cursor sweeps stop inserting placeholders too (Priority: P3)

When an agent edits a document, its cursor sweep animation (the moving selection that shows the "area of work") uses the same position helpers. After this feature, those helpers are pure on every path: a mutation's cursor sweep over a text-less block no longer inserts placeholder nodes. The mutation's **actual edits** still write and are still attributed exactly as before — only the position math becomes side-effect-free.

**Why this priority**: Completes the invariant ("position math never writes, on any path") so the bug cannot resurface through the mutation path, but the attribution damage on this path is masked today by the mutation's legitimate writes, so it is lower urgency than the read path.

**Independent Test**: Perform a mutation on a document containing text-less blocks such that the cursor sweep passes over them; assert the persisted updates contain exactly the mutation's intended content changes (no placeholder text-node insertions), while the sweep animation still covers the swept blocks.

**Acceptance Scenarios**:

1. **Given** a document with an image between two paragraphs, **When** an agent mutation edits both paragraphs (sweep crosses the image), **Then** the persisted update log contains only the paragraph edits — no insertions into the image block — and the sweep highlight still visibly covers the image.
2. **Given** any mutation, **When** its cursor sweep positions are computed, **Then** computing those positions produces zero document changes beyond the mutation's own edits (verified by comparing persisted updates against the mutation's intended operations).

---

### Edge Cases

- **Empty document (zero blocks)**: whole-document read must succeed with no highlight and no write; must not throw and must not create a first block.
- **Document whose only content is text-less blocks** (e.g., three images): expanding sweep covers all blocks via boundary anchors; zero writes.
- **Nested text-less elements** (empty list item, empty blockquote, empty table cell targeted by path): boundary anchoring applies at the targeted element, not just top-level blocks; navigation into the structure never inserts nodes at any depth.
- **Offset beyond available text** (position requested past the end of a block's text): existing behavior clamps to the end of the last text run; when there is no text run at all, it now clamps to the element boundary instead of creating one.
- **Concurrent edit during a highlight sweep**: positions are relative and adjust with concurrent edits (existing behavior); a concurrent edit that empties a block mid-sweep must not cause the sweep to write.
- **Deploy-window mixed sessions**: during rollout, an old server instance may still emit old-shape positions (anchored to a placeholder node it just created) while new instances emit boundary-anchored shapes. Viewers must tolerate both. See Risks & Compatibility below — this is transient and confined to live sessions because presence positions are ephemeral (never persisted).
- **Position computation failure**: if a position for a block genuinely cannot be computed without writing, the highlight for that block is skipped (the read/mutation itself is unaffected) — failing observational, never failing into a write. The read path already treats highlight errors as non-fatal warnings; that stance is preserved.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (the invariant)**: Presence-position computation MUST be free of document side effects on every code path — read highlights, query-scoped node selections, whole-document expanding sweeps, operation selections, and mutation cursor sweeps. Position math never inserts, deletes, or modifies any document content, including placeholder text nodes.
- **FR-002 (reads are pure)**: A read operation over any document — including documents containing empty paragraphs, images, horizontal rules, other text-less elements, and completely empty documents; in both whole-document and query-scoped modes — MUST persist zero update-log rows, MUST NOT advance the document clock, and MUST NOT add the agent to version-history authorship or per-update attribution.
- **FR-003 (boundary anchoring)**: For a target element with no text content, the computed position MUST anchor to the element's own boundary within its parent structure. Placeholder text nodes are never inserted to make a position computable.
- **FR-004 (highlight fidelity)**: Boundary-anchored positions MUST resolve to valid, visible selections under the client viewer's existing position-resolution semantics: on a live replica, every emitted anchor/head position resolves non-null, and text-less blocks in a read sweep produce a visible highlight rather than being skipped.
- **FR-005 (text-path regression guard)**: Positions computed for text-bearing content MUST be byte-identical to current behavior — same serialized position values for the same inputs. Only the text-less branch changes.
- **FR-006 (mutation writes unchanged)**: Mutation operations MUST continue to persist and attribute their actual edits exactly as today. Only their sweep-position computation becomes pure; the set of persisted updates for a mutation equals its intended content changes and nothing more.
- **FR-007 (no surface changes)**: No database schema changes, no API/tool-contract changes, and no client code changes. The client's position-resolution component is explicitly unchanged by this feature.
- **FR-008 (CRDT discipline)**: The change MUST follow Constitution Principle IV: no delete-and-recreate of content, no change to structural (query-based) targeting semantics, no shift to positional targeting. Existing relative-position adjustment under concurrent edits is preserved.
- **FR-009 (fail observational)**: If a highlight position cannot be computed, the presence effect for that block is skipped with a non-fatal warning; under no circumstance does a fallback path write to the document.

### Key Entities

- **Presence position**: an ephemeral, serialized pointer into a live document used to render agent cursors/highlights. Broadcast via awareness to connected viewers; never persisted. This feature changes how it is constructed for text-less targets (element boundary instead of forced text-node interior).
- **Update log row**: the persisted, attributed record of a document change; the unit of version history and authorship. The acceptance bar for reads is zero new rows.
- **Text-less block/element**: any document element with no text runs — empty paragraph, image, horizontal rule, empty list item/blockquote/table cell, or an empty document itself.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of read operations produce zero persisted document updates, verified across a matrix of document shapes (empty doc; doc of only images/rules; mixed doc; nested empty containers) × read modes (whole-document, query-scoped).
- **SC-002**: After any read, the document's version history and recent-author list are identical to before the read — the agent never appears as an author of a document it only read.
- **SC-003**: 100% of blocks covered by a read sweep — including text-less blocks — produce a resolvable, visible highlight; zero highlight steps are dropped relative to today's behavior on text-bearing content.
- **SC-004**: For text-bearing content, computed positions are unchanged from current behavior (byte-identical serialized positions on a regression corpus).
- **SC-005**: For mutations over documents with text-less blocks, the persisted update set contains exactly the mutation's intended changes — zero placeholder insertions — while sweep coverage is visually unchanged.
- **SC-006**: The full existing presence/highlight test suite passes unchanged except where it asserted the old (buggy) placeholder-insertion behavior.

## Scope

**In scope**

- The server-side position helpers (`server/mcp/yjs/cursor-operations.js`: `createCursorPosition`, `createCursorPositionFromPath`, and everything built on them — `createNodeSelection`, `createExpandingBlockHighlights`, `createOperationSelection`, block-range selections) and their consumers' observable behavior: the read highlight path (`server/mcp/tools/read-document.js` → `agent-presence.js` `queueHighlightSequence`) and the mutation sweep path (`server/mcp/mutation-aggregator.js`, `server/mcp/sandbox/bridge.js`).
- Regression tests encoding the invariant (zero update rows after reads; pure sweeps for mutations; boundary-anchor resolvability against client resolution semantics on a live replica).

**Out of scope**

- Client changes: `client/src/components/CollaborationCursorWithSelection.js` and the viewer's position resolution are untouched.
- Any schema or API change; any change to how mutations apply or attribute their edits; any change to awareness transport or the single awareness-write gate (feature 015).
- The choice of exact position-construction mechanism (the platform offers text-node-free anchoring from a type index into the parent structure); the plan selects the construction. This spec fixes the invariant and observable outcomes only.

## Risks & Compatibility

- **Position-shape change for text-less blocks (recorded decision D-1)**: boundary anchoring changes the serialized shape of presence positions for text-less targets. Old-shape positions reference a placeholder node that new code never creates; new-shape positions are boundary-anchored. Compatibility exposure is strictly **live sessions during the deploy window**: presence positions travel only over ephemeral awareness and are never persisted, so no stored data ever contains an old shape. The client resolver already returns null (and the viewer skips rendering) for unresolvable positions, so the worst case is a transiently skipped highlight step in a mixed-version window. Accepted as-is; no compatibility shim. (RATIFIED-BY-DEFAULT — see clarifications-needed.md D-1.)
- **Silent fidelity regression**: the cheap fix (skip text-less blocks) would pass the zero-writes test while quietly degrading the presence feature. FR-004/SC-003 exist specifically to block that outcome; the live-replica resolvability assertion is mandatory, not optional.
- **Helper reuse breadth**: the helpers serve both read and mutation paths; a fix scoped only to the read path would leave the invariant violable. FR-001/FR-006 pin the full breadth.

## Assumptions

- Presence/highlight positions are transported exclusively via ephemeral awareness state and are never persisted with the document; therefore no data migration or backfill is needed for old-shape positions. (Verified against the presence implementation and design doc.)
- The client viewer's existing resolution semantics can resolve an element-boundary-anchored position to a renderable selection without client changes (the platform's relative-position model supports anchoring at a type index within a parent). The plan phase validates the exact construction against the live resolver; FR-004's replica test is the guard.
- The read path's existing non-fatal handling of highlight errors (warn and continue) is the intended behavior and is retained (FR-009).
- Existing update-log/version-history query surfaces are sufficient to assert "zero new rows / no new author" in tests; no new observability is required.
- Fixing the two insertion sites in the shared helpers covers all consumers (read highlights, node selections, expanding sweeps, operation selections, mutation sweeps) because all position construction flows through them; the plan phase confirms no other call site constructs positions by mutating the tree.
