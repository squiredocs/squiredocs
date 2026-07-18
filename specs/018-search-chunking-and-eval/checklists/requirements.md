# Specification Quality Checklist: Structure-Aware Search Chunking, Selective Contextual Preambles, and a First-Class Evaluation Harness

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-18
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — *see note 1 for the ratified-mechanism and current-code-fact exceptions*
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — *all open decisions resolved as RATIFIED-BY-DEFAULT in `../clarifications-needed.md` (RBD-1…RBD-8) per Constitution Principle VI*
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details) — *see note 1*
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification — *see note 1*

## Notes

1. **Ratified-mechanism and current-code-fact exceptions.** The spec names concrete
   mechanisms in exactly two situations, both deliberate:
   - **Design-pinned mechanisms**: heading-boundary ~600-token chunks with
     `heading_path`, preambles embedded + keyword-indexed with the chunk, the 017
     content-hash gate, doc-level RRF roll-up, the metric set
     (Recall@k/MRR/nDCG/recall@token-budget), the npm-script entry point, migration
     slot `1798000000000`, and the reference-only status of `rag-search-v2`. These are
     Sam-ratified in `design/content-search.md` (feature-018 amendment) or fixed
     repository constraints — the spec cites them as requirements because the design
     doc is ground truth (Constitution VI), not because the spec chose them.
   - **Current-code facts**: references to `server/search-indexer.js:64-72`
     (the fixed-window chunker being replaced), the saturated draft-set eval result,
     and the ~5.7 s/query reranker finding describe the verified present state that
     motivates the feature, not prescribed implementation.
   Genuinely open mechanics (chunk storage layout, keyword-index topology, exact
   chunker internals beyond the pinned semantics) are explicitly delegated to plan
   (RBD-1, RBD-2, RBD-8).
2. **Validation iteration 1 (2026-07-18)**: initial draft passed all items; the
   preamble-display question (could generated text surface in snippets?) was caught
   during self-review and resolved as RBD-3 + FR-018/SC-005 rather than left implicit.
   No [NEEDS CLARIFICATION] markers were ever emitted — the pre-authorized
   RATIFIED-BY-DEFAULT path was used per the pipeline overrides (no user interaction).
3. **Traceability spot-check**: every ratified pin in the design amendment maps to at
   least one FR (chunking → FR-001/002; selective preambles → FR-012/014; hash scope →
   FR-015; frozen contracts → FR-019; harness/metrics/curated set → FR-023/024/027/028;
   build-now decision → FR-029; reranker default → FR-030); every FR maps to a user
   story or edge case; SC-001…SC-012 cover the caller-required criteria (determinism,
   preambles-iff-multi-chunk, zero shape change, one-command eval, discrimination,
   published before/after) plus authorization and rollout safety.
