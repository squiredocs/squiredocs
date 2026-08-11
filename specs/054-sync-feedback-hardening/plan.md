# Implementation Plan: Sync Feedback Hardening (Repo-Sync Trust Pack)

**Branch**: `054-sync-feedback-hardening` (feature directory; work stays on `main` per the
solo trunk-based workflow) | **Date**: 2026-08-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/054-sync-feedback-hardening/spec.md`

## Summary

Make the two-way markdown sync channel trustworthy for coding agents. Four runtime items plus
one docs item, all additive:

1. **Staleness signal** — every `mode=sync` response reports `baselineClock`, `currentClock`,
   `clockGap`, `docChangedSinceBaseline`; opt-in `strict=true` rejects a stale push with 409
   `sync_baseline_stale`.
2. **Dry run** — `dryRun=true` computes the whole plan and applies nothing.
3. **Per-block change report** — `blocksChanged[]` with block index, type, excerpt, and op
   kind (`text` | `reconcile` | `structural`), removing the re-export-and-grep verification
   round trip.
4. **Ordered-list numbering** — both serializer copies honor `start`; the strict parser
   preserves it; the round-trip suite covers it.
5. **Guidance split** — whole-file sync is for authoring/importing/bulk updates, XPath-targeted
   modify for small targeted edits, at every surface teaching the channel rule.

**Technical approach.** The engine already computes almost everything needed. `validateSyncBaseline`
already returns `currentClock`; the route drops it. `applySyncPush` is already
compute-then-mutate, with `storeUpdate` as the first durable write. So items 1–3 are: use a
value already computed (staleness, in the route), return early before an existing line (dry
run), and derive a report from the plan object that already exists (change report). No new
engine path, no new merge logic, **no database changes and no migration**.

Item 4 is four one-site edits — two serializer copies that must stay byte-identical, one
frozen parser, one already-correct parser — plus a round-trip corpus entry.

Item 5 is documentation across twelve files (nine surfaces; three are generated from inline
text in `distribution/publish.mjs`), under three pinned byte budgets.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server), React 18 client (untouched by this feature)

**Primary Dependencies**: Express, Yjs / y-prosemirror, `diff` (LCS), the in-house
registry-driven markdown pipeline (`shared/markdown/`, `shared/format-registry.js`)

**Storage**: PostgreSQL (`yjs_updates` — **read only**, `MAX(clock)`), Redis (diff cache —
**version bump only**), S3 (image bytes, via the existing staged image pass). **No schema
change, no migration.**

**Testing**: Jest backend (`server/__tests__/`, `__tests__/integration/`), parallel with
per-worker DB and Redis isolation derived from `JEST_WORKER_ID` (Constitution II)

**Target Platform**: Linux server pods behind an ingress; agents over MCP + REST

**Project Type**: Web service (agent/API-facing contract change) + documentation surfaces

**Performance Goals**: No regression on the sync path. Staleness is free (value already
computed). The change report is O(changed blocks) over an already-built plan. Dry run is
strictly cheaper than a real push (skips `storeUpdate`, fan-out, and index marking).

**Constraints**: Additive receipt only — existing consumers and previously written baseline
files must keep working (SC-008). Pinned byte budgets: `SERVER_INSTRUCTIONS` ≤ 1,536 B
(311 B free), `modify.description` ≤ 2,048 B (**218 B free — the binding constraint**),
`import_markdown_file.description` ≤ 2,048 B (832 B free). The two serializer copies must stay
byte-identical (SC-006). The strict parser is FROZEN (feature 001 CN-2) — this feature carries
the one sanctioned exception.

**Scale/Scope**: ~6 runtime source files, ~8 test files, 12 documentation write sites.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.3.0. Re-checked after Phase 1.*

| Principle | Verdict | Basis |
|---|---|---|
| **I. Documentation Reflects Reality** | **PASS** | `README.md` is an explicit surface (FR-015 #8, RBD-054-10) and must be updated in the same commit — the receipt contract and two query params change. `docs/dev.md` is unaffected (no workflow change). |
| **II. Test-Backed Changes** | **PASS** | Every behavioral change is covered (research R11). FR-014 extends the **registry-driven round-trip suite** exactly as the principle mandates for serialization changes. Suites stay parallel-isolated; no serial assumptions added. |
| **III. Trunk-Based Solo Workflow** | **PASS** | No new ceremony. Runs through the standard `/the-pipeline` flow; work stays on `main` per the orchestrator's mandate. |
| **IV. Collaboration-Safe Document Operations** | **PASS** | No new mutation path. Dry run *removes* mutation. The change report is derived from `structuralOps`, the same function `applyHunks` uses, and is read-only. Format knowledge for `start` stays in the shared schema + registry-driven parsers — no new format branch. Attribution untouched. |
| **V. Secure by Default** | **PASS** | No new ingestion surface. `strict`/`dryRun` are booleans parsed with the route's existing convention, rejected when unparseable. Dry run runs the **full** staged image policy, so it cannot be used to bypass image vetting (research R3) — it is strictly less permissive than a real push. Auth and editor-role gates are unchanged and still upstream. |
| **VI. Design Docs Are Ground Truth** | **PASS** | Both amendments are the authority; nothing in `design/` is edited. Three gaps found during planning are recorded as RATIFIED-BY-DEFAULT in the ledger (RBD-054-11, RBD-054-12, and an amendment to RBD-054-6) rather than resolved silently. |
| **VII. Horizontally Scalable App Pods** | **PASS** | No process-local state added. Staleness reads Postgres; the change report is per-request; dry run writes nothing. Correctness does not depend on replica count. |

**No violations. Complexity Tracking table is empty.**

Post-Phase-1 re-check: unchanged. The design artifacts introduced no new projects, no new
dependencies, no persistence, and no abstraction layers — one new pure function
(`buildChangeReport`), one new option on an existing function (`dryRun`), and one shared
boolean-param helper extracted from code already in the file.

## Project Structure

### Documentation (this feature)

```text
specs/054-sync-feedback-hardening/
├── spec.md                      # committed
├── clarifications-needed.md     # RBD ledger — extended by this plan
├── checklists/requirements.md   # committed
├── plan.md                      # this file
├── research.md                  # Phase 0 — R1..R11
├── data-model.md                # Phase 1 — response-shape entities (no DB)
├── quickstart.md                # Phase 1 — validation guide
├── contracts/
│   ├── sync-receipt-v2.md       # delta on specs/004-two-way-sync/contracts/sync-push.md
│   └── guidance-split.md        # ratified sentence, measured variants, 12 write sites
└── tasks.md                     # /speckit-tasks output
```

### Source Code (repository root)

```text
server/
├── markdown-sync.js                  # buildChangeReport (new), blockExcerpt (cap→120),
│                                     # applySyncPush dryRun early-return.
│                                     # pushTouchedBlocks NOT modified (research R4)
├── api/
│   ├── docs-import.js                # strict/dryRun parsing, staleness merge,
│   │                                 # sync_baseline_stale 409, presence skip on dryRun
│   └── chat.js                       # BASE_SYSTEM_PROMPT — split ADDED (no rule text today)
├── diff-service.js                   # CACHE_VERSION v10 → v11 (research R9)
└── mcp/
    ├── index.js                      # SERVER_INSTRUCTIONS — COMPACT variant
    ├── yjs/serialization.js          # ordered-list start, BOTH copies (:255-262, :646-653)
    └── tools/
        ├── modify.js                 # sync-redirect paragraph REWRITTEN (218 B headroom)
        ├── import-markdown-file.js   # intent list gains the split
        └── tool-documentation/export-api.js   # channel-rule block + sync section

