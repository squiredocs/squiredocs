# Implementation Plan: General Markdown Parser (Tolerant CommonMark + GFM Subset)

**Branch**: `main` (pipeline worktree; solo trunk workflow per Constitution III) | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-general-markdown-parser/spec.md`

**Design ground truth**: `design/markdown-import-two-way-sync.md` (§Design Decision, §1.1), `design/document-model-format-pipeline.md`. Open decisions settled in [clarifications-needed.md](./clarifications-needed.md) (CN-1…CN-10, RATIFIED-BY-DEFAULT).

## Summary

Generalize the in-house markdown parser from "the exact dialect `toMarkdown()` emits" to a tolerant CommonMark + GFM subset (emphasis variants, loose/lazy/multi-paragraph lists, setext headings, indented code, autolinks, escapes/entities, hard breaks, task-list degradation, registry-derived HTML whitelist), while pinning today's behavior byte-identically behind an explicit `strict` mode for the diff engine. Both the parser and the format registry relocate to `shared/` so one grammar can later serve server import (002) and editor paste (M5).

Technical approach (details in [research.md](./research.md)):

- **Strict mode = the current parser, frozen verbatim** as `shared/markdown/strict-parser.js`; a new dispatch entry `shared/markdown/index.js` keeps the `(markdown, diffMark)` signature and adds an optional `{ strict }` options argument (CN-1, CN-2). Byte-identity is proven by a characterization snapshot generated from the pre-move parser before any code moves.
- **Tolerant mode = a new two-layer parser** per the design's structure note: a container-stack **block classifier** (`tolerant/block-parser.js`) plus a **registry-driven inline tokenizer** with the CommonMark delimiter-stack emphasis algorithm (`tolerant/inline-parser.js`), and a small entities module (CN-4). Alternate emphasis delimiters live in the registry (`altWrap` metadata), not in parser-local code (FR-015, Constitution IV).
- **Never-lose-content** is enforced architecturally (every construct has a literal-text degradation) and by a fast-check fuzz/property suite with a word-subsequence oracle (FR-013, TR-003).
- **Diff engine opts into strict** at its three `markdownToPm` call sites; `CACHE_VERSION` stays `v7` because strict output is byte-identical.

## Technical Context

**Language/Version**: Node.js 22 (v22.22.3 in the dev pod); CommonJS modules for all `shared/` code (matches `shared/prosemirror-schema.js`; the unmerged Vitest+ESM branch adapts them like the rest of the backend — spec Assumptions)

**Primary Dependencies**: none new at runtime (design decision: extend in-house parser, zero markdown libs). Existing: `prosemirror-model` (via shared schema). Test-only addition: `fast-check` (devDependency; justification in research.md R3)

**Storage**: N/A (pure function: string → ProseMirror JSON). Redis diff cache is a consumer concern; `CACHE_VERSION` `v7` in `server/diff-service.js` intentionally unchanged (CN-2)

**Testing**: backend Jest (`server/__tests__/`, serial `--runInBand` against shared DB — new suites are pure-function, no DB); client Vitest (`client/src/**/__tests__/`, jsdom) for the client-safety test (TR-005)

**Target Platform**: dual — Node server (diff engine today, import surfaces in 002) and browser bundle (editor paste, M5). "Client-safe" for M1 = loads with zero Node built-ins, proven by test (SC-007)

**Project Type**: shared library modules inside the existing web app monorepo (`shared/` consumed by `server/` and `client/`)

**Performance Goals**: 100 KB markdown parses < 1 s; no 64 KB fuzz input > 5 s (SC-006). Achieved by line-based O(n) block scan and delimiter-stack emphasis with the `openers_bottom` optimization (no regex backtracking on nested delimiters)

**Constraints**: strict-mode output byte-identical to the pre-feature parser for all inputs (CN-2); tolerant mode must not change the parse of canonical serializer output (FR-012, US3 AS-3); registry stays the single source of truth for inline format knowledge (Constitution IV); parser input is untrusted — output is inert JSON only, no execution/network (Constitution V, FR-010)

**Scale/Scope**: ~2 moved files + ~4 new shared modules + 1 registry extension; 5 new/extended test suites + checked-in fixture corpus (curated CommonMark/GFM examples + ≥10 real-world docs); 3 production call sites updated (`server/diff-service.js` ×3), 1 registry import site (`server/mcp/yjs/serialization.js`), 2 test requires

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.1 before Phase 0; re-checked after Phase 1 design.*

| # | Principle | Assessment | Result |
|---|-----------|------------|--------|
| I | Documentation Reflects Reality | Shipping this makes `README.md` and the current-state statements in `design/document-model-format-pipeline.md` stale (parser location, "parses only the dialect toMarkdown emits"). Plan carries explicit polish tasks: update `README.md` in the shipping commit; amend the Squire source doc and re-export via `node design/sync.mjs` (never hand-edit the export) — CN-10. | PASS (with polish tasks) |
| II | Test-Backed Changes | Every behavioral change is test-backed: registry-driven round-trip suite extended to run both modes (TR-002), curated CommonMark/GFM fixtures (TR-001), fuzz/property suite (TR-003), diff-service suite unchanged + `---` regression pins (TR-004), client-safety test (TR-005), pre-move characterization snapshot pinning strict mode. All backend suites remain serial; new parser suites are DB-free pure-function tests. | PASS |
| III | Trunk-Based Solo Workflow | No new ceremony. Work is sized for one implementer in a pipeline worktree; merge = run tests, commit to main. No new processes, hooks, or gates introduced. | PASS |
| IV | Collaboration-Safe Document Operations | The parser never mutates live documents — it produces detached ProseMirror JSON; Yjs materialization stays with existing consumers (the diff engine builds throwaway docs). Format knowledge stays in the single registry: alternate emphasis delimiters are registry `altWrap` entries, the HTML whitelist is derived from `INLINE_HTML_TAGS`/schema, and `buildInlineRegex()` continues to drive strict inline parsing. No positional targeting anywhere. | PASS |
| V | Secure by Default for Agent & User Content | Trust boundary stated in spec FR-010 and honored: all parser input is untrusted text; output is inert JSON; non-whitelist HTML (including `<script>`) becomes literal visible text, never executed or dropped; no URL fetching (image rehosting is 002); no new endpoints/tokens; adversarial-input fuzzing is a required suite. The parser performs no sanitization side effects — existing guardrails (`isAllowedImageSrc`, SVG sanitizer) remain at materialization surfaces. | PASS |
| VI | Design Docs Are Ground Truth | Plan implements design §Design Decision (extend in-house parser, zero new runtime deps) and §1.1 (target grammar, split into block classifier + registry-driven inline tokenizer, keep signature, strict option, never-lose-content rule). Every open point the design leaves is settled in the CN ledger, not ad hoc; doc amendment flows through the Squire source doc + `sync.mjs` (CN-10). | PASS |

**Post-Phase-1 re-check** (after research.md / data-model.md / contracts): no new violations introduced. The one deliberate complexity — two block-grammar implementations (frozen strict + new tolerant) — violates no principle (the registry remains the single source of format knowledge for both paths); it is the mechanism required by the CN-2 byte-identity guarantee and is recorded in research.md R1 with the rejected simpler alternative.

**Complexity Tracking entries**: none (no constitution violations to justify).

## Project Structure

### Documentation (this feature)

```text
specs/001-general-markdown-parser/
├── spec.md                  # Feature specification
├── clarifications-needed.md # CN-1…CN-10 RATIFIED-BY-DEFAULT ledger
├── plan.md                  # This file
├── research.md              # Phase 0 decisions (R1–R10)
├── data-model.md            # Phase 1 entities: modes, tokens, degradation ladder, fixture formats
├── quickstart.md            # Phase 1 validation guide
├── contracts/
│   └── parser-api.md        # Public API contract: markdownToPm, registry exports, 003 seam
└── tasks.md                 # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
shared/
├── prosemirror-schema.js            # existing (unchanged)
├── format-registry.js               # MOVED from server/format-registry.js; + tolerant altWrap metadata & derived exports
└── markdown/
    ├── index.js                     # NEW public entry: markdownToPm(markdown, diffMark, { strict }) dispatch; re-exports parseInline
    ├── strict-parser.js             # MOVED verbatim from server/markdown-to-pm.js (frozen; only require path changed)
    └── tolerant/
        ├── block-parser.js          # NEW container-stack block classifier (setext, indented code, loose/lazy lists, --- disambiguation, fences, tables, task-list seam)
        ├── inline-parser.js         # NEW registry-driven inline tokenizer + CommonMark delimiter-stack emphasis, autolinks, escapes, HTML whitelist, hard breaks
        └── entities.js              # NEW numeric refs + curated named entities (CN-4)

