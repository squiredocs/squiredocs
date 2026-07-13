<!--
Sync Impact Report
==================
Version change: (template) → 1.0.0
Modified principles: n/a (initial adoption — all placeholders filled)
Added sections:
  - Core Principles (5): I. Documentation Reflects Reality; II. Test-Backed Changes;
    III. Trunk-Based Solo Workflow; IV. Collaboration-Safe Document Operations;
    V. Secure by Default for Agent & User Content
  - Technology & Architecture Constraints
  - Development Workflow & Quality Gates
  - Governance
Removed sections: none (template slots consumed)
Templates requiring updates:
  ✅ .specify/templates/plan-template.md — Constitution Check gate is generic
     ("[Gates determined based on constitution file]"); derives from this file at plan time.
  ✅ .specify/templates/spec-template.md — no constitution-specific references; no change needed.
  ✅ .specify/templates/tasks-template.md — no constitution-specific references; no change needed.
  ✅ .specify/templates/commands/ — directory does not exist; nothing to update.
Follow-up TODOs: none.
-->

# Squire Docs Constitution

## Core Principles

### I. Documentation Reflects Reality

`README.md` is the core source of documentation for the application and MUST stay accurate;
`docs/dev.md` is the authoritative guide for local development. Any change that alters
behavior, features, APIs, or workflow described in these docs MUST update them in the same
commit. When analysis reveals docs are already out of date, they MUST be corrected as part of
the work that discovered the drift — stale documentation is a defect, not a chore.

Rationale: a single developer plus AI agents rely on the docs as shared ground truth; drift
compounds fast when the primary reader is an agent that takes the docs literally.

### II. Test-Backed Changes

Every behavioral change MUST be covered by tests and the affected suites MUST pass before
commit. Backend tests run under Jest (`server/__tests__/`, `__tests__/integration/`),
frontend under Vitest (`client/src/**/__tests__/`). Format/serialization changes MUST extend
the registry-driven round-trip suite (`server/__tests__/format-roundtrip.test.js`) so new
marks and nodes get bidirectional coverage by construction. Backend tests share one database
and MUST run serially — never launch concurrent backend test runs against the same DB.

Rationale: with no code review, the test suite is the only reviewer; round-trip invariants
are what keep the CRDT, serializer, and parser honest with each other.

### III. Trunk-Based Solo Workflow

This is a single-developer project with no pull-request or code-review ceremony. The default
path for a normal change is: run the tests, commit to `main`, deploy. Branches MUST be used
only when they earn it — exploratory spikes, larger multi-step efforts, or work risky enough
to isolate until ready. Process MUST NOT be added for its own sake; any new ceremony requires
a concrete failure it prevents.

Rationale: the cost of process falls on one person; simplicity is what keeps velocity and
deployment honest (YAGNI applies to workflow, not just code).

### IV. Collaboration-Safe Document Operations

Code that mutates live documents MUST use targeted operations against the Yjs tree and MUST
NOT delete-and-recreate content wholesale — collaboration, undo history, version attribution,
and CRDT identity survive only under in-place transformation. Element targeting MUST be
structural (XPath/queries), never positional indexing. Format knowledge (marks, nodes, style
props) MUST live in the single registry (`server/format-registry.js` and the shared schema)
so export, import, editor, and agent tooling cannot drift apart. Provenance is a product
invariant: edits MUST remain attributable to the human or agent that made them.

Rationale: Squire's differentiators are real-time collaboration and attribution; any code
path that breaks CRDT identity silently destroys both.

### V. Secure by Default for Agent & User Content

Content authored by agents or collaborators is untrusted input. Script execution MUST stay
inside the isolated-vm sandbox with its memory/timeout limits; rendered SVG MUST pass the
strict sanitizer (no scripts, event handlers, foreignObject, or external references); image
sources MUST satisfy the app-URL guardrail (no data: or external srcs written into docs);
API tokens MUST be scoped and expiring (`sk_sqd_`), and new endpoints MUST enforce auth and
document-level ACLs. New ingestion surfaces (imports, uploads, webhooks) MUST state their
trust boundary and validation policy in the spec before implementation.

Rationale: the product's pitch is "bring your own agent" — that only works if hostile or
buggy agent output cannot execute, exfiltrate, or corrupt.

## Technology & Architecture Constraints

- Stack: Node.js 22+ / Express / y-websocket backend; React 18 + TipTap + Yjs frontend;
  PostgreSQL (node-pg-migrate for schema changes) with pgvector; Redis for sessions/state;
  S3 for image bytes (documents store only short app URLs).
- Schema migrations MUST go through node-pg-migrate; no ad-hoc DDL.
- AI-provider behavior (model dispatch, key validation, caching) lives in one place:
  `server/api/ai-providers.js`. New providers/models MUST be added there, not inline.
- Server-side markdown/serialization logic uses the in-house registry-driven pipeline; adding
  a third-party markdown/serialization dependency requires an explicit justification against
  Principle IV's single-registry rule.
- Shared client/server logic (schema, sanitizers, parsers) belongs under `shared/`.

## Development Workflow & Quality Gates

- Development happens in the Minikube `app-dev` pod (see `docs/dev.md`); commands run inside
  the pod. Mutagen sync can leave a running dev server on stale code — restart it when in doubt.
- Gate for every change: affected tests pass (serially for backend) → docs updated if behavior
  changed (Principle I) → commit to `main` → deploy via the deploy scripts.
- Feature work driven through spec-kit artifacts (`.specify/`) MUST pass the plan-phase
  Constitution Check against this document; violations require an entry in the plan's
  Complexity Tracking table with the simpler alternative and why it was rejected.
- Test output MUST stay LLM-friendly: keep the custom reporters wired in so passing suites
  summarize to one line and only failures expand.

## Governance

This constitution supersedes ad-hoc practice for all work in this repository. The sole
maintainer amends it directly: an amendment is a commit to `main` that updates this file,
bumps the version per semantic versioning (MAJOR: principle removal/redefinition; MINOR: new
principle or materially expanded guidance; PATCH: clarification/wording), updates the Sync
Impact Report comment, and propagates changes to the `.specify/templates/` artifacts when
gates or required sections change. Compliance is reviewed at spec-kit plan time (Constitution
Check gate) and whenever an agent session begins work that touches a governed area. Runtime
agent guidance lives in `CLAUDE.md`; where they conflict, this constitution wins.

**Version**: 1.0.0 | **Ratified**: 2026-07-13 | **Last Amended**: 2026-07-13
