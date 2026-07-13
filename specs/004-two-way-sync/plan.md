# Implementation Plan: Two-Way Sync (Offline-Collaborator Push)

**Branch**: `004-two-way-sync` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-two-way-sync/spec.md`

## Summary

Add a `mode=sync` push half to feature 002's `PUT /api/docs/:docId/import` route. A repo `.md`
file (frontmatter included) is pushed back to Squire; its edits are replayed as **native CRDT
operations anchored at the export-time baseline clock** — exactly as if the repo editor were a
collaborator who went offline at that clock, edited, and reconnected. The server reconstructs the
Y.Doc at the frontmatter `clock` from the retained update log (`getYDocAtClock`), forks it under a
**synthetic client identity**, character-diffs the fork's canonical markdown against the pushed
markdown, classifies each hunk (text → character ops via a new serializer **source map**;
structural → block replacement via `markdownToPm`), and applies the fork's *update-since-baseline*
to the live document through the **normal update path** (`Y.applyUpdate` on the shared doc with an
attribution origin → persistence + broadcast + search indexing). CRDT convergence merges the push
with concurrent live edits deterministically — no conflict states, no compare-and-set, no retry.
Blocks changed on both sides since the baseline (found via state-vector comparison) are returned as
**advisory overlap flags**. Formatting-only / unchanged pushes canonicalize to an empty diff and are
true no-ops. The round-trip invariant (`import(export(doc))` ≡ no-op) becomes a standing CI property.

**Technical approach** grounds entirely on primitives that already exist in the code:
`postgres-persistence.getYDocAtClock` / `getStateVectorsAtClocks` (baseline + overlap), the
`restoreVersion` forward-update pattern (fork → `encodeStateAsUpdate(fork, baselineSV)` →
`Y.applyUpdate` onto the live doc), the in-house `toMarkdownNodes` serializer (extended with a
source map), `markdownToPm` (structural replacement), the npm `diff` package's `diffChars`, and the
`origin.js` / `document-service.updateDocument` attribution model. No new architectural machinery.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server modules), ES2022.

**Primary Dependencies**: `yjs` (CRDT: `applyUpdate`, `encodeStateAsUpdate`, `encodeStateVector`,
`XmlFragment`/`XmlText`/`XmlElement`), `diff` v8 (`diffChars` for character-level hunks; `diffLines`
already used by diff-service), the in-house serializer (`server/mcp/yjs/serialization.js`) and
parser (`server/markdown-to-pm.js`), the format registry (`server/format-registry.js`), Express
(route), YAML frontmatter parsing (owned by 003, consumed here). Zero new npm dependencies.

**Storage**: PostgreSQL. Reads `yjs_updates` (full retained update log — no compaction, every
historical clock reconstructible). Writes exactly one new `yjs_updates` row per content-changing
push via the standard update path. On-behalf-of provenance needs a home (see D8 / Complexity
Tracking) — one small additive migration.

**Testing**: Jest backend (`server/__tests__/`, `__tests__/integration/`), serial against the
shared test DB (Constitution II). New: convergence property test (push ≡ real offline Yjs client),
round-trip CI invariant extending `server/__tests__/format-roundtrip.test.js`, hunk-replay unit
tests, overlap-flag tests, order-independence (mid-push edit) tests, API-level route tests.

**Target Platform**: Linux server (Minikube `app-dev` pod for dev; commands run inside the pod).

**Project Type**: Web service (Express + y-websocket backend; the client is untouched by this
feature — push is a server-side protocol on an existing REST route).

**Performance Goals**: A push against a document up to 1 MB of markdown returns its receipt in
under 10 s (SC-007). Baseline reconstruction cost is linear in the update-log length up to the
baseline clock (same cost profile as `getYDocAtClock`, already used by version history/diff).

**Constraints**: No conflict states, no 409-on-conflict, no compare-and-set, no retry loop
(FR-008). Application MUST be order-independent w.r.t. concurrent live edits (SC-004). Replay MUST
be deterministic over (document, baseline clock, canonical content) so retries are idempotent
(FR-011, D5). MUST NOT delete-and-recreate untouched content (Constitution IV). MUST NOT fall back
to whole-document replacement (FR-015, D1). Pushed markdown is untrusted input (Constitution V).

**Scale/Scope**: One route mode + one new server module (`server/markdown-sync.js`, the push
engine) + a source-map extension to the serializer + the diff/classify/replay pipeline + response
shaping. No client work. No new dependency.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.1. Re-checked post-design.*

### I. Documentation Reflects Reality — PASS
This feature adds a protocol mode to a documented route. `README.md` and any export/sync docs are
updated in the implementing commit (Polish phase task). The design doc `design/markdown-import-two-way-sync.md`
§2.4/§2.4.1 is the ground truth and is not falsified by this plan (the plan implements its
mechanism verbatim); should implementation falsify any documented mechanism, the doc is amended in
the same effort (Constitution VI). Per parallel-safe overrides, this PLAN agent does not itself edit
those docs — the doc-update work is captured as tasks for the implementer.

### II. Test-Backed Changes — PASS (and central to the feature)
The convergence property test and the `export → import → export` round-trip invariant are
**first-class tasks**, not afterthoughts (FR-016, FR-017, SC-001/SC-002/SC-009). Round-trip
coverage extends the registry-driven `format-roundtrip.test.js` so new marks/nodes inherit sync
coverage by construction. Backend suites run serially. No behavioral change ships without tests.

### III. Trunk-Based Solo Workflow — PASS
No new ceremony. One route mode, one engine module, standard update path. The one migration (D8) is
minimal and additive. Nothing here adds process for its own sake.

### IV. Collaboration-Safe Document Operations — PASS (this principle is the heart of the feature)
The entire design exists to satisfy IV: character-level ops preserve CRDT identity, marks, undo
history, and attribution of all untouched content; block replacement is the **bounded, classifier-
last-resort fallback** used only when a hunk touches structure. The classifier MUST prefer the text
interpretation whenever a hunk can be expressed as one (FR-007). Targeting is structural (fork tree
walked by the source map / block ranges), never positional indexing into the live doc — indeed the
live doc is never consulted during diff/replay (FR-004). Format knowledge stays in the single
registry (the source map is emitted by the same registry-driven `toMarkdownNodes`; structural
replacement uses the same `markdownToPm`), so export/import/replay cannot drift. Provenance is
preserved: pushes land under the credential's identity via the standard origin model, plus optional
on-behalf-of text (FR-013). **No delete-and-recreate of untouched content** is the explicit
invariant (FR-008, SC-003).

### V. Secure by Default for Agent & User Content — PASS
Pushed markdown is untrusted input end to end (FR-003): parser HTML whitelist (001), no execution,
image-source guardrails (002/003). Auth is inherited from 002 (session or scoped/expiring `sk_sqd_`
token with `documents:write`); per-document editor ACL is re-checked on every push (FR-003, D2).
On-behalf-of metadata is rendered strictly as length-capped text, never interpreted as markup or
active links (FR-013, D6). The trust boundary is stated here as required for a new ingestion mode.

### VI. Design Docs Are Ground Truth — PASS
The plan implements `design/markdown-import-two-way-sync.md` §2.4/§2.4.1 as written. The seven open
product decisions are settled as RATIFIED-BY-DEFAULT in `clarifications-needed.md` (D1–D7); this
plan adds D8 (on-behalf-of storage) in the same format rather than deciding silently. No design-doc
mechanism is contradicted; the retention open-question is honored as a forward guard (D1).

**Result**: No violations. The single justified deviation from the "no migrations expected"
guidance is the additive on-behalf-of column (D8) — recorded in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/004-two-way-sync/
├── plan.md              # This file
├── research.md          # Source-map design + hunk-classification algorithm + fork/clientID mechanics
├── data-model.md        # Sync push, Baseline, Fork, Source map, Diff hunk, Overlap flag, Receipt, OnBehalfOf
├── quickstart.md        # Runnable validation scenarios (curl push, no-op, overlap, rejection)
├── contracts/
│   └── sync-push.md      # mode=sync request/response contract (extends 002's PUT response)
├── clarifications-needed.md  # D1–D7 ratified defaults (+ D8 appended by this plan)
└── tasks.md             # /speckit-tasks output (next stage)
```

