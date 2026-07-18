# Implementation Plan: Sync-Path Discoverability for External Agents

**Branch**: `019-sync-path-discoverability` | **Date**: 2026-07-18 | **Spec**: specs/019-sync-path-discoverability/spec.md

**Input**: Feature specification from `/specs/019-sync-path-discoverability/spec.md`,
clarifications-needed.md (RBD-1..7 + DR-1), design amendments at commits 3b13209
and c790282 (design wins on conflict — Constitution VI).

## Summary

Make the REST import byte channel win the "sync an existing markdown file"
decision at every surface an external MCP agent sees: (1) a new no-content recipe
tool `import_markdown_file` that returns one ready-to-run compound shell command
(one-shot token claim + curl import + receipt write-back) built on the existing
pending-mint machinery; (2) a trigger-word contract across create_document /
modify / get_tool_documentation / server instructions — with UTF-8-byte budgets
test-asserted; (3) a teaching nudge (≥2 KB) and soft refusal with `allowRetyped`
escape hatch (≥10 KB) on retyped markdown into create_document; (4) the first-sync
remedy in the `sync_baseline_missing` rejection; (5) a task-named "Sync a repo
file" recipe in agents.md. **Plus, folded in by design amendment c790282 (DR-1)**:
read_document absorbs read_document_version (hidden deprecation alias; advertised
count stays sixteen), a registry-wide description diet with a shared ≤2,048-byte
test, and get_tool_documentation drops its scope requirement. No migrations; no
changes to claim mechanics, the receipt contract, or the `rest_api` reference.

## Technical Context

**Language/Version**: Node.js 22 (CommonJS server), Express; no client JS changes
(agents.md is a static file under `client/public/`)

**Primary Dependencies**: existing only — ioredis (pending mints), yjs,
y-websocket, express; no new dependencies

**Storage**: none added — Redis pending-mint records (existing shape, second call
site); NO database migrations (spec Out of Scope)

**Testing**: Jest (backend: `server/__tests__/`, `server/mcp/__tests__/`,
`__tests__/integration/`), serial runs against the shared test DB
(Constitution II); SC-002 test starts a real listening HTTP server and executes
the recipe via `bash`

**Target Platform**: Linux server (Minikube app-dev pod for development)

**Project Type**: web service (Express backend + static public file)

**Performance Goals**: n/a — teaching-surface text changes and one stateless
recipe generator; the only added per-call work is two env reads and one
`Buffer.byteLength` in create_document

**Constraints**: UTF-8 **byte** budgets, test-asserted: every advertised tool
description ≤ 2,048 bytes; server instructions ≤ 1,536 bytes (RBD-7). Budgets
re-measure against implement-time `main`. `modify` (2,049 B) and
`get_collaborators` (2,787 B) are over the cap today — the diet is a latent-bug
fix. No document content or token may transit `import_markdown_file` in either
direction. Claim-flow security properties preserved unchanged (SC-009).

**Scale/Scope**: 1 new MCP tool module, ~10 tool-description edits, 1 registry
change (add + hide + scope drop), 1 handler behavior change (create_document
teaching), 1 REST error-message string, agents.md section, 4 chat-layer touch
points, ~8 test files (5 new, 3+ extended). No schema, no frontend components.

## Constitution Check

*GATE evaluated against constitution v1.1.1 — pre-Phase-0 and re-checked post-Phase-1: PASS (no violations; Complexity Tracking empty).*

- **I. Documentation Reflects Reality**: README.md's MCP tool list ("All 15 MCP
  document tools", `read_document_version` bullet) and agents.md change with the
  surface; both are updated in-feature (Polish phase + US5) and agents.md is
  drift-guarded by test. docs/dev.md unaffected.
- **II. Test-Backed Changes**: every behavioral change lands tests-first (tasks
  are ordered test → implementation per story); backend suites run serially. No
  format/serialization changes, so the round-trip registry suite is untouched.
- **III. Trunk-Based Solo Workflow**: single feature branch per the pipeline;
  no new ceremony introduced.
- **IV. Collaboration-Safe Document Operations**: no document mutation paths are
  added or altered — the recipe tool touches no documents; create_document's
  teaching check runs before any side effect; read_document's versionId branch is
  read-only reconstruction of a historical Y.Doc.
- **V. Secure by Default**: no new ingestion surface — `import_markdown_file`
  accepts no content; its trust boundary is the existing claim flow, reused not
  forked (research R1), with scope enforcement at the tool boundary (FR-001) and
  the no-chain/delegation-liveness guards shared with create_access_token. The
  claim secret in the result is existing, accepted transcript residue. Refusal
  never blocks (escape hatch always honored). get_tool_documentation's scope drop
  exposes only static documentation text (design-ratified DR-1).
- **VI. Design Docs Are Ground Truth**: both amendments are ratified and exported;
  the mid-flight fold-in (c790282) supersedes spec FR-024's exclusion for exactly
  three items and SC-001's "seventeen" — recorded as **DR-1** in
  clarifications-needed.md rather than re-opening the spec. Design and spec
  conflicts resolve to the design.

## Project Structure

### Documentation (this feature)

