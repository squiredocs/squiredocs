# Specification Quality Checklist: IaC & Config Management — Dedicated Hardened Cluster

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-15
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — *qualified: the deliverable of this feature IS infrastructure configuration, so the named technologies (OpenTofu, Kustomize, SOPS/age, k3s flags, AWS resources) are the product surface mandated verbatim by the design doc (d20917e), not leaked implementation choices. No application-code implementation details are present.*
- [x] Focused on user value and business needs — user = the operator; value = reproducible, hardened, auditable, reversible migration
- [x] Written for non-technical stakeholders — *as far as the domain allows; each story leads with the operator-value framing*
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — 0 markers; all open decisions resolved as RATIFIED-BY-DEFAULT (RD-1..RD-14) and flagged gaps (G1–G3) in `clarifications-needed.md` per Constitution Principle VI
- [x] Requirements are testable and unambiguous — FR-001..FR-024, each verifiable by render/validate/review
- [x] Success criteria are measurable — SC-001..SC-008 (counts, exit codes, 100%/0 assertions)
- [x] Success criteria are technology-agnostic (no implementation details) — *qualified as above: criteria measure properties of the authored configuration (renders succeed, 0 plaintext secrets, 5/5 hardening properties), which is the feature's product*
- [x] All acceptance scenarios are defined — every user story has Given/When/Then scenarios
- [x] Edge cases are identified — 10 edge cases incl. cross-feature ordering, import mismatch, ACME vs. prefix-list, state bootstrap
- [x] Scope is clearly bounded — explicit Scope Boundary section: authoring only, no app code, no migrations, nothing applied to AWS
- [x] Dependencies and assumptions identified — Assumptions + Dependencies & Cross-Feature Handoffs sections (feature 010 contract verified against current code)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows — 6 prioritized, independently testable stories (Tofu, Kustomize, SOPS, deploy, backup, runbook)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification — *qualified as above*

## Notes

- Verification Gate is explicitly NOT `npm test`: `kustomize build` per overlay + `tofu validate`/`tofu fmt -check`, with a documented fallback ladder (terraform fmt / kubectl kustomize / structured manual review) since `tofu`, `kustomize`, and `kubectl` are absent in the dev pod today.
- The runbook (FR-024) is delivered alongside the spec at `specs/011-iac-config-management/runbook.md`.
- Gaps G1 (CloudFront-scoped 443 vs. ACME), G2 (feature-010 ordering), G3 (edge/DNS topology wording) are resolved by default but flagged for Sam's ratification.