shared/
├── markdown/strict-parser.js         # :240 start preservation (FROZEN — sanctioned exception)
└── markdown/tolerant/block-parser.js # already correct — no change

distribution/
├── shared/skill.md, shared/onboard.md   # sources → Claude + Cursor SKILL.md, onboard command
└── publish.mjs                          # inline sources for Kiro steering/POWER + Cursor .mdc

client/public/agents.md               # published agent guide
README.md                             # sync + MCP documentation (Constitution I)
```

**Structure Decision**: Existing web-service layout; no new directories or modules. The engine
(`server/markdown-sync.js`) keeps owning plan computation; the route
(`server/api/docs-import.js`) keeps owning HTTP contract, parameter validation, and presence.
Staleness lands in the route because that is where the validated value already lives and where
a rejection can precede every side effect (research R1).

## Key design decisions

Full reasoning in [research.md](./research.md); the load-bearing ones:

- **R1 — staleness in the route, not the engine.** `validateSyncBaseline` already returns
  `currentClock` (`markdown-sync.js:1042`); `handleSyncPush` discards it. One merge site covers
  all three engine exits, and `currentClock` keeps FR-001's meaning (validation time).
- **R2 — dry run returns between `detectOverlaps` (:1141-1148) and `storeUpdate` (:1160).**
  The cut is the first durable write, so "nothing applied" is enforced by control flow.
- **R3 — the staged image pass still runs under dry run** (RBD-054-11), because it produces the
  canonical string the plan is diffed against. Skipping it would make the preview predict a
  different plan. Disclosed in the contract.
- **R4 — `pushTouchedBlocks` is not modified.** It labels reconcile blocks `text` and feeds the
  shipped `overlaps[].pushSide` contract. A sibling `buildChangeReport` provides the finer
  vocabulary FR-009 needs.
- **R5 — the report reuses `structuralOps`**, so it cannot drift from what is applied, and
  boundary insertions are reported with an anchor + `position` rather than an invented index.
- **R7/R8 — FR-012 and FR-013 must land in one change.** The diff engine serializes a version
  and re-parses it with the **strict** parser; shipping the serializer fix alone would make
  every ordered-list item diff as changed.
- **R8 — the strict parser is FROZEN.** One pinned test asserts today's behavior and must be
  updated: `server/__tests__/markdown-tolerant.test.js:203`. The 70-case characterization
  snapshot is unaffected (both its ordered-list cases use `start: 1`).
- **R9 — bump the diff `CACHE_VERSION` v10 → v11** (RBD-054-12), or cached diffs keep rendering
  the old flattened numbering.

## Ledger changes made by this plan

Appended to [clarifications-needed.md](./clarifications-needed.md):

- **RBD-054-11** — dry run runs the staged image pass (disclosed side effect). *Flagged for a
  human glance: the one place a dry run is not literally free.*
- **RBD-054-12** — diff `CACHE_VERSION` bumped v10 → v11 as a consequence of FR-013.
- **RBD-054-13** — FR-015's nine surfaces resolve to twelve files; three are generated from
  inline text in `distribution/publish.mjs`, and `chat.js` is an addition rather than an edit.
- **RBD-054-6 (amended)** — one excerpt helper at 120 chars, widening overlap excerpts too.

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| `modify.description` has only 218 B of headroom | **Rewrite** the existing sync-redirect paragraph instead of appending; re-measure with the byte script before running tests |
| Serializer copies drift → source maps desync | Both edits in one task; pinned by `format-roundtrip.test.js:764` and `serialization.sourcemap.test.js` (SC-006) |
| Strict-parser change regresses the diff engine | Characterization snapshot verified unaffected; `diff-service.test.js` in the gate; cache version bumped |
| Editing generated distribution files | `contracts/guidance-split.md` names the real write sites; `node distribution/publish.mjs` validates and has a drift tripwire |
| Overlap with feature 055 | 054 touches neither `computeHunks` nor alignment. `buildChangeReport` consumes only the plan shape `applyHunks` already consumes, so 055's re-implementation of plan *computation* flows through unchanged |
| Dry run mistaken for an applied receipt | Two independent guards: `dryRun: true` marker **and** omitted `markdown` |

## Out of scope (restated)

Feature 055's block-aligned merge (`computeHunks` pre-pass, block LCS, per-block character
diffing, atomic structural fallbacks) — **054 must not respecify or modify hunk computation or
merge alignment**. Also out: changing the channel rule's substance, strict-by-default, automatic
rebase/retry, dry run for `append`/`replace`/create, receipt pagination or diff-content
payloads, and UI surfaces.

## Complexity Tracking

*No Constitution Check violations. Table intentionally empty.*