### Source Code (repository root)

```text
server/
├── markdown-sync.js              # NEW — push engine: baseline fork, diff, hunk-classify, op replay,
│                                 #        overlap detection, receipt shaping. Y.Doc in / update out.
├── mcp/yjs/serialization.js      # EXTEND — toMarkdownNodes gains an optional source-map sink:
│                                 #        toMarkdown / toMarkdownNodes stay byte-identical; add
│                                 #        toMarkdownWithSourceMap(nodes) → { markdown, sourceMap }.
├── markdown-to-pm.js             # CONSUME (001) — structural replacement parses via markdownToPm;
│                                 #        materialization into Yjs reuses restoreVersion's clone helper.
├── markdown-import.js            # CONSUME (002) — sync mode dispatches to markdown-sync.js.
├── api/docs-import.js            # EXTEND (002) — PUT route: mode=sync branch, baseline resolution,
│                                 #        onBehalfOf parsing, receipt response.
├── postgres-persistence.js       # CONSUME — getYDocAtClock (baseline), getStateVectorsAtClocks
│                                 #        (overlap), storeUpdate (via normal path). No change expected.
├── version-history.js            # CONSUME — restoreVersion forward-update pattern (reference impl),
│                                 #        createAuthor (surfacing onBehalfOf in the timeline).
├── document-service.js           # CONSUME — updateDocument / getSharedDoc: apply fork delta to live doc.
├── origin.js                     # CONSUME — createOrigin(userId, agentName) for attribution.
└── format-registry.js            # CONSUME — INLINE_MARKS drives source-map syntax-vs-text classification.

migrations/
└── <ts>_add-on-behalf-of-to-updates.js  # NEW (additive) — yjs_updates.on_behalf_of JSONB NULL (D8).

server/__tests__/
├── markdown-sync.convergence.test.js     # NEW — push ≡ real offline Yjs client (property test, SC-002)
├── markdown-sync.replay.test.js          # NEW — text-hunk / structural-hunk replay units
├── markdown-sync.overlap.test.js         # NEW — state-vector overlap flagging (SC-006)
├── markdown-sync.order-independence.test.js  # NEW — mid-push edits, arrival-order invariance (SC-004)
├── markdown-sync.rejection.test.js       # NEW — invalid/unavailable/mismatched-baseline (SC-008)
├── serialization.sourcemap.test.js       # NEW — source-map offset correctness (marks, syntax chars)
└── format-roundtrip.test.js              # EXTEND — sync round-trip invariant (SC-001, SC-009)

__tests__/integration/
└── sync-push.route.test.js               # NEW — API-level PUT mode=sync (auth, receipt, no-op)
```