```text
specs/019-sync-path-discoverability/
├── spec.md
├── clarifications-needed.md   # RBD-1..7 + DR-1 (design-ratified fold-in)
├── checklists/requirements.md
├── plan.md                    # This file
├── research.md                # Phase 0 (R1–R10)
├── data-model.md              # Phase 1 (minimal — no schema)
├── quickstart.md              # Phase 1
├── contracts/
│   ├── import-markdown-file.md    # recipe tool contract
│   ├── teaching-surfaces.md       # trigger words, budgets, nudge/refusal, remedy
│   └── read-document-merge.md     # DR-1: versionId absorption + alias + scope drop
└── tasks.md                   # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
server/
├── mcp/
│   ├── index.js                          # SERVER_INSTRUCTIONS: trigger phrase, export for test
│   ├── auth/pending-mints.js             # UNCHANGED (reused via R1 helper)
│   ├── tools/
│   │   ├── import-markdown-file.js       # NEW — recipe tool (US1)
│   │   ├── index.js                      # register + scope; hidden alias; scope drop
│   │   ├── create-access-token.js        # extract prepareClaimDelivery() (R1)
│   │   ├── create-document.js            # trigger words, trim, nudge/refusal, allowRetyped
│   │   ├── modify.js                     # trim + "or syncing"/mode=sync
│   │   ├── get-tool-documentation.js     # headline
│   │   ├── read-document.js              # versionId param (DR-1); diet
│   │   ├── read-document-version.js      # thin delegate, hidden alias (DR-1)
│   │   ├── read-helpers.js               # shared historical-read core (DR-1)
│   │   ├── undo.js / redo.js             # diet to ~500 B (DR-1)
│   │   ├── get-collaborators.js          # banner-art removal (fixes 2,787 B overrun)
│   │   ├── share-document.js             # owner-only sentence (DR-1)
│   │   └── list-documents.js             # PARAMETERS-prose diet (DR-1)
│   └── __tests__/tools/                  # new + extended suites (see tasks)
├── api/
│   ├── docs-import.js                    # sync_baseline_missing remedy (line 78)
│   ├── token-claim.js                    # UNCHANGED (mounted in e2e test)
│   ├── chat.js                           # VERSION workflow prompt (DR-1)
│   ├── chat-tools.js                     # XPATH_TOOLS (DR-1)
│   ├── chat-staleness.js                 # versionId reads are not snapshots (DR-1)
│   └── chat-dedup.js                     # versionId-aware dedup keys (DR-1)
├── __tests__/                            # agents-md-claims, markdown-sync.rejection ext.
client/public/agents.md                   # "Sync a repo file" + tool-list update
__tests__/integration/
└── import-recipe-e2e.test.js             # NEW — SC-002/SC-008 live-server test
README.md                                 # MCP tool list / counts (Constitution I)
```

**Structure Decision**: All work lands in the existing Express backend tree —
`server/mcp/tools/` for the MCP surface, `server/api/` for REST + chat touch
points, static `client/public/agents.md` for the onboarding page. No new
directories except the new tool module and test files.

## Architecture Decisions (index into research.md)

- **R1** — recipe reuses `create_access_token`'s mint path via an extracted
  `prepareClaimDelivery()` helper; pending-mints untouched.
- **R2** — one compound POSIX command; receipt write-back via follow-up
  `GET …/export?format=markdown&frontmatter=true` (no JSON parsing of markdown in
  shell; docId extracted with escape-safe UUID grep); token only at
  `~/.squire/token`.
- **R3** — `CREATE_DOCUMENT_NUDGE_BYTES` / `CREATE_DOCUMENT_REFUSAL_BYTES`, read
  per call, pair-wise fallback to defaults on invalid config.
- **R4** — registry-wide byte-budget test (converts today's char-based cap);
  `SERVER_INSTRUCTIONS` exported and capped at 1,536 B; found `get_collaborators`
  at 2,787 B (second latent truncation bug beyond `modify`).
- **R5** — read_document `versionId` absorption mechanics; `HIDDEN_TOOL_ALIASES`
  in the registry keeps `read_document_version` executable but unadvertised;
  chat staleness/dedup handle versioned reads correctly.
- **R6** — SC-002 e2e: real listening server + `bash` execution with sandboxed
  `HOME`.
- **R7–R8** — trigger-surface test suite; agents.md drift-guard extension.
- **R9** — per-tool diet plan preserving 016-asserted undo/redo phrases.
- **R10** — scope-map removal for get_tool_documentation.

## Phases

- **Phase 0** (research.md): decisions R1–R10 — complete, no NEEDS CLARIFICATION.
- **Phase 1** (this plan + data-model.md + contracts/ + quickstart.md): entities
  are in-memory/contract-level only (no schema); three contracts document the
  recipe tool, the teaching surfaces, and the DR-1 merge.
- **Phase 2** (/speckit-tasks): dependency-ordered tasks, tests-first per story.
  Story order deviates from pure priority order in one place: the DR-1
  surface-reduction story runs **before** the US2 trigger-word story because the
  diet funds the byte room the trigger words spend, and the byte-budget test can
  only go green once both land.

## Complexity Tracking

No constitution violations — table intentionally empty.