server/
├── diff-service.js                  # require path updated; 3 call sites pass { strict: true } (CN-1)
├── mcp/yjs/serialization.js         # require path updated (../../shared/format-registry)
└── __tests__/
    ├── format-roundtrip.test.js     # extended: round-trips run in BOTH modes (TR-002)
    ├── diff-service.test.js         # requires updated; must pass unchanged (TR-004)
    ├── markdown-strict-characterization.test.js   # NEW: pins strict mode to pre-move snapshot
    ├── markdown-tolerant.test.js    # NEW: construct-level tolerant grammar tests + edge cases
    ├── markdown-fixtures.test.js    # NEW: runs curated CommonMark/GFM + real-world fixtures (TR-001, SC-001, SC-002)
    ├── markdown-fuzz.test.js        # NEW: fast-check property suite (TR-003, SC-003, SC-006)
    └── fixtures/markdown/
        ├── strict-characterization.json   # generated from PRE-move parser, checked in
        ├── commonmark/*.json              # curated spec examples per construct
        ├── gfm/*.json                     # task lists, strikethrough, autolinks, table subset
        ├── real-world/*.md + *.expected.json
        └── EXCLUSIONS.md                  # per-example exclusion reasons (CN-7)

client/src/__tests__/
└── sharedMarkdown.test.js           # NEW Vitest (jsdom): imports shared parser+registry, parses sample, module-graph Node-builtin scan (TR-005, SC-007)

(deleted: server/markdown-to-pm.js, server/format-registry.js — no stale copies, FR-014)
```

**Structure Decision**: shared-library placement per Constitution ("Shared client/server logic … belongs under `shared/`") and the design's shared-code note. `shared/markdown/` is a directory (not one file) because the design itself prescribes the block-classifier/inline-tokenizer split; `index.js` is the only public entry. Client build config needs **no change**: `client/vite.config.js` already sets `server.fs.allow: ['..']` for `../shared` imports, and the Vitest client suite already resolves relative imports into `shared/` (`svg-sanitizer.mjs` precedent in `client/src/extensions/__tests__/svgSanitizer.test.js`).

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified.

*No violations — table intentionally empty. The dual-implementation (frozen strict copy + tolerant parser) tradeoff is recorded in research.md R1: it is required by the CN-2 byte-identity guarantee and does not split format knowledge (the registry remains the single source of truth for both paths).*