**Structure Decision**: Single Express web-service backend (the existing repository layout). The
push engine is one new server module (`server/markdown-sync.js`) with a thin route branch; the only
serializer change is an additive source-map emitter that leaves `toMarkdown`/`toMarkdownNodes`
byte-for-byte identical. No client changes (Out of Scope in spec). This mirrors how `diff-service.js`
and `version-history.js` already sit beside the persistence layer and reuse the serializer/parser.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| One additive migration (`yjs_updates.on_behalf_of JSONB NULL`, D8) despite "no migrations expected" | FR-013 requires optional on-behalf-of provenance (author/email/sha/url) to be **recorded with the push's version entry and surfaced in version history**. Version-history entries are derived per `yjs_updates` row; that table has only `user_id` + `agent_name` (TEXT) and no free-form metadata column, so structured, per-entry provenance has nowhere durable to live. | (a) Overloading `agent_name` with a serialized string was rejected: it drives `createAuthor`'s `isAgent`/`displayName` logic, so the encoded blob would corrupt the author label and cannot carry four structured fields cleanly. (b) A separate side-table keyed by `(doc_guid, clock)` is also a migration and adds a join for no benefit over a nullable column. (c) Redis/ephemeral storage was rejected: version history is durable, so provenance must be too. The chosen column is additive, nullable, no backfill, touching only the push write and the timeline read — the minimum that satisfies FR-013 honestly. If review prefers zero migrations, the fallback is a compact text label folded into `agent_name` (e.g. `Squire Sync · alice@x · a1b2c3d`), accepting loss of structured rendering. |
