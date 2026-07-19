# Specification Quality Checklist: Word-Level Two-Tier Inline Diff Highlighting

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-19
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- "No implementation details" is passed in the sense this project's constitution and
  pipeline use it: the observable contract of this feature includes payload shape
  (`inlineSegments` as an additive field consumed by the chat client and ignorable by
  external MCP agents), document marks (`diffInsertWord`/`diffDeleteWord`, part of the
  shared schema — pinned by name in the design ground truth's schema marks list), and
  the cache-version bump (a correctness requirement, pinned by the amendment). Named
  mechanics beyond that (helper shape, file locations, CSS tokens) appear only in
  ground-truth/plan citations and the ledger, matching the house style of specs
  016–020; the FRs pin behavior, contract, and honesty properties, not code structure.
- No [NEEDS CLARIFICATION] markers: this feature runs with no user interaction; every
  decision the two design amendments and the approved plan did not pin was taken with
  a best default and recorded as RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
  in `../clarifications-needed.md` (RBD-1 … RBD-4).
- Current-state claims verified against the working tree on 2026-07-19:
  `computeChatDiff` → `postProcessDiffLines` pairs `-`/`+` blocks and filters
  `formatAnnotations` on the truncation branch (limits 50,000 chars / 200 lines);
  `DiffView` renders `{entry.line}` as a flat string and is shared by modify and
  undo/redo cards (020 merged — `undo-service.js` calls `computeChatDiff`);
  `computeMarkdownDiff` stamps `diffInsert`/`diffDelete` per `diffLines` part via
  `markdownToPm(..., { strict: true })` with `CACHE_VERSION = 'v7'`; `VersionPreview`
  renders the marks as `ins`/`del` styled off `--canvas-diff-add-bg`/`--canvas-diff-del-bg`;
  jsdiff `^8.0.4` is already a dependency.
- Scope bounds: additive on both surfaces — one payload field with client fallback, two
  service-only marks plus a cache bump; no migrations, no new dependencies, no new
  limits, frozen parser untouched (CN-2), legacy ychange path explicitly out of scope.
- Validation iteration 1: all items pass; no spec revisions were required beyond the
  initial draft.
