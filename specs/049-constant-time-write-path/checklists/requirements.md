# Specification Quality Checklist: Constant-Time Server-Side Write Path

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-03
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

## Feature-specific gates (added for 049)

- [x] The borrowing mechanism is specified with the collision check and the restore-in-`finally` (FR-001, FR-002)
- [x] The two-phase signature is a first-class requirement, not a footnote, and states what the mutate phase may and may not do (FR-003)
- [x] The open verification is specified as **blocking**, with the settled part, the still-owed part, and an explicit stop-the-line rule (FR-008, DEC-049-7)
- [x] The identity cache is separately testable, with clock-from-the-document's-own-store and random-per-process both required (FR-006, US3)
- [x] What 049 deletes is enumerated (FR-009); what it must not change is enumerated (FR-010)
- [x] The yjs-upgrade caveat carries a guard test that fails loudly (FR-012)
- [x] Every 048 invariant guard is either kept or consciously re-pointed, none dropped (FR-011)
- [x] Every decision taken without the maintainer is recorded as RATIFIED-BY-DEFAULT (`clarifications-needed.md` §A)
- [x] Every design-doc silence is flagged rather than resolved ad hoc (`clarifications-needed.md` §D)
- [x] Every codebase contradiction of the design section is reported, not designed around (`clarifications-needed.md` §E)

## Notes

**Validation iteration 1 — findings and resolutions.**

1. *"No implementation details"* is applied here in the sense this project's
   design contract uses. `design/collaboration-core.md` is ground truth and is
   itself mechanism-level (it names `doc.clientID`, `doc.store.clients`,
   `updateDocument`, and the six call sites), and Principle VI makes that text
   binding. A 049 spec that abstracted away "the borrowed client id" would not
   be specifying the ratified feature. The spec therefore names mechanism where
   the design does, and stays out of **how** it is coded — the signature shape,
   the cache's data structure, the eviction policy, and the detection
   implementation are all explicitly deferred to plan. Same precedent as
   `specs/048-per-identity-server-docs/spec.md`.

2. *"Written for non-technical stakeholders"* — each user story leads with the
   user-visible consequence (a write on a big document is slow; a failed write
   could leave half an edit; the handshake grows forever; the mechanism could
   break silently on an upgrade) before any mechanism appears. Same reading as 048.

3. Initial draft treated the spec-phase library sweep as satisfying the open
   verification. **Corrected**: FR-008 now states the sweep is *evidence, not
   discharge*, and the implementer still performs and records the verification.
   A spec-phase source read is not an implementation-phase proof, and the design
   doc's standard for this feature is explicitly "verified, not assumed".

4. Initial draft carried the design's "no better and no worse" residual claim
   forward unexamined. **Corrected**: reading `yjs.cjs:3379-3381` showed yjs
   self-heals its own client id on a detected collision and a cached borrowed id
   gets no such protection. Added FR-007 (the required analogue) and recorded the
   design-doc gap as D-049-A.

5. Initial draft did not bound the identity cache. **Corrected**: FR-006 requires
   it to be bounded, evictable, and released with the document, with the
   asymmetry that makes eviction safe recorded in RBD-049-4.

All items pass as of iteration 1 (two corrections applied in place). No
[NEEDS CLARIFICATION] markers were emitted; every open question was resolvable
from the design doc or the codebase, and each default is recorded in
`clarifications-needed.md`.
